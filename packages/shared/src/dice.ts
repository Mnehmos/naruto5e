/**
 * Deterministic, seedable dice — the engine owns all dice (Architecture §9.1:
 * "the combat engine is the sole authority on outcomes - owns all dice").
 *
 * Reproducibility is a hard requirement (playtests must reproduce), so every
 * random draw comes from a seeded mulberry32 PRNG held by the room. Same seed +
 * same sequence of calls => identical results.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Roll a single die with `sides` faces (1..sides). */
  die(sides: number): number {
    return this.int(1, sides);
  }

  /** Serializable state, so a room's RNG survives persistence. */
  snapshot(): number {
    return this.state >>> 0;
  }

  static restore(state: number): Rng {
    const r = new Rng(0);
    r.state = state >>> 0;
    return r;
  }
}

/** Derive a stable 32-bit seed from a string (e.g. a roomId). */
export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface DiceRoll {
  expression: string;
  rolls: number[];
  modifier: number;
  total: number;
}

/** Roll `count` dice of `sides`. */
export function rollDice(rng: Rng, count: number, sides: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(rng.die(sides));
  return out;
}

/**
 * Roll a dice expression like "2d6+3", "1d8", "4d4-1", "10".
 * Supports a single dice term plus an optional flat modifier.
 */
export function rollExpression(rng: Rng, expr: string): DiceRoll {
  const cleaned = expr.replace(/\s+/g, "").toLowerCase();
  const m = cleaned.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) {
    // treat as a flat number
    const flat = Number(cleaned);
    if (Number.isFinite(flat)) {
      return { expression: expr, rolls: [], modifier: flat, total: flat };
    }
    throw new Error(`Unparseable dice expression: "${expr}"`);
  }
  const count = m[1] === "" ? 1 : parseInt(m[1], 10);
  const sides = parseInt(m[2], 10);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  const rolls = rollDice(rng, count, sides);
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  return { expression: expr, rolls, modifier, total };
}

export interface D20Roll {
  natural: number; // the kept d20 face
  both?: [number, number]; // when adv/dis, both faces
  modifier: number;
  total: number;
  advantage: boolean;
  disadvantage: boolean;
  isCrit: boolean; // natural 20
  isFumble: boolean; // natural 1
}

export interface D20Options {
  modifier?: number;
  advantage?: boolean;
  disadvantage?: boolean;
  bonus?: number; // flat bonus stacked on top of modifier (e.g. Will of Fire +5)
}

/** Roll a d20 check/attack/save with advantage/disadvantage handling. */
export function rollD20(rng: Rng, opts: D20Options = {}): D20Roll {
  const adv = !!opts.advantage && !opts.disadvantage;
  const dis = !!opts.disadvantage && !opts.advantage;
  const a = rng.die(20);
  let natural = a;
  let both: [number, number] | undefined;
  if (adv || dis) {
    const b = rng.die(20);
    both = [a, b];
    natural = adv ? Math.max(a, b) : Math.min(a, b);
  }
  const modifier = (opts.modifier ?? 0) + (opts.bonus ?? 0);
  return {
    natural,
    both,
    modifier,
    total: natural + modifier,
    advantage: adv,
    disadvantage: dis,
    isCrit: natural === 20,
    isFumble: natural === 1,
  };
}
