import { reject, rollD20, rollExpression } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { abilityMod } from "../rules/abilities.js";

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}
function loadChar(ctx: ResolveContext): Character {
  const c = chars(ctx).get(String(ctx.op.actorId));
  if (!c) throw reject("actor_required", "This action requires a valid actorId.", {}, ["Set actorId to a character."]);
  return c;
}
function conMod(c: Character): number {
  return abilityMod((c.abilityTotals ?? c.abilities).con);
}

/**
 * Ch.7 rest (dual-pool recovery) + downtime activities. Per the architecture
 * (§13), rest/downtime is the trigger + container for the multi-agent tick —
 * Phase 9 embeds the tick + playerDigest into this return. For now it returns
 * restResult (the party's direct benefit).
 */
export function registerRestIntents(engine: Engine): void {
  engine.registerHandler("rest", (ctx) => {
    const c = loadChar(ctx);
    const type = String(ctx.op.params.type ?? "short");
    const cm = conMod(c);
    const before = { hp: c.hp.current, chakra: c.chakra.current };
    let hitDiceSpent = 0;
    let chakraDiceSpent = 0;

    if (type === "long") {
      c.hp.current = c.hp.max;
      c.chakra.current = c.chakra.max;
      // recover half (rounded down, min 1) of each dice pool
      const recoverHd = Math.max(1, Math.floor(c.hitDice.total / 2));
      const recoverCd = Math.max(1, Math.floor(c.chakraDice.total / 2));
      c.hitDice.remaining = Math.min(c.hitDice.total, c.hitDice.remaining + recoverHd);
      c.chakraDice.remaining = Math.min(c.chakraDice.total, c.chakraDice.remaining + recoverCd);
      if (c.exhaustion > 0) c.exhaustion -= 1;
      if (ctx.op.params.missionBoundary === true) c.willOfFire = true;
    } else {
      // short rest: spend dice to recover
      const spendHd = Math.min(Number(ctx.op.params.spendHitDice ?? 0), c.hitDice.remaining);
      const spendCd = Math.min(Number(ctx.op.params.spendChakraDice ?? 0), c.chakraDice.remaining);
      for (let i = 0; i < spendHd; i++) {
        const roll = rollExpression(ctx.rng, `1d${c.hitDice.type}`);
        c.hp.current = Math.min(c.hp.max, c.hp.current + Math.max(1, roll.total + cm));
        c.hitDice.remaining--;
        hitDiceSpent++;
      }
      for (let i = 0; i < spendCd; i++) {
        const roll = rollExpression(ctx.rng, `1d${c.chakraDice.type}`);
        c.chakra.current = Math.min(c.chakra.max, c.chakra.current + Math.max(1, roll.total + cm));
        c.chakraDice.remaining--;
        chakraDiceSpent++;
      }
    }
    chars(ctx).put(c);
    const restResult = {
      type,
      recovered: { hp: c.hp.current - before.hp, chakra: c.chakra.current - before.chakra, hitDiceSpent, chakraDiceSpent },
      willOfFire: c.willOfFire ? "refreshed" : "unchanged",
      pools: { hp: c.hp, chakra: c.chakra, hitDice: c.hitDice, chakraDice: c.chakraDice },
    };
    // restResult is layer 1; tick (layer 2) + playerDigest (layer 3) embed in Phase 9.
    ctx.ir.emit("rest", { actor: c.id, data: { restResult }, narration: `${c.name} takes a ${type} rest: +${restResult.recovered.hp} HP, +${restResult.recovered.chakra} chakra.` });
  });

  // ---- downtime activities (Ch.7c) ------------------------------------
  engine.registerHandler("downtime_train", (ctx) => {
    const c = loadChar(ctx);
    const weeks = Number(ctx.op.params.weeks ?? 25);
    const cost = weeks * 50;
    if (c.ryo < cost) throw reject("insufficient_ryo", `Training ${weeks} weeks costs ${cost} Ryo; ${c.name} has ${c.ryo}.`, { required: cost, available: c.ryo }, ["Earn more Ryo, or train fewer weeks."]);
    c.ryo -= cost;
    const kind = String(ctx.op.params.kind ?? "feat");
    const value = String(ctx.op.params.value ?? "a new technique");
    if (kind === "feat") c.feats.push(value);
    else if (kind === "tool") c.proficiencies.tools.push(value);
    else if (kind === "weapon") c.proficiencies.weapons.push(value);
    else if (kind === "language") {
      const langs = ((c.resources as any).languages ??= []);
      langs.push(value);
    }
    chars(ctx).put(c);
    ctx.ir.emit("downtime", { actor: c.id, data: { activity: "training", weeks, cost, kind, value, status: "complete" }, narration: `${c.name} trains ${weeks} weeks (${cost} Ryo) and learns ${value}.` });
  });

  engine.registerHandler("downtime_research", (ctx) => {
    const c = loadChar(ctx);
    ctx.ir.emit("downtime", { actor: c.id, data: { activity: "research", topic: ctx.op.params.topic, status: "pending_gm" }, narration: `${c.name} researches ${ctx.op.params.topic ?? "a mystery"} — the GM will reveal what's uncovered.` });
  });

  engine.registerHandler("downtime_recuperate", (ctx) => {
    const c = loadChar(ctx);
    const roll = rollD20(ctx.rng, { modifier: conMod(c) + (c.proficiencies.savingThrows.includes("con") ? c.proficiencyBonus : 0) });
    const success = roll.total >= 15;
    if (success && ctx.op.params.endEffect) c.conditions = c.conditions.filter((x) => x !== ctx.op.params.endEffect);
    chars(ctx).put(c);
    ctx.ir.emit("downtime", { actor: c.id, data: { activity: "recuperate", save: roll.total, dc: 15, success }, narration: `${c.name} recuperates a week (CON save ${roll.total} vs DC 15 → ${success ? "recovers" : "no change"}).` });
  });

  engine.registerHandler("downtime_shop", (ctx) => {
    const c = loadChar(ctx);
    const discount = rollExpression(ctx.rng, "5d4").total; // 5d4 % reduction
    ctx.ir.emit("downtime", { actor: c.id, data: { activity: "shopping", discountPercent: discount, items: ctx.op.params.items }, narration: `${c.name} shops a week and finds goods at a ${discount}% discount.` });
  });
}
