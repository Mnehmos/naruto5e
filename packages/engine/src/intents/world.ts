import { newId, reject, rollExpression } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { NpcRelationshipSchema, NpcSchema, NpcGoalSchema, NpcSecretSchema, NpcJournalSchema, VendorSchema, StolenItemSchema, HeatStateSchema, CorpseSchema, DECAY_ORDER, type Corpse, type HeatState, type NpcRelationship, type Vendor } from "../domain/world.js";
import { applyStandingDelta, getLedger } from "../rules/standing.js";
import { dispositionTier, familiarityTier, salientMemories } from "../rules/npc.js";
import { resolveSpeech, type Volume } from "../rules/social.js";

function coll<T extends { id: string }>(ctx: ResolveContext, name: string) {
  return ctx.store.collection<T>(name);
}
function relId(npcId: string, actorId: string) {
  return `${npcId}:${actorId}`;
}

/**
 * Shared situational read for an NPC — the single source of truth behind both
 * npc_decide (the decision menu) and npc_compose (the agent prompt's state/scene
 * slices). Pure read over store: dominant goal, who's present + how the NPC
 * regards each, threats, and the legal social-move menu.
 */
export function npcSituation(ctx: ResolveContext, npc: any) {
  const room = ctx.room.id;
  const npcId = npc.id;
  const rels = coll<NpcRelationship>(ctx, "npc_relationships");
  const goals = (npc.goals ?? [])
    .filter((g: any) => !g.done)
    .sort((a: any, b: any) => (b.intensity ?? 1) - (a.intensity ?? 1) || (b.progress ?? 0) - (a.progress ?? 0));
  const dominant = goals[0];
  const pcs = ctx.store.collection<any>("characters").find((c) => c.roomId === room && !c.dead);
  const foes = ctx.store.collection<any>("adversaries").find((a) => a.roomId === room && !a.dead);
  const peers = ctx.store.collection<any>("npcs").find((n) => n.roomId === room && n.id !== npcId);
  const distFt = (o: any) =>
    !npc.position || !o.position ? undefined : Math.max(Math.abs(npc.position.x - o.position.x), Math.abs(npc.position.y - o.position.y)) * 5;
  const regard = pcs.map((c: any) => {
    const rel = rels.get(relId(npcId, c.id));
    const salient = salientMemories(rel?.memories ?? [], { limit: 3 });
    let standing: any = null;
    if (npc.authorityId) {
      const l = getLedger(ctx.store, c.id, npc.authorityId);
      if (l) standing = { reputation: l.reputation, hostile: l.hostile };
    }
    return {
      actorId: c.id,
      name: c.name,
      attitude: dispositionTier(rel?.disposition ?? 0),
      closeness: familiarityTier(rel?.familiarity ?? 0),
      interactionCount: rel?.interactionCount ?? 0,
      distanceFt: distFt(c),
      remembers: salient.map((m) => m.summary),
      ...(standing ? { standing } : {}),
    };
  });
  const actions: { type: string; label: string; paramsHint: string }[] = [
    { type: "social_speak", label: "Speak", paramsHint: "{ text, volume?(whisper|talk|shout), topics?[] } — say something; eavesdrop-aware + remembered." },
    { type: "npc_interact", label: "Shift stance", paramsHint: "{ npcId, actorId, beat, dispositionDelta?, familiarityDelta?, importance? } — register how this beat changes how the NPC feels about a PC." },
  ];
  if (npc.position) actions.push({ type: "move", label: "Reposition", paramsHint: "{ to:{x,y} | distance } — approach, withdraw, or patrol." });
  if (dominant) actions.push({ type: "npc_set_goal", label: "Advance goal", paramsHint: `{ npcId, goal:{ id:"${dominant.id}", progress:<0..100> } } — push the "${dominant.text}" agenda.` });
  if ((npc.knownFacts ?? []).length) actions.push({ type: "social_speak", label: "Reveal/withhold a fact", paramsHint: "{ text } — choose whether to share what the NPC knows." });

  const goalLine = dominant
    ? `Driving goal: "${dominant.text}" (drive: ${dominant.drive}, intensity ${dominant.intensity ?? 1}, ${dominant.progress ?? 0}% done)${dominant.targetActorId ? `, aimed at ${dominant.targetActorId}` : ""}.`
    : "No active agenda — react to the scene.";
  const factsLine = (npc.knownFacts ?? []).length ? `Knows: ${npc.knownFacts.join("; ")}.` : "";
  const presentLine = regard.length
    ? `Present: ${regard.map((r) => `${r.name} (regards as ${r.attitude}, ${r.closeness}${r.remembers.length ? `; recalls: ${r.remembers.join(", ")}` : ""})`).join(" · ")}.`
    : "No player characters present.";
  const threatsLine = foes.length ? `Threats in the room: ${foes.map((f: any) => f.name).join(", ")}.` : "";
  const stateBlock = [`You are ${npc.name}${npc.authorityId ? `, affiliated with ${npc.authorityId}` : ""}.`, goalLine, factsLine].filter(Boolean).join(" ");
  const sceneLine = [presentLine, threatsLine].filter(Boolean).join(" ");
  const contextSummary = [
    `${npc.name} decides what to do next.` + (npc.authorityId ? ` (Affiliation: ${npc.authorityId}.)` : ""),
    goalLine,
    factsLine,
    presentLine,
    threatsLine,
    `Choose ONE move that best serves the goal and how the NPC feels about who's present, then submit it as a normal intent.`,
  ]
    .filter(Boolean)
    .join(" ");
  return { goals, dominant, regard, foes, peers, actions, distFt, stateBlock, sceneLine, contextSummary };
}

/**
 * Build a provider-ready messages[] from an NPC's agent config + situation. Pure
 * (no store), so both npc_compose and the rest-bounded tick reuse it. Slice order
 * mirrors the rpg.mcp composer: persona -> directive -> secrets -> state ->
 * recent journal (system), then the DM situation (or the auto scene) as the user turn.
 */
export function composeNpcMessages(
  npc: any,
  sit: ReturnType<typeof npcSituation>,
  situation?: string,
  journalLimit = 5,
): { messages: { role: "system" | "user"; content: string }[]; slicesIncluded: string[]; estimatedTokens: number } {
  const systemParts: string[] = [];
  const slicesIncluded: string[] = [];
  const add = (name: string, text?: string) => {
    if (text && text.trim()) {
      systemParts.push(text.trim());
      slicesIncluded.push(name);
    }
  };
  add("persona", npc.persona ?? `You are ${npc.name}, a person in this world.`);
  add("directive", npc.directive);
  if ((npc.secrets ?? []).length) add("secrets", `PRIVATE — known only to you (never state these outright):\n${npc.secrets.map((s: any) => `- ${s.text}`).join("\n")}`);
  add("state", sit.stateBlock);
  const recentJournal = (npc.journal ?? []).slice(-journalLimit);
  if (recentJournal.length) add("journal", `Recently, you:\n${recentJournal.map((j: any) => `- ${j.entry}`).join("\n")}`);

  const closing =
    "\n\n--- HOW TO RESPOND ---\nStay in character and declare ONE thing you do — an ATTEMPT, not an outcome (you can TRY to expose a secret; whether it lands is the dice's call). " +
    'PREFER a single JSON action object so it resolves cleanly, e.g. {"intent":"speak","text":"Lower your voices.","target":"Iwao","tone":"low"} ' +
    '| {"intent":"goal","goal":"shadow the squad"} | {"intent":"move","distance":15} | {"intent":"attack","target":"Raijū"} | {"intent":"cast","jutsu":"<id>","target":"…"} | {"intent":"reflect","text":"I wait and watch."}. ' +
    "Plain first-person prose also works. The engine adjudicates the result.";
  const messages: { role: "system" | "user"; content: string }[] = [];
  if (systemParts.length) messages.push({ role: "system", content: systemParts.join("\n\n") + closing });
  const userContent = (situation ?? "").trim() || `${sit.sceneLine}\n\nWhat do you do?`;
  messages.push({ role: "user", content: userContent });

  return { messages, slicesIncluded, estimatedTokens: Math.ceil(messages.reduce((n, m) => n + m.content.length + 8, 0) / 4) };
}

/**
 * Phase 7 — the four world-consequence systems. ALL standing-affecting acts route
 * through `applyStandingDelta` (the spine). DM write-surfaces; players act
 * through the DM.
 */
export function registerWorldIntents(engine: Engine): void {
  // ============ A) npc_manage (memory <-> Standing) ============
  engine.registerHandler("npc_create", (ctx) => {
    const goals = ((ctx.op.params.goals as any[]) ?? []).map((g) =>
      NpcGoalSchema.parse({ id: g.id ?? newId("goal"), text: String(g.text ?? "an unstated aim"), drive: g.drive, targetActorId: g.targetActorId, targetAuthorityId: g.targetAuthorityId, intensity: g.intensity ?? 1 }),
    );
    const p = ctx.op.params;
    const npc = NpcSchema.parse({
      id: (p.id as string) || newId("npc"),
      roomId: ctx.room.id,
      name: String(p.name ?? "NPC"),
      authorityId: p.authorityId as string,
      goals,
      position: p.position as any,
      persona: p.persona != null ? String(p.persona) : undefined,
      directive: p.directive != null ? String(p.directive) : undefined,
      model: p.model != null ? String(p.model) : undefined,
      autoOnTurn: p.autoOnTurn === true,
    });
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_created", { data: { npc }, narration: `${npc.name} enters the world${goals.length ? ` (pursuing ${goals.length} goal${goals.length === 1 ? "" : "s"})` : ""}.` });
  });

  // npc_set_agent — upsert the durable agent config (persona/directive/model/
  // autoOnTurn) on an NPC, so it can be invoked to act in character.
  engine.registerHandler("npc_set_agent", (ctx) => {
    const p = ctx.op.params;
    const npc = coll<any>(ctx, "npcs").get(String(p.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${p.npcId}".`, {}, ["Create the NPC first (npc_manage create)."]);
    if (p.persona !== undefined) npc.persona = String(p.persona);
    if (p.directive !== undefined) npc.directive = String(p.directive);
    if (p.model !== undefined) npc.model = String(p.model);
    if (p.autoOnTurn !== undefined) npc.autoOnTurn = p.autoOnTurn === true;
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_agent", {
      data: { npcId: npc.id, persona: npc.persona, directive: npc.directive, model: npc.model ?? null, autoOnTurn: npc.autoOnTurn },
      narration: `${npc.name}'s agent is configured${npc.model ? ` (${npc.model})` : ""}.`,
    });
  });

  // npc_add_secret / npc_remove_secret — agent-private knowledge (guarded; injected
  // into the agent prompt, never narrated by the engine).
  engine.registerHandler("npc_add_secret", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${ctx.op.params.npcId}".`, {}, ["Create the NPC first."]);
    const secret = NpcSecretSchema.parse({ id: newId("secret"), text: String(ctx.op.params.text ?? "") });
    npc.secrets = npc.secrets ?? [];
    npc.secrets.push(secret);
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_secret", { data: { npcId: npc.id, secret, count: npc.secrets.length } });
  });
  engine.registerHandler("npc_remove_secret", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${ctx.op.params.npcId}".`, {}, ["Create the NPC first."]);
    const id = String(ctx.op.params.secretId ?? "");
    npc.secrets = (npc.secrets ?? []).filter((s: any) => s.id !== id);
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_secret", { data: { npcId: npc.id, removed: id, count: npc.secrets.length } });
  });

  // npc_add_journal / npc_get_journal — the NPC's first-person rolling memory.
  engine.registerHandler("npc_add_journal", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${ctx.op.params.npcId}".`, {}, ["Create the NPC first."]);
    const entry = NpcJournalSchema.parse({ id: newId("jrnl"), entry: String(ctx.op.params.entry ?? "") });
    npc.journal = npc.journal ?? [];
    npc.journal.push(entry);
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_journal", { data: { npcId: npc.id, entry, count: npc.journal.length } });
  });
  engine.registerHandler("npc_get_journal", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${ctx.op.params.npcId}".`, {}, ["Create the NPC first."]);
    const limit = Number(ctx.op.params.limit ?? 10);
    const entries = (npc.journal ?? []).slice(-limit);
    ctx.ir.emit("npc_journal", { data: { npcId: npc.id, entries, count: (npc.journal ?? []).length } });
  });

  // npc_compose — assemble the agent's prompt slices into a provider-ready
  // messages[] (the engine half of "invoke an NPC"). READ-ONLY; the controller/
  // harness sends these messages to the model. Slice order mirrors the rpg.mcp
  // composer: persona -> directive -> secrets -> state -> recent journal, then the
  // DM-supplied situation as the user turn. The engine hosts no LLM.
  engine.registerHandler("npc_compose", (ctx) => {
    const npcId = String(ctx.op.params.npcId ?? "");
    const npc = coll<any>(ctx, "npcs").get(npcId);
    if (!npc) throw reject("entity_not_found", `No NPC "${npcId}".`, { npcId }, ["Create the NPC first (npc_manage create)."]);
    const sit = npcSituation(ctx, npc);
    const { messages, slicesIncluded, estimatedTokens } = composeNpcMessages(npc, sit, String(ctx.op.params.situation ?? ""), Number(ctx.op.params.journalLimit ?? 5));
    ctx.ir.emit("npc_prompt", {
      actor: npcId,
      data: {
        npcId,
        name: npc.name,
        model: npc.model ?? null, // controller falls back to NARUTO_NPC_MODEL
        messages,
        slicesIncluded,
        estimatedTokens,
        affordances: { actions: sit.actions },
      },
      narration: `Composed ${npc.name}'s agent prompt (${slicesIncluded.join(", ") || "situation only"}).`,
    });
  });

  // npc_set_goal — upsert (or remove) a goal the NPC pursues off-screen; the tick
  // advances it and routes directed drives through the Standing spine.
  engine.registerHandler("npc_set_goal", (ctx) => {
    const npc = coll<any>(ctx, "npcs").get(String(ctx.op.params.npcId ?? ""));
    if (!npc) throw reject("entity_not_found", `No NPC "${ctx.op.params.npcId}".`, {}, ["Create the NPC first (npc_create)."]);
    const g = (ctx.op.params.goal as any) ?? {};
    const remove = ctx.op.params.remove === true;
    npc.goals = npc.goals ?? [];
    const id = g.id ?? newId("goal");
    npc.goals = npc.goals.filter((x: any) => x.id !== id);
    if (!remove) {
      npc.goals.push(NpcGoalSchema.parse({ id, text: String(g.text ?? "an unstated aim"), drive: g.drive, targetActorId: g.targetActorId, targetAuthorityId: g.targetAuthorityId, intensity: g.intensity ?? 1, progress: g.progress ?? 0 }));
    }
    coll(ctx, "npcs").put(npc);
    ctx.ir.emit("npc_goal", { data: { npcId: npc.id, goals: npc.goals, removed: remove ? id : undefined }, narration: remove ? `${npc.name} sets aside a goal.` : `${npc.name} now pursues: ${g.text ?? "an aim"}.` });
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
    rel.interactionCount = (rel.interactionCount ?? 0) + 1;
    const beat = String(ctx.op.params.beat ?? "an exchange");
    const importance = (ctx.op.params.importance as any) ?? "low";
    const topics = (ctx.op.params.topics as string[]) ?? [];
    const sd = ctx.op.params.standingDelta as any;
    rel.memories.push({ eventId: newId("mem"), summary: beat, importance, topics, standingDelta: sd, sentiment: Number(ctx.op.params.dispositionDelta ?? 0), witnessed: ctx.op.params.witnessed !== false });
    rels.put(rel);
    // a memory with a standingDelta writes into the authority ledger (the "why" behind reputation)
    let standing: any = null;
    if (sd?.authorityId) {
      const l = applyStandingDelta(ctx.store, actorId, sd.authorityId, { reputation: sd.reputation, favor: sd.favor, reason: beat });
      standing = { authorityId: sd.authorityId, reputation: l.reputation, favor: l.favor };
    }
    ctx.ir.emit("npc_interaction", {
      actor: actorId,
      data: { npcId, disposition: rel.disposition, familiarity: rel.familiarity, attitude: dispositionTier(rel.disposition), closeness: familiarityTier(rel.familiarity), interactionCount: rel.interactionCount, standing },
      narration: `${npc.name}: ${beat}.`,
    });
  });

  // npc_context — a single LLM-ready summary (tiers + salient memories + facts +
  // standing) so the DM can roleplay an NPC consistently in one read. Curated
  // from the rpg.mcp get_context idea; filters via limit/minImportance/topic.
  engine.registerHandler("npc_context", (ctx) => {
    const npcId = String(ctx.op.params.npcId ?? "");
    const actorId = String(ctx.op.actorId ?? ctx.op.params.actorId ?? "");
    const npc = coll<any>(ctx, "npcs").get(npcId);
    if (!npc) throw reject("entity_not_found", `No NPC "${npcId}".`, { npcId }, ["Create the NPC first (npc_create)."]);
    const rel = coll<NpcRelationship>(ctx, "npc_relationships").get(relId(npcId, actorId));
    const familiarity = rel?.familiarity ?? 0;
    const disposition = rel?.disposition ?? 0;
    const salient = salientMemories(rel?.memories ?? [], {
      limit: Number(ctx.op.params.limit ?? 5),
      minImportance: ctx.op.params.minImportance as string | undefined,
      topic: ctx.op.params.topic as string | undefined,
    });
    const facts = [...new Set([...(npc.knownFacts ?? []), ...(rel?.knownFacts ?? [])])];
    let standing: any = null;
    if (npc.authorityId && actorId) {
      const l = getLedger(ctx.store, actorId, npc.authorityId);
      if (l) standing = { authorityId: npc.authorityId, reputation: l.reputation, favor: l.favor, hostile: l.hostile };
    }
    const attitude = dispositionTier(disposition);
    const closeness = familiarityTier(familiarity);
    const lines = [
      `${npc.name} regards ${actorId || "the party"} as ${attitude} (${closeness}; ${rel?.interactionCount ?? 0} prior interaction${(rel?.interactionCount ?? 0) === 1 ? "" : "s"}).`,
      salient.length ? `Remembers: ${salient.map((m) => m.summary).join("; ")}.` : "",
      facts.length ? `Knows: ${facts.join("; ")}.` : "",
      standing ? `Standing with ${standing.authorityId}: reputation ${standing.reputation}${standing.hostile ? " (HOSTILE)" : ""}.` : "",
    ].filter(Boolean);
    ctx.ir.emit("npc_context", {
      actor: actorId || undefined,
      data: { npcId, name: npc.name, attitude, closeness, disposition, familiarity, interactionCount: rel?.interactionCount ?? 0, salientMemories: salient, knownFacts: facts, standing },
      narration: lines.join(" "),
    });
  });

  // npc_decide — the NPC analogue of agent_context: assemble everything an LLM
  // needs to choose what THIS NPC does next, framed as a decision. Persona
  // (goals+drives+known facts) + the scene (who's present) + how the NPC regards
  // each present PC (attitude/closeness + salient memories + standing) + a menu of
  // LEGAL social moves. READ-ONLY: the MOVE is produced by the calling LLM and
  // comes back as an ordinary intent (social_speak / move / npc_interact /
  // npc_set_goal), which the engine adjudicates. The engine hosts no LLM.
  engine.registerHandler("npc_decide", (ctx) => {
    const npcId = String(ctx.op.params.npcId ?? "");
    const npc = coll<any>(ctx, "npcs").get(npcId);
    if (!npc) throw reject("entity_not_found", `No NPC "${npcId}".`, { npcId }, ["Create the NPC first (npc_manage create)."]);
    const focusId = String(ctx.op.params.observerActorId ?? ctx.op.params.actorId ?? "");
    const s = npcSituation(ctx, npc);
    ctx.ir.emit("npc_decision", {
      actor: npcId,
      data: {
        npc: { id: npc.id, name: npc.name, authorityId: npc.authorityId, knownFacts: npc.knownFacts ?? [], position: npc.position },
        goals: s.goals,
        dominantGoal: s.dominant ?? null,
        scene: {
          mode: ctx.room.mode,
          present: s.regard,
          threats: s.foes.map((f: any) => ({ id: f.id, name: f.name, distanceFt: s.distFt(f) })),
          peers: s.peers.map((p: any) => ({ id: p.id, name: p.name })),
        },
        focusActorId: focusId || null,
        affordances: { actions: s.actions },
        contextSummary: s.contextSummary,
      },
      narration: s.contextSummary,
    });
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
    const tiers = rel ? { attitude: dispositionTier(rel.disposition), closeness: familiarityTier(rel.familiarity) } : null;
    ctx.ir.emit("npc_relationship", { data: { relationship: rel ?? null, tiers } });
  });

  // social_speak — who overhears an exchange (ninja eavesdropping). Reuses grid
  // positions + Stealth/Perception skills + Deafened + Silent Killing; overhearing
  // NPCs remember what they caught (feeds npc_context).
  engine.registerHandler("social_speak", (ctx) => {
    const speakerId = String(ctx.op.actorId ?? ctx.op.params.actorId ?? "");
    const room = ctx.room.id;
    const speaker = coll<any>(ctx, "characters").get(speakerId) ?? coll<any>(ctx, "adversaries").get(speakerId) ?? coll<any>(ctx, "npcs").get(speakerId);
    if (!speaker) throw reject("actor_required", "social_speak requires a valid speaker actorId.", { speakerId }, ["Set actorId to a character, adversary, or NPC in the room."]);
    const volume = (ctx.op.params.volume as Volume) ?? "talk";
    const text = String(ctx.op.params.text ?? "");
    const audience = ctx.op.params.audience as string[] | undefined;
    const all: any[] = [
      ...coll<any>(ctx, "characters").find((c) => c.roomId === room),
      ...coll<any>(ctx, "adversaries").find((a) => a.roomId === room),
      ...coll<any>(ctx, "npcs").find((n) => n.roomId === room),
    ];
    const listeners = (audience ? audience.map((id) => all.find((a) => a.id === id)).filter(Boolean) : all.filter((a) => a.id !== speakerId)) as any[];
    const results = resolveSpeech(ctx.rng, speaker, listeners, { volume, concealment: Number(ctx.op.params.concealment ?? 0) });
    const heard = results.filter((r) => r.heard);
    // overhearing NPCs remember it (speech -> NPC memory -> later npc_context)
    if (ctx.op.params.record !== false) {
      const rels = coll<NpcRelationship>(ctx, "npc_relationships");
      for (const r of heard) {
        const npc = coll<any>(ctx, "npcs").get(r.listenerId);
        if (!npc) continue;
        let rel = rels.get(relId(npc.id, speakerId));
        if (!rel) rel = NpcRelationshipSchema.parse({ id: relId(npc.id, speakerId), npcId: npc.id, actorId: speakerId, authorityId: npc.authorityId });
        rel.memories.push({ eventId: newId("mem"), summary: `overheard (${r.clarity}): "${text}"`, importance: (ctx.op.params.importance as any) ?? "low", topics: ((ctx.op.params.topics as string[]) ?? []).concat("overheard"), sentiment: 0, witnessed: true });
        rels.put(rel);
      }
    }
    ctx.ir.emit("social_speak", {
      actor: speakerId,
      data: { volume, text, heardBy: heard.map((r) => r.listenerId), results },
      narration: `${speaker.name ?? speakerId} ${volume === "whisper" ? "whispers" : volume === "shout" ? "shouts" : "speaks"}: "${text}" — caught by ${heard.length}/${listeners.length}.`,
    });
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
