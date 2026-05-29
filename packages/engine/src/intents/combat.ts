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
import { INCAPACITATING } from "../rules/conditions.js";
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
  const active = enc.order[enc.activeIndex];
  if (active !== actorId && !cost.reaction) {
    throw reject("off_turn", `It is ${active}'s turn, not ${ref.doc.name}'s.`, { active }, ["Wait for your turn, or use a reaction."]);
  }
  // incapacitating conditions block actions
  const conds: string[] = ref.doc.conditions ?? [];
  if (cost.action || cost.bonus) {
    const blocking = conds.find((c) => INCAPACITATING.has(c));
    if (blocking) throw reject("incapacitated", `${ref.doc.name} is ${blocking} and cannot act.`, { condition: blocking }, ["Remove the condition first."]);
  }
  if (!ref.doc.turnBudget) ref.doc.turnBudget = defaultBudget(ref.doc.speed ?? 30);
  const aff = canAfford(ref.doc.turnBudget, cost);
  if (!aff.ok) throw reject("action_economy", `${ref.doc.name}: ${aff.detail}.`, { lacking: aff.lacking }, ["Use a different action, or end your turn (advance)."]);
  spend(ref.doc.turnBudget, cost);
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
      ctx.ir.emit("advance", { actor: ref.doc.id, data: { round, activeIndex: idx, turn: ref.doc.id }, narration: `Round ${round}: ${ref.doc.name}'s turn.` });
      // downed PC auto-rolls a death save at the start of its turn
      if (ref.doc.isPC && !ref.doc.dead && (ref.doc.hp?.current ?? 1) === 0 && !ref.doc.deathSaves?.stable) {
        autoDeathSave(ctx, ref);
      }
    }
  };
  engine.registerHandler("advance", advance);
  engine.registerHandler("combat_advance", advance);
  engine.registerHandler("end_turn", advance);

  engine.registerHandler("combat_end", (ctx) => {
    const enc = activeEncounter(ctx.store, ctx.room.id);
    if (enc) {
      enc.status = "ended";
      encounters(ctx).put(enc);
    }
    const room = rooms(ctx).get(ctx.room.id)!;
    room.mode = "scene";
    delete (room as any).encounterId;
    rooms(ctx).put(room);
    ctx.ir.emit("combat_end", { data: { encounterId: enc?.id }, narration: "The encounter ends." });
  });

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
    const finesse = ctx.op.params.finesse === true;
    const ability = (ctx.op.params.ability as "str" | "dex") ?? (finesse ? (actorAbilityMod(attacker, "dex") >= actorAbilityMod(attacker, "str") ? "dex" : "str") : "str");
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
      saveActor(ctx.store, tref);
      ctx.ir.emit("damage", { actor: attacker.id, data: { target: targetId, amount: out.dealt, type: ctx.op.params.damageType ?? "physical", rolls: dmg.rolls, hp: out.hp }, narration: `${tref.doc.name} takes ${out.dealt} damage (${out.hp.current}/${out.hp.max}).` });
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
