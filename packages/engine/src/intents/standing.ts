import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { softDescriptor, type StandingLedger } from "../domain/standing.js";
import { applyStandingDelta, ensureLedger, getLedger, getLedgersFor } from "../rules/standing.js";

function requireChar(ctx: ResolveContext, id: string | undefined): Character {
  const c = ctx.store.collection<Character>("characters").get(String(id));
  if (!c) throw reject("actor_required", "This standing op requires a valid character id.", { id }, ["Set actorId to a character."]);
  return c;
}

/** standing_manage — per-authority reputation + favor, gating, the rogue path. */
export function registerStandingIntents(engine: Engine): void {
  engine.registerHandler("grant_reputation", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    if (!authorityId) throw reject("authority_required", "grant_reputation requires params.authorityId.", {}, ["Name the authority (e.g. leaf_village)."]);
    const amount = Number(ctx.op.params.amount ?? 0);
    const l = applyStandingDelta(ctx.store, c.id, authorityId, { reputation: amount, authorityType: ctx.op.params.authorityType as any });
    ctx.ir.emit("standing", { actor: c.id, data: { authorityId, reputation: l.reputation, favor: l.favor, reason: ctx.op.params.reason, descriptor: softDescriptor(l.reputation, l.hostile) }, narration: `${c.name}'s standing with ${authorityId} rises to ${l.reputation} — ${softDescriptor(l.reputation, l.hostile)}.` });
  });

  engine.registerHandler("grant_favor", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    const amount = Number(ctx.op.params.amount ?? 0);
    const l = applyStandingDelta(ctx.store, c.id, authorityId, { favor: amount, authorityType: ctx.op.params.authorityType as any });
    ctx.ir.emit("standing", { actor: c.id, data: { authorityId, favor: l.favor, favorCap: l.favorCap, capped: l.favor === l.favorCap }, narration: `${c.name} is granted favor with ${authorityId} (now ${l.favor}/${l.favorCap}).` });
  });

  engine.registerHandler("spend_favor", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    const amount = Number(ctx.op.params.amount ?? 1);
    const on = String(ctx.op.params.on ?? "a gated boon");
    const l = getLedger(ctx.store, c.id, authorityId);
    if (!l || l.favor < amount) {
      throw reject("insufficient_favor", `${c.name} has ${l?.favor ?? 0} favor with ${authorityId}; spending ${amount} on "${on}" requires more.`, { required: amount, available: l?.favor ?? 0 }, ["Earn favor through service, or spend less."]);
    }
    l.favor -= amount;
    ctx.store.collection<StandingLedger>("standings").put(l);
    ctx.ir.emit("standing", { actor: c.id, data: { authorityId, favor: l.favor, spentOn: on, amount }, narration: `${c.name} spends ${amount} favor with ${authorityId} to be granted ${on}.` });
  });

  engine.registerHandler("check_access", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    const minReputation = Number(ctx.op.params.minReputation ?? (ctx.op.params.requirement as any)?.minReputation ?? 0);
    const l = getLedger(ctx.store, c.id, authorityId);
    const rep = l?.reputation ?? 0;
    const offered = rep >= minReputation && !(l?.hostile);
    ctx.ir.emit("access", { actor: c.id, data: { authorityId, reputation: rep, minReputation, offered, what: ctx.op.params.what }, narration: offered ? `${authorityId} will offer ${ctx.op.params.what ?? "it"} to ${c.name}.` : `${c.name}'s standing with ${authorityId} (${rep}) is below the threshold (${minReputation}) — not offered.` });
  });

  engine.registerHandler("add_obligation", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    const duty = String(ctx.op.params.duty ?? "duty rotation");
    const l = ensureLedger(ctx.store, c.id, authorityId, ctx.op.params.authorityType as any);
    l.obligations.push({ duty, leaveCost: Number(ctx.op.params.leaveCost ?? 1) });
    ctx.store.collection<StandingLedger>("standings").put(l);
    ctx.ir.emit("obligation", { actor: c.id, data: { authorityId, duty, obligations: l.obligations }, narration: `${c.name} is assigned ${duty} by ${authorityId} (claims leave).` });
  });

  engine.registerHandler("discharge_obligation", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    const l = getLedger(ctx.store, c.id, authorityId);
    if (l) {
      const duty = String(ctx.op.params.duty ?? "");
      l.obligations = duty ? l.obligations.filter((o) => o.duty !== duty) : [];
      ctx.store.collection<StandingLedger>("standings").put(l);
    }
    ctx.ir.emit("obligation", { actor: c.id, data: { authorityId, discharged: ctx.op.params.duty }, narration: `${c.name} discharges an obligation to ${authorityId}.` });
  });

  // The rogue path: defection is a ledger SWAP, not an escape.
  engine.registerHandler("defect", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const from = String(ctx.op.params.fromAuthority ?? "");
    const to = String(ctx.op.params.toAuthority ?? "");
    if (!from || !to) throw reject("defect_params", "defect requires fromAuthority and toAuthority.", {}, ["Name the old village/authority and the new patron."]);
    const old = ensureLedger(ctx.store, c.id, from);
    old.reputation = Math.min(old.reputation, -50);
    old.hostile = true;
    old.favor = 0;
    ctx.store.collection<StandingLedger>("standings").put(old);
    const patron = ensureLedger(ctx.store, c.id, to, "patron");
    patron.reputation = Math.max(patron.reputation, Number(ctx.op.params.startingReputation ?? 10));
    patron.favor = Number(ctx.op.params.startingFavor ?? 1);
    ctx.store.collection<StandingLedger>("standings").put(patron);
    (c as any).rogue = true;
    ctx.store.collection<Character>("characters").put(c);
    ctx.ir.emit("defect", {
      actor: c.id,
      data: { from, to, fromReputation: old.reputation, toReputation: patron.reputation },
      narration: `${c.name} defects: ${from} brands them a missing-nin (standing craters to ${old.reputation}); ${to} becomes their new — and predatory — patron.`,
    });
  });

  engine.registerHandler("get_ledgers", (ctx) => {
    const c = requireChar(ctx, ctx.op.actorId);
    const ledgers = getLedgersFor(ctx.store, c.id).map((l) => ({ ...l, descriptor: softDescriptor(l.reputation, l.hostile) }));
    ctx.ir.emit("ledgers", { actor: c.id, data: { ledgers } });
  });
}
