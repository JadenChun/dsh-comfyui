/**
 * Queue tracking: remembers every prompt this plugin queued (from tools or
 * the panel) so the panel can show "ours" in the ComfyUI queue and move
 * completed runs into the asset index. Sweeps run on read (queue/assets
 * routes), so no background timers leak into the fiber lifecycle.
 */
import { ComfyUIClient, collectMedia, hasMedia, nameFromHistoryEntry, type ComfyUIHistoryEntry, type ComfyUIMediaItem } from './comfyui.js'
import type { AssetRecord, ComfyUIStore, TrackedState } from './store.js'

/** A prompt this plugin queued. Kept after completion so the task center
 * can still show its workflow name and "ours" marker. */
export interface QueuedRun {
  promptId: string
  ts: string
  workflowName: string | null
  source: string
}

/** Upper bound on remembered runs; oldest are dropped beyond this. */
const MAX_TRACKED_RUNS = 500

/** Recent completed metadata-bearing jobs to inspect for externally queued runs. */
const MAX_HISTORY_DISCOVERY = 200

function deriveWorkflowName(media: ComfyUIMediaItem[]): string | null {
  const filename = media[0]?.filename
  if (filename === undefined || filename === '') return null
  const stem = filename
    .replace(/.[^.]+$/, '')
    .replace(/[_-]d{5,}[_-]?$/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
  return stem !== '' ? stem : null
}

function jobTimestamp(createTime: number | null | undefined): string {
  if (typeof createTime === 'number' && Number.isFinite(createTime) && createTime > 0) {
    const date = new Date(createTime)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  return new Date().toISOString()
}

/** Tracks queued prompts until they complete or vanish. */
export class QueueTracker {
  private readonly runs = new Map<string, QueuedRun>()
  /** Prompt ids already swept into the asset index, so sweep is idempotent. */
  private readonly archived = new Set<string>()

  /**
   * Optional durable backing: the tracked memory is persisted so completed
   * runs still land in the asset index after a web-server restart.
   */
  constructor(private readonly persisted?: {
    load(): Promise<TrackedState>
    save(state: TrackedState): Promise<void>
  }) {}

  /** Restore persisted runs/archived state; call once before tracking. */
  async init(): Promise<void> {
    if (this.persisted === undefined) return
    const state = await this.persisted.load()
    for (const run of state.runs) {
      this.runs.set(run.promptId, {
        promptId: run.promptId,
        ts: run.ts,
        workflowName: run.workflowName,
        source: run.source,
      })
    }
    for (const id of state.archived) this.archived.add(id)
  }

  /** Fire-and-forget persistence; failures must not break queueing. */
  private persistNow(): void {
    if (this.persisted === undefined) return
    const state: TrackedState = {
      runs: [...this.runs.values()],
      archived: [...this.archived],
    }
    void this.persisted.save(state).catch(() => undefined)
  }

  track(run: QueuedRun): void {
    this.runs.set(run.promptId, run)
    this.persistNow()
  }

  untrack(promptId: string): void {
    this.runs.delete(promptId)
    this.persistNow()
  }

  get(promptId: string): QueuedRun | undefined {
    return this.runs.get(promptId)
  }

  list(): QueuedRun[] {
    return [...this.runs.values()]
  }

  /**
   * Move completed runs into the asset store.
   *
   * Plugin-tracked runs keep their saved workflow name as the highest-priority
   * source. The second pass discovers completed external jobs that carry a
   * ComfyUI workflow_id (for example comfy-agent-harness MCP generations),
   * reads their history metadata, and indexes them without importing every
   * unnamed manual ComfyUI run.
   *
   * @returns the records newly appended.
   */
  async sweep(opts: {
    client: ComfyUIClient
    store: ComfyUIStore
    maxItems: number
    proxyBase: string | undefined
  }): Promise<AssetRecord[]> {
    const completed: AssetRecord[] = []
    const existingAssets = await opts.store.listAssets()
    const existingIds = new Set(existingAssets.map((record) => record.promptId))
    for (const id of existingIds) this.archived.add(id)

    for (const run of [...this.runs.values()]) {
      if (this.archived.has(run.promptId)) continue
      const entry = await opts.client.getHistory(run.promptId).catch(() => undefined)
      if (entry === undefined || !isCompleted(entry)) continue

      const media = collectMedia({ promptId: run.promptId, entry, maxItems: opts.maxItems, proxyBase: opts.proxyBase })
      const record: AssetRecord = {
        promptId: run.promptId,
        ts: run.ts,
        workflowName: run.workflowName ?? nameFromHistoryEntry(entry) ?? deriveWorkflowName(media),
        source: run.source,
        media,
      }
      await opts.store.appendAsset(record)
      completed.push(record)
      existingIds.add(run.promptId)
      this.archived.add(run.promptId)
    }

    const jobs = await opts.client.getJobs({
      status: ['completed'],
      limit: MAX_HISTORY_DISCOVERY,
      offset: 0,
      sortBy: 'created_at',
      sortOrder: 'desc',
    }).catch(() => undefined)

    for (const job of jobs?.jobs ?? []) {
      if (typeof job.workflow_id !== 'string' || job.workflow_id === '') continue
      if (existingIds.has(job.id) || this.archived.has(job.id)) continue

      const entry = await opts.client.getHistory(job.id).catch(() => undefined)
      if (entry === undefined || !isCompleted(entry)) continue
      const media = collectMedia({ promptId: job.id, entry, maxItems: opts.maxItems, proxyBase: opts.proxyBase })
      if (media.length === 0) {
        this.archived.add(job.id)
        continue
      }

      const record: AssetRecord = {
        promptId: job.id,
        ts: jobTimestamp(job.create_time),
        workflowName: nameFromHistoryEntry(entry) ?? deriveWorkflowName(media),
        source: 'comfyui-history',
        media,
      }
      await opts.store.appendAsset(record)
      completed.push(record)
      existingIds.add(job.id)
      this.archived.add(job.id)
    }

    if (this.runs.size > MAX_TRACKED_RUNS) {
      const oldest = this.runs.keys().next().value
      if (oldest !== undefined) this.runs.delete(oldest)
    }
    this.persistNow()
    return completed
  }
}

function isCompleted(entry: ComfyUIHistoryEntry): boolean {
  return entry.status?.status_str === 'success'
    || entry.status?.completed === true
    || hasMedia(entry)
}
