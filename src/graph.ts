/**
 * ComfyUI UI-graph link normalization. The frontend changed how saved graphs
 * serialize the `links` array: rows used to be positional
 * (`[id, originId, originSlot, targetId, targetSlot, type]`), while the v0.4
 * frontend writes object entries
 * (`{ id, origin_id, origin_slot, target_id, target_slot, type }`). Analysis
 * and conversion both want one canonical shape, so both go through
 * {@link normalizeLinks} before touching a graph.
 */

/** Canonical link row: [linkId, originId, originSlot, targetId, targetSlot, type]. */
export type GraphLink = [number, number, number, number, number, string]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize one link entry; undefined when the entry is not a readable link. */
export function normalizeLink(raw: unknown): GraphLink | undefined {
  if (Array.isArray(raw)) {
    if (raw.length < 6) return undefined
    const [id, origin, originSlot, target, targetSlot, type] = raw as unknown[]
    if (
      typeof id !== 'number' || typeof origin !== 'number' ||
      typeof originSlot !== 'number' || typeof target !== 'number' ||
      typeof targetSlot !== 'number'
    ) {
      return undefined
    }
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : '']
  }
  if (isObject(raw)) {
    const { id, origin_id: origin, origin_slot: originSlot, target_id: target, target_slot: targetSlot, type } = raw
    if (
      typeof id !== 'number' || typeof origin !== 'number' ||
      typeof originSlot !== 'number' || typeof target !== 'number' ||
      typeof targetSlot !== 'number'
    ) {
      return undefined
    }
    return [id, origin, originSlot, target, targetSlot, typeof type === 'string' ? type : '']
  }
  return undefined
}

/** Normalize a whole `links` array, skipping entries that are not readable. */
export function normalizeLinks(raw: unknown): GraphLink[] {
  if (!Array.isArray(raw)) return []
  const links: GraphLink[] = []
  for (const entry of raw) {
    const link = normalizeLink(entry)
    if (link !== undefined) links.push(link)
  }
  return links
}
