/**
 * The empirical jutsu point-cost model (reverse-engineered from the catalog;
 * the point unit is 1 chakra). A jutsu's RANK sets its point budget; effects are
 * bought from a priced menu calibrated so a built jutsu lands in the same power
 * band as canon. A governor, not a hard cap (green / yellow / red).
 *
 *   budget = {E:2,D:4,C:8,B:14,A:19,S:28}
 *   spend  = Σ(dice × per-die) + range×0.04 + areaDim×0.107 + 0.4×conditionTiers
 *            − 10% (if concentration);  E/D apply a low-rank floor discount.
 *   per-die: d4 1.0, d6 1.3, d8 1.7, d10 2.1, d12 2.5  (~2.6 avg dmg/chakra)
 */
export type Rank = "E" | "D" | "C" | "B" | "A" | "S";

export const RANK_BUDGET: Record<Rank, number> = { E: 2, D: 4, C: 8, B: 14, A: 19, S: 28 };
export const PER_DIE: Record<number, number> = { 4: 1.0, 6: 1.3, 8: 1.7, 10: 2.1, 12: 2.5 };
const RANK_SEQ: Rank[] = ["E", "D", "C", "B", "A", "S"];

export interface PriceInput {
  damage?: string; // "Xdy"
  range?: number; // feet (single-target reach / line length)
  area?: { size: number; shape?: string }; // AoE dimension in feet
  conditionTiers?: number; // # of conditions imposed
  concentration?: boolean;
  /** delivery hint: save/attack are ~cost-neutral; area is the premium. */
  save?: string;
}

export interface PriceResult {
  spend: number;
  breakdown: { damage: number; range: number; area: number; conditions: number; concentrationRebate: number; floorDiscount: number };
}

export function priceDamage(dice?: string): number {
  if (!dice) return 0;
  const m = dice.match(/^(\d+)d(\d+)$/);
  if (!m) return 0;
  const count = Number(m[1]);
  const per = PER_DIE[Number(m[2])] ?? 1.3;
  return count * per;
}

export function priceEffects(rank: Rank, input: PriceInput): PriceResult {
  const damage = priceDamage(input.damage);
  const range = (input.range ?? 0) * 0.04;
  const area = (input.area?.size ?? 0) * 0.107;
  const conditions = (input.conditionTiers ?? 0) * 0.4;
  let spend = damage + range + area + conditions;
  const concentrationRebate = input.concentration ? -spend * 0.1 : 0;
  spend += concentrationRebate;
  // low-rank floor adjustment (the model runs high at E/D)
  const floorDiscount = rank === "D" ? -2 : rank === "E" ? -1 : 0;
  spend = Math.max(0, spend + floorDiscount);
  return { spend, breakdown: { damage, range, area, conditions, concentrationRebate, floorDiscount } };
}

export type Verdict = "green" | "yellow" | "red";

export function verdict(rank: Rank, spend: number): { verdict: Verdict; budget: number; note: string } {
  const budget = RANK_BUDGET[rank];
  const nextRank = RANK_SEQ[RANK_SEQ.indexOf(rank) + 1];
  const nextBudget = nextRank ? RANK_BUDGET[nextRank] : Math.round(budget * 1.5);
  let v: Verdict;
  let note: string;
  if (spend <= budget + 0.5) {
    v = "green";
    note = `in band (${spend.toFixed(1)} ≤ budget ${budget}).`;
  } else if (spend <= nextBudget) {
    v = "yellow";
    note = `~1 band hot (${spend.toFixed(1)} vs budget ${budget}); trim dice/area/range to land green.`;
  } else {
    v = "red";
    note = `over budget (${spend.toFixed(1)} vs budget ${budget}); reduce the effect or raise the rank.`;
  }
  return { verdict: v, budget, note };
}
