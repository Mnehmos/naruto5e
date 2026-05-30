import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "./client.js";
import * as lifecycle from "./engine-process.js";

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
        "ORDER MATTERS: ops run top-to-bottom against evolving state, so an earlier op's effect is visible to a later one. " +
        "Default stop-on-failure (commits up to the first failure, returns the rest + reason); atomic:true = all-or-nothing; " +
        "dryRun:true = run the ordered sequence and ROLL BACK, returning the would-be IR so you can validate the plan/ordering before committing (nothing persists). " +
        "REF-THREADING: an op may set `bind:\"name\"`; a later op can reference the id it created as \"$name\" (whole value) or \"${name}\" (in a string), or positionally as \"$0\",\"$1\". " +
        "So you can create-then-use in one batch (e.g. spawn a boss with bind:\"boss\", then target \"$boss\") without a round-trip. Returns ordered IR.",
      inputSchema: {
        roomId: z.string(),
        ops: z.array(
          z.object({ type: z.string(), actorId: z.string().optional(), params: z.record(z.any()).optional(), bind: z.string().optional() }),
        ),
        atomic: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        role: z.enum(["player", "dm"]).optional(),
      },
    },
    async (args) => ok(await client.batch(args as any)),
  );

  server.registerTool(
    "npc_manage",
    {
      description:
        "NPC management (consolidated action-router). Actions: " +
        "create {name, authorityId?} — add an NPC; " +
        "interact {npcId, beat, dispositionDelta?, familiarityDelta?, importance?(low|notable|defining), topics?, witnessed?, standingDelta?} — record an interaction (a standingDelta writes the NPC's authority ledger), bumps interactionCount; " +
        "learn_fact {npcId, fact} — the NPC now knows a fact; " +
        "get_relationship {npcId} — raw relationship + derived attitude/closeness tiers; " +
        "context {npcId, limit?, minImportance?, topic?} — an LLM-ready summary (attitude/closeness tiers + salient topic/importance-filtered memories + known facts + Standing) to roleplay the NPC consistently in one read.",
      inputSchema: {
        roomId: z.string(),
        action: z.enum(["create", "interact", "learn_fact", "get_relationship", "context"]),
        actorId: z.string().optional(),
        npcId: z.string().optional(),
        name: z.string().optional(),
        authorityId: z.string().optional(),
        beat: z.string().optional(),
        fact: z.string().optional(),
        dispositionDelta: z.number().optional(),
        familiarityDelta: z.number().optional(),
        importance: z.enum(["low", "notable", "defining"]).optional(),
        topics: z.array(z.string()).optional(),
        witnessed: z.boolean().optional(),
        standingDelta: z.object({ authorityId: z.string(), reputation: z.number().optional(), favor: z.number().optional() }).optional(),
        limit: z.number().optional(),
        minImportance: z.enum(["low", "notable", "defining"]).optional(),
        topic: z.string().optional(),
      },
    },
    async ({ roomId, action, actorId, ...rest }) => {
      const type = { create: "npc_create", interact: "npc_interact", learn_fact: "npc_learn_fact", get_relationship: "npc_get_relationship", context: "npc_context" }[action];
      return ok(await client.submitIntent({ roomId, actorId, type, params: rest }));
    },
  );

  server.registerTool(
    "server_manage",
    {
      description:
        "Manage the tier-1 engine server lifecycle (dev ergonomics). " +
        "action: status (is the engine reachable on NARUTO_ENGINE_URL — returns /v1/health), " +
        "start (spawn a DETACHED engine that outlives the controller; no-op if already healthy), " +
        "stop (kill the tracked engine PID, with a kill-by-port fallback), " +
        "restart (stop then start). PORT is derived from the engine URL; SQLite state in data/ survives a restart. " +
        "Use this when game tools return 'fetch failed' (engine down).",
      inputSchema: {
        action: z.enum(["status", "start", "stop", "restart"]),
        dbDriver: z.enum(["sqlite", "memory"]).optional(),
      },
    },
    async ({ action, dbDriver }) => ok(await lifecycle.manage(action, client.url, { dbDriver })),
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

  // ---- Phase 6: Standing / RPP ----------------------------------------
  server.registerTool(
    "grant_standing",
    { description: "Award reputation (threshold: what's offered) or favor (spendable, capped) with an authority.", inputSchema: { roomId: z.string(), actorId: z.string(), authorityId: z.string(), reputation: z.number().optional(), favor: z.number().optional(), authorityType: z.string().optional(), reason: z.string().optional() } },
    async ({ roomId, actorId, authorityId, reputation, favor, authorityType, reason }) => {
      const out: any[] = [];
      if (reputation) out.push(await client.submitIntent({ roomId, actorId, type: "grant_reputation", params: { authorityId, amount: reputation, authorityType, reason } }));
      if (favor) out.push(await client.submitIntent({ roomId, actorId, type: "grant_favor", params: { authorityId, amount: favor, authorityType } }));
      return ok(out);
    },
  );
  server.registerTool(
    "spend_favor",
    { description: "Cash favor to be taught/granted a gated thing.", inputSchema: { roomId: z.string(), actorId: z.string(), authorityId: z.string(), amount: z.number(), on: z.string() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "spend_favor", params })),
  );
  server.registerTool(
    "check_access",
    { description: "Does the character's reputation meet the threshold to be OFFERED gated content?", inputSchema: { roomId: z.string(), actorId: z.string(), authorityId: z.string(), minReputation: z.number(), what: z.string().optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "check_access", params })),
  );
  server.registerTool(
    "defect",
    { description: "The rogue path — crater the old authority's ledger and open a patron's (a missing-nin).", inputSchema: { roomId: z.string(), actorId: z.string(), fromAuthority: z.string(), toAuthority: z.string() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "defect", params })),
  );
  server.registerTool(
    "get_ledgers",
    { description: "Read all of a character's per-authority Standing ledgers (with soft descriptors).", inputSchema: { roomId: z.string(), actorId: z.string() } },
    async ({ roomId, actorId }) => ok(await client.submitIntent({ roomId, actorId, type: "get_ledgers" })),
  );

  // ---- Phase 7: world-consequence systems -----------------------------
  server.registerTool(
    "npc_interact",
    { description: "Record an NPC interaction (memory). A standingDelta writes into that NPC's authority ledger.", inputSchema: { roomId: z.string(), actorId: z.string(), npcId: z.string(), beat: z.string(), importance: z.string().optional(), dispositionDelta: z.number().optional(), standingDelta: z.object({ authorityId: z.string(), reputation: z.number().optional(), favor: z.number().optional() }).optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "npc_interact", params })),
  );
  server.registerTool(
    "economy_buy",
    { description: "Buy from a vendor (gated stock checks Standing; high reputation discounts).", inputSchema: { roomId: z.string(), actorId: z.string(), vendorId: z.string(), item: z.string() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "economy_buy", params })),
  );
  server.registerTool(
    "steal",
    { description: "Steal an item (sets heat, records witnesses). Getting reported damages Standing with the jurisdiction.", inputSchema: { roomId: z.string(), actorId: z.string(), item: z.string(), jurisdictionAuthorityId: z.string(), witnesses: z.array(z.string()).optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "theft_steal", params })),
  );
  server.registerTool(
    "harvest_corpse",
    { description: "Harvest a weighted secret (KKG/clan secret/scroll) from a body — craters the deceased's authority, spikes the patron's (the rogue trade-off). KKG needs a fresh body.", inputSchema: { roomId: z.string(), actorId: z.string(), corpseId: z.string(), what: z.string(), patronAuthorityId: z.string().optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "corpse_harvest", params })),
  );
  server.registerTool(
    "recover_corpse",
    { description: "Return a body to its authority — an honorable, Standing-positive act.", inputSchema: { roomId: z.string(), actorId: z.string(), corpseId: z.string(), toAuthorityId: z.string().optional(), honor: z.number().optional() } },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "corpse_recover", params })),
  );

  // ---- Phase 8: content tools -----------------------------------------
  server.registerTool(
    "jutsu_build",
    {
      description: "Author a balanced jutsu via the empirical point model. op: draft|price|rerank|commit. Returns a canon Ch.9 record + points + green/yellow/red verdict.",
      inputSchema: { roomId: z.string(), op: z.string().optional(), rank: z.string().optional(), classification: z.string().optional(), name: z.string().optional(), effects: z.record(z.any()).optional(), record: z.record(z.any()).optional(), targetRank: z.string().optional() },
    },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "jutsu_build", params })),
  );
  server.registerTool(
    "freeform",
    {
      description: "Conform an improvised action into a priced, castable primitive (op: resolve|cost). Shares the jutsu_build pricing engine so a one-off can't out-power a real jutsu.",
      inputSchema: { roomId: z.string(), actorId: z.string().optional(), op: z.string().optional(), description: z.string().optional(), classification: z.string().optional(), rank: z.string().optional(), effects: z.record(z.any()).optional(), targets: z.array(z.string()).optional() },
    },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "freeform", params })),
  );

  // ---- state management + discoverability -----------------------------
  server.registerTool(
    "list_actions",
    { description: "List every engine action verb (the full intent vocabulary) — use when unsure what to submit.", inputSchema: {} },
    async () => ok(await client.listActions()),
  );
  server.registerTool(
    "end_combat",
    { description: "End the active encounter (drops the room back to scene mode).", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => ok(await client.submitIntent({ roomId, type: "combat_end" })),
  );
  server.registerTool(
    "reset_room",
    { description: "Clear all entities (characters, adversaries, encounters, missions, NPCs, vendors, corpses) in a room and return it to scene mode.", inputSchema: { roomId: z.string() } },
    async ({ roomId }) => ok(await client.submitIntent({ roomId, type: "room_reset" })),
  );
  server.registerTool(
    "reset_world",
    { description: "Wipe ALL game state across every room/collection — a full clean slate.", inputSchema: { roomId: z.string().optional() } },
    async ({ roomId }) => ok(await client.submitIntent({ roomId: roomId ?? "system", type: "world_reset" })),
  );
  server.registerTool(
    "delete_character",
    { description: "Delete a character/adversary by id (also removes it from the active encounter).", inputSchema: { roomId: z.string(), id: z.string() } },
    async ({ roomId, id }) => ok(await client.submitIntent({ roomId, type: "character_delete", params: { id } })),
  );

  // ---- Phase 9: the world tick (also embedded in rest) ----------------
  server.registerTool(
    "tick_preview",
    { description: "Preview which NPC agents a tick would call (by proximity + stake + magnitude), without resolving.", inputSchema: { roomId: z.string(), trigger: z.string().optional() } },
    async ({ roomId, trigger }) => ok(await client.submitIntent({ roomId, type: "tick_preview", params: { trigger } })),
  );
  server.registerTool(
    "tick_run",
    { description: "Run a standalone world tick (the rest tool embeds this automatically). Returns tick + playerDigest.", inputSchema: { roomId: z.string(), trigger: z.string().optional() } },
    async ({ roomId, trigger }) => ok(await client.submitIntent({ roomId, type: "tick_run", params: { trigger } })),
  );
}
