import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "./client.js";

/**
 * The MCP tool surface (Architecture §3.1). Per §9.3 the action surface IS the
 * ruleset, so the controller exposes a universal `submit_intent` seam plus
 * `batch`, plus scoped read tools. Higher-level named tools (character_manage,
 * jutsu_manage, combat_action, ...) are thin wrappers added per phase — each
 * still collapses to "submit an intent" (§3.3). The controller adds no logic.
 */
function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

export function registerTools(server: McpServer, client: EngineClient): void {
  server.registerTool(
    "submit_intent",
    {
      description:
        "Submit a structured Naruto 5e intent to the engine (the universal write seam). " +
        "type is any engine action (narrate, scene, character_create, cast, attack, advance, rest, ...). " +
        "Returns the resolved IR or a four-part educational rejection.",
      inputSchema: {
        roomId: z.string(),
        type: z.string(),
        actorId: z.string().optional(),
        params: z.record(z.any()).optional(),
        role: z.enum(["player", "dm"]).optional(),
      },
    },
    async (args) => ok(await client.submitIntent(args as any)),
  );

  server.registerTool(
    "batch",
    {
      description:
        "Submit an ordered list of intents as one sequenced transaction (the DM-ergonomics capstone). " +
        "Default stop-on-failure; atomic:true = all-or-nothing. Returns ordered IR.",
      inputSchema: {
        roomId: z.string(),
        ops: z.array(
          z.object({ type: z.string(), actorId: z.string().optional(), params: z.record(z.any()).optional() }),
        ),
        atomic: z.boolean().optional(),
        role: z.enum(["player", "dm"]).optional(),
      },
    },
    async (args) => ok(await client.batch(args as any)),
  );

  server.registerTool(
    "narrate",
    {
      description: "DM narration: emit a narrate IR line into the room's shared feed.",
      inputSchema: { roomId: z.string(), text: z.string(), actorId: z.string().optional() },
    },
    async ({ roomId, text, actorId }) =>
      ok(await client.submitIntent({ roomId, type: "narrate", actorId, params: { text } })),
  );

  server.registerTool(
    "get_room_state",
    {
      description: "Scoped read: full room snapshot (room, characters, active encounter).",
      inputSchema: { roomId: z.string() },
    },
    async ({ roomId }) => ok(await client.getRoomState(roomId)),
  );

  server.registerTool(
    "get_character",
    { description: "Scoped read: a character record by id.", inputSchema: { id: z.string() } },
    async ({ id }) => ok(await client.getCharacter(id)),
  );

  server.registerTool(
    "create_character",
    {
      description:
        "Build a Naruto 5e character end-to-end (the 7-step build in one call): clan, class, " +
        "background, abilities (method: manual|point_buy|standard_array|roll_4d6), and any required " +
        "skill/ability choices. Returns the finalized sheet or an educational rejection naming what's missing.",
      inputSchema: {
        roomId: z.string(),
        name: z.string(),
        clan: z.string().optional(),
        className: z.string().optional(),
        background: z.string().optional(),
        level: z.number().optional(),
        abilities: z.record(z.any()).optional(),
        abilityChoices: z.array(z.string()).optional(),
        bgAbilityChoice: z.string().optional(),
        clanSkillChoices: z.array(z.string()).optional(),
        classSkillChoices: z.array(z.string()).optional(),
        backgroundSkillChoices: z.array(z.string()).optional(),
      },
    },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "character_create", params })),
  );

  server.registerTool(
    "level_up",
    {
      description: "Advance a character one level (recomputes pools, proficiency, rank, new features).",
      inputSchema: { roomId: z.string(), actorId: z.string() },
    },
    async ({ roomId, actorId }) => ok(await client.submitIntent({ roomId, actorId, type: "character_level_up" })),
  );

  server.registerTool(
    "list_clans",
    { description: "List the 20 playable clan options.", inputSchema: {} },
    async () => ok(await client.listContent("clans")),
  );

  server.registerTool(
    "list_classes",
    { description: "List the 8 base classes (HD/Chakra die, saves, archetype).", inputSchema: {} },
    async () => ok(await client.listContent("classes")),
  );

  server.registerTool(
    "list_jutsu",
    {
      description: "Read the jutsu catalog, filterable by rank (E-S), classification, or name query.",
      inputSchema: {
        rank: z.string().optional(),
        classification: z.string().optional(),
        q: z.string().optional(),
      },
    },
    async (args) => ok(await client.listJutsu(args)),
  );

  // ---- Phase 2: jutsu + combat ----------------------------------------
  server.registerTool(
    "learn_jutsu",
    { description: "Teach a character a jutsu (validates the Jutsu Known cap + keyword gates).", inputSchema: { roomId: z.string(), actorId: z.string(), jutsu: z.string() } },
    async ({ roomId, actorId, jutsu }) => ok(await client.submitIntent({ roomId, actorId, type: "jutsu_learn", params: { jutsu } })),
  );

  server.registerTool(
    "cast_jutsu",
    {
      description: "Cast a jutsu (gates chakra + components + TurnBudget, then resolves attack/save/damage/conditions, upcast, concentration).",
      inputSchema: { roomId: z.string(), actorId: z.string(), jutsu: z.string(), targets: z.array(z.string()).optional(), atRank: z.string().optional() },
    },
    async ({ roomId, actorId, jutsu, targets, atRank }) => ok(await client.submitIntent({ roomId, actorId, type: "cast", params: { jutsu, targets, atRank } })),
  );

  server.registerTool(
    "attack",
    { description: "Make a weapon/taijutsu attack against a target.", inputSchema: { roomId: z.string(), actorId: z.string(), target: z.string(), damage: z.string().optional(), ability: z.string().optional() } },
    async ({ roomId, actorId, target, damage, ability }) => ok(await client.submitIntent({ roomId, actorId, type: "attack", params: { target, damage, ability } })),
  );

  server.registerTool(
    "start_combat",
    { description: "Roll initiative and begin an encounter (combatants default to all characters in the room).", inputSchema: { roomId: z.string(), combatants: z.array(z.object({ actorId: z.string(), team: z.string().optional() })).optional() } },
    async ({ roomId, combatants }) => ok(await client.submitIntent({ roomId, type: "combat_start", params: { combatants } })),
  );

  server.registerTool(
    "advance_turn",
    { description: "Advance to the next combatant (the turn authority; auto-rolls death saves for the downed).", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => ok(await client.submitIntent({ roomId, type: "advance" })),
  );

  server.registerTool(
    "get_encounter",
    { description: "Read the active encounter (order, round, active turn).", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => ok(await client.getEncounter(roomId)),
  );
}
