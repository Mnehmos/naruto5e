/**
 * Phase B — active buff helpers.  Closes the silent-no-op bug for non-healing
 * utility/buff techniques by giving the engine an explicit place to land an
 * observable effect (AC bonus, temp HP, condition grant, advantage flag, aura,
 * generic mod bag).
 *
 * Contract:
 *  - `applyBuffDoc` is idempotent per (source, name): re-casting the same buff
 *    from the same caster REPLACES the prior entry rather than stacking.  This
 *    matches the concentration-replacement rule (regression bug_1780152079128)
 *    and gives content authors a predictable refresh semantic.
 *  - `tickBuffs` strips expired entries; returns the names removed so callers
 *    can emit `buff_expired` IR.
 *  - Pure mutation; IR emission is the caller's responsibility.
 */
export interface BuffEntry {
  source: string;
  name: string;
  kind: "generic" | "ac_bonus" | "temp_hp" | "condition_grant" | "advantage_flag" | "aura";
  mod: Record<string, number>;
  advantageOn: string[];
  conditionGranted?: string;
  aura?: { radius: number; shape?: string; grants: Record<string, number | string | boolean> };
  expiresOnRound?: number;
  rounds?: number;
  concentration: boolean;
}

export interface ApplyBuffResult {
  applied: BuffEntry;
  refreshed: boolean; // true when a same-(source,name) entry was replaced
}

/** Append (or refresh) a buff entry on a target doc.  Pure mutation. */
export function applyBuffDoc(doc: any, entry: BuffEntry): ApplyBuffResult {
  doc.activeBuffs = doc.activeBuffs ?? [];
  const idx = doc.activeBuffs.findIndex(
    (b: BuffEntry) => b.source === entry.source && b.name === entry.name,
  );
  let refreshed = false;
  if (idx >= 0) {
    doc.activeBuffs[idx] = entry;
    refreshed = true;
  } else {
    doc.activeBuffs.push(entry);
  }
  return { applied: entry, refreshed };
}

/** Strip any buffs whose duration has elapsed by `currentRound`.  Returns the
 *  stripped entries so the caller can emit `buff_expired` IR per. */
export function tickBuffs(doc: any, currentRound: number): BuffEntry[] {
  const buffs: BuffEntry[] = doc.activeBuffs ?? [];
  if (!buffs.length) return [];
  const kept: BuffEntry[] = [];
  const stripped: BuffEntry[] = [];
  for (const b of buffs) {
    if (typeof b.expiresOnRound === "number" && currentRound >= b.expiresOnRound) {
      stripped.push(b);
      continue;
    }
    kept.push(b);
  }
  doc.activeBuffs = kept;
  return stripped;
}

/** Sum every active buff's contribution to a single numeric mod key (e.g. "ac"). */
export function buffModTotal(doc: any, key: string): number {
  const buffs: BuffEntry[] = doc.activeBuffs ?? [];
  let total = 0;
  for (const b of buffs) {
    if (typeof b.mod?.[key] === "number") total += b.mod[key];
  }
  return total;
}

/** Does any active buff grant advantage on the given check tag? */
export function hasBuffAdvantage(doc: any, tag: string): boolean {
  const buffs: BuffEntry[] = doc.activeBuffs ?? [];
  const t = tag.toLowerCase();
  return buffs.some((b) => (b.advantageOn ?? []).some((x) => x.toLowerCase() === t));
}

/** Strip every buff sourced by `casterId` (used when concentration drops). */
export function stripBuffsBySource(doc: any, casterId: string): BuffEntry[] {
  const buffs: BuffEntry[] = doc.activeBuffs ?? [];
  if (!buffs.length) return [];
  const kept: BuffEntry[] = [];
  const stripped: BuffEntry[] = [];
  for (const b of buffs) {
    if (b.source === casterId && b.concentration) stripped.push(b);
    else kept.push(b);
  }
  doc.activeBuffs = kept;
  return stripped;
}
