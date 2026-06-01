import { reject } from "@naruto5e/shared";
import type { ContentPack } from "../content.js";
import type { ResourceDef, ResourcePool } from "../domain/resource.js";

/**
 * Resource-pool chokepoint. All reads/writes to a named resource go through
 * here — no handler should poke `doc.chakra` directly except inside this file.
 *
 * Routing rule:
 *  - If the ResourceDef declares `poolField` (the Naruto chakra binding), the
 *    live pool lives at `doc[poolField]`.
 *  - Otherwise the pool lives at `doc.resources[id]`.
 *
 * Writes clamp `current` into `[0, max]`. An attempt to debit more than
 * available throws `resource_affordability_gate` with the legacy alias
 * `chakra_affordability` preserved for `id === "chakra"`.
 */

function ensureResourcesBag(doc: any): Record<string, any> {
  if (!doc.resources || typeof doc.resources !== "object") doc.resources = {};
  return doc.resources;
}

export function resolveResource(content: ContentPack, resourceId: string): ResourceDef {
  const def = content.getResource(resourceId);
  if (!def) {
    throw reject(
      "unknown_resource",
      `No resource "${resourceId}" registered in the content pack.`,
      { resourceId, known: content.listResources().map((r) => r.id) },
      ["Register the resource via content.addResource(...) or pick an existing id."],
    );
  }
  return def;
}

/** Read a pool view, attempting both the legacy `poolField` slot and `resources[id]`. */
export function readPool(doc: any, def: ResourceDef): ResourcePool {
  if (def.poolField && doc[def.poolField] && typeof doc[def.poolField] === "object") {
    return doc[def.poolField];
  }
  const bag = ensureResourcesBag(doc);
  const slot = bag[def.id];
  if (slot && typeof slot === "object" && typeof slot.current === "number") return slot as ResourcePool;
  // Synthesize an empty pool so callers never NPE; max=0 → any debit > 0 will reject.
  const empty: ResourcePool = { current: 0, max: 0, temp: 0 };
  bag[def.id] = empty;
  return empty;
}

/** Write a pool back. Clamps current to [0, max]. */
function writePool(doc: any, def: ResourceDef, pool: ResourcePool): void {
  pool.current = Math.max(0, Math.min(pool.max, Math.floor(pool.current)));
  if (def.poolField) {
    doc[def.poolField] = pool;
    return;
  }
  ensureResourcesBag(doc)[def.id] = pool;
}

export function debitPool(doc: any, content: ContentPack, resourceId: string, amount: number): { pool: ResourcePool; spent: number } {
  const def = resolveResource(content, resourceId);
  const pool = readPool(doc, def);
  const amt = Math.floor(amount);
  if (amt < 0) {
    throw reject(
      "resource_affordability_gate",
      `Cannot debit a negative amount of ${def.label || def.id}.`,
      { resource: def.id, requested: amt, legacyRule: def.id === "chakra" ? "chakra_affordability" : undefined },
      ["Use creditPool for a positive credit, not debitPool with a negative amount."],
    );
  }
  if (amt > pool.current) {
    // Legacy alias — handlers (notably jutsu_cast) keep emitting the legacy
    // rule string for `chakra`, but the generalized rule is what new code asserts.
    const legacy = def.id === "chakra" ? "chakra_affordability" : undefined;
    throw reject(
      "resource_affordability_gate",
      `${def.label || def.id} costs ${amt}; ${pool.current} available.`,
      { resource: def.id, required: amt, available: pool.current, shortfall: amt - pool.current, legacyRule: legacy },
      [`Reduce the cost (≤ ${pool.current} ${def.label || def.id}), or recover via rest.`],
    );
  }
  pool.current -= amt;
  writePool(doc, def, pool);
  return { pool, spent: amt };
}

export function creditPool(doc: any, content: ContentPack, resourceId: string, amount: number): { pool: ResourcePool; credited: number } {
  const def = resolveResource(content, resourceId);
  const pool = readPool(doc, def);
  const amt = Math.max(0, Math.floor(amount));
  const before = pool.current;
  pool.current = Math.min(pool.max, pool.current + amt);
  writePool(doc, def, pool);
  return { pool, credited: pool.current - before };
}

/** Set a pool to a specific shape (used by derivation + rest recovery). */
export function setPool(doc: any, def: ResourceDef, pool: ResourcePool): ResourcePool {
  writePool(doc, def, pool);
  return readPool(doc, def);
}
