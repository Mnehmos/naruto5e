/**
 * Combat resolution rules (Ch.8) + the two source-grounded resolver modules:
 *  - elemental_advantage_resolve: Fire > Wind > Lightning > Earth > Water > Fire.
 *  - clash_resolve: opposed contest = casting-ability mod + rank value + d20.
 */
import { rollD20, rollExpression, type Rng } from "@naruto5e/shared";

export const RANK_VALUE: Record<string, number> = { E: 0, D: 1, C: 2, B: 3, A: 4, S: 5 };

/** superiority cycle: key beats value. */
const BEATS: Record<string, string> = {
  Fire: "Wind",
  Wind: "Lightning",
  Lightning: "Earth",
  Earth: "Water",
  Water: "Fire",
};

const ELEMENT_KEYWORDS = ["Fire", "Water", "Wind", "Earth", "Lightning", "Ice"];

/** Pull the element keyword from a jutsu (keywords first, then name/description). */
export function jutsuElement(jutsu: any): string | undefined {
  const hay = `${(jutsu.keywords ?? []).join(" ")} ${jutsu.name ?? ""} ${jutsu.description ?? ""}`;
  for (const el of ELEMENT_KEYWORDS) if (new RegExp(`\\b${el}\\b`, "i").test(hay)) return el;
  // Ice resolves as Water for the advantage cycle
  return undefined;
}

function cycleElement(el: string | undefined): string | undefined {
  if (!el) return undefined;
  return el === "Ice" ? "Water" : el;
}

export type ElementalEdge = "attacker" | "defender" | "neutral";

export function elementalAdvantage(attackerEl?: string, defenderEl?: string): ElementalEdge {
  const a = cycleElement(attackerEl);
  const d = cycleElement(defenderEl);
  if (!a || !d) return "neutral";
  if (BEATS[a] === d) return "attacker";
  if (BEATS[d] === a) return "defender";
  return "neutral";
}

export interface ClashResult {
  winner: "a" | "b" | "tie";
  aTotal: number;
  bTotal: number;
  aRoll: number;
  bRoll: number;
  close: boolean; // within 3
}

/**
 * clash_resolve (Decided policy): opposed check = casting mod + rank value + d20.
 * Higher wins; loser's effect negated (or halved on a close call within 3). Ties
 * -> both partially resolve (half). Elemental advantage grants advantage on the
 * clash check to the superior side.
 */
export function clashResolve(
  rng: Rng,
  a: { castingMod: number; rank: string; element?: string },
  b: { castingMod: number; rank: string; element?: string },
): ClashResult {
  const edge = elementalAdvantage(a.element, b.element);
  const aRoll = rollD20(rng, { advantage: edge === "attacker", disadvantage: edge === "defender" }).natural;
  const bRoll = rollD20(rng, { advantage: edge === "defender", disadvantage: edge === "attacker" }).natural;
  const aTotal = aRoll + a.castingMod + (RANK_VALUE[a.rank] ?? 0);
  const bTotal = bRoll + b.castingMod + (RANK_VALUE[b.rank] ?? 0);
  const diff = Math.abs(aTotal - bTotal);
  const winner = aTotal === bTotal ? "tie" : aTotal > bTotal ? "a" : "b";
  return { winner, aTotal, bTotal, aRoll, bRoll, close: diff <= 3 };
}

/** Roll damage; on a crit, double the dice (not the modifier) per 5e. */
export function rollDamage(rng: Rng, dice: string, crit = false): { total: number; rolls: number[] } {
  const r = rollExpression(rng, dice);
  if (!crit || r.rolls.length === 0) return { total: r.total, rolls: r.rolls };
  const extra = rollExpression(rng, dice);
  return { total: r.total + extra.rolls.reduce((a, b) => a + b, 0), rolls: [...r.rolls, ...extra.rolls] };
}
