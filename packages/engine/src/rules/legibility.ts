/**
 * Hidden-state primitive helpers (Phase C). Pure functions that walk a dotted
 * fieldPath into an entity and read/mutate the wrapped value. NEVER expose
 * `actual` to the caller — only `getActualUnsafe` does, and that's an
 * engine-internal read intended for reveal_*.
 */
import { HiddenFieldSchema, isHiddenField, type HiddenField } from "../domain/legibility.js";

/** Walk a dotted path (`memo.disposition`) to the parent + last key. */
function walkParent(doc: any, path: string): { parent: any; key: string } | undefined {
  if (!doc || !path) return undefined;
  const parts = path.split(".");
  let cur: any = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  if (cur == null) return undefined;
  return { parent: cur, key: parts[parts.length - 1] };
}

/** Resolve the value at `path` (raw — may be a HiddenField wrapper or a literal). */
function rawAt(doc: any, path: string): unknown {
  const w = walkParent(doc, path);
  if (!w) return undefined;
  return w.parent[w.key];
}

/**
 * Promote a plain field at `fieldPath` into a HiddenField wrapper in-place.
 * If the field is already a wrapper, this is a no-op (idempotent).  If the
 * field doesn't exist yet, the wrapper is created with `actual = undefined`,
 * `apparent = null` (unknown).
 *
 * Returns the HiddenField for further mutation by the caller.
 */
export function markHidden(doc: any, fieldPath: string, opts: { concealment?: number; apparent?: unknown } = {}): HiddenField {
  const w = walkParent(doc, fieldPath);
  if (!w) throw new Error(`markHidden: cannot walk path "${fieldPath}" on entity`);
  const existing = w.parent[w.key];
  if (isHiddenField(existing)) return existing;

  const wrapper: HiddenField = HiddenFieldSchema.parse({
    actual: existing,
    apparent: opts.apparent ?? null,
    concealment: opts.concealment ?? 10,
    evidence: [],
    __hidden: true,
  });
  w.parent[w.key] = wrapper;
  return wrapper;
}

/** True if the field at `path` is wrapped as hidden. */
export function isHidden(doc: any, fieldPath: string): boolean {
  return isHiddenField(rawAt(doc, fieldPath));
}

/**
 * Public APPARENT read. Returns `{ value, knownState }`:
 *  - knownState = 'unknown' → `value` is `null` (engine answers UNKNOWN; no narration commit)
 *  - knownState = 'known'   → `value` is the apparent reading
 *  - knownState = 'plain'   → field is NOT wrapped; returns the literal value
 *
 * This is the canonical chokepoint; intent handlers MUST route through here
 * rather than reading `entity.field` directly when the field may be hidden.
 */
export function getApparent(doc: any, fieldPath: string): { value: unknown; knownState: "known" | "unknown" | "plain" } {
  const raw = rawAt(doc, fieldPath);
  if (!isHiddenField(raw)) return { value: raw, knownState: "plain" };
  if (raw.apparent === null || raw.apparent === undefined) return { value: null, knownState: "unknown" };
  return { value: raw.apparent, knownState: "known" };
}

/**
 * ENGINE-INTERNAL: read the actual (ground-truth) value. Never expose via an
 * intent return. Used only by reveal_* flows to copy actual → apparent.
 */
export function getActualUnsafe(doc: any, fieldPath: string): unknown {
  const raw = rawAt(doc, fieldPath);
  if (!isHiddenField(raw)) return raw;
  return raw.actual;
}

/** Set the apparent value (used by reveal_* and read commit). */
export function setApparent(doc: any, fieldPath: string, value: unknown): HiddenField {
  const w = walkParent(doc, fieldPath);
  if (!w) throw new Error(`setApparent: cannot walk path "${fieldPath}"`);
  const wrapper = w.parent[w.key];
  if (!isHiddenField(wrapper)) {
    throw new Error(`setApparent: field "${fieldPath}" is not a HiddenField (mark it first)`);
  }
  wrapper.apparent = value;
  wrapper.lastReadAs = value;
  return wrapper;
}

/** Mask: set apparent to null AND raise concealment by `bumpConcealment`. */
export function applyMask(doc: any, fieldPath: string, bumpConcealment = 5): HiddenField {
  const w = walkParent(doc, fieldPath);
  if (!w) throw new Error(`applyMask: cannot walk path "${fieldPath}"`);
  let wrapper = w.parent[w.key];
  if (!isHiddenField(wrapper)) {
    wrapper = markHidden(doc, fieldPath);
  }
  wrapper.apparent = null;
  wrapper.concealment = Math.max(0, (wrapper.concealment ?? 10) + bumpConcealment);
  return wrapper;
}

/**
 * Reveal: copy actual → apparent. If `partial` is true and actual is an
 * object, only the listed keys are revealed (the rest stay null/unknown).
 * If actual is null/undefined, apparent becomes null (still unknown).
 */
export function applyReveal(doc: any, fieldPath: string, partial?: string[]): HiddenField {
  const w = walkParent(doc, fieldPath);
  if (!w) throw new Error(`applyReveal: cannot walk path "${fieldPath}"`);
  let wrapper = w.parent[w.key];
  if (!isHiddenField(wrapper)) {
    wrapper = markHidden(doc, fieldPath);
  }
  if (partial && partial.length && wrapper.actual && typeof wrapper.actual === "object") {
    const merged: Record<string, unknown> =
      wrapper.apparent && typeof wrapper.apparent === "object" && wrapper.apparent !== null
        ? { ...(wrapper.apparent as Record<string, unknown>) }
        : {};
    for (const k of partial) {
      merged[k] = (wrapper.actual as Record<string, unknown>)[k];
    }
    wrapper.apparent = merged;
  } else {
    wrapper.apparent = wrapper.actual ?? null;
  }
  if (wrapper.apparent !== null && wrapper.apparent !== undefined) {
    wrapper.lastReadAs = wrapper.apparent;
  }
  return wrapper;
}

/**
 * Append an evidence record (audit trail). The caller decides the kind +
 * disposition; helpers above do not touch evidence so handlers control
 * narration.
 */
export function pushEvidence(
  wrapper: HiddenField,
  ev: {
    kind: "read" | "reveal" | "mask" | "mark";
    observerId?: string;
    apparent?: unknown;
    disposition?: "commit" | "unknown" | "no_op_spoken" | "reject_inert";
    note?: string;
    at?: number;
  },
): HiddenField {
  wrapper.evidence.push({
    kind: ev.kind,
    observerId: ev.observerId,
    apparent: ev.apparent,
    disposition: ev.disposition ?? "commit",
    note: ev.note,
    at: ev.at,
  });
  return wrapper;
}

/**
 * Resolve a target entity from `{ entityKind, entityId }`. Returns the live
 * document or undefined. Supported kinds: characters, npcs, adversaries,
 * corpses, stolen_items, missions, items. Future kinds are looked up by
 * collection name directly (the store accepts any name).
 */
export function lookupEntity(store: any, entityKind: string, entityId: string): any | undefined {
  if (!entityKind || !entityId) return undefined;
  const coll = store.collection(entityKind);
  return coll.get(entityId);
}

/** Persist the entity through its named collection. */
export function persistEntity(store: any, entityKind: string, entity: any): void {
  store.collection(entityKind).put(entity);
}
