/**
 * Offline check of the workflow preset transfer: export → analyze → import
 * round trip (parameters, skill packs with CJK file names and binary assets,
 * a bulk 150-file pack, empty directories, the requireSkill flag), the clash suffix, the traversal
 * guards, and the format/version refusals. Requires `npm run build` first —
 * it imports the compiled `lib/transfer.js`, like the other test scripts.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { analyzeImportPackage, applyImportPackage, buildExportPackage, PRESET_FORMAT } from '../lib/transfer.js'
import { createWorkflowSkillPacks } from '../lib/skillpack.js'

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Smallest valid PNG, for the binary round trip. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=',
  'base64',
)

const root = await mkdtemp(join(tmpdir(), 'dsc-transfer-'))

/** An in-memory TransferHost whose skill packs live in a real directory tree,
 * so import-side pack writes go through the actual pack store. */
function createHost() {
  const library = new Map()
  const packs = createWorkflowSkillPacks({
    skillsRoot: root,
    async getWorkflow(id) { return library.get(id) },
    async updateWorkflowSkill(id, patch) {
      const current = library.get(id)
      if (current === undefined) return undefined
      const next = { ...current }
      if (patch.skillDir === null) { delete next.skillDir; delete next.requireSkill }
      else if (patch.skillDir !== undefined) next.skillDir = patch.skillDir
      if (patch.requireSkill === true) next.requireSkill = true
      else if (patch.requireSkill === false) delete next.requireSkill
      library.set(id, next)
      return next
    },
  })
  return {
    library,
    skillPacks: packs,
    async listWorkflows() { return [...library.values()] },
    async getWorkflow(id) { return library.get(id) },
    async saveWorkflow(input) {
      const created = {
        id: randomUUID(),
        name: (input.name === '' ? 'unnamed-workflow' : input.name).slice(0, 80),
        description: input.description ?? '',
        workflow: input.workflow,
        parameters: Array.isArray(input.parameters) && input.parameters.length > 0 ? input.parameters : undefined,
        tags: input.tags,
        updatedAt: new Date().toISOString(),
      }
      library.set(created.id, created)
      return { ok: true, workflow: created }
    },
  }
}

console.log('seed')
const source = createHost()
const wfA = {
  id: 'a0000001-0000-0000-0000-000000000001',
  name: '文生图 · 基础',
  description: '最基本的文生图流程',
  workflow: {
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
  },
  parameters: [{ id: 'p1', name: 'prompt', label: '提示词', type: 'string', nodeId: '3', inputKey: 'text', default: '你好' }],
  tags: ['文生图'],
  updatedAt: new Date().toISOString(),
}
source.library.set(wfA.id, wfA)
const wfB = {
  id: 'b0000002-0000-0000-0000-000000000002',
  name: '图生视频 Wan',
  description: 'Wan 2.1 图生视频',
  workflow: { '9': { class_type: 'SaveAnimatedWEBP', inputs: { fps: 16 } } },
  parameters: [{ id: 'p2', name: 'frames', label: '帧数', type: 'number', nodeId: '9', inputKey: 'frame_count', default: 81 }],
  tags: ['图生视频'],
  updatedAt: new Date().toISOString(),
}
source.library.set(wfB.id, wfB)
const enabledB = await source.skillPacks.enable(wfB.id)
check('seed pack B', enabledB.ok === true, enabledB.ok ? '' : enabledB.error)
await source.skillPacks.writeFile(wfB.id, 'SKILL.md', '---\nsummary: 图生视频的用法\n---\n# 图生视频\n')
const REF_TEXT = '# 风格参考\n- 电影感构图（CJK 路径测试）'
await source.skillPacks.writeFile(wfB.id, 'references/风格.md', REF_TEXT)
await source.skillPacks.importFile(wfB.id, 'ref.png', PNG_1PX, 'assets')
await source.skillPacks.makeDir(wfB.id, 'templates')
await source.skillPacks.setRequired(wfB.id, true)

// A pack bulk-copied from the outside can far exceed any panel-era limit —
// a real music-template library lands at 1000+ small files, and the export →
// import round trip MUST carry it whole (the store's per-write file cap once
// failed such an import at file #101 while the workflow itself landed fine,
// which read as "import failed but skills exist").
const wfC = {
  id: 'c0000003-0000-0000-0000-000000000003',
  name: '音乐生成 minimax',
  description: '大技能包回归用例',
  workflow: { '5': { class_type: 'SaveAudio', inputs: {} } },
  parameters: [{ id: 'p3', name: 'lyrics', label: '歌词', type: 'string', nodeId: '5', inputKey: 'audio', default: '' }],
  tags: ['音乐'],
  updatedAt: new Date().toISOString(),
}
source.library.set(wfC.id, wfC)
const enabledC = await source.skillPacks.enable(wfC.id)
check('seed pack C', enabledC.ok === true, enabledC.ok ? '' : enabledC.error)
await source.skillPacks.writeFile(wfC.id, 'SKILL.md', '---\nsummary: 音乐模板库\n---\n# 音乐\n')
const BULK_FILES = 150
for (let i = 0; i < BULK_FILES; i++) {
  const write = await source.skillPacks.writeFile(wfC.id, `references/bulk-${String(i).padStart(4, '0')}.txt`, `模板 ${i}\n`)
  if (!write.ok) {
    check('seed bulk file write', false, write.error)
    break
  }
}

console.log('export')
const noIds = await buildExportPackage(source, [])
check('empty selection refused', noIds.ok === false, JSON.stringify(noIds))
const badIds = await buildExportPackage(source, 'nope')
check('non-array ids refused', badIds.ok === false)
const exported = await buildExportPackage(source, [wfA.id, wfB.id, wfC.id, 'missing-id'])
check('export succeeds', exported.ok === true, exported.ok ? '' : exported.error)
check('three workflows exported', exported.ok && exported.count === 3)
check('unknown id reported', exported.ok && exported.warnings.some((w) => w.includes('missing-id')))
check('ascii download name', exported.ok && /^dsh-comfyui-presets-\d{8}-\d{6}-\d{3}\.zip$/.test(exported.filename), exported.ok ? exported.filename : '')
const zipBytes = Buffer.from(exported.ok ? exported.bytes : [])
const listing = exported.ok ? Object.keys(unzipSync(new Uint8Array(zipBytes))) : []
check('manifest present', listing.includes('preset.json'), listing.join(','))
check('CJK pack file archived', listing.includes(`skills/${wfB.id}/references/风格.md`), listing.join(','))
check('binary asset archived', listing.includes(`skills/${wfB.id}/assets/ref.png`), listing.join(','))

console.log('analyze')
const garbage = analyzeImportPackage(Buffer.from('not a zip at all'))
check('non-zip refused', garbage.ok === false, JSON.stringify(garbage))
const noManifest = analyzeImportPackage(Buffer.from(zipSync({ 'readme.txt': strToU8('hi') })))
check('missing manifest refused', noManifest.ok === false)
const wrongFormat = analyzeImportPackage(Buffer.from(zipSync({
  'preset.json': strToU8(JSON.stringify({ format: 'other', version: 1, workflows: [] })),
})))
check('foreign format refused', wrongFormat.ok === false, JSON.stringify(wrongFormat))
const future = analyzeImportPackage(Buffer.from(zipSync({
  'preset.json': strToU8(JSON.stringify({ format: PRESET_FORMAT, version: 99, workflows: [] })),
})))
check('newer version refused with a hint', future.ok === false && (future.error ?? '').includes('升级'), JSON.stringify(future))
const analysis = analyzeImportPackage(zipBytes)
check('analyze succeeds', analysis.ok === true, analysis.ok ? '' : analysis.error)
check('three candidates', analysis.ok && analysis.analysis.workflows.length === 3)
const candC = analysis.ok ? analysis.analysis.workflows.find((c) => c.name === wfC.name) : undefined
check('bulk pack file count listed', candC !== undefined && candC.skill !== null && candC.skill.fileCount === BULK_FILES + 1, JSON.stringify(candC))
const candB = analysis.ok ? analysis.analysis.workflows.find((c) => c.name === wfB.name) : undefined
check('candidate carries index', analysis.ok && analysis.analysis.workflows[0]?.index === 0)
check('skill summary listed', candB !== undefined && candB.skill !== null && candB.skill.fileCount === 3, JSON.stringify(candB))
check('required flag listed', candB !== undefined && candB.skill?.required === true)
check('no warnings for a healthy package', candB !== undefined && candB.warnings.length === 0, JSON.stringify(candB?.warnings))
check('param count listed', candB !== undefined && candB.paramCount === 1)

console.log('import')
const fresh = createHost()
const applied = await applyImportPackage(fresh, zipBytes, [0, 1, 2])
check('apply succeeds', applied.ok === true, applied.ok ? '' : applied.error)
check('all three imported', applied.ok && applied.imported === 3)
const newA = applied.ok ? applied.results.find((r) => r.index === 0) : undefined
const newB = applied.ok ? applied.results.find((r) => r.index === 1) : undefined
check('names preserved (no clash)', newA !== undefined && newA.ok && newA.newName === wfA.name, JSON.stringify(newA))
check('fresh ids minted', newA !== undefined && newA.ok && newA.newId !== wfA.id)
const storedA = newA !== undefined && newA.ok ? fresh.library.get(newA.newId) : undefined
check('parameters carried over', storedA !== undefined && JSON.stringify(storedA.parameters) === JSON.stringify(wfA.parameters))
check('workflow JSON carried over', storedA !== undefined && JSON.stringify(storedA.workflow) === JSON.stringify(wfA.workflow))
check('tags carried over', storedA !== undefined && JSON.stringify(storedA.tags) === JSON.stringify(wfA.tags))
const packB = newB !== undefined && newB.ok ? await fresh.skillPacks.info(newB.newId) : undefined
check('pack mounted on import', packB !== undefined)
check('SKILL.md restored', packB !== undefined && packB.files.some((f) => f.path === 'SKILL.md'))
check('empty directory restored', packB !== undefined && packB.dirs.includes('templates'))
const refBack = newB !== undefined && newB.ok ? await fresh.skillPacks.readRaw(newB.newId, 'references/风格.md') : undefined
check('CJK file byte-identical', refBack !== undefined && refBack.ok && refBack.value.bytes.equals(Buffer.from(REF_TEXT, 'utf8')))
const pngBack = newB !== undefined && newB.ok ? await fresh.skillPacks.readRaw(newB.newId, 'assets/ref.png') : undefined
check('binary asset byte-identical', pngBack !== undefined && pngBack.ok && pngBack.value.bytes.equals(PNG_1PX))
const storedB = newB !== undefined && newB.ok ? fresh.library.get(newB.newId ?? '') : undefined
check('requireSkill restored', storedB !== undefined && storedB.requireSkill === true)
const newC = applied.ok ? applied.results.find((r) => r.index === 2) : undefined
check('bulk pack imports without warnings', newC !== undefined && newC.ok && newC.warnings.length === 0, JSON.stringify(newC))
const packC = newC !== undefined && newC.ok ? await fresh.skillPacks.info(newC.newId) : undefined
check('bulk pack complete after import', packC !== undefined && packC.files.length === BULK_FILES + 1, packC !== undefined ? String(packC.files.length) : 'no pack')
check('bulk pack last file readable', packC !== undefined && packC.files.some((f) => f.path === `references/bulk-${String(BULK_FILES - 1).padStart(4, '0')}.txt`))

console.log('clash + partial selection')
const again = await applyImportPackage(fresh, zipBytes, [0])
check('re-import succeeds', again.ok === true && again.imported === 1, JSON.stringify(again))
check('clash gets the（导入）suffix', again.ok && again.results[0]?.newName === `${wfA.name}（导入）`, again.ok ? again.results[0]?.newName : '')
const outOfRange = await applyImportPackage(fresh, zipBytes, [7])
check('out-of-range selection refused', outOfRange.ok === false, JSON.stringify(outOfRange))

console.log('hostile package')
const escapeNote = join(root, '..', 'escape.md')
const evil = {
  format: PRESET_FORMAT,
  version: 1,
  exportedAt: new Date().toISOString(),
  pluginVersion: 'test',
  count: 1,
  workflows: [{
    id: 'evil1',
    name: 'evil',
    description: '',
    tags: [],
    parameters: [],
    requireSkill: false,
    skill: { files: [{ path: '../escape.md', size: 1 }], dirs: [] },
    workflow: { '1': { class_type: 'NoOp', inputs: {} } },
  }],
}
const evilZip = Buffer.from(zipSync({
  'preset.json': strToU8(JSON.stringify(evil)),
  'skills/evil1/../escape.md': strToU8('x'),
}))
const evilAnalyze = analyzeImportPackage(evilZip)
check('traversal path flagged at analyze', evilAnalyze.ok && evilAnalyze.analysis.workflows[0]?.warnings.some((w) => w.includes('escape.md')), JSON.stringify(evilAnalyze))
const evilApply = await applyImportPackage(createHost(), evilZip, [0])
check('traversal file never written', (await stat(escapeNote).then(() => true).catch(() => false)) === false)
check('workflow still imports, pack refused', evilApply.ok && evilApply.imported === 1 && (evilApply.results[0]?.warnings ?? []).length > 0, JSON.stringify(evilApply))
const brokenWorkflow = {
  format: PRESET_FORMAT,
  version: 1,
  exportedAt: '',
  pluginVersion: 'test',
  count: 1,
  workflows: [{
    id: 'x1',
    name: 'broken',
    description: '',
    tags: [],
    parameters: [],
    requireSkill: false,
    skill: null,
    workflow: { '1': { inputs: {} } },
  }],
}
const brokenZip = Buffer.from(zipSync({ 'preset.json': strToU8(JSON.stringify(brokenWorkflow)) }))
const brokenAnalyze = analyzeImportPackage(brokenZip)
check('broken workflow flagged at analyze', brokenAnalyze.ok && brokenAnalyze.analysis.workflows[0]?.warnings.length === 1, JSON.stringify(brokenAnalyze))
const brokenApply = await applyImportPackage(createHost(), brokenZip, [0])
check('broken workflow refused at apply', brokenApply.ok && brokenApply.imported === 0 && brokenApply.results[0]?.ok === false, JSON.stringify(brokenApply))

await rm(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
