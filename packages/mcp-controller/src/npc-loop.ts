/**
 * The autonomous NPC intent loop (controller side): given an NPC's free-text declaration,
 * fetch the engine's affordances, CONFORM the declaration to a legal intent, SUBMIT it so the
 * engine resolves ground truth, and JOURNAL declaration + outcome together. A declaration is
 * an attempt; only the engine's result is canon. Pure conformance lives in npc-intent.ts; this
 * adds the engine round-trips.
 */
import type { EngineClient } from "./client.js";
import { conformNpcDeclaration, type ConformAffordances, type ConformResult } from "./npc-intent.js";

export type NpcMode = "tick" | "scene" | "combat" | "downtime";

export interface NpcTurnResult {
  npcId: string;
  name?: string;
  mode: NpcMode;
  declaration: string;
  conformance: ConformResult;
  resolution?: { status: string; events?: unknown[]; rejection?: unknown };
  journaled: boolean;
}

function eventData(result: any, ...types: string[]): any {
  const ev = (result?.events ?? []).find((e: any) => types.includes(e.type));
  return ev?.data;
}

function summarizeOutcome(result: any): string {
  if (!result) return "no engine response";
  if (result.status === "rejected") return `rejected (${result.reason?.rule ?? "illegal"}): ${result.reason?.explain ?? ""}`.trim();
  const narrations = (result.events ?? []).map((e: any) => e.narration).filter(Boolean);
  return narrations.join(" ") || "resolved";
}

/** Pull a conformance-ready affordance bundle from the engine for this NPC/combatant. */
export async function fetchAffordances(client: EngineClient, roomId: string, npcId: string, actorId: string | undefined, mode: NpcMode): Promise<{ aff: ConformAffordances; name?: string }> {
  if (mode === "combat" && actorId) {
    const r = await client.submitIntent({ roomId, actorId, type: "agent_context", params: {} });
    const d = eventData(r, "agent_context");
    return { aff: { jutsu: d?.affordances?.jutsu, allies: d?.scene?.allies, threats: d?.scene?.threats, actions: undefined }, name: d?.identity?.name };
  }
  const r = await client.submitIntent({ roomId, type: "npc_decide", params: { npcId } });
  const d = eventData(r, "npc_decision");
  return { aff: { actions: d?.affordances?.actions, present: d?.scene?.present, threats: d?.scene?.threats }, name: d?.npc?.name };
}

/**
 * Conform → submit → journal a single NPC declaration. Returns the full
 * declaration/conformance/resolution record (the brief's result shape).
 */
export async function resolveNpcDeclaration(
  client: EngineClient,
  args: { roomId: string; npcId: string; actorId?: string; declaration: string; mode: NpcMode; affordances?: ConformAffordances; name?: string },
): Promise<NpcTurnResult> {
  let aff = args.affordances;
  let name = args.name;
  if (!aff) {
    const fetched = await fetchAffordances(client, args.roomId, args.npcId, args.actorId, args.mode);
    aff = fetched.aff;
    name = name ?? fetched.name;
  }
  const conformance = conformNpcDeclaration({ declaration: args.declaration, npcId: args.npcId, actorId: args.actorId, roomId: args.roomId, mode: args.mode, affordances: aff });

  if (conformance.status !== "conformed") {
    // needs_dm_repair: record the ATTEMPT, mutate nothing. The DM (or a re-prompt) repairs it.
    await client.submitIntent({ roomId: args.roomId, type: "npc_add_journal", params: { npcId: args.npcId, entry: `Tried (needs DM): "${args.declaration}" — ${conformance.reason}` } });
    return { npcId: args.npcId, name, mode: args.mode, declaration: args.declaration, conformance, journaled: true };
  }

  const intent = conformance.intent;
  const res = await client.submitIntent({ roomId: args.roomId, actorId: intent.actorId, type: intent.type, params: intent.params });
  const resolution = { status: res?.status, events: res?.events, rejection: res?.reason };
  // the conformed reflection intent (npc_add_journal) already wrote the journal — don't double-log.
  if (intent.type !== "npc_add_journal") {
    await client.submitIntent({ roomId: args.roomId, type: "npc_add_journal", params: { npcId: args.npcId, entry: `Declared: "${args.declaration}" → ${summarizeOutcome(res)}` } });
  }
  return { npcId: args.npcId, name, mode: args.mode, declaration: args.declaration, conformance, resolution, journaled: true };
}
