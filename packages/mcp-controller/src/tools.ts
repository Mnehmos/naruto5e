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

  // ---- Phase 3: missions, rest, equipment -----------------------------
  server.registerTool(
    "post_mission",
    { description: "Post a ranked (D-S) mission to the board (rewards default by rank).", inputSchema: { roomId: z.string(), title: z.string(), rank: z.string(), rewardRyo: z.number().optional(), rewardMissionPoints: z.number().optional(), brief: z.string().optional() } },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "mission_post", params })),
  );
  server.registerTool(
    "resolve_mission",
    { description: "Resolve a mission (pays Ryo + mission points to the squad on success).", inputSchema: { roomId: z.string(), missionId: z.string(), outcome: z.enum(["success", "failure"]).optional(), bonusMultiplier: z.number().optional() } },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "mission_resolve", params })),
  );
  server.registerTool(
    "rest",
    { description: "Rest a character (short: spend Hit/Chakra Dice; long: full pools + dice recovery + WoF on a mission boundary).", inputSchema: { roomId: z.string(), actorId: z.string(), type: z.enum(["short", "long"]), spendHitDice: z.number().optional(), spendChakraDice: z.number().optional(), missionBoundary: z.boolean().optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "rest", params })),
  );
  server.registerTool(
    "buy_item",
    { description: "Buy an item with Ryo (educational rejection if unaffordable).", inputSchema: { roomId: z.string(), actorId: z.string(), item: z.string(), qty: z.number().optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "buy", params })),
  );
  server.registerTool(
    "equip_item",
    { description: "Equip a carried weapon/armor (recomputes AC).", inputSchema: { roomId: z.string(), actorId: z.string(), item: z.string() } },
    async ({ roomId, actorId, item }) => ok(await client.submitIntent({ roomId, actorId, type: "equip", params: { item } })),
  );

  // ---- Phase 4: adversaries -------------------------------------------
  server.registerTool(
    "spawn_adversary",
    {
      description: "Spawn a tier-scaled adversary (minion/elite/solo) via the 8-step build. Solo gets Legendary Actions/Resistance + Phase Transitions; Elite gets an extra action.",
      inputSchema: { roomId: z.string(), name: z.string(), tier: z.enum(["minion", "elite", "solo"]), role: z.string().optional(), clan: z.string().optional(), level: z.number(), partySize: z.number().optional(), jutsu: z.array(z.string()).optional(), traits: z.array(z.string()).optional() },
    },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "adversary_spawn", params })),
  );
  server.registerTool(
    "from_bingo_book",
    { description: "Instantiate a premade Bingo Book foe (Genin, Chunin, Anbu, Zabuza, Haku, Itachi, ...), optionally scaled.", inputSchema: { roomId: z.string(), name: z.string(), level: z.number().optional(), partySize: z.number().optional() } },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "from_bingo_book", params })),
  );
  server.registerTool(
    "freeform_attack",
    { description: "An adversary's tier/level-scaled freeform attack on a target.", inputSchema: { roomId: z.string(), actorId: z.string(), target: z.string(), descriptor: z.string().optional() } },
    async ({ roomId, actorId, target, descriptor }) => ok(await client.submitIntent({ roomId, actorId, type: "freeform_attack", params: { target, descriptor } })),
  );
  server.registerTool(
    "legendary_action",
    { description: "A Solo boss spends a Legendary Action off-turn (action: freeform_attack|cast|move).", inputSchema: { roomId: z.string(), actorId: z.string(), action: z.string(), params: z.record(z.any()).optional() } },
    async ({ roomId, actorId, action, params }) => ok(await client.submitIntent({ roomId, actorId, type: "legendary_action", params: { action, params } })),
  );

  // ---- Phase 5: customization -----------------------------------------
  server.registerTool(
    "multiclass",
    { description: "Take a level in a new class (validates ability prereqs; recomputes pools/jutsu-known).", inputSchema: { roomId: z.string(), actorId: z.string(), intoClass: z.string() } },
    async ({ roomId, actorId, intoClass }) => ok(await client.submitIntent({ roomId, actorId, type: "character_multiclass", params: { intoClass } })),
  );
  server.registerTool(
    "take_feat",
    { description: "Take a feat (in place of an ASI; validates prereqs, applies the feat's ability increase).", inputSchema: { roomId: z.string(), actorId: z.string(), feat: z.string(), abilityChoice: z.string().optional() } },
    async ({ roomId, actorId, feat, abilityChoice }) => ok(await client.submitIntent({ roomId, actorId, type: "take_feat", params: { feat, abilityChoice } })),
  );
  server.registerTool(
    "list_feats",
    { description: "Browse the feat catalog (optionally filter by name).", inputSchema: { q: z.string().optional() } },
    async ({ q }) => ok(await client.listContentQuery("feats", q)),
  );
}
