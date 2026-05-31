import { reject, rollD20 } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Room } from "../domain/room.js";
import { EncounterSchema, type Combatant, type Encounter } from "../domain/encounter.js";
import { newId } from "@naruto5e/shared";
import { loadActor, saveActor, actorAbilityMod, actorAC, type ActorRef } from "../rules/actor.js";
import { defaultBudget, canAfford, spend, costFromCastingTime, type CostDescriptor } from "../rules/turnBudget.js";
import { activeEncounter } from "../rules/turn.js";
import { applyDamageDoc } from "../rules/resolve.js";
import { rollDamage } from "../rules/combat.js";
import { checkPhaseTransition } from "../rules/adversary.js";
import { INCAPACITATING, CONDITION_DOT, clearedByCombatEnd } from "../rules/conditions.js";
import { castJutsu } from "./jutsu.js";

function rooms(ctx: ResolveContext) {
  return ctx.store.collection<Room>("rooms");
}
function encounters(ctx: ResolveContext) {
  return ctx.store.collection<Encounter>("encounters");
}

function resetBudget(doc: any): void {
  doc.turnBudget = defaultBudget(doc.speed ?? 30);
  doc.dodging = false;
}

function collToKind(coll: "characters" | "adversaries"): "character" | "adversary" {
  return coll === "adversaries" ? "adversary" : "character";
}

function getActiveEncounter(ctx: ResolveContext): Encounter {
  const enc = activeEncounter(ctx.store, ctx.room.id);
  if (!enc) throw reject("no_encounter", "No active encounter in this room.", {}, ["Start one with combat_start."]);
  return enc;
}

/** Enforce the turn authority + budget; spend the cost. Returns the actor ref. */
function gateAction(ctx: ResolveContext, cost: CostDescriptor): { ref: ActorRef; enc: Encounter } {
  const enc = getActiveEncounter(ctx);
  const actorId = ctx.op.actorId;
  if (!actorId) throw reject("actor_required", "This action requires an actorId.", {}, ["Set actorId."]);
  const ref = loadActor(ctx.store, actorId);
  if (!ref) throw reject("entity_not_found", `No actor "${actorId}".`, { actorId });
  const legendary = ctx.op.params.__legendary === true;
  const active = enc.order[enc.activeIndex];
  if (active !== actorId && !cost.reaction && !legendary) {
    throw reject("off_turn", `It is ${active}'s turn, not ${ref.doc.name}'s.`, { active }, ["Wait for your turn, or use a reaction."]);
  }
  // incapacitating conditions block actions
  const conds: string[] = ref.doc.conditions ?? [];
  if (cost.action || cost.bonus) {
    const blocking = conds.find((c) => INCAPACITATING.has(c));
    if (blocking) throw reject("incapacitated", `${ref.doc.name} is ${blocking} and cannot act.`, { condition: blocking }, ["Remove the condition first."]);
  }
  if (legendary) return { ref, enc }; // legendary actions don't spend the turn budget
  if (!ref.doc.turnBudget) ref.doc.turnBudget = defaultBudget(ref.doc.speed ?? 30);
  const aff = canAfford(ref.doc.turnBudget, cost);
  if (!aff.ok) throw reject("action_economy", `${ref.doc.name}: ${aff.detail}.`, { lacking: aff.lacking }, ["Use a different action, or end your turn (advance)."]);
  spend(ref.doc.turnBudget, cost);
  saveActor(ctx.store, ref); // persist the spend so the action economy actually gates repeat actions this turn
  return { ref, enc };
}

function gridDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5; // 5 ft per square (Chebyshev)
}

function autoDeathSave(ctx: ResolveContext, ref: ActorRef): void {
  const doc = ref.doc;
  doc.deathSaves = doc.deathSaves ?? { successes: 0, failures: 0, stable: false };
  const roll = rollD20(ctx.rng, {});
  let narration: string;
  if (roll.natural === 20) {
    doc.hp.current = 1;
    doc.conditions = (doc.conditions ?? []).filter((c: string) => c !== "Unconscious");
    doc.deathSaves = { successes: 0, failures: 0, stable: false };
    narration = `${doc.name} rallies — natural 20 on the death save, back at 1 HP!`;
  } else if (roll.natural === 1) {
    doc.deathSaves.failures = Math.min(3, doc.deathSaves.failures + 2);
    narration = `${doc.name} fails the death save badly (natural 1).`;
  } else if (roll.total >= 10) {
    doc.deathSaves.successes = Math.min(3, doc.deathSaves.successes + 1);
    narration = `${doc.name} steadies (death save ${roll.total}).`;
  } else {
    doc.deathSaves.failures = Math.min(3, doc.deathSaves.failures + 1);
    narration = `${doc.name} slips further (death save ${roll.total}).`;
  }
  if (doc.deathSaves.failures >= 3) {
    doc.dead = true;
    narration = `${doc.name} has died.`;
  } else if (doc.deathSaves.successes >= 3) {
    doc.deathSaves.stable = true;
    narration = `${doc.name} stabilizes.`;
  }
  saveActor(ctx.store, ref);
  ctx.ir.emit("death_save", { actor: doc.id, data: { ...roll, deathSaves: doc.deathSaves, dead: doc.dead }, narration });
}

/** Tick damage-over-time conditions (Burned/Bleeding) at the start of a turn. */
function tickDot(ctx: ResolveContext, ref: ActorRef): void {
  const doc = ref.doc;
  if (doc.dead || !doc.conditions?.length) return;
  for (const cond of [...doc.conditions]) {
    const dot = CONDITION_DOT[cond];
    if (!dot) continue;
    const dmg = rollDamage(ctx.rng, dot.dice);
    const isPC = doc.isPC ?? ref.coll === "characters";
    const out = applyDamageDoc(doc, dmg.total, { isPC });
    saveActor(ctx.store, ref);
    ctx.ir.emit("ongoing_damage", { actor: doc.id, data: { condition: cond, amount: out.dealt, type: dot.type, hp: out.hp }, narration: `${doc.name} takes ${out.dealt} ${dot.type} damage from ${cond} (${out.hp.current}/${out.hp.max} HP).` });
    if (out.died) ctx.ir.emit("down", { actor: doc.id, data: { target: doc.id, dead: true }, narration: `${doc.name} succumbs to ${cond}.` });
    else if (out.downed) ctx.ir.emit("down", { actor: doc.id, data: { target: doc.id, dead: false }, narration: `${doc.name} collapses from ${cond}, dying.` });
    if (doc.dead || (doc.hp?.current ?? 0) === 0) break;
  }
}

/** Start-of-turn: tick condition durations + roll save-to-end for control effects
 *  (Paralyzed/Stunned/etc.). A successful save (or expired duration) ends it. */
function tickConditionSaves(ctx: ResolveContext, ref: ActorRef): void {
  const doc = ref.doc;
  const states: any[] = doc.conditionStates ?? [];
  if (doc.dead || !states.length) return;
  const keep: any[] = [];
  for (const st of states) {
    let ended = false;
    if (typeof st.rounds === "number") {
      st.rounds -= 1;
      if (st.rounds <= 0) ended = true;
    }
    if (!ended && st.saveToEnd) {
      const mod = actorAbilityMod(doc, st.saveAbility) + (doc.proficiencies?.savingThrows?.includes?.(st.saveAbility) ? doc.proficiencyBonus ?? 0 : 0);
      const roll = rollD20(ctx.rng, { modifier: mod });
      const saved = roll.total >= st.dc;
      ctx.ir.emit("save", { actor: doc.id, data: { ability: st.saveAbility, roll: roll.total, dc: st.dc, success: saved, vs: st.name, saveToEnd: true }, narration: `${doc.name} ${String(st.saveAbility).toUpperCase()} save ${roll.total} vs DC ${st.dc} → ${saved ? `shakes off ${st.name}` : `still ${st.name}`}.` });
      if (saved) ended = true;
    }
    if (ended) {
      doc.conditions = (doc.conditions ?? []).filter((c: string) => c !== st.name);
      ctx.ir.emit("condition", { actor: doc.id, data: { target: doc.id, condition: st.name, applied: false, ended: true }, narration: `${doc.name} is no longer ${st.name}.` });
    } else {
      keep.push(st);
    }
  }
  doc.conditionStates = keep;
  saveActor(ctx.store, ref);
}

export function registerCombatIntents(engine: Engine): void {
  // ---- combat_manage --------------------------------------------------
  engine.registerHandler("combat_start", (ctx) => {
    const room = rooms(ctx).get(ctx.room.id)!;
    const reqd = (ctx.op.params.combatants as { actorId: string; team?: string; kind?: "character" | "adversary" }[]) ?? [];
    let ids: { actorId: string; team?: string; kind?: "character" | "adversary" }[] = reqd;
    if (ids.length === 0) {
      // default: all characters in the room
      const cs = ctx.store.collection("characters").find((c: any) => c.roomId === ctx.room.id && !c.dead);
      ids = cs.map((c: any) => ({ actorId: c.id, team: c.team ?? "pc", kind: "character" as const }));
    }
    if (ids.length === 0) throw reject("no_combatants", "No combatants to start an encounter.", {}, ["Create characters or pass params.combatants."]);

    const combatants: Combatant[] = [];
    for (const c of ids) {
      const ref = loadActor(ctx.store, c.actorId);
      if (!ref) throw reject("entity_not_found", `No actor "${c.actorId}" to add to combat.`, { actorId: c.actorId });
      const dexMod = actorAbilityMod(ref.doc, "dex");
      const initBonus = ref.doc.initiativeBonus ?? 0;
      const init = rollD20(ctx.rng, { modifier: dexMod + initBonus }).total;
      ref.doc.initiative = init;
      resetBudget(ref.doc);
      ref.doc.team = c.team ?? ref.doc.team ?? (ref.coll === "characters" ? "pc" : "enemy");
      saveActor(ctx.store, ref);
      combatants.push({ actorId: c.actorId, kind: c.kind ?? collToKind(ref.coll), initiative: init, isPC: ref.doc.isPC ?? ref.coll === "characters", team: ref.doc.team, extraActions: 0 });
      ctx.ir.emit("initiative", { actor: c.actorId, data: { initiative: init } });
    }
    combatants.sort((a, b) => b.initiative - a.initiative || a.actorId.localeCompare(b.actorId));
    const enc = EncounterSchema.parse({
      id: newId("enc"),
      roomId: ctx.room.id,
      combatants,
      order: combatants.map((c) => c.actorId),
      round: 1,
      activeIndex: 0,
      status: "active",
    });
    encounters(ctx).put(enc);
    room.mode = "combat";
    room.encounterId = enc.id;
    rooms(ctx).put(room);
    ctx.ir.emit("combat_start", { data: { encounterId: enc.id, order: enc.order, round: 1 }, narration: `Combat begins. Initiative: ${combatants.map((c) => `${c.actorId} (${c.initiative})`).join(", ")}.` });
    ctx.ir.emit("advance", { actor: enc.order[0], data: { round: 1, activeIndex: 0, turn: enc.order[0] }, narration: `${enc.order[0]} acts first.` });
  });

  const advance = (ctx: ResolveContext) => {
    const enc = getActiveEncounter(ctx);
    let idx = enc.activeIndex;
    let round = enc.round;
    // skip dead combatants; guard against everyone dead
    for (let steps = 0; steps < enc.order.length + 1; steps++) {
      idx += 1;
      if (idx >= enc.order.length) {
        idx = 0;
        round += 1;
      }
      const ref = loadActor(ctx.store, enc.order[idx]);
      if (ref && !ref.doc.dead) break;
    }
    enc.activeIndex = idx;
    enc.round = round;
    encounters(ctx).put(enc);

    const ref = loadActor(ctx.store, enc.order[idx]);
    if (ref) {
      resetBudget(ref.doc);
      saveActor(ctx.store, ref);
      // Solo Legendary Actions refresh: +1 per other combatant's turn (capped).
      for (const c of enc.combatants) {
        if (c.actorId === ref.doc.id) continue;
        const sref = loadActor(ctx.store, c.actorId);
        if (sref?.doc.legendary && sref.doc.legendary.actions < sref.doc.legendary.max) {
          sref.doc.legendary.actions = Math.min(sref.doc.legendary.max, sref.doc.legendary.actions + 1);
          saveActor(ctx.store, sref);
        }
      }
      // If the next combatant is an autonomous agent (autoOnTurn + persona/directive), flag it
      // so the controller can run its turn through the conform→resolve loop. The engine never
      // calls an LLM and never advances invisibly — it only surfaces the signal.
      const needsAgentTurn = (ref.doc as any).autoOnTurn && ((ref.doc as any).persona || (ref.doc as any).directive) && !ref.doc.dead ? { actorId: ref.doc.id, name: ref.doc.name, model: (ref.doc as any).model ?? null } : undefined;
      ctx.ir.emit("advance", { actor: ref.doc.id, data: { round, activeIndex: idx, turn: ref.doc.id, ...(needsAgentTurn ? { needsAgentTurn } : {}) }, narration: `Round ${round}: ${ref.doc.name}'s turn.` + (needsAgentTurn ? " (autonomous agent — resolve its turn)" : "") });
      // damage-over-time conditions (Burned/Bleeding) tick at the START of the turn
      tickDot(ctx, ref);
      // control conditions (Paralyzed/Stunned/...) get a save-to-end + duration tick
      tickConditionSaves(ctx, ref);
      // downed PC auto-rolls a death save at the start of its turn
      if (ref.doc.isPC && !ref.doc.dead && (ref.doc.hp?.current ?? 1) === 0 && !ref.doc.deathSaves?.stable) {
        autoDeathSave(ctx, ref);
      }
    }
  };
  engine.registerHandler("advance", advance);
  engine.registerHandler("combat_advance", advance);
  engine.registerHandler("end_turn", advance);

  const endCombat = (ctx: ResolveContext) => {
    const enc = activeEncounter(ctx.store, ctx.room.id);
    if (enc) {
      enc.status = "ended";
      encounters(ctx).put(enc);
      // concentration + action-economy do not persist across encounters — clear them for every combatant
      for (const c of enc.combatants) {
        const ref = loadActor(ctx.store, c.actorId);
        if (!ref) continue;
        ref.doc.concentration = [];
        delete (ref.doc as any).turnBudget; // out of combat: no action-economy gate (scene actions are free)
        // transient combat conditions don't outlive the fight — Prone, Stunned, Grappled, etc.
        // end with the encounter; only special status conditions (Petrified) persist. (Previously
        // NOTHING was cleared, so e.g. Prone lingered after combat and through a long rest.)
        if (Array.isArray(ref.doc.conditions)) ref.doc.conditions = ref.doc.conditions.filter((x: string) => !clearedByCombatEnd(x));
        if (Array.isArray(ref.doc.conditionStates)) ref.doc.conditionStates = ref.doc.conditionStates.filter((s: any) => !clearedByCombatEnd(s.name));
        saveActor(ctx.store, ref);
      }
    }
    const room = rooms(ctx).get(ctx.room.id)!;
    room.mode = "scene";
    delete (room as any).encounterId;
    rooms(ctx).put(room);
    ctx.ir.emit("combat_end", { data: { encounterId: enc?.id }, narration: "The encounter ends." });
  };
  // forgiving aliases so the verb is easy to find
  for (const v of ["combat_end", "end_combat", "end_encounter", "combat_stop"]) engine.registerHandler(v, endCombat);

  engine.registerHandler("combat_add", (ctx) => {
    const enc = getActiveEncounter(ctx);
    const actorId = String(ctx.op.params.actorId ?? ctx.op.actorId);
    const ref = loadActor(ctx.store, actorId);
    if (!ref) throw reject("entity_not_found", `No actor "${actorId}".`, { actorId });
    const init = rollD20(ctx.rng, { modifier: actorAbilityMod(ref.doc, "dex") + (ref.doc.initiativeBonus ?? 0) }).total;
    ref.doc.initiative = init;
    resetBudget(ref.doc);
    saveActor(ctx.store, ref);
    enc.combatants.push({ actorId, kind: collToKind(ref.coll), initiative: init, isPC: ref.doc.isPC ?? ref.coll === "characters", team: ref.doc.team ?? "enemy", extraActions: 0 });
    enc.combatants.sort((a, b) => b.initiative - a.initiative);
    const activeId = enc.order[enc.activeIndex];
    enc.order = enc.combatants.map((c) => c.actorId);
    enc.activeIndex = Math.max(0, enc.order.indexOf(activeId));
    encounters(ctx).put(enc);
    ctx.ir.emit("combat_add", { actor: actorId, data: { initiative: init }, narration: `${ref.doc.name} joins the fray (init ${init}).` });
  });

  engine.registerHandler("combat_remove", (ctx) => {
    const enc = getActiveEncounter(ctx);
    const actorId = String(ctx.op.params.actorId ?? ctx.op.actorId);
    const activeId = enc.order[enc.activeIndex];
    enc.combatants = enc.combatants.filter((c) => c.actorId !== actorId);
    enc.order = enc.combatants.map((c) => c.actorId);
    enc.activeIndex = Math.max(0, enc.order.indexOf(activeId));
    encounters(ctx).put(enc);
    ctx.ir.emit("combat_remove", { actor: actorId, data: {} });
  });

  // ---- combat_action --------------------------------------------------
  engine.registerHandler("attack", (ctx) => {
    const { ref } = gateAction(ctx, { action: 1 });
    const attacker = ref.doc;
    const targetId = String(ctx.op.params.target ?? "");
    const tref = loadActor(ctx.store, targetId);
    if (!tref) throw reject("entity_not_found", `No target "${targetId}".`, { target: targetId }, ["Specify params.target as a combatant id."]);
    // Default to the better physical stat — taijutsu/unarmed strikes key off
    // max(STR,DEX). Defaulting to STR under-rolled DEX/finesse martials (a Hyuga
    // taijutsu specialist's +6 came out +4). Callers can force one with params.ability.
    const ability = (ctx.op.params.ability as "str" | "dex") ?? (actorAbilityMod(attacker, "dex") >= actorAbilityMod(attacker, "str") ? "dex" : "str");
    const mod = actorAbilityMod(attacker, ability) + (attacker.proficiencyBonus ?? 0);
    const roll = rollD20(ctx.rng, { modifier: mod, advantage: tref.doc.dodging ? false : !!ctx.op.params.advantage, disadvantage: tref.doc.dodging || !!ctx.op.params.disadvantage });
    const ac = actorAC(tref.doc);
    const hit = roll.isCrit || (!roll.isFumble && roll.total >= ac);
    ctx.ir.emit("attack", { actor: attacker.id, data: { target: targetId, roll: roll.total, natural: roll.natural, vsAC: ac, hit, crit: roll.isCrit }, narration: `${attacker.name} attacks ${tref.doc.name}: ${roll.total} vs AC ${ac} → ${hit ? (roll.isCrit ? "critical hit" : "hit") : "miss"}.` });
    if (hit) {
      const dice = String(ctx.op.params.damage ?? "1d4");
      const dmg = rollDamage(ctx.rng, dice, roll.isCrit);
      const total = dmg.total + actorAbilityMod(attacker, ability);
      const isPC = tref.doc.isPC ?? tref.coll === "characters";
      const out = applyDamageDoc(tref.doc, total, { isPC });
      const crossed = tref.coll === "adversaries" ? checkPhaseTransition(tref.doc) : null;
      saveActor(ctx.store, tref);
      ctx.ir.emit("damage", { actor: attacker.id, data: { target: targetId, amount: out.dealt, type: ctx.op.params.damageType ?? "physical", rolls: dmg.rolls, hp: out.hp }, narration: `${tref.doc.name} takes ${out.dealt} damage (${out.hp.current}/${out.hp.max}).` });
      if (crossed) ctx.ir.emit("phase_transition", { actor: tref.doc.id, data: { threshold: crossed, phase: tref.doc.phases.current }, narration: `${tref.doc.name} enters a new phase (${crossed}% HP)!` });
      if (out.died) ctx.ir.emit("down", { actor: attacker.id, data: { target: targetId, dead: true }, narration: `${tref.doc.name} falls, slain.` });
      else if (out.downed) ctx.ir.emit("down", { actor: attacker.id, data: { target: targetId, dead: false }, narration: `${tref.doc.name} drops, dying.` });
    }
  });

  engine.registerHandler("move", (ctx) => {
    const enc = activeEncounter(ctx.store, ctx.room.id);
    const ref = loadActor(ctx.store, String(ctx.op.actorId));
    if (!ref) throw reject("actor_required", "move requires a valid actorId.", {});
    const to = ctx.op.params.to as { x: number; y: number } | undefined;
    const from = ref.doc.position as { x: number; y: number } | undefined;
    const distance = to && from ? gridDistance(from, to) : Number(ctx.op.params.distance ?? 0);
    if (enc) {
      // budget gate on movement
      const active = enc.order[enc.activeIndex];
      if (active !== ref.doc.id) throw reject("off_turn", `It is not ${ref.doc.name}'s turn.`, { active });
      if (!ref.doc.turnBudget) ref.doc.turnBudget = defaultBudget(ref.doc.speed ?? 30);
      const aff = canAfford(ref.doc.turnBudget, { movement: distance });
      if (!aff.ok) throw reject("action_economy", `${ref.doc.name} can't move ${distance} ft: ${aff.detail}.`, { distance, remaining: ref.doc.turnBudget.movement }, ["Dash for more movement, or move a shorter distance."]);
      spend(ref.doc.turnBudget, { movement: distance });
    }
    if (to) ref.doc.position = to;
    saveActor(ctx.store, ref);
    ctx.ir.emit("move", { actor: ref.doc.id, data: { from, to, distance, movementLeft: ref.doc.turnBudget?.movement }, narration: `${ref.doc.name} moves ${distance} ft.` });
  });

  engine.registerHandler("dash", (ctx) => {
    const { ref } = gateAction(ctx, { action: 1 });
    ref.doc.turnBudget.movement += ref.doc.speed ?? 30;
    saveActor(ctx.store, ref);
    ctx.ir.emit("dash", { actor: ref.doc.id, data: { movement: ref.doc.turnBudget.movement }, narration: `${ref.doc.name} dashes.` });
  });

  engine.registerHandler("dodge", (ctx) => {
    const { ref } = gateAction(ctx, { action: 1 });
    ref.doc.dodging = true;
    saveActor(ctx.store, ref);
    ctx.ir.emit("dodge", { actor: ref.doc.id, data: {}, narration: `${ref.doc.name} takes the Dodge action (attackers have disadvantage).` });
  });

  engine.registerHandler("disengage", (ctx) => {
    const { ref } = gateAction(ctx, { action: 1 });
    ref.doc.disengaging = true;
    saveActor(ctx.store, ref);
    ctx.ir.emit("disengage", { actor: ref.doc.id, data: {}, narration: `${ref.doc.name} disengages.` });
  });

  // stand up from Prone — the player spends ACTION ECONOMY (half their speed in movement,
  // per 5e) to shake the positional condition; free out of combat. This is the deliberate
  // "remove a transient condition by spending resources" path (vs duration/save-to-end).
  const stand = (ctx: ResolveContext) => {
    const enc = activeEncounter(ctx.store, ctx.room.id);
    const ref = loadActor(ctx.store, String(ctx.op.actorId));
    if (!ref) throw reject("actor_required", "stand requires a valid actorId.", {});
    if (!(ref.doc.conditions ?? []).includes("Prone")) throw reject("not_prone", `${ref.doc.name} is not Prone — nothing to stand up from.`, {}, ["Only a Prone creature stands up."]);
    let cost = 0;
    if (enc) {
      const active = enc.order[enc.activeIndex];
      if (active !== ref.doc.id) throw reject("off_turn", `It is not ${ref.doc.name}'s turn.`, { active });
      if (!ref.doc.turnBudget) ref.doc.turnBudget = defaultBudget(ref.doc.speed ?? 30);
      cost = Math.ceil((ref.doc.speed ?? 30) / 2); // standing costs half your speed
      const aff = canAfford(ref.doc.turnBudget, { movement: cost });
      if (!aff.ok) throw reject("action_economy", `${ref.doc.name} needs ${cost} ft of movement to stand: ${aff.detail}.`, { cost, remaining: ref.doc.turnBudget.movement }, ["Dash for more movement, or stand next turn."]);
      spend(ref.doc.turnBudget, { movement: cost });
    }
    ref.doc.conditions = (ref.doc.conditions ?? []).filter((c: string) => c !== "Prone");
    saveActor(ctx.store, ref);
    ctx.ir.emit("stand", { actor: ref.doc.id, data: { cost, movementLeft: ref.doc.turnBudget?.movement }, narration: `${ref.doc.name} gets to their feet${cost ? ` (spends ${cost} ft of movement)` : ""}.` });
  };
  for (const v of ["stand", "stand_up", "get_up"]) engine.registerHandler(v, stand);

  for (const simple of ["help", "hide", "search", "use_object", "use_item"]) {
    engine.registerHandler(simple, (ctx) => {
      const { ref } = gateAction(ctx, simple === "use_item" || simple === "use_object" ? { action: 1 } : { action: 1 });
      ctx.ir.emit(simple, { actor: ref.doc.id, data: { detail: ctx.op.params }, narration: `${ref.doc.name} takes the ${simple.replace("_", " ")} action.` });
    });
  }

  engine.registerHandler("ready", (ctx) => {
    const { ref } = gateAction(ctx, { action: 1 });
    ref.doc.readied = { trigger: String(ctx.op.params.trigger ?? "a trigger"), op: ctx.op.params.op };
    saveActor(ctx.store, ref);
    ctx.ir.emit("ready", { actor: ref.doc.id, data: { trigger: ref.doc.readied.trigger }, narration: `${ref.doc.name} readies an action: ${ref.doc.readied.trigger}.` });
  });

  // cast as a combat action delegates to the keystone resolver (which gates budget itself)
  engine.registerHandler("cast", (ctx) => castJutsu(ctx));

  engine.registerHandler("death_save", (ctx) => {
    const ref = loadActor(ctx.store, String(ctx.op.actorId));
    if (!ref) throw reject("actor_required", "death_save requires a valid actorId.", {});
    if ((ref.doc.hp?.current ?? 1) > 0) throw reject("not_dying", `${ref.doc.name} is not at 0 HP.`, {});
    autoDeathSave(ctx, ref);
  });

  // apply/remove a condition directly (DM authority)
  engine.registerHandler("condition", (ctx) => {
    const ref = loadActor(ctx.store, String(ctx.op.actorId ?? ctx.op.params.target));
    if (!ref) throw reject("actor_required", "condition requires a valid actor/target.", {});
    const name = String(ctx.op.params.condition ?? "");
    const remove = ctx.op.params.remove === true;
    ref.doc.conditions = ref.doc.conditions ?? [];
    if (remove) ref.doc.conditions = ref.doc.conditions.filter((c: string) => c !== name);
    else if (!ref.doc.conditions.includes(name)) ref.doc.conditions.push(name);
    saveActor(ctx.store, ref);
    ctx.ir.emit("condition", { actor: ref.doc.id, data: { target: ref.doc.id, condition: name, applied: !remove } });
  });
}
