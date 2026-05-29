/**
 * Ability-score math (Ch.1, Ch.6) — pure, deterministic.
 * Confirmed system facts: proficiency bonus is +3 at level 1; power tiers by
 * level band (Genin 1-4 / Chunin 5-8 / Junin 9-12 / Kage 13-15 / Legendary
 * 16-20).
 */
import { rollDice, type Rng } from "@naruto5e/shared";
import type { Ability } from "./skills.js";

export type AbilityScores = Record<Ability, number>;

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Proficiency bonus. Confirmed: +3 at L1 (a divergence from vanilla 5e's +2).
 * The book firmly anchors only L1=+3; we scale +1 every 4 levels, mirroring 5e's
 * cadence shifted up by one, aligned to the power-tier bands. (Logged in
 * BUILD_LOG; adversaries use their own table in Ch.14.)
 *  L1-4 = 3, L5-8 = 4, L9-12 = 5, L13-16 = 6, L17-20 = 7.
 */
export function proficiencyBonus(level: number): number {
  return 3 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4);
}

export type Rank = "Academy" | "Genin" | "Chunin" | "Jonin" | "Kage" | "Legendary";

/** Rank from level band (Ch.1). Derived but overridable on the record. */
export function rankFromLevel(level: number): Rank {
  if (level <= 0) return "Academy";
  if (level <= 4) return "Genin";
  if (level <= 8) return "Chunin";
  if (level <= 12) return "Jonin";
  if (level <= 15) return "Kage";
  return "Legendary";
}

// ---- ability generation methods (Ch.1) --------------------------------

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

/** 5e point-buy cost table; 27 points, scores 8..15. */
const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_BUDGET = 27;

export function pointBuyCost(scores: AbilityScores): { total: number; ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (POINT_BUY_COST[v] === undefined) {
      errors.push(`${k}=${v} is outside the point-buy range (8..15).`);
    } else {
      total += POINT_BUY_COST[v];
    }
  }
  if (total > POINT_BUY_BUDGET) errors.push(`point-buy total ${total} exceeds the ${POINT_BUY_BUDGET}-point budget.`);
  return { total, ok: errors.length === 0, errors };
}

/** Roll 4d6-drop-lowest, six times, using the engine's seeded RNG. */
export function roll4d6DropLowest(rng: Rng): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const dice = rollDice(rng, 4, 6).sort((a, b) => a - b);
    out.push(dice[1] + dice[2] + dice[3]);
  }
  return out;
}

export function emptyScores(fill = 10): AbilityScores {
  return { str: fill, dex: fill, con: fill, int: fill, wis: fill, cha: fill };
}

/** average value of a die for take-average leveling (round up): floor(n/2)+1. */
export function dieAverage(sides: number): number {
  return Math.floor(sides / 2) + 1;
}
