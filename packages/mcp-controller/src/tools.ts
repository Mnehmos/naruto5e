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
}
