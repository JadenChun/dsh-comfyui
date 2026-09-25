import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nameFromHistoryEntry } from '../lib/comfyui.js'
import { QueueTracker } from '../lib/queue.js'
import { ComfyUIStore } from '../lib/store.js'

const media = (filename) => ({
  '9': {
    images: [{ filename, subfolder: 'Agentic', type: 'output' }],
  },
})

const historyEntry = (name, filename) => ({
  prompt: [
    1,
    'prompt-id',
    { '1': { class_type: 'Test', inputs: {} } },
    {
      create_time: 1780000000000,
      extra_pnginfo: { workflow: { id: 'qwen_image_2_1', name } },
    },
    ['9'],
  ],
  outputs: media(filename),
  status: { status_str: 'success', completed: true, messages: [] },
})

const objectEntry = {
  prompt: {
    extra_data: {
      extra_pnginfo: { workflow: { id: 'minimax_h3', name: 'MiniMax H3' } },
    },
  },
}

if (nameFromHistoryEntry(historyEntry('Qwen-Image-2.1 Edit', 'edit.png')) !== 'Qwen-Image-2.1 Edit') {
  throw new Error('tuple-form history workflow name was not parsed')
}
if (nameFromHistoryEntry(objectEntry) !== 'MiniMax H3') {
  throw new Error('object-form history workflow name was not parsed')
}
if (nameFromHistoryEntry({ prompt: [1, 'x', {}, {}, []] }) !== null) {
  throw new Error('missing workflow name should return null')
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-comfyui-history-name-'))
try {
  const store = new ComfyUIStore(dir, 200)
  await store.init()

  let persisted = { runs: [], archived: [] }
  const tracker = new QueueTracker({
    load: async () => persisted,
    save: async (state) => { persisted = structuredClone(state) },
  })
  await tracker.init()

  tracker.track({
    promptId: 'plugin-run',
    ts: '2026-09-25T00:00:00.000Z',
    workflowName: 'Saved Plugin Workflow',
    source: 'comfyui_workflow',
  })

  const histories = new Map([
    ['plugin-run', historyEntry('Metadata Should Not Override', 'plugin_00001_.png')],
    ['mcp-run', historyEntry('Qwen-Image-2.1 Edit', 'Qwen_Image_2_1_EDIT_00001_.png')],
  ])

  const client = {
    getHistory: async (id) => histories.get(id),
    getJobs: async () => ({
      jobs: [
        {
          id: 'plugin-run',
          status: 'completed',
          priority: 1,
          create_time: 1780000000000,
          outputs_count: 1,
          previewable_outputs_count: 1,
          workflow_id: 'saved-plugin-id',
        },
        {
          id: 'mcp-run',
          status: 'completed',
          priority: 2,
          create_time: 1780000001000,
          outputs_count: 1,
          previewable_outputs_count: 1,
          workflow_id: 'qwen_image_2_1',
        },
        {
          id: 'unnamed-manual-run',
          status: 'completed',
          priority: 3,
          create_time: 1780000002000,
          outputs_count: 1,
          previewable_outputs_count: 1,
          workflow_id: null,
        },
      ],
      pagination: { offset: 0, limit: 200, total: 3, has_more: false },
    }),
  }

  const first = await tracker.sweep({
    client,
    store,
    maxItems: 20,
    proxyBase: 'http://127.0.0.1:3080',
  })

  if (first.length !== 2) throw new Error(`expected two indexed runs, got ${first.length}`)
  const assets = await store.listAssets()
  const plugin = assets.find((asset) => asset.promptId === 'plugin-run')
  const mcp = assets.find((asset) => asset.promptId === 'mcp-run')
  if (plugin?.workflowName !== 'Saved Plugin Workflow') {
    throw new Error(`tracked plugin name regressed: ${plugin?.workflowName}`)
  }
  if (mcp?.workflowName !== 'Qwen-Image-2.1 Edit') {
    throw new Error(`external MCP metadata name missing: ${mcp?.workflowName}`)
  }
  if (assets.some((asset) => asset.promptId === 'unnamed-manual-run')) {
    throw new Error('unnamed manual job should not be auto-imported')
  }

  await store.deleteAsset('mcp-run')
  const second = await tracker.sweep({
    client,
    store,
    maxItems: 20,
    proxyBase: 'http://127.0.0.1:3080',
  })
  if (second.some((asset) => asset.promptId === 'mcp-run')) {
    throw new Error('archived external run was re-added after deletion')
  }

  console.log('PASS: ComfyUI history workflow names and external job sweep')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
