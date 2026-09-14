/**
 * Workflow preset transfer: export library workflows (API format) together
 * with their parameters and skill packs into one .zip archive, and import
 * such an archive back as NEW workflows.
 *
 * Why a zip: skill packs carry binary assets, and a zip stores them as-is
 * (no base64 inflation) while keeping the pack layout 1:1 — importing a pack
 * is close to restoring a directory. `preset.json` alone carries everything
 * textual (workflows, parameters, skill file lists), so the panel can
 * analyze a package by reading one small entry before anything is written.
 *
 * Security posture: nothing inside the archive is trusted. Filesystem paths
 * are never taken from zip entry names — the pack root is re-derived from
 * the imported workflow's own slug (`skillSlug(newName, newId)`), and every
 * pack-relative path from preset.json re-passes `parseSkillPath` plus the
 * `writeBytes` containment/cap checks inside the pack store. Import always
 * creates new workflow records, so a hostile package cannot overwrite an
 * existing one; its worst outcome is junk that the user deletes.
 */
import { createRequire } from 'node:module'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Unzipped, Zippable } from 'fflate'
import type { WorkflowParameter } from './params.js'
import { validateWorkflow, type StoredWorkflow } from './store.js'
import { parseSkillPath, sizeLimitOf, SKILL_MAIN, type SkillPackResult, type WorkflowSkillPack } from './skillpack.js'

/** Marker plus layout version of the packages this module writes. */
export const PRESET_FORMAT = 'dsh-comfyui-workflow-preset'
export const PRESET_VERSION = 1

/** Manifest file name inside the archive. */
const MANIFEST_ENTRY = 'preset.json'
/** Zip prefix under which skill-pack files are archived, keyed by source id. */
const SKILL_PREFIX = 'skills/'
/** Hard cap on the uploaded archive (route-level check before parsing). */
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024
/** Decompression bombs: refuse single entries and totals beyond these. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
/** A package is a curated bundle, not a library dump. */
const MAX_PACKAGE_WORKFLOWS = 500

/** One workflow record inside preset.json. */
export interface PresetWorkflow {
  /** Id in the EXPORTING library; import mints a fresh one. */
  id: string
  name: string
  description: string
  tags?: string[]
  parameters?: WorkflowParameter[]
  requireSkill?: boolean
  /** Skill-pack contents; null when the workflow has no pack (or it was unreadable). */
  skill: PresetSkillRef | null
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
}

/** What the panel and tools need to know about one archived pack. */
export interface PresetSkillRef {
  files: Array<{ path: string; size: number }>
  /** Sub-directories, kept so empty ones survive the round trip. */
  dirs: string[]
}

/** The whole manifest. `count` mirrors `workflows.length` on export and is
 * recomputed (not trusted) on import. */
export interface PresetManifest {
  format: string
  version: number
  exportedAt: string
  pluginVersion: string
  count: number
  workflows: PresetWorkflow[]
}

/** Structural slice of the runtime the transfer routes operate through. */
export interface TransferHost {
  listWorkflows(): Promise<StoredWorkflow[]>
  getWorkflow(id: string): Promise<StoredWorkflow | undefined>
  saveWorkflow(input: {
    name: string
    description: string
    workflow: unknown
    parameters?: WorkflowParameter[]
    tags?: string[]
  }): Promise<{ ok: true; workflow: StoredWorkflow } | { ok: false; error: string }>
  skillPacks: {
    info(id: string): Promise<WorkflowSkillPack | undefined>
    readRaw(id: string, path: string): Promise<SkillPackResult<{ bytes: Buffer; contentType: string }>>
    enable(id: string): Promise<SkillPackResult<WorkflowSkillPack>>
    disable(id: string): Promise<SkillPackResult<true>>
    writeFile(id: string, path: string, content: string): Promise<SkillPackResult<WorkflowSkillPack>>
    importFile(id: string, file: string, bytes: Buffer, bucket?: string): Promise<SkillPackResult<{ path: string; pack: WorkflowSkillPack }>>
    importFiles(id: string, entries: ReadonlyArray<{ path: string; bytes: Buffer }>): Promise<SkillPackResult<WorkflowSkillPack>>
    makeDir(id: string, name: string): Promise<SkillPackResult<WorkflowSkillPack>>
    setRequired(id: string, required: boolean): Promise<SkillPackResult<WorkflowSkillPack>>
  }
}

export type ExportResult =
  | { ok: true; bytes: Uint8Array; filename: string; count: number; names: string[]; warnings: string[] }
  | { ok: false; error: string }

/** One listed workflow inside an analyzed package. */
export interface ImportCandidate {
  /** Position in the manifest; the apply call selects by this index, which
   * stays stable because the same bytes are parsed again. */
  index: number
  id: string
  name: string
  description: string
  tags: string[]
  paramCount: number
  skill: { fileCount: number; totalBytes: number; required: boolean } | null
  /** Non-fatal problems already visible at analysis time. */
  warnings: string[]
}

export interface ImportAnalysis {
  version: number
  exportedAt: string
  pluginVersion: string
  workflows: ImportCandidate[]
}

/** Per-workflow result of an import; `ok` entries carry their new identity. */
export interface ImportOutcome {
  index: number
  name: string
  ok: boolean
  newName?: string
  newId?: string
  error?: string
  warnings: string[]
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** Zip entry name for one archived pack file. */
function packEntry(sourceId: string, path: string): string {
  return `${SKILL_PREFIX}${sourceId}/${path}`
}

/** Local-time stamp for the download file name (ASCII on purpose: it goes
 * into a Content-Disposition header without RFC 5987 encoding). Milliseconds
 * are included so two exports within the same second never share a name —
 * download managers dedupe on file name too. */
function stamp(): string {
  const d = new Date()
  const p = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

/** The plugin's own version, recorded in the manifest for troubleshooting.
 * Resolved relative to this file so the published package works; anything
 * unusual just degrades to an empty string. */
function pluginVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

/** Inflate with memory guards: entries beyond the per-file cap are dropped
 * (and later reported as missing), and once the running total exceeds the
 * package cap nothing more is inflated. */
function unzipBounded(data: Uint8Array): Unzipped {
  let total = 0
  return unzipSync(data, {
    filter: (file) => {
      total += file.originalSize
      return file.originalSize <= MAX_ENTRY_BYTES && total <= MAX_TOTAL_BYTES
    },
  })
}

/**
 * Build one preset package from the selected library workflows.
 * @param host - the runtime face (workflow store + skill packs).
 * @param ids - workflow ids to export; unknown ids are skipped with a warning.
 */
export async function buildExportPackage(host: TransferHost, ids: unknown): Promise<ExportResult> {
  if (!Array.isArray(ids)) return fail('ids 必须是数组')
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (wanted.length === 0) return fail('请先选择要导出的工作流')
  const zip: Zippable = {}
  const exported: PresetWorkflow[] = []
  const warnings: string[] = []
  for (const id of wanted) {
    const stored = await host.getWorkflow(id)
    if (stored === undefined) {
      warnings.push(`工作流不存在，已跳过：${id}`)
      continue
    }
    const entry: PresetWorkflow = {
      id: stored.id,
      name: stored.name,
      description: stored.description,
      tags: stored.tags !== undefined && stored.tags.length > 0 ? [...stored.tags] : [],
      parameters: stored.parameters !== undefined && stored.parameters.length > 0 ? stored.parameters : [],
      requireSkill: stored.requireSkill === true,
      skill: null,
      workflow: stored.workflow,
    }
    if (stored.skillDir !== undefined && stored.skillDir !== '') {
      const pack = await host.skillPacks.info(stored.id)
      if (pack === undefined) {
        warnings.push(`技能包目录不可读，未随包导出：${stored.name}`)
      } else {
        const files: Array<{ path: string; size: number }> = []
        for (const file of pack.files) {
          const raw = await host.skillPacks.readRaw(stored.id, file.path)
          if (!raw.ok) {
            warnings.push(`技能包文件读取失败，已跳过：${stored.name} / ${file.path}`)
            continue
          }
          zip[packEntry(stored.id, file.path)] = Uint8Array.from(raw.value.bytes)
          files.push({ path: file.path, size: file.size })
        }
        if (files.length > 0) {
          entry.skill = { files, dirs: [...pack.dirs] }
        } else {
          warnings.push(`技能包没有可读取的文件，未随包导出：${stored.name}`)
        }
      }
    }
    exported.push(entry)
  }
  if (exported.length === 0) return fail(warnings.length > 0 ? warnings.join('；') : '没有可导出的工作流')
  const manifest: PresetManifest = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    exportedAt: new Date().toISOString(),
    pluginVersion: pluginVersion(),
    count: exported.length,
    workflows: exported,
  }
  zip[MANIFEST_ENTRY] = strToU8(JSON.stringify(manifest, null, 2))
  const bytes = zipSync(zip)
  return {
    ok: true,
    bytes,
    filename: `dsh-comfyui-presets-${stamp()}.zip`,
    count: exported.length,
    names: exported.map((entry) => entry.name),
    warnings,
  }
}

/** Structural check of preset.json; returns the normalized manifest or why it was refused. */
function parseManifest(value: unknown): PresetManifest | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'preset.json 结构不正确'
  const raw = value as Record<string, unknown>
  if (raw.format !== PRESET_FORMAT) return '这不是 dsh-comfyui 工作流预设包'
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return '预设包版本号不正确'
  if (version > PRESET_VERSION) return `预设包版本过新（v${version}），请升级插件后再导入`
  const workflowsRaw = raw.workflows
  if (!Array.isArray(workflowsRaw)) return '预设包里没有工作流清单'
  if (workflowsRaw.length > MAX_PACKAGE_WORKFLOWS) return `预设包包含的工作流过多（上限 ${MAX_PACKAGE_WORKFLOWS} 个）`
  const workflows: PresetWorkflow[] = []
  for (const item of workflowsRaw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const w = item as Record<string, unknown>
    if (typeof w.id !== 'string' || w.id === '') continue
    if (typeof w.name !== 'string' || w.name === '') continue
    if (typeof w.workflow !== 'object' || w.workflow === null || Array.isArray(w.workflow)) continue
    workflows.push({
      id: w.id,
      name: w.name,
      description: typeof w.description === 'string' ? w.description : '',
      tags: Array.isArray(w.tags) ? w.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      parameters: Array.isArray(w.parameters) ? (w.parameters as WorkflowParameter[]) : [],
      requireSkill: w.requireSkill === true,
      skill: parseSkillRef(w.skill),
      workflow: w.workflow as PresetWorkflow['workflow'],
    })
  }
  if (workflows.length === 0) return '预设包里没有结构完整的工作流'
  return {
    format: PRESET_FORMAT,
    version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    pluginVersion: typeof raw.pluginVersion === 'string' ? raw.pluginVersion : '',
    count: workflows.length,
    workflows,
  }
}

function parseSkillRef(value: unknown): PresetSkillRef | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const filesRaw = raw.files
  if (!Array.isArray(filesRaw)) return null
  const files: Array<{ path: string; size: number }> = []
  for (const item of filesRaw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const f = item as Record<string, unknown>
    if (typeof f.path !== 'string' || f.path === '') continue
    files.push({ path: f.path, size: typeof f.size === 'number' ? f.size : 0 })
  }
  const dirs = Array.isArray(raw.dirs)
    ? raw.dirs.filter((dir): dir is string => typeof dir === 'string' && dir !== '')
    : []
  return files.length > 0 || dirs.length > 0 ? { files, dirs } : null
}

/** Parse and validate one uploaded archive without touching the disk. */
function readPackage(bytes: Buffer): { ok: true; manifest: PresetManifest; files: Unzipped } | { ok: false; error: string } {
  if (bytes.length === 0) return fail('上传内容为空')
  let files: Unzipped
  try {
    files = unzipBounded(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  } catch (error) {
    return fail(`无法读取预设包：${error instanceof Error ? error.message : String(error)}`)
  }
  const raw = files[MANIFEST_ENTRY]
  if (raw === undefined) return fail(`预设包缺少 ${MANIFEST_ENTRY}，不是有效的预设包`)
  let manifest: unknown
  try {
    manifest = JSON.parse(strFromU8(raw))
  } catch {
    return fail(`${MANIFEST_ENTRY} 不是有效的 JSON`)
  }
  const parsed = parseManifest(manifest)
  return typeof parsed === 'string' ? fail(parsed) : { ok: true, manifest: parsed, files }
}

/**
 * Analyze one uploaded package: list the workflows it offers, with per-item
 * warnings for anything that would fail at apply time. No disk writes.
 */
export function analyzeImportPackage(bytes: Buffer): { ok: true; analysis: ImportAnalysis } | { ok: false; error: string } {
  const read = readPackage(bytes)
  if (!read.ok) return read
  const { manifest, files } = read
  const workflows = manifest.workflows.map((entry, index): ImportCandidate => {
    const warnings: string[] = []
    const problem = validateWorkflow(entry.workflow)
    if (problem !== undefined) warnings.push(problem)
    let skill: ImportCandidate['skill'] = null
    if (entry.skill !== null) {
      for (const file of entry.skill.files) {
        // Flag the grammar problem at analyze time (visible before anything
        // is written); apply re-checks and skips the same paths regardless.
        if (parseSkillPath(file.path).ok === false) warnings.push(`技能包路径不合法：${file.path}`)
        else if (files[packEntry(entry.id, file.path)] === undefined) warnings.push(`包内缺少技能包文件：${file.path}`)
      }
      skill = {
        fileCount: entry.skill.files.length,
        totalBytes: entry.skill.files.reduce((sum, file) => sum + file.size, 0),
        required: entry.requireSkill === true,
      }
    }
    return {
      index,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      tags: entry.tags ?? [],
      paramCount: (entry.parameters ?? []).length,
      skill,
      warnings,
    }
  })
  return {
    ok: true,
    analysis: {
      version: manifest.version,
      exportedAt: manifest.exportedAt,
      pluginVersion: manifest.pluginVersion,
      workflows,
    },
  }
}

/** Light shape check on parameters: a malformed entry is dropped, a valid one
 * passes through untouched so future fields survive the round trip. */
function sanitizeParameters(value: unknown): WorkflowParameter[] {
  if (!Array.isArray(value)) return []
  const out: WorkflowParameter[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const valid =
      typeof raw.id === 'string' && raw.id !== '' &&
      typeof raw.name === 'string' && raw.name !== '' &&
      (raw.type === 'string' || raw.type === 'number' || raw.type === 'boolean') &&
      typeof raw.nodeId === 'string' && raw.nodeId !== '' &&
      typeof raw.inputKey === 'string' && raw.inputKey !== '' &&
      (typeof raw.default === 'string' || typeof raw.default === 'number' || typeof raw.default === 'boolean')
    if (valid) out.push(item as WorkflowParameter)
  }
  return out
}

/** First free variant of a name; the importer never overwrites, so a clash
 * just mints the next suffix. The set also tracks names minted during this
 * run, so two same-named entries in one package cannot collide either. */
function uniqueName(used: Set<string>, base: string): string {
  const clean = base.trim() === '' ? 'unnamed-workflow' : base.trim()
  if (!used.has(clean)) {
    used.add(clean)
    return clean
  }
  const marked = `${clean}（导入）`
  if (!used.has(marked)) {
    used.add(marked)
    return marked
  }
  for (let i = 2; ; i++) {
    const candidate = `${clean}（导入 ${i}）`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

/** Restore one archived skill pack under the freshly created workflow. Files
 * go through the same pack-store paths as a manual edit (grammar, extension
 * whitelist, size caps), so an out-of-spec package fails per file with a
 * reason instead of poisoning the pack. */
async function importSkillPack(
  host: TransferHost,
  newId: string,
  sourceId: string,
  skill: PresetSkillRef,
  required: boolean,
  files: Unzipped,
  warnings: string[],
): Promise<void> {
  const enabled = await host.skillPacks.enable(newId)
  if (!enabled.ok) {
    warnings.push(`技能包挂载失败：${enabled.error}`)
    return
  }
  // One batched write for the whole pack: the store checks its limits once
  // and enumerates the directory twice (before/after) instead of per file —
  // a 1000-file pack under per-file checks was minutes of filesystem churn
  // and read as a frozen import. Oversized or ungrammatical entries are
  // skipped here with a warning, so one bad file never sinks the batch.
  const entries: Array<{ path: string; bytes: Buffer }> = []
  for (const file of skill.files) {
    const parsed = parseSkillPath(file.path)
    if (!parsed.ok) {
      warnings.push(`技能包路径不合法，已跳过：${file.path}`)
      continue
    }
    const entry = files[packEntry(sourceId, file.path)]
    if (entry === undefined) {
      warnings.push(`包内缺少技能包文件：${file.path}`)
      continue
    }
    const bytes = Buffer.from(entry)
    if (bytes.length > sizeLimitOf(parsed.value.file)) {
      warnings.push(`技能包文件超过大小上限，已跳过：${file.path}（${Math.ceil(bytes.length / 1024)} KB）`)
      continue
    }
    entries.push({ path: file.path, bytes })
  }
  if (entries.length === 0) {
    await host.skillPacks.disable(newId)
    warnings.push('技能包没有一个文件写入成功，已放弃挂载')
    return
  }
  const written = await host.skillPacks.importFiles(newId, entries)
  if (!written.ok) {
    await host.skillPacks.disable(newId)
    warnings.push(`技能包还原失败，已放弃挂载：${written.error}`)
    return
  }
  for (const dir of skill.dirs) {
    const made = await host.skillPacks.makeDir(newId, dir)
    if (!made.ok) warnings.push(`技能包子目录创建失败：${dir}`)
  }
  if (required) {
    const gate = await host.skillPacks.setRequired(newId, true)
    if (!gate.ok) warnings.push(`必读标记设置失败：${gate.error}`)
  }
  // One limit tripping on every remaining file reads as an error wall that
  // buries the row and the user's trust with it — keep the first few and
  // summarize the rest. The full list still lands in the host log.
  if (warnings.length > 12) {
    const dropped = warnings.length - 12
    warnings.length = 12
    warnings.push(`……其余 ${dropped} 条警告已省略`)
  }
}

/**
 * Import the selected workflows from one uploaded package. Every workflow
 * becomes a NEW library record (fresh id, name suffixed on clash); skill
 * packs land in freshly slugged directories, so nothing on disk is reused
 * or overwritten.
 * @param selected - manifest indexes to import (as listed by analyze).
 */
export async function applyImportPackage(
  host: TransferHost,
  bytes: Buffer,
  selected: unknown,
): Promise<{ ok: true; results: ImportOutcome[]; imported: number } | { ok: false; error: string }> {
  const read = readPackage(bytes)
  if (!read.ok) return read
  const { manifest, files } = read
  if (!Array.isArray(selected)) return fail('请先选择要导入的工作流')
  const wanted = [...new Set(selected.filter((index): index is number =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < manifest.workflows.length))]
  if (wanted.length === 0) return fail('请先选择要导入的工作流')
  const usedNames = new Set((await host.listWorkflows()).map((workflow) => workflow.name))
  const results: ImportOutcome[] = []
  let imported = 0
  for (const index of wanted) {
    const entry = manifest.workflows[index]!
    const outcome: ImportOutcome = { index, name: entry.name, ok: false, warnings: [] }
    const problem = validateWorkflow(entry.workflow)
    if (problem !== undefined) {
      outcome.error = problem
      results.push(outcome)
      continue
    }
    const saved = await host.saveWorkflow({
      name: uniqueName(usedNames, entry.name),
      description: entry.description,
      workflow: entry.workflow,
      parameters: sanitizeParameters(entry.parameters),
      tags: entry.tags,
    })
    if (!saved.ok) {
      outcome.error = saved.error
      results.push(outcome)
      continue
    }
    outcome.ok = true
    outcome.newName = saved.workflow.name
    outcome.newId = saved.workflow.id
    imported++
    if (entry.skill !== null) {
      await importSkillPack(host, saved.workflow.id, entry.id, entry.skill, entry.requireSkill === true, files, outcome.warnings)
    }
    results.push(outcome)
  }
  return { ok: true, results, imported }
}
