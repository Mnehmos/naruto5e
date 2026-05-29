/**
 * Standing helpers — the shared spine the four world-consequence systems
 * (npc/economy/theft/corpse) route their deltas through (Phase 7).
 */
import { StandingLedgerSchema, type StandingLedger } from "../domain/standing.js";
import type { Store } from "../store/types.js";

function ledgerId(charId: string, authorityId: string): string {
  return `${charId}:${authorityId}`;
}

export function getLedger(store: Store, charId: string, authorityId: string): StandingLedger | undefined {
  return store.collection<StandingLedger>("standings").get(ledgerId(charId, authorityId));
}

export function ensureLedger(
  store: Store,
  charId: string,
  authorityId: string,
  authorityType: StandingLedger["authorityType"] = "village",
): StandingLedger {
  const coll = store.collection<StandingLedger>("standings");
  let l = coll.get(ledgerId(charId, authorityId));
  if (!l) {
    l = StandingLedgerSchema.parse({ id: ledgerId(charId, authorityId), charId, authorityId, authorityType });
    coll.put(l);
  }
  return l;
}

export interface StandingDelta {
  reputation?: number;
  favor?: number;
  authorityType?: StandingLedger["authorityType"];
  reason?: string;
}

/**
 * Apply a Standing delta (the connective tissue). Favor is clamped to favorCap;
 * crossing into negative reputation flags hostility. Returns the updated ledger.
 */
export function applyStandingDelta(store: Store, charId: string, authorityId: string, delta: StandingDelta): StandingLedger {
  const coll = store.collection<StandingLedger>("standings");
  const l = ensureLedger(store, charId, authorityId, delta.authorityType);
  if (delta.reputation) l.reputation += delta.reputation;
  if (delta.favor) l.favor = Math.max(0, Math.min(l.favorCap, l.favor + delta.favor));
  if (l.reputation < 0) l.hostile = true;
  if (l.reputation >= 0 && delta.reputation && delta.reputation > 0) l.hostile = false;
  coll.put(l);
  return l;
}

export function getLedgersFor(store: Store, charId: string): StandingLedger[] {
  return store.collection<StandingLedger>("standings").find((l) => l.charId === charId);
}
