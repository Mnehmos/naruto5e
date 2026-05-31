import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EngineClient } from "./client.js";
import * as lifecycle from "./engine-process.js";
import { openaiChat } from "./openai.js";
import { resolveNpcDeclaration, type NpcMode } from "./npc-loop.js";

const NPC_MODEL = () => process.env.NARUTO_NPC_MODEL ?? "gpt-5.4-mini";

/**
 * After a rest/tick, the engine emits tick.agentPrompts — composed prompts for the in-scope
 * LLM agent-NPCs. Each is a cheap "what do you do?" call: invoke the model (the engine hosts
 * no LLM) and record the NPC's declaration ("I do this").
 *
 * PRIMARY path (default): the declaration is journaled and returned — the DM (the orchestrating
 * LLM with this MCP tool surface) ADJUDICATES it the same way it adjudicates a player's natural
 * language: read "I do this", submit the matching intent(s) through the engine. NPCs use the
 * same tool surface as the player; the DM is the adjudicator.
 *
 * OPT-IN (resolve:true): for HEADLESS/autonomous runs (cron, no DM-LLM in the loop), conform the
 * declaration deterministically (npc-loop/npc-intent) and submit it so the world still moves
 * unattended. This is a fallback for the DM's adjudication, not the assumed path. Either way the
 * deterministic embedded tick already advanced goals/standing, so the world moves with no key.
 */
async function invokeTickAgents(client: EngineClient, roomId: string, result: any, resolve = false): Promise<{ invoked: any[]; note?: string }> {
  const ev = (result.events ?? []).find((e: any) => e.type === "rest" || e.type === "tick");
  const prompts: any[] = ev?.data?.tick?.agentPrompts ?? [];
  if (!prompts.length) return { invoked: [] };
  if (!process.env.OPENAI_API_KEY) return { invoked: [], note: `${prompts.length} agent-NPC(s) in scope, but OPENAI_API_KEY is unset — the deterministic tick already advanced them.` };
  const invoked: any[] = [];
  for (const p of prompts) {
    try {
      const { text, finishReason } = await openaiChat({ model: p.model ?? NPC_MODEL(), messages: p.messages, timeoutMs: 60_000 });
      if (!text) {
        invoked.push({ npcId: p.npcId, name: p.name, action: "(no reply)", finishReason });
        continue;
      }
      if (resolve) {
        const turn = await resolveNpcDeclaration(client, { roomId, npcId: p.npcId, declaration: text, mode: "tick", name: p.name });
        invoked.push({ npcId: p.npcId, name: p.name, declaration: text, conformance: turn.conformance.status, resolution: turn.resolution?.status, finishReason });
      } else {
        await client.submitIntent({ roomId, type: "npc_add_journal", params: { npcId: p.npcId, entry: text } });
        invoked.push({ npcId: p.npcId, name: p.name, action: text, finishReason });
      }
    } catch (e) {
      invoked.push({ npcId: p.npcId, name: p.name, error: (e as Error).message });
    }
  }
  return { invoked };
}

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
        "create {name, authorityId?, goals?[], position?} — add an NPC; " +
        "interact {npcId, beat, dispositionDelta?, familiarityDelta?, importance?(low|notable|defining), topics?, witnessed?, standingDelta?} — record an interaction (a standingDelta writes the NPC's authority ledger), bumps interactionCount; " +
        "learn_fact {npcId, fact} — the NPC now knows a fact; " +
        "set_goal {npcId, goal:{text, drive?(advance|undermine|protect|train|patrol|scheme), targetActorId?, targetAuthorityId?, intensity?, id?}, remove?} — give the NPC an agenda the world tick pursues off-screen (directed drives move Standing + the NPC's memory of the target); " +
        "get_relationship {npcId} — raw relationship + derived attitude/closeness tiers; " +
        "context {npcId, limit?, minImportance?, topic?} — an LLM-ready summary (attitude/closeness tiers + salient topic/importance-filtered memories + known facts + Standing) to roleplay the NPC consistently in one read; " +
        "decide {npcId, observerActorId?} — the NPC analogue of agent_context: assembles a DECISION prompt (driving goal + drive + known facts + who's present + how the NPC regards each PC + a menu of legal social moves). READ-ONLY — pick ONE move from the menu and submit it as an ordinary intent (social_speak/move/npc_interact/set_goal); " +
        "set_agent {npcId, persona?, directive?, model?, autoOnTurn?} — configure the NPC's durable LLM agent (DM-authored identity + behavioral instructions + model); " +
        "add_secret {npcId, text} / remove_secret {npcId, secretId} — agent-private knowledge (injected into the prompt, never narrated); " +
        "add_journal {npcId, entry} / get_journal {npcId, limit?} — the NPC's first-person rolling memory; " +
        "compose / preview_prompt {npcId, situation?, journalLimit?} — assemble the agent's messages[] (persona→directive→secrets→state→journal→situation) WITHOUT calling the model; " +
        "invoke {npcId, situation?, record?, resolve?, mode?} — compose AND call the model so the NPC replies in character with a declared intent. By default records the reply as a journal entry (the DM resolves it). With resolve:true it runs the FULL autonomous loop: conform the declaration to a legal intent, submit it so the engine resolves ground truth, and journal declaration+outcome (an unconformable reply becomes needs_dm_repair and mutates nothing). Rest/downtime invoke agents automatically.",
      inputSchema: {
        roomId: z.string(),
        action: z.enum(["create", "interact", "learn_fact", "set_goal", "get_relationship", "context", "decide", "set_agent", "add_secret", "remove_secret", "add_journal", "get_journal", "compose", "preview_prompt", "invoke"]),
        actorId: z.string().optional(),
        npcId: z.string().optional(),
        observerActorId: z.string().optional(),
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
        goals: z.array(z.record(z.any())).optional(),
        goal: z.record(z.any()).optional(),
        remove: z.boolean().optional(),
        position: z.object({ x: z.number(), y: z.number() }).optional(),
        limit: z.number().optional(),
        minImportance: z.enum(["low", "notable", "defining"]).optional(),
        topic: z.string().optional(),
        // ── agent config / invocation ──
        persona: z.string().optional().describe("DM-authored identity & voice (system slice)."),
        directive: z.string().optional().describe("DM-authored behavioral instructions (system slice)."),
        model: z.string().optional().describe("Override model for this NPC (default NARUTO_NPC_MODEL)."),
        autoOnTurn: z.boolean().optional().describe("Auto-invoke when this NPC's turn comes up in combat."),
        text: z.string().optional().describe("Secret text (add_secret)."),
        secretId: z.string().optional().describe("Secret id (remove_secret)."),
        entry: z.string().optional().describe("Journal entry text (add_journal)."),
        situation: z.string().optional().describe("Per-invoke scene narrative (compose/invoke); becomes the user turn."),
        journalLimit: z.number().optional().describe("How many recent journal entries to include (compose/invoke)."),
        record: z.boolean().optional().describe("invoke: record the reply as a journal entry (default true)."),
        resolve: z.boolean().optional().describe("invoke: run the full conform→submit→journal loop so the declaration becomes engine-resolved ground truth (default false = journal only)."),
        mode: z.enum(["tick", "scene", "combat", "downtime"]).optional().describe("invoke+resolve: the action mode (default scene; use combat for in-fight turns)."),
      },
    },
    async ({ roomId, action, actorId, ...rest }) => {
      // invoke = compose (engine) + call the model (controller); the engine hosts no LLM.
      if (action === "invoke") {
        const composed = await client.submitIntent({ roomId, actorId, type: "npc_compose", params: rest });
        const ev = (composed.events ?? []).find((e: any) => e.type === "npc_prompt");
        if (!ev) return ok(composed); // a rejection (e.g. unknown NPC) passes straight through
        const model = ev.data.model ?? NPC_MODEL();
        try {
          const { text, finishReason, usage } = await openaiChat({ model, messages: ev.data.messages, timeoutMs: 60_000 });
          if ((rest as any).resolve === true && text) {
            // full autonomous loop: conform the declaration → submit → journal declaration+outcome
            const turn = await resolveNpcDeclaration(client, { roomId, npcId: ev.data.npcId, actorId, declaration: text, mode: ((rest as any).mode as NpcMode) ?? "scene", affordances: { actions: ev.data.affordances?.actions } });
            return ok({ npcId: ev.data.npcId, name: ev.data.name, model, declaration: text, conformance: turn.conformance, resolution: turn.resolution, journaled: turn.journaled, finishReason, usage });
          }
          if (text && (rest as any).record !== false) await client.submitIntent({ roomId, type: "npc_add_journal", params: { npcId: ev.data.npcId, entry: text } });
          return ok({ npcId: ev.data.npcId, name: ev.data.name, model, action: text, finishReason, usage, slicesIncluded: ev.data.slicesIncluded, affordances: ev.data.affordances });
        } catch (e) {
          return ok({ npcId: ev.data.npcId, name: ev.data.name, model, error: (e as Error).message, hint: "Set OPENAI_API_KEY in .env; check the model name (NARUTO_NPC_MODEL)." });
        }
      }
      const type = {
        create: "npc_create", interact: "npc_interact", learn_fact: "npc_learn_fact", set_goal: "npc_set_goal",
        get_relationship: "npc_get_relationship", context: "npc_context", decide: "npc_decide",
        set_agent: "npc_set_agent", add_secret: "npc_add_secret", remove_secret: "npc_remove_secret",
        add_journal: "npc_add_journal", get_journal: "npc_get_journal", compose: "npc_compose", preview_prompt: "npc_compose",
      }[action];
      return ok(await client.submitIntent({ roomId, actorId, type, params: rest }));
    },
  );

  server.registerTool(
    "social_speak",
    {
      description:
        "Ninja eavesdropping. An actor speaks at a volume (whisper|talk|shout); the engine computes who overhears via grid distance vs the volume's range, with an opposed Stealth(speaker) vs Perception(listener) roll at the edge — respecting the Deafened condition and the Silent Killing trait (speaker stays unheard except on a winning Perception roll). concealment 0..1 shrinks the range (e.g. Hidden Mist). audience defaults to everyone else in the room. Overhearing NPCs remember what they caught (feeds npc_manage context).",
      inputSchema: {
        roomId: z.string(),
        actorId: z.string(),
        text: z.string(),
        volume: z.enum(["whisper", "talk", "shout"]).optional(),
        audience: z.array(z.string()).optional(),
        concealment: z.number().optional(),
        record: z.boolean().optional(),
        importance: z.enum(["low", "notable", "defining"]).optional(),
        topics: z.array(z.string()).optional(),
      },
    },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "social_speak", params })),
  );

  server.registerTool(
    "agent_context",
    {
      description:
        "LLM-agent seam — assemble one actor's turn context so an LLM can play them. Read-only; returns the actor's identity, vitals (hp/chakra/conditions/position/turnBudget), the scene (allies & threats with distance), and the LEGAL/affordable moves: which KNOWN jutsu are castable right now (with cost/element/delivery + why-not) plus the basic actions available. The MOVE is yours to decide — submit it as a normal intent (cast/attack/move/...). For NPC roleplay use npc_manage context instead.",
      inputSchema: { roomId: z.string(), actorId: z.string() },
    },
    async ({ roomId, actorId }) => ok(await client.submitIntent({ roomId, actorId, type: "agent_context" })),
  );

  server.registerTool(
    "campaign_manage",
    {
      description:
        "Campaign/world layer above rooms (unifies scenes, party, missions=quests, and per-authority Standing=factions under one arc + world clock + journal). Actions: " +
        "create {name, party?, arc?, activeRoomId?, scenes?, factionsOfNote?, strictTemporal?, maxUnauthorizedDays?}; " +
        "get {campaignId, journalLimit?} -> dashboard (party + missions + standings + journal + open time blocks); " +
        "set {campaignId, arc?, activeRoomId?, addParty?, removeParty?, addScene?, addLocation?, factionsOfNote?, strictTemporal?, maxUnauthorizedDays?}; " +
        "plan_day {campaignId, blocks:[{label, location?, requiredAttention?, actorsInScope?, startsAt?}], replace?} -> lay out the day's attention schedule; " +
        "resolve_block {campaignId, blockId, digest?, resolvedIntents?} -> mark a scheduled block as lived (unblocks time); " +
        "advance_day {campaignId, days?, arc?, compressionAuthorized?} -> advance the world clock (STRICT MODE: rejects skipping past unresolved required blocks or > maxUnauthorizedDays unless compressionAuthorized:true); " +
        "log {campaignId, beat} -> append a day-stamped journal beat.",
      inputSchema: {
        roomId: z.string(),
        action: z.enum(["create", "get", "set", "plan_day", "resolve_block", "advance_day", "log"]),
        campaignId: z.string().optional(),
        name: z.string().optional(),
        arc: z.string().optional(),
        party: z.array(z.string()).optional(),
        scenes: z.array(z.string()).optional(),
        activeRoomId: z.string().optional(),
        factionsOfNote: z.array(z.string()).optional(),
        addParty: z.array(z.string()).optional(),
        removeParty: z.array(z.string()).optional(),
        addScene: z.array(z.string()).optional(),
        addLocation: z.record(z.any()).optional(),
        beat: z.string().optional(),
        days: z.number().optional(),
        journalLimit: z.number().optional(),
        strictTemporal: z.boolean().optional(),
        maxUnauthorizedDays: z.number().optional(),
        blocks: z.array(z.record(z.any())).optional(),
        blockId: z.string().optional(),
        digest: z.string().optional(),
        resolvedIntents: z.number().optional(),
        replace: z.boolean().optional(),
        compressionAuthorized: z.boolean().optional(),
      },
    },
    async ({ roomId, action, ...rest }) => {
      const type = { create: "campaign_create", get: "campaign_get", set: "campaign_set", plan_day: "campaign_plan_day", resolve_block: "campaign_resolve_block", advance_day: "campaign_advance_day", log: "campaign_log" }[action];
      return ok(await client.submitIntent({ roomId, type, params: rest }));
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
        "Build a Naruto 5e character end-to-end in ONE call — clan + class + background + abilities + the skill/ability sub-choices each demands, plus auto-rolled genesis. " +
        "Rejections are EDUCATIONAL: each names the exact missing field and its legal options — read it and resubmit (you can resolve a full build in 1-2 round-trips this way).\n\n" +
        "🧩 REQUIRED: roomId, name. Defaults fill the rest (Non-Clan / Ninjutsu Specialist / Student / level 1 / manual stats), but a real PC sets clan, className, background, level.\n\n" +
        "🎲 ABILITIES — pass `abilities:{method, ...}`:\n" +
        "• method='manual' (default) REQUIRES `abilities.scores:{str,dex,con,int,wis,cha}` (all six).\n" +
        "• method='point_buy' | 'standard_array' | 'roll_4d6' auto-assign — no scores needed.\n\n" +
        "🧷 SUB-CHOICES — clan/background/class each demand picks IF their definition offers a choice (the rejection prints the exact menu + count):\n" +
        "• background → backgroundSkillChoices[] (N skills from its list) + bgAbilityChoice (+1 to one of its two abilities).\n" +
        "• class → classSkillChoices[] (N skills from its list).\n" +
        "• clan → clanSkillChoices[] and/or abilityChoices[] when the clan grants a choose-from list (most clans are fixed).\n" +
        "Backgrounds: Entertainer, Genius, Hard Worker, Hermit, Leader, Noble, Student, Traveler, Trouble Maker, Urchin. Clans/classes: see list_clans / list_classes.\n\n" +
        "🩸 GENESIS: by default the engine rolls chakra affinity(ies) on a rarity curve, derives any Kekkei Genkai from the natures (e.g. Wind+Lightning→Tempest, Water+Wind→Ice), and rolls special traits (e.g. Sharingan stage for Uchiha). Returned under events[].data.genesis.\n" +
        "🧬 AUTHORED BLOODLINE (optional): pin the genesis instead of blind-rolling — pass `kkg` to be BORN with a Kekkei Genkai (e.g. 'Dust (Jinton)', 'Dust', or 'Jinton' — its required natures, here Earth+Wind+Fire, are guaranteed) and/or `affinities:[...]` for explicit natures. Pinned genesis is deterministic (exactly clan + requested natures, no random extras); echoed back under events[].data.genesisRequested. KKG list mirrors the recipes (Ice, Wood, Lava, Boil, Storm, Explosion, Scorch, Magnet, Plasma, Tempest, Dust); an unknown name yields an educational rejection.\n" +
        "⚡ autoLoadout:true (opt-in) also grants a rank-appropriate baseline jutsu per affinity + per KKG — the 'standard kit, then their choice' model. Omit it to let the player pick everything (use jutsu_learnable to discover legal options).",
      inputSchema: {
        roomId: z.string().describe("Room/scene the character is created in."),
        name: z.string().describe("Character name."),
        clan: z.string().optional().describe("Clan name (see list_clans). Defaults to Non-Clan. Grants ability increases, skills, signature trait, and any affinity."),
        className: z.string().optional().describe("Class name (see list_classes). Defaults to Ninjutsu Specialist."),
        background: z.string().optional().describe("One of: Entertainer, Genius, Hard Worker, Hermit, Leader, Noble, Student, Traveler, Trouble Maker, Urchin. Defaults to Student."),
        level: z.number().optional().describe("Character level (default 1). Sets rank cap (Academy→E … Kage/Legendary→S) and pool sizes."),
        abilities: z.record(z.any()).optional().describe("{method:'manual'|'point_buy'|'standard_array'|'roll_4d6', scores?:{str,dex,con,int,wis,cha}}. scores REQUIRED for manual; ignored otherwise."),
        abilityChoices: z.array(z.string()).optional().describe("Clan ability-increase picks, when the clan offers a choose-from list (rejection names the options)."),
        bgAbilityChoice: z.string().optional().describe("Background +1 ability pick — one of the two the background offers (rejection names them)."),
        clanSkillChoices: z.array(z.string()).optional().describe("Clan skill picks, when the clan grants a choose-from list."),
        classSkillChoices: z.array(z.string()).optional().describe("Class skill picks (N from the class's list; rejection names the count + options)."),
        backgroundSkillChoices: z.array(z.string()).optional().describe("Background skill picks (N from the background's list; rejection names the count + options)."),
        autoLoadout: z.boolean().optional().describe("Opt-in: also auto-learn one rank-appropriate baseline jutsu per affinity + per KKG. Default false (player picks via jutsu_learnable)."),
        kkg: z.string().optional().describe("Authored bloodline: be BORN with this Kekkei Genkai (e.g. 'Dust (Jinton)' | 'Dust' | 'Jinton'). Its required natures are guaranteed and the KKG derived. Pins genesis deterministically. Unknown name → educational rejection listing valid KKGs."),
        affinities: z.array(z.string()).optional().describe("Authored natures: pin specific chakra affinities at genesis (subset of Fire/Water/Wind/Earth/Lightning). Combine with or instead of kkg; unknown nature → educational rejection."),
      },
    },
    async ({ roomId, ...params }) => ok(await client.submitIntent({ roomId, type: "character_create", params })),
  );

  server.registerTool(
    "jutsu_learnable",
    {
      description:
        "Discovery: every jutsu this actor could LEARN right now — passes all gates (rank cap, affinity/KKG, clan, class), excludes already-known — sorted by rank then damage. The 'what can I learn' complement to agent_context's 'what can I cast'. Use it to pick rank-appropriate kit (a Jonin should be wielding A-rank, an S-rank Legendary the big ones). Optional classification filter + limit.",
      inputSchema: { roomId: z.string(), actorId: z.string(), classification: z.string().optional(), limit: z.number().optional() },
    },
    async ({ roomId, actorId, ...params }) => ok(await client.submitIntent({ roomId, actorId, type: "jutsu_learnable", params })),
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
    { description: "Self-study: a character learns a jutsu on their own (validates the Jutsu Known cap + rank/clan/class/affinity gates). For TAUGHT acquisition (a teacher/Kage/scroll lifts a gate), use jutsu_acquire instead.", inputSchema: { roomId: z.string(), actorId: z.string(), jutsu: z.string() } },
    async ({ roomId, actorId, jutsu }) => ok(await client.submitIntent({ roomId, actorId, type: "jutsu_learn", params: { jutsu } })),
  );

  // jutsu acquisition — grow an arsenal through the WORLD, not just self-study.
  server.registerTool(
    "jutsu_acquire",
    {
      description:
        "Grow a character's arsenal through social/world channels (each lifts the gates it legitimately can). Actions:\n" +
        "• teach {studentId, jutsu, teacherId?, via?, requires?, bypass?, viaFavor?, force?} — a tutor/teacher/special-trainer/Kage/school imparts a technique. A same-clan teacherId lifts the clan lock; a medical sensei lifts the class lock; via:'kage' lifts everything; requires:{authorityId,minReputation?,minRank?} gates a VAULT/archive on standing; viaFavor lifts off-affinity. The teacher↔student bond is recorded.\n" +
        "• study_scroll {actorId, jutsu?|scroll?} — learn from a jutsu scroll in the pack (a forbidden scroll lifts clan/affinity); consumed unless reusable.\n" +
        "• buy_scroll {actorId, jutsu, priceRyo?, requires?, forbidden?} — the RYO/market path: buy a jutsu scroll for money (price scales by rank; a village archive can gate on standing). Then study_scroll to learn it.\n" +
        "• grant_scroll {actorId, jutsu, forbidden?, reusable?} — mint a jutsu scroll into the pack (reward/loot/vault withdrawal).\n" +
        "• buy_slot {actorId, authorityId, slots?, costPerSlot?} — PURCHASE technique slots with FAME (reputation) through a social leader; spends standing (political capital) to expand the sanctioned repertoire.\n" +
        "Distinct paths: RYO buys gear/scrolls; FAME buys slots; FAVOR (favor_unlock) buys off-affinity; a TEACHER/Kage grants past gates; STANDING opens vaults.",
      inputSchema: {
        roomId: z.string(),
        action: z.enum(["teach", "study_scroll", "buy_scroll", "grant_scroll", "buy_slot"]),
        priceRyo: z.number().optional(),
        actorId: z.string().optional(),
        studentId: z.string().optional(),
        jutsu: z.string().optional(),
        teacherId: z.string().optional(),
        via: z.enum(["tutor", "teacher", "trainer", "kage", "school", "vault", "scroll", "training"]).optional(),
        requires: z.record(z.any()).optional(),
        bypass: z.array(z.string()).optional(),
        viaFavor: z.boolean().optional(),
        scroll: z.string().optional(),
        forbidden: z.boolean().optional(),
        reusable: z.boolean().optional(),
        authorityId: z.string().optional(),
        slots: z.number().optional(),
        costPerSlot: z.number().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ roomId, action, ...rest }) => {
      const type = { teach: "jutsu_teach", study_scroll: "study_scroll", buy_scroll: "jutsu_buy_scroll", grant_scroll: "jutsu_scroll_grant", buy_slot: "jutsu_slot_buy" }[action];
      return ok(await client.submitIntent({ roomId, type, params: rest }));
    },
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
    {
      description: "Advance to the next combatant (the turn authority; auto-rolls death saves for the downed). If the next combatant is an autonomous agent (adversary with autoOnTurn), the result carries data.needsAgentTurn — call npc_turn to resolve it, OR pass auto:true to resolve it inline (the model picks + the engine adjudicates its move). Turns never advance invisibly: auto is opt-in.",
      inputSchema: { roomId: z.string(), auto: z.boolean().optional() },
    },
    async ({ roomId, auto }) => {
      const result = await client.submitIntent({ roomId, type: "advance" });
      const adv = (result.events ?? []).find((e: any) => e.type === "advance");
      const sig = adv?.data?.needsAgentTurn;
      if (auto && sig && process.env.OPENAI_API_KEY) {
        const composed = await client.submitIntent({ roomId, actorId: sig.actorId, type: "npc_compose", params: { npcId: sig.actorId, situation: "It is your turn in combat. Declare your move." } });
        const pev = (composed.events ?? []).find((e: any) => e.type === "npc_prompt");
        if (pev) {
          try {
            const { text } = await openaiChat({ model: sig.model ?? NPC_MODEL(), messages: pev.data.messages, timeoutMs: 60_000 });
            if (text) {
              const turn = await resolveNpcDeclaration(client, { roomId, npcId: sig.actorId, actorId: sig.actorId, declaration: text, mode: "combat" });
              return ok({ ...result, agentTurn: { declaration: text, conformance: turn.conformance, resolution: turn.resolution } });
            }
          } catch (e) {
            return ok({ ...result, agentTurn: { error: (e as Error).message } });
          }
        }
      }
      return ok(result);
    },
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
    {
      description:
        "Rest a character (short: spend Hit/Chakra Dice; long: full pools + dice recovery + WoF on a mission boundary; downtime: largest world advance). " +
        "Rest EMBEDS the rest-bounded world tick: in-scope NPC goals advance off-screen AND configured agent-NPCs are invoked (OpenAI) to act in character — short→2 agents, long→4, downtime→all. Their actions come back under npcAgents and are saved to each NPC's journal.",
      inputSchema: { roomId: z.string(), actorId: z.string(), type: z.enum(["short", "long", "downtime"]), spendHitDice: z.number().optional(), spendChakraDice: z.number().optional(), missionBoundary: z.boolean().optional() },
    },
    async ({ roomId, actorId, ...params }) => {
      const result = await client.submitIntent({ roomId, actorId, type: "rest", params });
      const npcAgents = await invokeTickAgents(client, roomId, result);
      return ok({ ...result, npcAgents });
    },
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
      description: "Spawn a tier-scaled adversary (minion/elite/solo) via the 8-step build. Solo gets Legendary Actions/Resistance + Phase Transitions; Elite gets an extra action. affinity sets the foe's chakra natures (surfaced in agent_context). Give it persona+directive+autoOnTurn to make it an AUTONOMOUS combatant: combat advance then flags needsAgentTurn so its turns resolve through the conform→engine loop (advance_turn auto:true / npc_turn).",
      inputSchema: { roomId: z.string(), name: z.string(), tier: z.enum(["minion", "elite", "solo"]), role: z.string().optional(), clan: z.string().optional(), level: z.number(), partySize: z.number().optional(), jutsu: z.array(z.string()).optional(), traits: z.array(z.string()).optional(), affinity: z.array(z.string()).optional(), persona: z.string().optional(), directive: z.string().optional(), model: z.string().optional(), autoOnTurn: z.boolean().optional() },
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
    "hints",
    {
      description:
        "Resource cheat-sheet — what each resource IS and HOW TO SPEND it (chakra, action economy, technique slots, fame/reputation, favor, downtime, ryo, XP, Will of Fire, time). Read this to learn the verbs: e.g. you can BUY technique slots with fame (jutsu_acquire buy_slot), be TAUGHT a jutsu past its gate by a Kage/teacher/scroll (jutsu_acquire), spend DOWNTIME to train, and strict time needs plan_day/resolve_block before advancing. Optional topic filters (e.g. 'fame', 'jutsu', 'downtime').",
      inputSchema: { roomId: z.string(), topic: z.string().optional() },
    },
    async ({ roomId, topic }) => ok(await client.submitIntent({ roomId, type: "hints", params: { topic } })),
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
    { description: "Run a standalone world tick (rest embeds this automatically). trigger short|long|downtime sets magnitude. Always advances off-screen NPC goals deterministically, and invokes in-scope agent-NPCs for a cheap 'what do you do?' — their declarations come back under npcAgents for YOU (the DM) to adjudicate via the tool surface (the primary path). resolve:true is the OPT-IN headless mode: deterministically conform+submit each declaration so the world moves unattended (cron/no DM). passiveStanding:false silences the off-screen reputation drip. Returns tick + playerDigest.", inputSchema: { roomId: z.string(), trigger: z.string().optional(), resolve: z.boolean().optional(), passiveStanding: z.boolean().optional() } },
    async ({ roomId, trigger, resolve, passiveStanding }) => {
      const result = await client.submitIntent({ roomId, type: "tick_run", params: { trigger, passiveStanding } });
      const npcAgents = await invokeTickAgents(client, roomId, result, resolve === true);
      return ok({ ...result, npcAgents });
    },
  );

  server.registerTool(
    "npc_turn",
    {
      description:
        "On-demand autonomous NPC turn (the full loop in one call): compose the NPC's prompt for THIS situation → call the model → CONFORM the declaration to a legal intent → submit it so the engine resolves ground truth → journal declaration+outcome. Use in live scenes/combat when a relevant NPC should act like a player at the table. An unconformable reply returns needs_dm_repair and mutates nothing. (Engine stays LLM-free; the model call is here.)",
      inputSchema: {
        roomId: z.string(),
        npcId: z.string(),
        actorId: z.string().optional().describe("The NPC's combatant id (for combat affordances/agent_context); defaults to npcId."),
        situation: z.string().describe("The scene pressure the NPC reacts to (becomes the user turn)."),
        mode: z.enum(["tick", "scene", "combat", "downtime"]).optional(),
        journalLimit: z.number().optional(),
      },
    },
    async ({ roomId, npcId, actorId, situation, mode, journalLimit }) => {
      const composed = await client.submitIntent({ roomId, actorId, type: "npc_compose", params: { npcId, situation, journalLimit } });
      const ev = (composed.events ?? []).find((e: any) => e.type === "npc_prompt");
      if (!ev) return ok(composed); // a rejection (e.g. unknown NPC) passes straight through
      const model = ev.data.model ?? NPC_MODEL();
      try {
        const { text, finishReason, usage } = await openaiChat({ model, messages: ev.data.messages, timeoutMs: 60_000 });
        if (!text) return ok({ npcId, name: ev.data.name, model, error: "empty reply", finishReason });
        const turn = await resolveNpcDeclaration(client, { roomId, npcId, actorId, declaration: text, mode: (mode as NpcMode) ?? "scene", affordances: { actions: ev.data.affordances?.actions }, name: ev.data.name });
        return ok({ npcId, name: ev.data.name, model, declaration: text, conformance: turn.conformance, resolution: turn.resolution, journaled: turn.journaled, finishReason, usage });
      } catch (e) {
        return ok({ npcId, name: ev.data.name, model, error: (e as Error).message, hint: "Set OPENAI_API_KEY in .env; check NARUTO_NPC_MODEL." });
      }
    },
  );

  server.registerTool(
    "tick_resolve",
    {
      description: "Resolve a DM-conformed batch of NPC/world ops as one sequenced transaction (the manual analogue of the autonomous loop — when YOU conform several NPC declarations yourself and want them all submitted). ops:[{type, actorId?, params}].",
      inputSchema: { roomId: z.string(), ops: z.array(z.object({ type: z.string(), actorId: z.string().optional(), params: z.record(z.any()).optional() })) },
    },
    async ({ roomId, ops }) => ok(await client.submitIntent({ roomId, type: "tick_resolve", params: { ops } })),
  );
}
