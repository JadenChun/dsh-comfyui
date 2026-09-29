/**
 * dsh-comfyui client half: registers the comfyui_run tool card and the
 * ComfyUI settings page. Registered through slots.inject so contributions
 * wait on the real slot declarations and unwind with this plugin's fiber.
 */
import { createElement as h } from 'react'
import { makeT, getLang } from './i18n.ts'
import { ComfyUICard, type ComfyUICardProps } from './card.tsx'
import { ComfyUISettings, type ComfyUISettingsProps } from './settings.tsx'
import { ComfyUIPanel, type ComfyUIPanelProps } from './panel.tsx'
import { ComfyUITrigger, type ComfyUITriggerProps } from './trigger.tsx'
import { injectStyles } from './styles.ts'
import { panelStore } from './panel-store.ts'

export const name = 'dsh-comfyui'
export const inject = ['slots']

interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: unknown): unknown
}

interface ComfyUIClientContext {
  effect(callback: () => unknown, label?: string): void
  slots: SlotsService
}

export function apply(ctx: ComfyUIClientContext): void {
  // Plugin-local i18n: language comes from localStorage (settings page), not
  // the host locale, so zh/en switching works without a host change.
  const t = makeT(getLang())
  ctx.effect(() => injectStyles(), 'dsh-comfyui: styles')

  ctx.effect(() => {
    let disposed = false
    let inFlight = false
    let timer: number | null = null

    const pollQueue = async (): Promise<void> => {
      if (disposed || inFlight || document.visibilityState !== 'visible') return
      inFlight = true
      try {
        const response = await fetch('/comfyui/queue', { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`queue request failed: ${response.status}`)
        const data = await response.json() as { ok?: boolean; running?: unknown[]; pending?: unknown[] }
        if (data.ok !== true) throw new Error('queue response not ok')
        if (!disposed) panelStore.setQueueActivity((data.running?.length ?? 0) + (data.pending?.length ?? 0))
      } catch {
        // Keep the last known activity count on transient failures.
      } finally {
        inFlight = false
      }
    }

    const startPolling = (): void => {
      if (timer !== null) window.clearInterval(timer)
      timer = null
      if (document.visibilityState !== 'visible') return
      void pollQueue()
      timer = window.setInterval(() => void pollQueue(), 3_000)
    }

    const onVisibilityChange = (): void => startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)
    startPolling()

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (timer !== null) window.clearInterval(timer)
    }
  }, 'dsh-comfyui: queue activity')

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_run' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'comfyui_workflow' },
    (props: unknown) => h(ComfyUICard, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUICardProps),
  ))

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'comfyui', order: 30, label: () => t('settingsTitle') },
    (props: unknown) => h(ComfyUISettings, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUISettingsProps),
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'comfyui.panel', order: 20, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUIPanel, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUIPanelProps),
  ))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
    { name: 'conversation.session.header.actions', id: 'comfyui', order: 100, label: () => t('panelTitle') },
    (props: unknown) => h(ComfyUITrigger, { t, ...((props ?? {}) as Record<string, unknown>) } as unknown as ComfyUITriggerProps),
  ))
}
