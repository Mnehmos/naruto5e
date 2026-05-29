/**
 * Ch.14 adversary engine — tier baselines (L1–30) + Minion/Elite/Solo modifiers.
 *
 * Baseline anchors are the VERIFIED points from the source table (p341):
 *   L1  AC11 prof3 HP8  atk5  ; L10 AC13 prof6 HP53 atk30 ;
 *   L20 AC14 prof9 HP103 atk58 ; L30 AC16 prof12 HP153 atk90.
 * HP is the clean closed form 8 + 5·(L−1) (matches all four anchors exactly);
 * AC/prof/attack are piecewise-linearly interpolated between the anchors so the
 * confirmed values are exact and the in-between is smooth/monotonic. Chakra,
 * damage/round, and ability mods are rules-faithful scalings (flagged).
 */
export type Tier = "minion" | "elite" | "solo";

function interp(level: number, pts: [number, number][]): number {
  const L = level;
  if (L <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    if (L <= x1) return Math.round(y0 + ((y1 - y0) * (L - x0)) / (x1 - x0));
  }
  // extrapolate from the last segment
  const [x0, y0] = pts[pts.length - 2];
  const [x1, y1] = pts[pts.length - 1];
  return Math.round(y1 + ((y1 - y0) * (L - x1)) / (x1 - x0));
}

const AC_PTS: [number, number][] = [[1, 11], [10, 13], [20, 14], [30, 16]];
const PROF_PTS: [number, number][] = [[1, 3], [10, 6], [20, 9], [30, 12]];
const ATK_PTS: [number, number][] = [[1, 5], [10, 30], [20, 58], [30, 90]];

export interface AdversaryBaseline {
  ac: number;
  proficiencyBonus: number;
  hp: number;
  chakra: number;
  attack: number; // primary attack bonus (freeform)
  damage: number; // damage/round budget
  abilityMods: Record<string, number>;
}

export function adversaryBaseline(level: number): AdversaryBaseline {
  const L = Math.max(1, Math.min(30, level));
  const prof = interp(L, PROF_PTS);
  const primary = Math.round(L / 3); // scales save/skill mods with level
  const minor = Math.round(L / 6);
  return {
    ac: interp(L, AC_PTS),
    proficiencyBonus: prof,
    hp: 8 + 5 * (L - 1),
    chakra: 8 + 4 * (L - 1),
    attack: interp(L, ATK_PTS),
    damage: 4 + 3 * L,
    abilityMods: { str: primary, dex: minor, con: primary, int: minor, wis: minor, cha: minor },
  };
}

export interface TierMods {
  ac: number;
  hpMul: number;
  chakraMul: number;
  save: number;
  init: number;
  attack: number;
  damageMul: number;
  dc: number;
  xpMul: number;
}

/** Exact tier modifiers from the source. Solo HP/Chakra scale by party size. */
export function tierMods(tier: Tier, partySize = 4): TierMods {
  switch (tier) {
    case "minion":
      return { ac: -2, hpMul: 0, chakraMul: 1, save: -2, init: -2, attack: -2, damageMul: 0.2, dc: -3, xpMul: 0.25 };
    case "elite":
      return { ac: 2, hpMul: 1.5, chakraMul: 1.5, save: 1, init: 0, attack: 1, damageMul: 1.1, dc: 1, xpMul: 2 };
    case "solo":
      return { ac: 4, hpMul: Math.max(1, partySize), chakraMul: Math.max(1, partySize), save: 2, init: 0, attack: 2, damageMul: 1.2, dc: 3, xpMul: 4 };
  }
}

/** Jutsu-rank cap by tier (prevents burst one-shots). */
export function jutsuRankCap(tier: Tier): "D" | "B" | "S" {
  return tier === "minion" ? "D" : tier === "elite" ? "B" : "S";
}

const RANK_ORDER = ["E", "D", "C", "B", "A", "S"];
export function rankWithinCap(rank: string, cap: string): boolean {
  return RANK_ORDER.indexOf(rank) <= RANK_ORDER.indexOf(cap);
}

/**
 * Legendary Resistance (Solo): on a failed save, auto-succeed and burn a use.
 * Mutates the doc; returns true if a resistance was spent.
 */
export function useLegendaryResistance(doc: any): boolean {
  if (doc?.legendary?.resistance > 0) {
    doc.legendary.resistance -= 1;
    return true;
  }
  return false;
}

/**
 * Phase Transition (Solo): when HP crosses 60% or 30% of max, advance a phase
 * (clears conditions, signals a new phase). Returns the crossed threshold or null.
 */
export function checkPhaseTransition(doc: any): 60 | 30 | null {
  if (!doc?.phases) return null;
  const pct = (doc.hp.current / doc.hp.max) * 100;
  const crossed = doc.phases.crossed ?? [];
  for (const t of [60, 30] as const) {
    if (pct <= t && !crossed.includes(t)) {
      crossed.push(t);
      doc.phases.crossed = crossed;
      doc.phases.current = (doc.phases.current ?? 1) + 1;
      doc.conditions = []; // a new phase clears lingering effects
      return t;
    }
  }
  return null;
}
