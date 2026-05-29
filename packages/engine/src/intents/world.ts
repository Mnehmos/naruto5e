import { newId, reject, rollExpression } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { NpcRelationshipSchema, NpcSchema, VendorSchema, StolenItemSchema, HeatStateSchema, CorpseSchema, DECAY_ORDER, type Corpse, type HeatState, type NpcRelationship, type Vendor } from "../domain/world.js";
import { applyStandingDelta, getLedger } from "../rules/standing.js";

function coll<T extends { id: string }>(ctx: ResolveContext, name: string) {
  return ctx.store.collection<T>(name);
}
function relId(npcId: string, actorId: string) {
  return `${npcId}:${actorId}`;
}

/**
 * Phase 7 — the four world-consequence systems. ALL standing-affecting acts route
 * through `applyStandingDelta` (the spine). DM write-surfaces; players act
 * through the DM.
 */
export function registerWorldIntents(engine: Engine): void {
  // ============ A) npc_manage (memory <-> Standing) ============
  engine.registerHandler("npc_create", (ctx) => {
    const npc = NpcSchema.parse({ id: (ctx.op.params.id as string) || newId("npc"), roomId: ctx.room.id, name: String(ctx.op.params.name ?? "NPC"), authorityId: ctx.op.params.authorityId as string });
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_created", { data: { npc }, narration: `${npc.name} enters the world.` });
  });

  engine.registerHandler("npc_interact", (ctx) => {
    const npcId = String(ctx.op.params.npcId ?? "");
    const actorId = String(ctx.op.actorId ?? ctx.op.params.actorId ?? "");
    const npc = coll<any>(ctx, "npcs").get(npcId);
    if (!npc) throw reject("entity_not_found", `No NPC "${npcId}".`, {}, ["Create the NPC first (npc_create)."]);
    const rels = coll<NpcRelationship>(ctx, "npc_relationships");
    let rel = rels.get(relId(npcId, actorId));
    if (!rel) rel = NpcRelationshipSchema.parse({ id: relId(npcId, actorId), npcId, actorId, authorityId: npc.authorityId });
    rel.familiarity = Math.min(100, rel.familiarity + Number(ctx.op.params.familiarityDelta ?? 5));
    rel.disposition = Math.max(-100, Math.min(100, rel.disposition + Number(ctx.op.params.dispositionDelta ?? 0)));
    const beat = String(ctx.op.params.beat ?? "an exchange");
    const importance = (ctx.op.params.importance as any) ?? "low";
    const sd = ctx.op.params.standingDelta as any;
    rel.memories.push({ eventId: newId("mem"), summary: beat, importance, standingDelta: sd, sentiment: Number(ctx.op.params.dispositionDelta ?? 0), witnessed: ctx.op.params.witnessed !== false });
    rels.put(rel);
    // a memory with a standingDelta writes into the authority ledger (the "why" behind reputation)
    let standing: any = null;
    if (sd?.authorityId) {
      const l = applyStandingDelta(ctx.store, actorId, sd.authorityId, { reputation: sd.reputation, favor: sd.favor, reason: beat });
      standing = { authorityId: sd.authorityId, reputation: l.reputation, favor: l.favor };
    }
    ctx.ir.emit("npc_interaction", { actor: actorId, data: { npcId, disposition: rel.disposition, familiarity: rel.familiarity, standing }, narration: `${npc.name}: ${beat}.` });
  });

  engine.registerHandler("npc_learn_fact", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", "No NPC to learn a fact.", {});
    const fact = String(ctx.op.params.fact ?? "");
    if (!npc.knownFacts.includes(fact)) npc.knownFacts.push(fact);
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_fact", { data: { npcId: npc.id, fact, knownFacts: npc.knownFacts } });
  });

  engine.registerHandler("npc_get_relationship", (ctx) => {
    const rel = coll<NpcRelationship>(ctx, "npc_relationships").get(relId(String(ctx.op.params.npcId), String(ctx.op.actorId ?? ctx.op.params.actorId)));
    ctx.ir.emit("npc_relationship", { data: { relationship: rel ?? null } });
  });

  // ============ B) economy_manage (Ryo gated by Standing) ============
  engine.registerHandler("vendor_create", (ctx) => {
    const v = VendorSchema.parse({ id: (ctx.op.params.id as string) || newId("vendor"), roomId: ctx.room.id, name: String(ctx.op.params.name ?? "Merchant"), authorityId: ctx.op.params.authorityId as string, openStock: (ctx.op.params.openStock as any) ?? [], gatedStock: (ctx.op.params.gatedStock as any) ?? [], heatCapacity: Number(ctx.op.params.heatCapacity ?? 0) });
    coll(ctx, "vendors").put(v);
    ctx.ir.emit("vendor_created", { data: { vendor: v }, narration: `${v.name}'s shop opens.` });
  });

  function standingDiscount(ctx: ResolveContext, actorId: string, authorityId?: string): number {
    if (!authorityId) return 0;
    const l = getLedger(ctx.store, actorId, authorityId);
    if (!l || l.reputation <= 40) return 0;
    return Math.min(20, Math.floor((l.reputation - 40) / 5)); // up to 20% off when trusted
  }

  engine.registerHandler("economy_list_stock", (ctx) => {
    const v = coll<Vendor>(ctx, "vendors").get(String(ctx.op.params.vendorId ?? ""));
    if (!v) throw reject("entity_not_found", "No such vendor.", {}, ["Create one (vendor_create)."]);
    const actorId = String(ctx.op.actorId ?? "");
    const unlocked = v.gatedStock.filter((g) => {
      const l = getLedger(ctx.store, actorId, g.requires.authorityId);
      return (l?.reputation ?? 0) >= g.requires.minReputation && !l?.hostile;
    });
    ctx.ir.emit("vendor_stock", { actor: actorId, data: { vendor: v.id, openStock: v.openStock, gatedUnlocked: unlocked, gatedLocked: v.gatedStock.filter((g) => !unlocked.includes(g)).map((g) => ({ itemId: g.itemId, requires: g.requires })) } });
  });

  engine.registerHandler("economy_buy", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "economy_buy requires a valid actorId.", {});
    const v = coll<Vendor>(ctx, "vendors").get(String(ctx.op.params.vendorId ?? ""));
    if (!v) throw reject("entity_not_found", "No such vendor.", {});
    const itemId = String(ctx.op.params.item ?? "");
    const gated = v.gatedStock.find((g) => g.itemId === itemId);
    const open = v.openStock.find((o) => o.itemId === itemId);
    if (gated) {
      const l = getLedger(ctx.store, c.id, gated.requires.authorityId);
      if ((l?.reputation ?? 0) < gated.requires.minReputation || l?.hostile) {
        throw reject("not_offered", `${itemId} is gated: ${gated.requires.authorityId} reputation ${gated.requires.minReputation}+ required (you have ${l?.reputation ?? 0}). Ryo alone can't buy it.`, { requires: gated.requires, have: l?.reputation ?? 0 }, ["Earn reputation with that authority — Standing permits what Ryo cannot."]);
      }
    } else if (!open) {
      throw reject("not_stocked", `${v.name} doesn't stock "${itemId}".`, {}, ["List the stock first (economy_list_stock)."]);
    }
    const item = ctx.engine.content.getItem(itemId);
    const listed = (gated?.ryoPrice ?? open?.ryoPrice ?? item?.valueRyo ?? 0) * (v.buyRate ?? 1);
    const discount = standingDiscount(ctx, c.id, v.authorityId);
    const price = Math.max(0, Math.round(listed * (1 - discount / 100)));
    if (c.ryo < price) throw reject("insufficient_ryo", `${itemId} costs ${price} Ryo; ${c.name} has ${c.ryo}.`, { required: price, available: c.ryo }, ["Earn Ryo or sell goods."]);
    c.ryo -= price;
    if (item) c.equipment.push({ ...structuredClone(item), equipped: false, qty: 1 });
    else c.equipment.push({ id: itemId, name: itemId, qty: 1 });
    coll(ctx, "characters").put(c);
    ctx.ir.emit("buy", { actor: c.id, data: { item: itemId, price, discount, ryo: c.ryo, vendor: v.id }, narration: `${c.name} buys ${itemId} from ${v.name} for ${price} Ryo${discount ? ` (${discount}% standing discount)` : ""}.` });
  });

  // ============ C) theft_manage (heat + rogue trigger) ============
  engine.registerHandler("theft_steal", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    if (!c) throw reject("actor_required", "theft_steal requires a valid actorId (the thief).", {});
    const itemId = String(ctx.op.params.item ?? "");
    const jurisdiction = String(ctx.op.params.jurisdictionAuthorityId ?? ctx.op.params.jurisdiction ?? "");
    if (!jurisdiction) throw reject("jurisdiction_required", "theft_steal requires jurisdictionAuthorityId.", {}, ["Name whose jurisdiction the theft happens in."]);
    const witnesses = ((ctx.op.params.witnesses as string[]) ?? []).map((npcId) => ({ npcId, recognizes: true }));
    const stolen = StolenItemSchema.parse({ id: newId("stolen"), itemId, originalOwnerId: ctx.op.params.fromOwnerId as string, stolenBy: c.id, jurisdictionAuthorityId: jurisdiction, heat: witnesses.length ? "burning" : "hot", witnesses, recognizable: ctx.op.params.recognizable !== false });
    coll(ctx, "stolen_items").put(stolen);
    const item = ctx.engine.content.getItem(itemId);
    c.equipment.push(item ? { ...structuredClone(item), equipped: false, stolen: true, qty: 1 } : { id: itemId, name: itemId, stolen: true, qty: 1 });
    coll(ctx, "characters").put(c);
    ctx.ir.emit("theft", { actor: c.id, data: { stolenId: stolen.id, item: itemId, heat: stolen.heat, witnesses: witnesses.length }, narration: `${c.name} steals ${itemId} in ${jurisdiction}'s jurisdiction (heat: ${stolen.heat}${witnesses.length ? ", witnessed" : ""}).` });
  });

  function heatState(ctx: ResolveContext, actorId: string, authorityId: string): HeatState {
    const id = `${actorId}:${authorityId}`;
    let h = coll<HeatState>(ctx, "heat_states").get(id);
    if (!h) h = HeatStateSchema.parse({ id, actorId, authorityId });
    return h;
  }

  engine.registerHandler("theft_report", (ctx) => {
    const stolen = coll<any>(ctx, "stolen_items").get(String(ctx.op.params.stolenId ?? ""));
    if (!stolen) throw reject("entity_not_found", "No such stolen item.", {});
    const authorityId = stolen.jurisdictionAuthorityId;
    const penalty = Number(ctx.op.params.penalty ?? 15);
    // Caught/reported -> Standing hit with the jurisdiction's authority (routed through the spine).
    const l = applyStandingDelta(ctx.store, stolen.stolenBy, authorityId, { reputation: -penalty, reason: "caught stealing" });
    const h = heatState(ctx, stolen.stolenBy, authorityId);
    h.level += penalty;
    h.incidents += 1;
    let rogueTrigger = false;
    if ((h.level >= 50 || h.incidents >= 3) && !h.rogueTriggered) {
      h.rogueTriggered = true;
      rogueTrigger = true;
    }
    coll(ctx, "heat_states").put(h);
    ctx.ir.emit("theft_reported", { actor: stolen.stolenBy, data: { authorityId, reputation: l.reputation, heat: h.level, incidents: h.incidents, rogueTrigger }, narration: `A witness reports the theft — ${stolen.stolenBy}'s standing with ${authorityId} drops to ${l.reputation}.${rogueTrigger ? " The bridge is burning: the rogue path beckons (consider defect)." : ""}` });
  });

  engine.registerHandler("theft_heat_decay", (ctx) => {
    const stolen = coll<any>(ctx, "stolen_items").get(String(ctx.op.params.stolenId ?? ""));
    if (!stolen) throw reject("entity_not_found", "No such stolen item.", {});
    const order = ["burning", "hot", "warm", "cold"];
    const idx = Math.min(order.length - 1, order.indexOf(stolen.heat) + Number(ctx.op.params.steps ?? 1));
    stolen.heat = order[idx];
    coll(ctx, "stolen_items").put(stolen);
    ctx.ir.emit("heat_decay", { data: { stolenId: stolen.id, heat: stolen.heat } });
  });

  engine.registerHandler("theft_fence", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    const stolen = coll<any>(ctx, "stolen_items").get(String(ctx.op.params.stolenId ?? ""));
    const v = coll<Vendor>(ctx, "vendors").get(String(ctx.op.params.vendorId ?? ""));
    if (!c || !stolen || !v) throw reject("entity_not_found", "theft_fence requires actor, stolenId, and vendorId.", {});
    if ((v.heatCapacity ?? 0) <= 0) throw reject("no_fence", `${v.name} won't launder stolen goods.`, {}, ["Find a fence (a vendor with heatCapacity), often a patron's."]);
    const item = ctx.engine.content.getItem(stolen.itemId);
    const gain = Math.round((item?.valueRyo ?? 0) * (v.sellRate ?? 0.5) * 0.7);
    c.ryo += gain;
    c.equipment = c.equipment.filter((e: any) => !(e.stolen && (e.id === stolen.itemId || e.name === stolen.itemId)));
    coll(ctx, "characters").put(c);
    coll(ctx, "stolen_items").delete(stolen.id);
    // fencing with a patron's fence builds patron standing (deeper into the rogue economy)
    let patron: any = null;
    if (v.authorityId) {
      const l = applyStandingDelta(ctx.store, c.id, v.authorityId, { reputation: 3, authorityType: "patron", reason: "laundered goods" });
      patron = { authorityId: v.authorityId, reputation: l.reputation };
    }
    ctx.ir.emit("fence", { actor: c.id, data: { item: stolen.itemId, gain, patron }, narration: `${c.name} fences ${stolen.itemId} for ${gain} Ryo.` });
  });

  // ============ D) corpse_manage (death, secrets, Standing) ============
  engine.registerHandler("corpse_create", (ctx) => {
    const corpse = CorpseSchema.parse({ id: (ctx.op.params.id as string) || newId("corpse"), roomId: ctx.room.id, deceasedId: ctx.op.params.deceasedId as string, name: ctx.op.params.name as string, deceasedAuthorityId: ctx.op.params.authorityId as string, clan: ctx.op.params.clan as string, carries: (ctx.op.params.carries as any) ?? [] });
    coll(ctx, "corpses").put(corpse);
    ctx.ir.emit("corpse_created", { data: { corpse }, narration: `${corpse.name ?? "A body"} lies fallen (${corpse.carries.length} thing(s) it carries).` });
  });

  engine.registerHandler("corpse_loot", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    const corpse = coll<Corpse>(ctx, "corpses").get(String(ctx.op.params.corpseId ?? ""));
    if (!c || !corpse) throw reject("entity_not_found", "corpse_loot requires actor + corpseId.", {});
    const taken: string[] = [];
    for (const carry of corpse.carries) {
      if (carry.taken) continue;
      if (carry.type === "ryo") {
        c.ryo += carry.amount ?? 0;
        carry.taken = true;
        taken.push(`${carry.amount} Ryo`);
      } else if (carry.type === "gear" || carry.type === "scroll") {
        const item = carry.itemId ? ctx.engine.content.getItem(carry.itemId) : undefined;
        c.equipment.push(item ? { ...structuredClone(item), qty: 1 } : { id: carry.itemId ?? "loot", name: carry.itemId ?? "loot", qty: 1 });
        carry.taken = true;
        taken.push(carry.itemId ?? carry.type);
      }
    }
    coll(ctx, "characters").put(c);
    coll(ctx, "corpses").put(corpse);
    ctx.ir.emit("loot", { actor: c.id, data: { corpseId: corpse.id, taken }, narration: `${c.name} loots the body: ${taken.join(", ") || "nothing mundane"}.` });
  });

  engine.registerHandler("corpse_harvest", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    const corpse = coll<Corpse>(ctx, "corpses").get(String(ctx.op.params.corpseId ?? ""));
    if (!c || !corpse) throw reject("entity_not_found", "corpse_harvest requires actor + corpseId.", {});
    const what = String(ctx.op.params.what ?? "kkg");
    // KKG must be taken fresh (decay gates harvest)
    if ((what === "kkg") && corpse.decayStage !== "fresh") {
      throw reject("decayed", `The ${what} can only be harvested from a fresh body; this one is ${corpse.decayStage}.`, { decayStage: corpse.decayStage }, ["Harvest immediately after death (a real time pressure)."]);
    }
    const carry = corpse.carries.find((x) => x.type === what && !x.taken);
    if (!carry) throw reject("nothing_to_harvest", `No untaken ${what} on this body.`, { carries: corpse.carries }, ["Check what the corpse carries (corpse identify/state)."]);
    carry.taken = true;
    coll(ctx, "corpses").put(corpse);
    // taboo act: cratering the deceased's authority, spiking the rogue patron's
    const severity = carry.tabooSeverity ?? 0.7;
    const authorityDrop = Math.round(20 * severity);
    const patronGain = Math.round(15 * severity);
    let authorityStanding: any = null;
    let patronStanding: any = null;
    if (corpse.deceasedAuthorityId) {
      const l = applyStandingDelta(ctx.store, c.id, corpse.deceasedAuthorityId, { reputation: -authorityDrop, reason: `harvested ${what} from the dead` });
      authorityStanding = { authorityId: corpse.deceasedAuthorityId, reputation: l.reputation };
    }
    const patronId = ctx.op.params.patronAuthorityId as string;
    if (patronId) {
      const l = applyStandingDelta(ctx.store, c.id, patronId, { reputation: patronGain, authorityType: "patron", reason: `delivered forbidden ${what}` });
      patronStanding = { authorityId: patronId, reputation: l.reputation };
    }
    // store the harvested secret as an item/flag on the harvester
    c.equipment.push({ id: `${what}-${corpse.id}`, name: `${corpse.clan ?? corpse.name ?? "unknown"} ${what.toUpperCase()}`, type: "secret", tabooSeverity: severity, qty: 1 });
    coll(ctx, "characters").put(c);
    ctx.ir.emit("harvest", {
      actor: c.id,
      data: { corpseId: corpse.id, what, severity, authorityStanding, patronStanding },
      narration: `${c.name} harvests the ${what} — a taboo act. ${corpse.deceasedAuthorityId ?? "the dead's people"} will never forgive it; a darker patron is pleased.`,
    });
  });

  engine.registerHandler("corpse_recover", (ctx) => {
    const c = coll<Character>(ctx, "characters").get(String(ctx.op.actorId));
    const corpse = coll<Corpse>(ctx, "corpses").get(String(ctx.op.params.corpseId ?? ""));
    if (!c || !corpse) throw reject("entity_not_found", "corpse_recover requires actor + corpseId.", {});
    const toAuthority = String(ctx.op.params.toAuthorityId ?? corpse.deceasedAuthorityId ?? "");
    corpse.recovered = true;
    coll(ctx, "corpses").put(corpse);
    let standing: any = null;
    if (toAuthority) {
      const l = applyStandingDelta(ctx.store, c.id, toAuthority, { reputation: Number(ctx.op.params.honor ?? 12), reason: "returned the fallen" });
      standing = { authorityId: toAuthority, reputation: l.reputation };
    }
    ctx.ir.emit("recover", { actor: c.id, data: { corpseId: corpse.id, toAuthority, standing }, narration: `${c.name} returns ${corpse.name ?? "the body"} to ${toAuthority} — an honorable act that raises their standing.` });
  });

  engine.registerHandler("corpse_advance_decay", (ctx) => {
    const corpse = coll<Corpse>(ctx, "corpses").get(String(ctx.op.params.corpseId ?? ""));
    if (!corpse) throw reject("entity_not_found", "No such corpse.", {});
    const idx = Math.min(DECAY_ORDER.length - 1, DECAY_ORDER.indexOf(corpse.decayStage) + Number(ctx.op.params.steps ?? 1));
    corpse.decayStage = DECAY_ORDER[idx];
    coll(ctx, "corpses").put(corpse);
    ctx.ir.emit("decay", { data: { corpseId: corpse.id, decayStage: corpse.decayStage }, narration: `The body decays to ${corpse.decayStage}.` });
  });
}
