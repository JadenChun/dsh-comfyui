/**
 * Bridge to a running Local Inference Manager through llwmctl, its supported
 * automation interface. The Manager owns the ComfyUI progress WebSocket under a
 * stable clientId; this bridge learns that id (so prompts queued here report
 * progress to the Manager) and mirrors the Manager's live per-task progress back,
 * so the Manager card and the plugin UI show the same numbers.
 *
 * Progress has three mutually exclusive modes, chosen automatically:
 *   - push       Manager reachable and it POSTs progress to our loopback route;
 *   - poll       Manager reachable but push is unavailable/stale: poll
 *                media.queue.status on the interval;
 *   - standalone Manager unreachable: the plugin's own ComfyUI WebSocket is used
 *                instead (the caller owns that socket; this bridge reports
 *                active=false so only one source runs at a time).
 *
 * Everything is best-effort: a missing Manager, a blocked llwmctl, or a slow call
 * leaves progress empty; queueing and completion (detected by polling ComfyUI
 * history) are unaffected.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { RunProgress } from './progress.js'

const execFileAsync = promisify(execFile)

/** Progress push is considered stale after this long without a callback. */
const PUSH_STALE_MS = 12_000
/** Subscription lifetime; re-subscribed before it expires. */
const SUBSCRIBE_TTL_SECONDS = 300
/** Re-subscribe when the current one is within this window of expiring. */
const SUBSCRIBE_RENEW_MS = (SUBSCRIBE_TTL_SECONDS - 30) * 1000

export type ManagerProgressMode = 'push' | 'poll' | 'off'

export interface ManagerBridgeOptions {
  /** Path to llwmctl.exe; empty disables the bridge. */
  llwmctlPath: string
  /** Manager workspace root, passed as --workspace. */
  workspace: string
  /** ComfyUI base URL to query on the Manager. */
  baseUrl: string
  /** How often to reconcile mode / poll while prompts are tracked. */
  pollMs: number
  /** Whether any prompt is still being tracked (gates polling). */
  shouldPoll: () => boolean
  /** Loopback callback URL for pushes; undefined until the web server is up. */
  callbackUrl: () => string | undefined
  /** Notified when Manager-assisted progress starts or stops. */
  onActiveChange?: (active: boolean) => void
}

/** Live per-task progress as reported by the Manager. */
export interface ManagerRunProgress extends RunProgress {}

export class ManagerBridge {
  private options: ManagerBridgeOptions
  private readonly token = randomUUID()
  private readonly progress = new Map<string, ManagerRunProgress>()
  private clientId: string | undefined
  private subscriptionId: string | undefined
  private subscribedAt = 0
  private lastPushAt = 0
  private mode: ManagerProgressMode = 'off'
  private active = false
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false

  constructor(options: ManagerBridgeOptions) {
    this.options = options
    if (this.enabled) {
      this.timer = setInterval(() => {
        void this.tick()
      }, Math.max(500, options.pollMs))
      void this.tick()
    }
  }

  /** True when a Manager path is configured. */
  get enabled(): boolean {
    return this.options.llwmctlPath.trim() !== ''
  }

  /** True when the Manager is the active progress source (push or poll). */
  get activeSource(): boolean {
    return this.active
  }

  get progressMode(): ManagerProgressMode {
    return this.mode
  }

  /** Apply a settings-page change (path/workspace/url/poll interval). */
  reconfigure(options: ManagerBridgeOptions): void {
    const wasEnabled = this.enabled
    const moved = options.llwmctlPath !== this.options.llwmctlPath
      || options.workspace !== this.options.workspace
      || options.baseUrl !== this.options.baseUrl
    this.options = options
    if (!this.enabled) {
      this.stopTimer()
      this.reset('off')
      return
    }
    if (moved) {
      const previous = this.subscriptionId
      this.subscriptionId = undefined
      this.clientId = undefined
      this.progress.clear()
      this.reset('off')
      if (previous !== undefined) void this.unsubscribe(previous)
    }
    if (!wasEnabled || this.timer === null) {
      this.timer = setInterval(() => {
        void this.tick()
      }, Math.max(500, options.pollMs))
    }
    void this.tick()
  }

  /**
   * The Manager's ComfyUI clientId, cached only while the Manager reports its
   * progress listener is connected. Undefined while the Manager is unreachable
   * or its listener is down; callers then fall back to the plugin's own
   * CLIENT_ID, so the DSH's own WebSocket (progress.ts) still receives progress.
   */
  async resolveClientId(): Promise<string | undefined> {
    if (!this.enabled) return undefined
    try {
      const result = await this.run(['operations', 'run', 'media.session.status', '--set', `url=${this.options.baseUrl}`])
      const id = result.progressClientId
      this.clientId = result.progressListenerConnected === true && typeof id === 'string' && id !== ''
        ? id
        : undefined
    } catch {
      // Manager not reachable yet; clear any stale id so callers fall back.
      this.clientId = undefined
    }
    return this.clientId
  }

  /** Live progress for one prompt that the Manager is tracking. */
  get(promptId: string): ManagerRunProgress | undefined {
    return this.progress.get(promptId)
  }

  /** Drop a prompt's mirrored progress (e.g. after it completes). */
  forget(promptId: string): void {
    this.progress.delete(promptId)
  }

  /**
   * Accept a Manager progress push. Returns true when the token matched and the
   * payload was applied; the caller answers 403 otherwise.
   */
  acceptPush(token: string | undefined, body: unknown): boolean {
    if (!this.enabled || token !== this.token) return false
    const items = (body as { progress?: unknown } | null)?.progress
    if (!Array.isArray(items)) return false
    this.applyItems(items)
    this.lastPushAt = Date.now()
    this.setMode('push')
    return true
  }

  dispose(): void {
    this.stopTimer()
    this.progress.clear()
    const previous = this.subscriptionId
    this.subscriptionId = undefined
    if (previous !== undefined) void this.unsubscribe(previous)
    this.active = false
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private reset(mode: ManagerProgressMode): void {
    this.mode = mode
    if (mode !== 'push') this.progress.clear()
    if (mode === 'off') this.setActive(false)
  }

  private setMode(mode: ManagerProgressMode): void {
    this.mode = mode
    if (mode === 'off') this.setActive(false)
    else this.setActive(true)
  }

  private setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    this.options.onActiveChange?.(active)
  }

  private async tick(): Promise<void> {
    if (!this.enabled || this.busy) return
    this.busy = true
    try {
      const now = Date.now()

      if (this.mode === 'push') {
        // Renew before expiry, and fall back when pushes stop arriving mid-run.
        if (this.subscriptionId !== undefined && now - this.subscribedAt > SUBSCRIBE_RENEW_MS) {
          const callback = this.options.callbackUrl()
          if (callback !== undefined && await this.subscribe(callback)) return
        }
        if (!this.options.shouldPoll()) return
        if (now - this.lastPushAt < PUSH_STALE_MS) return
        this.mode = 'off'
        this.progress.clear()
      }

      const callback = this.options.callbackUrl()
      if (callback !== undefined && await this.subscribe(callback)) return
      if (await this.poll()) return
      this.reset('off')
    } finally {
      this.busy = false
    }
  }

  private async subscribe(callbackUrl: string): Promise<boolean> {
    try {
      const result = await this.run([
        'operations', 'run', 'media.progress.subscribe',
        '--set', `url=${callbackUrl}`,
        '--set', `token=${this.token}`,
        '--set', `ttlSeconds=${SUBSCRIBE_TTL_SECONDS}`,
      ])
      const id = result.subscriptionId
      if (typeof id !== 'string' || id === '') return false
      const previous = this.subscriptionId
      this.subscriptionId = id
      this.subscribedAt = Date.now()
      this.lastPushAt = Date.now()
      if (previous !== undefined && previous !== id) void this.unsubscribe(previous)
      this.setMode('push')
      return true
    } catch {
      return false
    }
  }

  private async poll(): Promise<boolean> {
    try {
      const result = await this.run(['operations', 'run', 'media.queue.status', '--set', `url=${this.options.baseUrl}`])
      const id = result.clientId
      // Only adopt the Manager's id while it reports its progress listener is
      // connected; otherwise drop the cache so queueing falls back to CLIENT_ID.
      this.clientId = result.progressListenerConnected === true && typeof id === 'string' && id !== ''
        ? id
        : undefined
      const items = result.items
      if (Array.isArray(items)) this.applyItems(items)
      this.setMode('poll')
      return true
    } catch {
      return false
    }
  }

  /** Replace the mirror with the full snapshot carried by a push or poll. */
  private applyItems(items: unknown[]): void {
    const next = new Map<string, ManagerRunProgress>()
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as { promptId?: unknown; value?: unknown; max?: unknown; node?: unknown; progress?: unknown }
      let { value, max, node } = record
      // Push carries flat items; poll maps to {promptId, value, max, node}.
      if ((typeof value !== 'number' || typeof max !== 'number') && typeof record.progress === 'object' && record.progress !== null) {
        const sample = record.progress as { value?: unknown; max?: unknown; node?: unknown }
        value = sample.value
        max = sample.max
        node = sample.node
      }
      if (typeof record.promptId !== 'string' || record.promptId === '') continue
      if (typeof value !== 'number' || typeof max !== 'number') continue
      next.set(record.promptId, { value, max, node: typeof node === 'number' ? node : null })
    }
    this.progress.clear()
    for (const [promptId, progress] of next) this.progress.set(promptId, progress)
  }

  private async unsubscribe(id: string): Promise<void> {
    try {
      await this.run(['operations', 'run', 'media.progress.unsubscribe', '--set', `subscription=${id}`])
    } catch {
      // The subscription expires on its own; nothing to do.
    }
  }

  private async run(args: string[]): Promise<Record<string, unknown>> {
    const { stdout } = await execFileAsync(
      this.options.llwmctlPath,
      [...args, '--workspace', this.options.workspace],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
    )
    const parsed = JSON.parse(stdout) as { ok?: unknown; error?: unknown; message?: unknown; result?: unknown }
    if (parsed.ok !== true) {
      throw new Error(typeof parsed.error === 'string' ? parsed.error : typeof parsed.message === 'string' ? parsed.message : 'llwmctl returned ok=false.')
    }
    return typeof parsed.result === 'object' && parsed.result !== null
      ? (parsed.result as Record<string, unknown>)
      : parsed
  }
}
