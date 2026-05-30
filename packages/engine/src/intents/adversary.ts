import { newId, reject, rollD20, rollExpression } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { AdversarySchema, type Adversary } from "../domain/adversary.js";
import { adversaryBaseline, jutsuRankCap, rankWithinCap, tierMods, type Tier, checkPhaseTransition } from "../rules/adversary.js";
import { loadActor, saveActor, actorAC } from "../rules/actor.js";
import { applyDamageDoc } from "../rules/resolve.js";
import { activeEncounter } from "../rules/turn.js";
import { defaultBudget, canAfford, spend } from "../rules/turnBudget.js";

function advs(ctx: ResolveContext) {
  return ctx.store.collection<Adversary>("adversaries");
}

/** Build an adversary statblock from the tier baseline + modifiers (the 8-step build). */
function buildAdversary(ctx: ResolveContext, opts: { name: string; tier: Tier; role?: string; clan?: string; level: number; partySize?: number; jutsu?: string[]; traits?: string[]; affinity?: string[]; id?: string; personalize?: { acMod?: number; attackMod?: number; hpMult?: number; damageMult?: number; dcMod?: number } }): Adversary {
  const base = adversaryBaseline(opts.level);
  const partySize = opts.partySize ?? 4;
  const m = tierMods(opts.tier, partySize);

  const pz = opts.personalize ?? {}; // step 7 of the 8-step build: tune AC/HP/attack vs the party
  let hp = Math.round(base.hp * (opts.tier === "minion" ? 1 : m.hpMul));
  if (opts.tier === "minion") hp = Math.max(1, Math.min(20, base.hp)); // minion HP 1–20
  hp = Math.max(1, Math.round(hp * (pz.hpMult ?? 1)));
  const chakra = Math.round(base.chakra * m.chakraMul);
  const cap = jutsuRankCap(opts.tier);
  const jutsu = (opts.jutsu ?? []).filter((id) => {
    const j = ctx.engine.content.getJutsu(id);
    return j && rankWithinCap(j.rank, cap);
  });

  const adv: Adversary = AdversarySchema.parse({
    id: opts.id ?? newId("adv"),
    roomId: ctx.room.id,
    name: opts.name,
    tier: opts.tier,
    role: opts.role ?? "striker",
    clan: opts.clan,
    level: opts.level,
    ac: base.ac + m.ac + (pz.acMod ?? 0),
    hp: { current: hp, max: hp, temp: 0 },
    chakra: { current: chakra, max: chakra, temp: 0 },
    abilityMods: Object.fromEntries(Object.entries(base.abilityMods).map(([k, v]) => [k, v + m.save])),
    proficiencyBonus: base.proficiencyBonus,
    saveBonus: m.save,
    attack: base.attack + m.attack + (pz.attackMod ?? 0),
    damage: Math.max(1, Math.round(base.damage * m.damageMul * (pz.damageMult ?? 1))),
    jutsuDC: 8 + base.proficiencyBonus + Math.round(opts.level / 3) + m.dc + (pz.dcMod ?? 0),
    initiativeBonus: m.init,
    traits: opts.traits ?? [],
    jutsu,
    affinity: opts.affinity ?? [],
    eliteAction: opts.tier === "elite",
    eliteTenacity: opts.tier === "elite" ? Math.max(1, Math.floor(opts.level / 1)) : 0,
    legendary: opts.tier === "solo" ? { actions: Math.max(1, partySize - 1), max: Math.max(1, partySize - 1), resistance: 3 } : undefined,
    phases: opts.tier === "solo" ? { thresholds: [60, 30], crossed: [], current: 1 } : undefined,
    xpMultiplier: m.xpMul,
  });
  return adv;
}

export function registerAdversaryIntents(engine: Engine): void {
  const spawn = (ctx: ResolveContext) => {
    const p = ctx.op.params;
    const tier = String(p.tier ?? "minion") as Tier;
    if (!["minion", "elite", "solo"].includes(tier)) throw reject("bad_tier", `tier must be minion|elite|solo (got "${tier}").`, { tier });
    const adv = buildAdversary(ctx, {
      name: String(p.name ?? `${tier} foe`),
      tier,
      role: p.role as string,
      clan: p.clan as string,
      level: Math.max(1, Math.min(30, Number(p.level ?? 1))),
      partySize: p.partySize ? Number(p.partySize) : undefined,
      jutsu: (p.jutsu as string[]) ?? [],
      traits: (p.traits as string[]) ?? [],
      affinity: (p.affinity as string[]) ?? [],
      personalize: p.personalize as any,
      id: p.id as string,
    });
    advs(ctx).put(adv);
    ctx.ir.emit("adversary_spawned", {
      actor: adv.id,
      data: { adversary: { id: adv.id, name: adv.name, tier: adv.tier, level: adv.level, ac: adv.ac, hp: adv.hp, attack: adv.attack, legendary: adv.legendary, phases: adv.phases } },
      narration: `${adv.name} (${adv.tier}, L${adv.level}) appears — AC ${adv.ac}, HP ${adv.hp.max}.`,
    });
  };
  engine.registerHandler("adversary_spawn", spawn);
  engine.registerHandler("adversary_build", spawn);

  engine.registerHandler("from_bingo_book", (ctx) => {
    const name = String(ctx.op.params.name ?? "");
    const tpl = ctx.engine.content.getBingo(name);
    if (!tpl) throw reject("unknown_foe", `No Bingo Book entry "${name}".`, { name }, [`Known foes: ${ctx.engine.content.bingoBook.map((b: any) => b.name).join(", ")}`]);
    const level = ctx.op.params.level !== undefined ? Number(ctx.op.params.level) : tpl.level;
    const adv = buildAdversary(ctx, {
      name: tpl.name,
      tier: tpl.tier,
      role: tpl.role,
      clan: tpl.clan,
      level,
      partySize: ctx.op.params.partySize ? Number(ctx.op.params.partySize) : undefined,
      jutsu: tpl.jutsu ?? [],
      traits: tpl.traits ?? [],
      affinity: tpl.affinity ?? [],
      personalize: ctx.op.params.personalize as any,
      id: ctx.op.params.id as string,
    });
    advs(ctx).put(adv);
    ctx.ir.emit("adversary_spawned", {
      actor: adv.id,
      data: { adversary: { id: adv.id, name: adv.name, tier: adv.tier, level: adv.level, ac: adv.ac, hp: adv.hp, attack: adv.attack, legendary: adv.legendary, phases: adv.phases }, usingAs: tpl.usingAs },
      narration: `${adv.name} enters — ${tpl.traits?.join(", ") ?? ""}.`,
    });
  });

  engine.registerHandler("adversary_scale", (ctx) => {
    const adv = advs(ctx).get(String(ctx.op.actorId ?? ctx.op.params.id));
    if (!adv) throw reject("entity_not_found", "No adversary to scale.", {});
    const rebuilt = buildAdversary(ctx, {
      name: adv.name,
      tier: adv.tier,
      role: adv.role,
      clan: adv.clan,
      level: Number(ctx.op.params.level ?? adv.level),
      partySize: Number(ctx.op.params.partySize ?? 4),
      jutsu: adv.jutsu,
      traits: adv.traits,
      affinity: adv.affinity,
      id: adv.id,
    });
    advs(ctx).put(rebuilt);
    ctx.ir.emit("adversary_scaled", { actor: adv.id, data: { level: rebuilt.level, ac: rebuilt.ac, hp: rebuilt.hp }, narration: `${adv.name} scales to L${rebuilt.level} (HP ${rebuilt.hp.max}).` });
  });

  // A tier/level-scaled freeform attack (adversaries carry no fixed attack list).
  engine.registerHandler("freeform_attack", (ctx) => {
    const ref = loadActor(ctx.store, String(ctx.op.actorId));
    if (!ref) throw reject("actor_required", "freeform_attack requires a valid actorId.", {});
    const attacker = ref.doc;
    const enc = activeEncounter(ctx.store, ctx.room.id);
    const legendary = ctx.op.params.__legendary === true;
    if (enc && !legendary) {
      if (enc.order[enc.activeIndex] !== attacker.id) throw reject("off_turn", `It is not ${attacker.name}'s turn.`, { active: enc.order[enc.activeIndex] });
      if (!attacker.turnBudget) attacker.turnBudget = defaultBudget(attacker.speed ?? 30);
      const aff = canAfford(attacker.turnBudget, { action: 1 });
      if (!aff.ok) throw reject("action_economy", `${attacker.name}: ${aff.detail}.`, {});
      spend(attacker.turnBudget, { action: 1 });
    }
    const tref = loadActor(ctx.store, String(ctx.op.params.target ?? ""));
    if (!tref) throw reject("entity_not_found", `No target "${ctx.op.params.target}".`, {}, ["Specify params.target."]);
    const bonus = attacker.attack ?? 5;
    const roll = rollD20(ctx.rng, { modifier: bonus, advantage: !!ctx.op.params.advantage, disadvantage: tref.doc.dodging });
    const ac = actorAC(tref.doc);
    const hit = roll.isCrit || (!roll.isFumble && roll.total >= ac);
    ctx.ir.emit("attack", { actor: attacker.id, data: { target: tref.doc.id, roll: roll.total, natural: roll.natural, vsAC: ac, hit, crit: roll.isCrit, freeform: ctx.op.params.descriptor ?? "a savage strike" }, narration: `${attacker.name} ${hit ? "hits" : "misses"} ${tref.doc.name} (${roll.total} vs AC ${ac}).` });
    if (hit) {
      const budget = attacker.damage ?? 7;
      let dealt = Math.max(1, Math.round(budget * (0.6 + ctx.rng.next() * 0.4)));
      if (roll.isCrit) dealt = Math.round(dealt * 1.5);
      const isPC = tref.doc.isPC ?? tref.coll === "characters";
      const out = applyDamageDoc(tref.doc, dealt, { isPC });
      applyAfterDamage(ctx, attacker, tref);
      ctx.ir.emit("damage", { actor: attacker.id, data: { target: tref.doc.id, amount: out.dealt, type: ctx.op.params.type ?? "physical", hp: out.hp }, narration: `${tref.doc.name} takes ${out.dealt} damage (${out.hp.current}/${out.hp.max}).` });
      if (out.died) ctx.ir.emit("down", { actor: attacker.id, data: { target: tref.doc.id, dead: true }, narration: `${tref.doc.name} falls.` });
      else if (out.downed) ctx.ir.emit("down", { actor: attacker.id, data: { target: tref.doc.id, dead: false }, narration: `${tref.doc.name} drops, dying.` });
    }
  });

  // Solo Legendary Action — act off-turn (1 Paragon action per other player's turn).
  engine.registerHandler("legendary_action", (ctx) => {
    const adv = advs(ctx).get(String(ctx.op.actorId));
    if (!adv) throw reject("actor_required", "legendary_action requires a Solo adversary actorId.", {});
    if (!adv.legendary || adv.legendary.actions <= 0) throw reject("no_legendary", `${adv.name} has no Legendary Actions remaining.`, { remaining: adv.legendary?.actions ?? 0 }, ["Wait for a player's turn to refresh, or use a normal turn."]);
    adv.legendary.actions -= 1;
    advs(ctx).put(adv);
    ctx.ir.emit("legendary_action", { actor: adv.id, data: { remaining: adv.legendary.actions, action: ctx.op.params.action }, narration: `${adv.name} takes a Legendary Action.` });
    // delegate to the named sub-action; the __legendary flag exempts it from the
    // off-turn lockout and normal turn-budget spend.
    const sub = String(ctx.op.params.action ?? "freeform_attack");
    const handler = ctx.engine.getHandler(sub);
    if (handler) {
      const subOp = { type: sub, actorId: adv.id, params: { ...(ctx.op.params.params as object), __legendary: true }, cost: undefined };
      handler({ ...ctx, op: subOp });
    }
  });
}

/** Solo legendary-action refresh + phase-transition signal after taking damage. */
export function applyAfterDamage(ctx: ResolveContext, attacker: any, tref: { doc: any; coll: string }): void {
  if (tref.coll !== "adversaries") {
    saveActor(ctx.store, tref as any);
    return;
  }
  const crossed = checkPhaseTransition(tref.doc);
  saveActor(ctx.store, tref as any);
  if (crossed) {
    ctx.ir.emit("phase_transition", { actor: tref.doc.id, data: { threshold: crossed, phase: tref.doc.phases.current }, narration: `${tref.doc.name} enters a new phase (${crossed}% HP) — lingering effects are thrown off!` });
  }
}
