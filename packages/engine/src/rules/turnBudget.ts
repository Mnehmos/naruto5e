/**
 * TurnBudget (Action Economy, formalizing Ch.8). Each turn is a budget of typed
 * resources; every combat intent declares a cost descriptor. The engine unifies
 * three gates — action economy, chakra cost, components — into one deterministic
 * "can you pay?" check BEFORE any dice roll (the affordability gate, §17/§ Action
 * Economy). Reaction refreshes at the START of your turn and is spendable between
 * turns.
 */
export interface TurnBudget {
  action: number;
  bonus: number;
  reaction: number;
  movement: number; // a divisible feet pool
  freeInteraction: number;
}

export interface CostDescriptor {
  action?: number;
  bonus?: number;
  reaction?: number;
  movement?: number;
  /** minutes/hours casting time -> not a combat action (ritual / out-of-combat). */
  ritual?: boolean;
}

export function defaultBudget(speed: number): TurnBudget {
  return { action: 1, bonus: 1, reaction: 1, movement: speed, freeInteraction: 1 };
}

/** Derive the action-economy cost from a jutsu's casting time string (Ch.9). */
export function costFromCastingTime(castingTime: string | null | undefined): CostDescriptor {
  const s = (castingTime ?? "1 action").toLowerCase();
  if (/reaction/.test(s)) return { reaction: 1 };
  if (/bonus/.test(s)) return { bonus: 1 };
  if (/minute|hour/.test(s)) return { ritual: true };
  return { action: 1 };
}

export interface AffordCheck {
  ok: boolean;
  lacking?: "action" | "bonus" | "reaction" | "movement";
  detail?: string;
}

export function canAfford(budget: TurnBudget, cost: CostDescriptor): AffordCheck {
  if (cost.ritual) return { ok: true }; // resolved out of combat / no budget spend
  if (cost.action && budget.action < cost.action) return { ok: false, lacking: "action", detail: `no action left (have ${budget.action})` };
  if (cost.bonus && budget.bonus < cost.bonus) return { ok: false, lacking: "bonus", detail: `no bonus action left (have ${budget.bonus})` };
  if (cost.reaction && budget.reaction < cost.reaction) return { ok: false, lacking: "reaction", detail: `no reaction available (have ${budget.reaction})` };
  if (cost.movement && budget.movement < cost.movement) return { ok: false, lacking: "movement", detail: `only ${budget.movement} ft of movement left` };
  return { ok: true };
}

export function spend(budget: TurnBudget, cost: CostDescriptor): void {
  if (cost.ritual) return;
  if (cost.action) budget.action -= cost.action;
  if (cost.bonus) budget.bonus -= cost.bonus;
  if (cost.reaction) budget.reaction -= cost.reaction;
  if (cost.movement) budget.movement -= cost.movement;
}
