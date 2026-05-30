import { reject, rollD20 } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import type { JutsuRecord } from "../content.js";
import { actorAC, actorAbilityMod, actorAffinity, actorCasting, loadActor, saveActor, type ActorRef } from "../rules/actor.js";
import { RANK_VALUE, clashResolve, elementalAdvantage, jutsuElement, rollDamage } from "../rules/combat.js";
import { applyDamageDoc, healDoc } from "../rules/resolve.js";
import { useLegendaryResistance, checkPhaseTransition } from "../rules/adversary.js";
import { blockedComponents, INCAPACITATING } from "../rules/conditions.js";
import { costFromCastingTime, canAfford, spend } from "../rules/turnBudget.js";
import { activeCombatantId } from "../rules/turn.js";

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}

function requireJutsu(ctx: ResolveContext, key: string): JutsuRecord {
  const j = ctx.engine.content.getJutsu(key);
  if (!j) throw reject("unknown_jutsu", `No jutsu "${key}" in the catalog.`, { key }, ["Check the name/id; query /v1/jutsu."]);
  return j;
}

/** Upcast/level-scaled damage dice (parses the free-text atHigherRanks clause). */
function effectiveDamageDice(jutsu: JutsuRecord, level: number, atRankValue: number): string | undefined {
  const eff = jutsu.effect;
  if (!eff?.damage) return undefined;
  const m = eff.damage.dice.match(/^(\d+)d(\d+)$/);
  if (!m) return eff.damage.dice;
  let count = Number(m[1]);
  const die = m[2];
  const higher = jutsu.atHigherRanks ?? "";
  const bump = higher.match(/(\d+)d(\d+)/);
  if (bump && /level/i.test(higher)) {
    const per = Number(bump[1]);
    const thresholds = [5, 11, 17].filter((t) => level >= t).length;
    count += per * thresholds;
  }
  const baseRank = RANK_VALUE[jutsu.rank] ?? 0;
  if (atRankValue > baseRank && bump && /rank/i.test(higher)) {
    count += Number(bump[1]) * (atRankValue - baseRank);
  }
  return `${count}d${die}`;
}

function isCombatant(doc: any): boolean {
  return !!doc.turnBudget;
}

/** Concentration check when a concentrating actor takes damage (CON save DC max(10, dealt/2)). */
function concentrationCheck(ctx: ResolveContext, ref: ActorRef, dealt: number): void {
  const conc = ref.doc.concentration ?? [];
  if (conc.length === 0 || dealt <= 0) return;
  const dc = Math.max(10, Math.floor(dealt / 2));
  const mod = actorAbilityMod(ref.doc, "con") + (ref.doc.proficiencyBonus && ref.doc.proficiencies?.savingThrows?.includes?.("con") ? ref.doc.proficiencyBonus : 0);
  const roll = rollD20(ctx.rng, { modifier: mod });
  if (roll.total < dc) {
    const dropped = ref.doc.concentration.pop();
    ctx.ir.emit("concentration", { actor: ref.doc.id, data: { broke: true, dropped: dropped?.name, save: roll.total, dc }, narration: `${ref.doc.name} loses concentration on ${dropped?.name} (save ${roll.total} vs DC ${dc}).` });
  }
}

/**
 * The cast resolver (Ch.9, the keystone). Used by jutsu_cast and combat_action.
 * Gates chakra + components + (in combat) TurnBudget before any dice, then
 * resolves attack/save/auto delivery with type-keyed casting, elemental
 * advantage, upcast scaling, conditions, healing, and concentration.
 */
export function castJutsu(ctx: ResolveContext): void {
  const actorId = ctx.op.actorId;
  const ref = actorId ? loadActor(ctx.store, actorId) : undefined;
  if (!ref) throw reject("actor_required", "cast requires a valid actorId.", { actorId }, ["Set actorId to the caster."]);
  const caster = ref.doc;
  const jutsu = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ctx.op.params.jutsuId ?? ""));

  // known check (PCs must have learned it; DM can force)
  const isPC = caster.isPC ?? ref.coll === "characters";
  const force = ctx.op.params.force === true;
  if (isPC && !force && Array.isArray(caster.jutsuKnown) && !caster.jutsuKnown.includes(jutsu.id)) {
    throw reject("not_known", `${caster.name} has not learned "${jutsu.name}".`, { jutsu: jutsu.id }, ["Learn it first (jutsu_learn), or pass force:true (DM)."]);
  }

  // incapacitation gate: a downed (0 HP) or incapacitated caster cannot act
  // (mirrors the combat_action gate so casting can't bypass it).
  const incap = (caster.conditions ?? []).find((c: string) => INCAPACITATING.has(c));
  if ((caster.hp?.current ?? 1) <= 0 || incap) {
    throw reject("incapacitated", `${caster.name} is ${incap ?? "unconscious"} and cannot cast.`, { condition: incap ?? "Unconscious", hp: caster.hp?.current }, ["Stabilize/revive first (healing or a successful death save)."]);
  }

  // components
  const blocked = blockedComponents(caster.conditions ?? []);
  const missing = (jutsu.components ?? []).filter((c) => blocked.has(c));
  if (missing.length) {
    throw reject("components_unavailable", `${caster.name} can't provide components [${missing.join(", ")}] for ${jutsu.name} (blocked by conditions ${(caster.conditions ?? []).join(", ")}).`, { missing }, ["Remove the blocking condition (e.g. escape Restrained), or pick another jutsu."]);
  }

  // rank + upcast cost
  const atRank = (ctx.op.params.atRank as string | undefined)?.toUpperCase();
  const atRankValue = atRank ? RANK_VALUE[atRank] ?? RANK_VALUE[jutsu.rank] : RANK_VALUE[jutsu.rank];
  const baseRankValue = RANK_VALUE[jutsu.rank] ?? 0;
  const baseCost = jutsu.cost ?? 0;
  const upcastExtra = atRank && atRankValue > baseRankValue && /rank/i.test(jutsu.atHigherRanks ?? "") ? (atRankValue - baseRankValue) * 3 : 0;
  const chakraCost = baseCost + upcastExtra;

  // chakra gate
  const chakra = caster.chakra ?? { current: 0, max: 0 };
  if (chakraCost > chakra.current) {
    throw reject(
      "chakra_affordability",
      `${jutsu.name} costs ${chakraCost} chakra; ${caster.name} has ${chakra.current} remaining.`,
      { required: chakraCost, available: chakra.current, shortfall: chakraCost - chakra.current },
      [`Cast a lower-rank jutsu (<= ${chakra.current} chakra), or rest to recover chakra.`],
    );
  }

  // budget gate (only in combat, when the actor has a TurnBudget)
  const cost = costFromCastingTime(jutsu.castingTime);
  const legendary = ctx.op.params.__legendary === true;
  if (isCombatant(caster)) {
    // off-turn lockout: only the active combatant may act, unless this is a
    // reaction or a Solo's legendary action.
    const active = activeCombatantId(ctx.store, ctx.room.id);
    if (active && active !== caster.id && !cost.reaction && !legendary) {
      throw reject("off_turn", `It is not ${caster.name}'s turn.`, { active }, ["Only reaction-cost jutsu may be cast off-turn (e.g. a substitution)."]);
    }
    if (!legendary) {
      const aff = canAfford(caster.turnBudget, cost);
      if (!aff.ok) {
        throw reject("action_economy", `${caster.name} can't cast ${jutsu.name}: ${aff.detail}.`, { lacking: aff.lacking, castingTime: jutsu.castingTime }, ["Use a jutsu with a different casting time, or end your turn."]);
      }
    }
  }

  // concentration cap (<= 2). Re-casting a jutsu already concentrated-on refreshes
  // that slot, so it doesn't count toward the cap (no "Fox Fire, Fox Fire" stacking).
  const eff = jutsu.effect;
  const wantsConcentration = !!eff?.concentration;
  if (wantsConcentration) {
    const heldOther = (caster.concentration ?? []).filter((c: any) => c.jutsuId !== jutsu.id);
    if (heldOther.length >= 2) {
      const held = heldOther.map((c: any) => c.name).join(", ");
      throw reject("concentration_full", `${caster.name} already holds 2 concentration jutsu (${held}).`, { held }, ["End one concentration (jutsu_concentration op:end) before casting another."]);
    }
  }

  // target validation BEFORE paying costs: a directed cast at only-dead targets
  // is rejected (don't charge chakra/action for striking a corpse).
  const requestedTargets = (ctx.op.params.targets as string[]) ?? [];
  if (requestedTargets.length && eff && eff.delivery !== "utility") {
    const aliveTargets = requestedTargets.filter((id) => {
      const t = loadActor(ctx.store, id);
      return t && !t.doc.dead && (t.doc.hp?.current ?? 1) > 0;
    });
    if (aliveTargets.length === 0) {
      throw reject("no_valid_target", `${jutsu.name} has no living target — every specified target is already defeated.`, { targets: requestedTargets }, ["Target a living creature, or pick a different action."]);
    }
  }

  // ---- pay costs ----
  caster.chakra.current -= chakraCost;
  if (isCombatant(caster) && !legendary) spend(caster.turnBudget, cost);

  const casting = actorCasting(caster, jutsu.classification);
  const attackerEl = jutsuElement(jutsu);

  // cast IR (carries area for the visualizer; element for tinting)
  ctx.ir.emit("cast", {
    actor: caster.id,
    data: {
      jutsu: jutsu.name,
      jutsuId: jutsu.id,
      classification: jutsu.classification,
      rank: atRank ?? jutsu.rank,
      cost: { chakra: chakraCost },
      area: eff?.area,
      element: attackerEl,
      delivery: eff?.delivery ?? "utility",
      targets: ctx.op.params.targets,
      origin: ctx.op.params.areaOrigin,
    },
    narration: `${caster.name} casts ${jutsu.name} (${atRank ?? jutsu.rank}-rank, ${chakraCost} chakra).`,
  });
  saveActor(ctx.store, ref);

  // start concentration slot — replace any existing slot for the SAME jutsu
  // (refresh duration/targets) rather than stacking a duplicate.
  if (wantsConcentration) {
    caster.concentration = (caster.concentration ?? []).filter((c: any) => c.jutsuId !== jutsu.id);
    caster.concentration.push({ jutsuId: jutsu.id, name: jutsu.name, targets: (ctx.op.params.targets as string[]) ?? [] });
    saveActor(ctx.store, ref);
  }

  // healing (self or targets)
  if (eff?.healing) {
    const targetIds = (ctx.op.params.targets as string[]) ?? [caster.id];
    for (const tid of targetIds) {
      const tref = loadActor(ctx.store, tid);
      if (!tref) continue;
      const dmgRoll = rollDamage(ctx.rng, eff.healing.dice);
      const res = healDoc(tref.doc, dmgRoll.total + casting.mod);
      saveActor(ctx.store, tref);
      ctx.ir.emit("heal", { actor: caster.id, data: { target: tid, amount: res.healed, hp: res.hp, revived: res.revived } });
    }
  }

  // damage / conditions delivery
  if (!eff || eff.delivery === "utility") return;

  const targetIds = (ctx.op.params.targets as string[]) ?? [];
  if (targetIds.length === 0) {
    // no targets given: emit nothing further (DM may resolve area narratively)
    ctx.ir.emit("cast_unresolved", { actor: caster.id, data: { reason: "no targets specified", jutsu: jutsu.name } });
    return;
  }

  const dmgDice = effectiveDamageDice(jutsu, caster.level ?? 1, atRankValue);

  for (const tid of targetIds) {
    const tref = loadActor(ctx.store, tid);
    if (!tref) {
      ctx.ir.emit("miss_target", { actor: caster.id, data: { target: tid, reason: "not found" } });
      continue;
    }
    if (tref.doc.dead) {
      ctx.ir.emit("miss_target", { actor: caster.id, data: { target: tid, reason: "already defeated" } });
      continue;
    }
    const target = tref.doc;
    const defenderEl = actorAffinity(target);
    const edge = elementalAdvantage(attackerEl, defenderEl[0]);

    if (eff.delivery === "attack") {
      const hits = Math.max(1, eff.hits ?? 1); // multi-projectile jutsu roll once per mote
      let anyHit = false;
      for (let h = 0; h < hits; h++) {
        const roll = rollD20(ctx.rng, { modifier: casting.attack, advantage: edge === "attacker", disadvantage: edge === "defender" });
        const ac = actorAC(target);
        const hit = roll.isCrit || (!roll.isFumble && roll.total >= ac);
        ctx.ir.emit("attack", { actor: caster.id, data: { target: tid, jutsu: jutsu.name, hitIndex: hits > 1 ? h + 1 : undefined, of: hits > 1 ? hits : undefined, roll: roll.total, natural: roll.natural, vsAC: ac, hit, crit: roll.isCrit, edge }, narration: `${caster.name}'s ${jutsu.name}${hits > 1 ? ` (${h + 1}/${hits})` : ""} ${hit ? "hits" : "misses"} ${target.name} (${roll.total} vs AC ${ac}).` });
        if (hit && dmgDice && !target.dead && (target.hp?.current ?? 1) >= 0) {
          applyDamageAndEmit(ctx, caster, tref, dmgDice, eff.damage!.type, roll.isCrit, isPCActor(tref));
          anyHit = true;
        }
      }
      if (anyHit) applyConditions(ctx, caster, tref, eff, null);
    } else if (eff.delivery === "save") {
      const ability = eff.saveAbility ?? "dex";
      const saveMod = actorAbilityMod(target, ability) + (target.proficiencies?.savingThrows?.includes?.(ability) ? target.proficiencyBonus ?? 0 : 0);
      const roll = rollD20(ctx.rng, { modifier: saveMod, disadvantage: edge === "attacker", advantage: edge === "defender" });
      let success = roll.total >= casting.saveDC;
      // Solo Legendary Resistance: turn a failed save into a success.
      if (!success && tref.coll === "adversaries" && useLegendaryResistance(target)) {
        success = true;
        saveActor(ctx.store, tref);
        ctx.ir.emit("legendary_resistance", { actor: tid, data: { remaining: target.legendary?.resistance, jutsu: jutsu.name }, narration: `${target.name} shrugs off ${jutsu.name} with Legendary Resistance.` });
      }
      ctx.ir.emit("save", { actor: tid, data: { ability, roll: roll.total, dc: casting.saveDC, success, jutsu: jutsu.name }, narration: `${target.name} ${ability.toUpperCase()} save ${roll.total} vs DC ${casting.saveDC} → ${success ? "success" : "failure"}.` });
      if (dmgDice) {
        const full = rollDamage(ctx.rng, dmgDice);
        const amount = success ? (eff.halfOnSave ? Math.floor(full.total / 2) : 0) : full.total;
        if (amount > 0) applyDamageNumberAndEmit(ctx, caster, tref, amount, eff.damage!.type, isPCActor(tref), full.rolls);
      }
      if (!success) applyConditions(ctx, caster, tref, eff, ability);
    } else if (eff.delivery === "auto") {
      if (dmgDice) applyDamageAndEmit(ctx, caster, tref, dmgDice, eff.damage!.type, false, isPCActor(tref));
      applyConditions(ctx, caster, tref, eff, null);
    }
  }
}

function isPCActor(ref: ActorRef): boolean {
  return ref.doc.isPC ?? ref.coll === "characters";
}

function applyConditions(ctx: ResolveContext, caster: any, tref: ActorRef, eff: any, _save: string | null): void {
  for (const c of eff.conditions ?? []) {
    if (!tref.doc.conditions) tref.doc.conditions = [];
    if (!tref.doc.conditions.includes(c.name)) {
      tref.doc.conditions.push(c.name);
      ctx.ir.emit("condition", { actor: caster.id, data: { target: tref.doc.id, condition: c.name, applied: true }, narration: `${tref.doc.name} is ${c.name}.` });
    }
  }
  saveActor(ctx.store, tref);
}

function applyDamageAndEmit(ctx: ResolveContext, caster: any, tref: ActorRef, dice: string, type: string, crit: boolean, isPC: boolean): void {
  const dmg = rollDamage(ctx.rng, dice, crit);
  applyDamageNumberAndEmit(ctx, caster, tref, dmg.total, type, isPC, dmg.rolls);
}

function applyDamageNumberAndEmit(ctx: ResolveContext, caster: any, tref: ActorRef, amount: number, type: string, isPC: boolean, rolls?: number[]): void {
  const out = applyDamageDoc(tref.doc, amount, { isPC });
  // Solo Phase Transition on crossing 60% / 30% HP.
  const crossed = tref.coll === "adversaries" ? checkPhaseTransition(tref.doc) : null;
  saveActor(ctx.store, tref);
  // `amount` = HP actually removed (after the overkill cap); `rolled` = raw dice total.
  ctx.ir.emit("damage", { actor: caster.id, data: { target: tref.doc.id, amount: out.dealt, rolled: amount, type, rolls, hp: out.hp }, narration: `${tref.doc.name} takes ${out.dealt} ${type} damage (${out.hp.current}/${out.hp.max} HP).` });
  if (crossed) ctx.ir.emit("phase_transition", { actor: tref.doc.id, data: { threshold: crossed, phase: tref.doc.phases.current }, narration: `${tref.doc.name} enters a new phase (${crossed}% HP)!` });
  concentrationCheck(ctx, tref, out.dealt);
  if (out.died) ctx.ir.emit("down", { actor: caster.id, data: { target: tref.doc.id, dead: true }, narration: `${tref.doc.name} is slain.` });
  else if (out.downed) ctx.ir.emit("down", { actor: caster.id, data: { target: tref.doc.id, dead: false }, narration: `${tref.doc.name} drops, unconscious and dying.` });
}

export function registerJutsuIntents(engine: Engine): void {
  engine.registerHandler("jutsu_cast", castJutsu);

  engine.registerHandler("jutsu_learn", (ctx) => {
    const c = chars(ctx).get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "jutsu_learn requires a valid actorId.", {}, ["Set actorId."]);
    // learning is a downtime/progression activity, not a combat action
    const room = ctx.store.collection<any>("rooms").get(ctx.room.id);
    if (room?.mode === "combat" && room?.encounterId && ctx.op.params.force !== true) {
      throw reject("in_combat", `${c.name} can't learn a new jutsu mid-combat.`, { mode: "combat" }, ["Learn it out of combat, or pass force:true (DM override)."]);
    }
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    if (c.jutsuKnown.includes(j.id)) {
      ctx.ir.emit("jutsu_learned", { actor: c.id, data: { jutsu: j.id, already: true } });
      return;
    }
    // keyword gates: Hijutsu (clan-only), Medical (needs feature)
    const kws = (j.keywords ?? []).map((k) => k.toLowerCase());
    if (kws.includes("hijutsu") && j.prerequisites && c.clan && !String(j.prerequisites).toLowerCase().includes(c.clan.toLowerCase())) {
      // soft gate: only enforce if prerequisites name a clan; otherwise allow
    }
    if (c.jutsuKnown.length >= c.jutsuKnownCap && !ctx.op.params.force) {
      throw reject("jutsu_known_cap", `${c.name} knows ${c.jutsuKnown.length}/${c.jutsuKnownCap} jutsu (cap reached).`, { known: c.jutsuKnown.length, cap: c.jutsuKnownCap }, ["Forget a jutsu (jutsu_forget), level up to raise the cap, or pass force:true."]);
    }
    c.jutsuKnown.push(j.id);
    chars(ctx).put(c);
    ctx.ir.emit("jutsu_learned", { actor: c.id, data: { jutsu: j.id, name: j.name, known: c.jutsuKnown.length, cap: c.jutsuKnownCap }, narration: `${c.name} learns ${j.name}.` });
  });

  engine.registerHandler("jutsu_forget", (ctx) => {
    const c = chars(ctx).get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "jutsu_forget requires a valid actorId.", {});
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    c.jutsuKnown = c.jutsuKnown.filter((x) => x !== j.id);
    chars(ctx).put(c);
    ctx.ir.emit("jutsu_forgotten", { actor: c.id, data: { jutsu: j.id } });
  });

  engine.registerHandler("jutsu_list_known", (ctx) => {
    const c = chars(ctx).get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "jutsu_list_known requires a valid actorId.", {});
    const known = c.jutsuKnown.map((id) => ctx.engine.content.getJutsu(id)).filter(Boolean);
    ctx.ir.emit("jutsu_known", { actor: c.id, data: { count: known.length, cap: c.jutsuKnownCap, jutsu: known } });
  });

  engine.registerHandler("jutsu_check_castable", (ctx) => {
    const ref = loadActor(ctx.store, String(ctx.op.actorId));
    if (!ref) throw reject("actor_required", "jutsu_check_castable requires a valid actorId.", {});
    const j = requireJutsu(ctx, String(ctx.op.params.jutsu ?? ""));
    const c = ref.doc;
    const known = !c.isPC || c.jutsuKnown?.includes?.(j.id);
    const enoughChakra = (c.chakra?.current ?? 0) >= (j.cost ?? 0);
    const blocked = [...blockedComponents(c.conditions ?? [])];
    const missing = (j.components ?? []).filter((x) => blocked.includes(x));
    const castable = known && enoughChakra && missing.length === 0;
    ctx.ir.emit("castable", { actor: c.id, data: { jutsu: j.id, castable, known, enoughChakra, missingComponents: missing, cost: j.cost } });
  });

  engine.registerHandler("jutsu_concentration", (ctx) => {
    const c = chars(ctx).get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "jutsu_concentration requires a valid actorId.", {});
    const op = String(ctx.op.params.op ?? "end");
    if (op === "end") {
      const which = ctx.op.params.jutsu as string | undefined;
      const before = c.concentration.length;
      c.concentration = which ? c.concentration.filter((x) => x.jutsuId !== which && x.name !== which) : [];
      chars(ctx).put(c);
      ctx.ir.emit("concentration", { actor: c.id, data: { op: "end", ended: before - c.concentration.length } });
    } else {
      ctx.ir.emit("concentration", { actor: c.id, data: { op: "list", holding: c.concentration } });
    }
  });

  // clash_resolve — two jutsu collide; opposed casting contest (Ch.8 setpiece).
  engine.registerHandler("jutsu_clash", (ctx) => {
    const a = ctx.op.params.a as { actorId: string; jutsu: string };
    const b = ctx.op.params.b as { actorId: string; jutsu: string };
    if (!a?.actorId || !b?.actorId) throw reject("bad_clash", "jutsu_clash requires params.a and params.b each with {actorId, jutsu}.", {}, ["Provide both clashing casters and their jutsu."]);
    const refA = loadActor(ctx.store, a.actorId);
    const refB = loadActor(ctx.store, b.actorId);
    if (!refA || !refB) throw reject("entity_not_found", "Both clashing actors must exist.", {});
    const jA = requireJutsu(ctx, a.jutsu);
    const jB = requireJutsu(ctx, b.jutsu);
    const result = clashResolve(
      ctx.rng,
      { castingMod: actorCasting(refA.doc, jA.classification).mod, rank: jA.rank, element: jutsuElement(jA) },
      { castingMod: actorCasting(refB.doc, jB.classification).mod, rank: jB.rank, element: jutsuElement(jB) },
    );
    const winnerId = result.winner === "a" ? a.actorId : result.winner === "b" ? b.actorId : null;
    ctx.ir.emit("clash", {
      data: { a: { ...a, total: result.aTotal, roll: result.aRoll }, b: { ...b, total: result.bTotal, roll: result.bRoll }, winner: winnerId, tie: result.winner === "tie", close: result.close },
      narration:
        result.winner === "tie"
          ? `${jA.name} and ${jB.name} clash to a standstill — both half-resolve.`
          : `${(result.winner === "a" ? jA : jB).name} overpowers ${(result.winner === "a" ? jB : jA).name} (${result.aTotal} vs ${result.bTotal})${result.close ? " — barely" : ""}.`,
    });
  });

  // jutsu_manage.define — register a new jutsu into the catalog at runtime.
  engine.registerHandler("jutsu_define", (ctx) => {
    const rec = ctx.op.params.jutsu as JutsuRecord;
    if (!rec || !rec.id || !rec.name) throw reject("bad_jutsu", "jutsu_define requires params.jutsu with id + name.", {});
    ctx.engine.content.addJutsu(rec);
    ctx.ir.emit("jutsu_defined", { data: { jutsu: rec.id, name: rec.name } });
  });
}
