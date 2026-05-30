import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Npc } from "../domain/world.js";
import { DECAY_ORDER, NpcRelationshipSchema, type Corpse, type NpcRelationship, type StolenItem } from "../domain/world.js";
import { applyStandingDelta } from "../rules/standing.js";

export type Magnitude = "small" | "medium" | "large";

export function magnitudeForRest(type: string): Magnitude {
  if (type === "downtime") return "large";
  if (type === "long") return "medium";
  return "small";
}

const AGENT_CAP: Record<Magnitude, number> = { small: 2, medium: 4, large: 99 };
const HEAT_STEPS: Record<Magnitude, number> = { small: 0, medium: 1, large: 4 };
const DECAY_STEPS: Record<Magnitude, number> = { small: 0, medium: 1, large: 2 };

/**
 * The Tick (Architecture §12-13): a rest-bounded, multi-agent off-screen world
 * advancement. Time advances only when the fiction pauses. Off-screen ticks
 * mutate world state silently; the DM narrates only the player-relevant digest.
 *
 * The engine is deterministic and hosts no LLMs, so the per-NPC "agent" actions
 * here are a deterministic stand-in (priced like any actor's). In the full
 * three-tier deployment the LLM tier supplies richer agent intents via
 * tick.run/agent.tick; the DM conforms them and submits tick.resolve. This
 * embedded path lets the world advance autonomously so the loop always runs.
 */
export interface TickResult {
  magnitude: Magnitude;
  agentsCalled: { npcId: string; name: string; action: string }[];
  resolved: { op: string; detail: string }[];
  consequenceDeltas: {
    standing: { authorityId: string; charId: string; reputationDelta: number; why: string }[];
    heatDecay: { stolenId: string; heat: string }[];
    corpseDecay: { corpseId: string; decayStage: string }[];
    economyDrift: string[];
    npcMemories: { npcId: string; summary: string }[];
  };
}

export function runEmbeddedTick(ctx: ResolveContext, magnitude: Magnitude, playerIds: string[]): { tick: TickResult; playerDigest: string[] } {
  const tick: TickResult = {
    magnitude,
    agentsCalled: [],
    resolved: [],
    consequenceDeltas: { standing: [], heatDecay: [], corpseDecay: [], economyDrift: [], npcMemories: [] },
  };
  const digest: string[] = [];
  const playerSet = new Set(playerIds);

  // ---- theft heat decay (long: a step; downtime: fully cools) ----
  const heatSteps = HEAT_STEPS[magnitude];
  if (heatSteps > 0) {
    const order = ["burning", "hot", "warm", "cold"];
    for (const s of ctx.store.collection<StolenItem>("stolen_items").list()) {
      const idx = Math.min(order.length - 1, order.indexOf(s.heat) + heatSteps);
      if (order[idx] !== s.heat) {
        s.heat = order[idx] as any;
        ctx.store.collection<StolenItem>("stolen_items").put(s);
        tick.consequenceDeltas.heatDecay.push({ stolenId: s.id, heat: s.heat });
        tick.resolved.push({ op: "heat_decay", detail: `${s.itemId} heat -> ${s.heat}` });
        if (playerSet.has(s.stolenBy)) digest.push(`The heat on your stolen ${s.itemId} cools to ${s.heat}.`);
      }
    }
  }

  // ---- corpse decay ----
  const decaySteps = DECAY_STEPS[magnitude];
  if (decaySteps > 0) {
    for (const c of ctx.store.collection<Corpse>("corpses").list()) {
      if (c.recovered) continue;
      const idx = Math.min(DECAY_ORDER.length - 1, DECAY_ORDER.indexOf(c.decayStage) + decaySteps);
      if (DECAY_ORDER[idx] !== c.decayStage) {
        c.decayStage = DECAY_ORDER[idx];
        ctx.store.collection<Corpse>("corpses").put(c);
        tick.consequenceDeltas.corpseDecay.push({ corpseId: c.id, decayStage: c.decayStage });
        tick.resolved.push({ op: "corpse_decay", detail: `${c.name ?? c.id} -> ${c.decayStage}` });
      }
    }
  }

  // ---- in-scope NPC agents act: goal-driven where an agenda exists, else generic ----
  const PROGRESS_STEP: Record<Magnitude, number> = { small: 5, medium: 15, large: 40 };
  const STANDING_BASE: Record<Magnitude, number> = { small: 1, medium: 2, large: 3 };
  const relId = (npcId: string, actorId: string) => `${npcId}:${actorId}`;
  const npcs = ctx.store.collection<Npc>("npcs").find((n) => n.roomId === ctx.room.id);
  const inScope = npcs.slice(0, AGENT_CAP[magnitude]);
  for (const npc of inScope) {
    const goal = (npc.goals ?? []).find((g) => !g.done);
    if (goal) {
      const target = goal.targetActorId ?? playerIds[0];
      const authority = goal.targetAuthorityId ?? npc.authorityId;
      let action = `pursues "${goal.text}"`;
      // directed drives move a Standing ledger AND the NPC's memory of the target
      if ((goal.drive === "advance" || goal.drive === "undermine" || goal.drive === "protect") && target && authority) {
        const dir = goal.drive === "undermine" ? -1 : 1;
        const delta = dir * Math.max(1, Math.round(STANDING_BASE[magnitude] * (goal.intensity ?? 1)));
        const l = applyStandingDelta(ctx.store, target, authority, { reputation: delta, reason: `${npc.name}: ${goal.text}` });
        tick.consequenceDeltas.standing.push({ authorityId: authority, charId: target, reputationDelta: delta, why: goal.text });
        tick.resolved.push({ op: "standing", detail: `${authority} ${delta >= 0 ? "+" : ""}${delta} (${npc.name})` });
        // surface the "why" as an off-screen NPC memory toward the target
        const rels = ctx.store.collection<NpcRelationship>("npc_relationships");
        let rel = rels.get(relId(npc.id, target));
        if (!rel) rel = NpcRelationshipSchema.parse({ id: relId(npc.id, target), npcId: npc.id, actorId: target, authorityId: npc.authorityId });
        rel.disposition = Math.max(-100, Math.min(100, rel.disposition + (dir > 0 ? 3 : -3)));
        rel.memories.push({ eventId: `mem_tick_${npc.id}_${goal.id}_${goal.progress}`, summary: `off-screen: ${goal.text}`, importance: "notable", topics: ["offscreen", goal.drive], sentiment: dir * 3, witnessed: false });
        rels.put(rel);
        tick.consequenceDeltas.npcMemories.push({ npcId: npc.id, summary: goal.text });
        if (playerSet.has(target)) digest.push(dir > 0 ? `${npc.name} advanced your standing with ${authority} (now ${l.reputation}).` : `${npc.name} worked against you with ${authority} (now ${l.reputation}).`);
        action = goal.drive === "undermine" ? `schemes against ${target}` : goal.drive === "protect" ? `watches over ${target}` : `advocates for ${target}`;
      }
      goal.progress = Math.min(100, (goal.progress ?? 0) + Math.round(PROGRESS_STEP[magnitude] * (goal.intensity ?? 1)));
      if (goal.progress >= 100 && !goal.done) {
        goal.done = true;
        tick.resolved.push({ op: "npc_goal", detail: `${npc.name} achieved: ${goal.text}` });
        tick.consequenceDeltas.npcMemories.push({ npcId: npc.id, summary: `achieved: ${goal.text}` });
        digest.push(`${npc.name} has achieved their aim: ${goal.text}.`);
      }
      ctx.store.collection<Npc>("npcs").put(npc);
      tick.agentsCalled.push({ npcId: npc.id, name: npc.name, action });
      continue;
    }
    // generic fallback for goal-less NPCs (deterministic, seeded by the room RNG)
    const roll = ctx.rng.int(0, 99);
    let action: string;
    if (roll < 30) {
      action = "patrols the vicinity";
    } else if (roll < 55) {
      action = "trains / advances their own goals";
    } else if (roll < 75 && npc.authorityId) {
      const target = playerIds[0];
      if (target) {
        const delta = magnitude === "large" ? ctx.rng.int(-3, 4) : ctx.rng.int(-1, 2);
        if (delta !== 0) {
          const l = applyStandingDelta(ctx.store, target, npc.authorityId, { reputation: delta, reason: `${npc.name}'s off-screen actions` });
          tick.consequenceDeltas.standing.push({ authorityId: npc.authorityId, charId: target, reputationDelta: delta, why: `${npc.name} acted` });
          tick.resolved.push({ op: "standing", detail: `${npc.authorityId} ${delta >= 0 ? "+" : ""}${delta}` });
          if (delta > 0) digest.push(`Word reaches you: ${npc.name} spoke well of you (${npc.authorityId} standing ${l.reputation}).`);
          else digest.push(`${npc.name} has been grumbling about you (${npc.authorityId} standing ${l.reputation}).`);
        }
      }
      action = "leverages their standing";
    } else {
      action = "leaves a message for the squad";
      digest.push(`${npc.name} left a message while you rested.`);
    }
    tick.agentsCalled.push({ npcId: npc.id, name: npc.name, action });
  }

  // ---- economy drift (downtime restocks; long: minor) ----
  if (magnitude === "large") {
    tick.consequenceDeltas.economyDrift.push("Vendors restock; gated stock refreshes; fence heat capacity resets.");
    tick.resolved.push({ op: "economy_drift", detail: "restock" });
  } else if (magnitude === "medium") {
    tick.consequenceDeltas.economyDrift.push("Prices drift slightly overnight.");
  }

  return { tick, playerDigest: digest };
}

export function registerTickIntents(engine: Engine): void {
  engine.registerHandler("tick_preview", (ctx) => {
    const magnitude = (ctx.op.params.magnitude as Magnitude) ?? magnitudeForRest(String(ctx.op.params.trigger ?? "long"));
    const npcs = ctx.store.collection<Npc>("npcs").find((n) => n.roomId === ctx.room.id).slice(0, AGENT_CAP[magnitude]);
    ctx.ir.emit("tick_preview", {
      data: { magnitude, agentsInScope: npcs.map((n) => ({ npcId: n.id, name: n.name, authorityId: n.authorityId })), stakes: "proximity + stake, bounded by magnitude" },
      narration: `A ${magnitude} tick would call ${npcs.length} agent(s).`,
    });
  });

  engine.registerHandler("tick_run", (ctx) => {
    // The engine selects in-scope agents and (LLM tier absent) emits deterministic
    // declared intents for the DM to conform; or resolve immediately if requested.
    const magnitude = (ctx.op.params.magnitude as Magnitude) ?? magnitudeForRest(String(ctx.op.params.trigger ?? "long"));
    const playerIds = ctx.store.collection<any>("characters").find((c) => c.roomId === ctx.room.id && c.isPC).map((c) => c.id);
    const { tick, playerDigest } = runEmbeddedTick(ctx, magnitude, playerIds);
    ctx.ir.emit("tick", { data: { tick }, narration: `Tick (${magnitude}): ${tick.agentsCalled.length} agents acted; ${tick.resolved.length} world ops resolved.` });
    ctx.ir.emit("player_digest", { data: { playerDigest }, narration: playerDigest.join(" ") || "(nothing surfaces to the players)" });
  });

  engine.registerHandler("tick_resolve", (ctx) => {
    // Resolve a DM-conformed batch of NPC/world ops (the LLM-supplied path).
    const ops = (ctx.op.params.ops as any[]) ?? [];
    if (!ops.length) throw reject("no_ops", "tick_resolve expects a conformed batch of NPC/world ops (params.ops).", {}, ["Use tick_run/preview, conform agent intents, then submit them here (or as a batch)."]);
    // delegate each op to its handler (sequenced)
    for (const op of ops) {
      const handler = ctx.engine.getHandler(String(op.type));
      if (handler) handler({ ...ctx, op: { type: op.type, actorId: op.actorId, params: op.params ?? {} } });
    }
    ctx.ir.emit("tick_resolved", { data: { count: ops.length } });
  });
}
