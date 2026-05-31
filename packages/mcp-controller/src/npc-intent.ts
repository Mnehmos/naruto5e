/**
 * NPC declaration → legal engine intent CONFORMANCE.
 *
 * The autonomous-NPC loop is: npc context → npc declaration (LLM text) → CONFORM → submit to
 * engine → engine resolves ground truth → journal declaration+outcome. This module is the
 * CONFORM rung: a deterministic mapper from what an NPC *says it does* to a submittable engine
 * intent — or a needs_dm_repair signal when the declaration can't be made legal. It is PURE
 * (no engine/network), so it's trivially testable and can't itself mutate state.
 *
 * Key principle: a declaration is an ATTEMPT, not an outcome. "I expose the secret" conforms to
 * a social_speak attempt; whether anyone hears/believes it is the engine's call, not the model's.
 *
 * Prefer STRUCTURED output: the NPC prompt asks for a JSON action object
 *   { "intent": "speak", "text": "...", "target": "...", "tone": "..." }
 * but plain first-person prose ("I step between them and lower my voice.") is tolerated.
 */

export interface ConformAffordances {
  actions?: { type: string; label?: string; paramsHint?: string }[]; // npc_decide legal-move menu
  jutsu?: { id: string; name?: string; castable?: boolean }[]; // agent_context castable jutsu
  allies?: { id: string; name?: string }[];
  threats?: { id: string; name?: string }[];
  present?: { actorId?: string; id?: string; name?: string }[]; // npc_decide regard list
}

export interface ConformInput {
  declaration: string;
  npcId: string;
  actorId?: string; // the acting entity id used as the intent's actorId (speaker/mover/attacker)
  roomId: string;
  mode: "tick" | "scene" | "combat" | "downtime";
  affordances?: ConformAffordances;
}

export interface ConformedIntent {
  type: string;
  actorId?: string;
  params: Record<string, unknown>;
}

export type ConformResult =
  | { status: "conformed"; intent: ConformedIntent; note?: string }
  | { status: "needs_dm_repair"; reason: string; suggestions: string[] };

const SPEECH_VERBS = /\b(say|says|said|tell|tells|told|warn|warns|whisper|whispers|shout|shouts|demand|demands|ask|asks|declare|declares|announce|announces|reveal|reveals|threaten|threatens|mutter|mutters|call out|calls out|greet|greets|order|orders|promise|promises|reassure|reassures|insist|insists)\b/i;
const MOVE_VERBS = /\b(move|moves|approach|approaches|step|steps|withdraw|withdraws|retreat|retreats|reposition|repositions|advance|advances|fall back|close in|back away|circle)\b/i;
const ATTACK_VERBS = /\b(attack|attacks|strike|strikes|lunge|lunges|swing|swings|slash|slashes|stab|stabs|punch|punches|charge|charges|engage|engages)\b/i;
const CAST_VERBS = /\b(cast|casts|weave|weaves|use|uses|unleash|unleashes|form|forms|perform|performs)\b/i;
const GOAL_VERBS = /\b(focus on|pursue|pursues|work toward|works toward|plot|plots|scheme|schemes|plan to|plans to|set out to|resolve to|dedicate)\b/i;
const REFLECT_VERBS = /\b(wait|waits|watch|watches|observe|observes|consider|considers|think|thinks|reflect|reflects|bide|bides|hold|holds|listen|listens|wonder|wonders|remember|remembers|do nothing|stay put|rest)\b/i;

function extractJson(text: string): any | undefined {
  if (!text) return undefined;
  // fenced ```json ... ``` block first
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1]];
  // else the first balanced {...}
  const brace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (brace >= 0 && lastBrace > brace) candidates.push(text.slice(brace, lastBrace + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === "object") return o;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Resolve a target NAME (or id) to a concrete actor id using the affordances, if possible. */
function resolveTarget(name: string | undefined, aff?: ConformAffordances): string | undefined {
  if (!name) return undefined;
  const pool = [...(aff?.threats ?? []), ...(aff?.allies ?? []), ...(aff?.present ?? [])];
  const byId = pool.find((p) => (p as any).id === name || (p as any).actorId === name);
  if (byId) return (byId as any).id ?? (byId as any).actorId;
  const lc = name.toLowerCase();
  const byName = pool.find((p) => (p as any).name && String((p as any).name).toLowerCase().includes(lc));
  if (byName) return (byName as any).id ?? (byName as any).actorId;
  return name; // pass through; the engine will resolve or reject educationally
}

function hasAction(aff: ConformAffordances | undefined, type: string): boolean {
  return !aff?.actions || aff.actions.some((a) => a.type === type); // if no menu provided, don't block
}

const VOLUME = new Set(["whisper", "talk", "shout"]);

/** Normalize a structured/keyword intent verb to an engine intent type + builder. */
function fromKeyword(kw: string): string | undefined {
  const k = kw.toLowerCase().trim();
  if (["speak", "say", "talk", "tell", "warn", "whisper", "shout", "demand", "reveal", "announce", "threaten", "social_speak"].includes(k)) return "social_speak";
  if (["interact", "relate", "shift", "stance", "npc_interact", "befriend", "intimidate"].includes(k)) return "npc_interact";
  if (["goal", "set_goal", "npc_set_goal", "pursue", "scheme"].includes(k)) return "npc_set_goal";
  if (["reflect", "journal", "wait", "observe", "think", "rest", "idle", "npc_add_journal", "nothing"].includes(k)) return "npc_add_journal";
  if (["move", "approach", "withdraw", "reposition", "retreat"].includes(k)) return "move";
  if (["attack", "strike"].includes(k)) return "attack";
  if (["cast", "jutsu", "use_jutsu"].includes(k)) return "cast";
  return undefined;
}

function repair(reason: string, suggestions: string[]): ConformResult {
  return { status: "needs_dm_repair", reason, suggestions };
}

/**
 * Conform an NPC's declaration into a single legal engine intent (or needs_dm_repair).
 */
export function conformNpcDeclaration(input: ConformInput): ConformResult {
  const text = (input.declaration ?? "").trim();
  const actorId = input.actorId ?? input.npcId;
  if (!text) return repair("The NPC declared nothing.", ["Re-invoke with a scene/situation, or have the DM narrate instead."]);

  const aff = input.affordances;
  const j = extractJson(text);

  // ---- structured form: { intent, text, target, tone, jutsu, to, distance, goal, beat } ----
  if (j && (j.intent || j.action || j.type)) {
    const type = fromKeyword(String(j.intent ?? j.action ?? j.type));
    if (!type) return repair(`Unrecognized intent "${j.intent ?? j.action ?? j.type}".`, ["Use one of: speak, interact, goal, reflect, move, attack, cast."]);
    return buildIntent(type, { ...input, declaration: text }, actorId, aff, {
      text: j.text ?? j.say ?? j.message,
      target: j.target ?? j.at ?? j.toward,
      tone: j.tone,
      volume: j.volume,
      jutsu: j.jutsu ?? j.technique,
      to: j.to,
      distance: j.distance,
      goal: j.goal ?? j.aim,
      beat: j.beat ?? j.text,
    });
  }

  // ---- plain prose: classify by verb / quotes ----
  const quoted = /["“”']([^"“”']{2,})["“”']/.exec(text);
  if (quoted) return buildIntent("social_speak", input, actorId, aff, { text: quoted[1] });
  if (SPEECH_VERBS.test(text)) return buildIntent("social_speak", input, actorId, aff, { text });
  if (ATTACK_VERBS.test(text) && input.mode === "combat") return buildIntent("attack", input, actorId, aff, { target: guessName(text, aff?.threats) });
  if (CAST_VERBS.test(text) && /jutsu|release|technique|\bart\b/i.test(text)) return buildIntent("cast", input, actorId, aff, { jutsu: guessJutsu(text, aff) });
  if (MOVE_VERBS.test(text) && hasAction(aff, "move")) return buildIntent("move", input, actorId, aff, { distance: 15 });
  if (GOAL_VERBS.test(text)) return buildIntent("npc_set_goal", input, actorId, aff, { goal: text });
  if (REFLECT_VERBS.test(text)) return buildIntent("npc_add_journal", input, actorId, aff, { beat: text });

  // a plain in-character sentence with no clear action verb is most safely an utterance OR a
  // private reflection. If it reads first-person, journal it (safe, non-mutating); else repair.
  if (/^\s*i\b/i.test(text)) return buildIntent("npc_add_journal", input, actorId, aff, { beat: text });
  return repair("Couldn't map the declaration to a legal action.", [
    "Have the NPC declare ONE concrete move: speak, interact, set a goal, move, attack, or cast.",
    'Prefer JSON: {"intent":"speak","text":"…","target":"…"}.',
  ]);
}

function guessName(text: string, pool?: { id?: string; name?: string }[]): string | undefined {
  if (!pool) return undefined;
  const hit = pool.find((p) => p.name && new RegExp(`\\b${escapeRe(p.name)}\\b`, "i").test(text));
  return hit ? hit.id : pool[0]?.id;
}
function guessJutsu(text: string, aff?: ConformAffordances): string | undefined {
  const list = (aff?.jutsu ?? []).filter((x) => x.castable !== false);
  const hit = list.find((jt) => jt.name && new RegExp(escapeRe(jt.name), "i").test(text));
  return hit?.id ?? list[0]?.id;
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildIntent(
  type: string,
  input: ConformInput,
  actorId: string,
  aff: ConformAffordances | undefined,
  parts: { text?: string; target?: string; tone?: string; volume?: string; jutsu?: string; to?: any; distance?: any; goal?: any; beat?: string },
): ConformResult {
  switch (type) {
    case "social_speak": {
      const text = (parts.text ?? "").toString().trim();
      if (!text) return repair("A speak action needs words.", ['Provide text: {"intent":"speak","text":"…"}.']);
      const volume = parts.volume && VOLUME.has(String(parts.volume)) ? String(parts.volume) : parts.tone && /whisper|low|quiet/i.test(parts.tone) ? "whisper" : parts.tone && /shout|yell|loud/i.test(parts.tone) ? "shout" : "talk";
      const params: Record<string, unknown> = { actorId, text, volume };
      const aud = resolveTarget(parts.target, aff);
      if (aud && aud !== parts.target) params.audience = [aud];
      return { status: "conformed", intent: { type: "social_speak", actorId, params } };
    }
    case "npc_interact": {
      const target = resolveTarget(parts.target, aff);
      if (!target) return repair("An interaction needs a target PC.", ["Name who the NPC relates to (target)."]);
      return { status: "conformed", intent: { type: "npc_interact", actorId, params: { npcId: input.npcId, actorId: target, beat: parts.beat ?? parts.text ?? "an exchange", importance: "low" } } };
    }
    case "npc_set_goal": {
      const goalText = typeof parts.goal === "string" ? parts.goal : (parts.goal?.text ?? parts.text);
      if (!goalText) return repair("A goal update needs goal text.", ['Provide goal: {"intent":"goal","goal":"shadow the squad"}.']);
      const goal = typeof parts.goal === "object" && parts.goal ? parts.goal : { text: goalText };
      return { status: "conformed", intent: { type: "npc_set_goal", actorId, params: { npcId: input.npcId, goal } } };
    }
    case "npc_add_journal": {
      const entry = (parts.beat ?? parts.text ?? input.declaration).toString().trim();
      return { status: "conformed", intent: { type: "npc_add_journal", actorId, params: { npcId: input.npcId, entry } }, note: "reflection (no world mutation)" };
    }
    case "move": {
      if (!hasAction(aff, "move")) return repair("This NPC has no legal movement here.", ["Use a social move instead, or have the DM place the NPC."]);
      const params: Record<string, unknown> = { actorId };
      if (parts.to && typeof parts.to === "object") params.to = parts.to;
      else params.distance = Number(parts.distance ?? 15) || 15;
      return { status: "conformed", intent: { type: "move", actorId, params } };
    }
    case "attack": {
      if (input.mode !== "combat") return repair("Attacks are only legal in combat.", ["Out of combat, use social_speak / npc_interact, or have the DM start combat."]);
      const target = resolveTarget(parts.target, aff);
      if (!target) return repair("An attack needs a target.", ["Name a target from the threats list."]);
      return { status: "conformed", intent: { type: "attack", actorId, params: { target } } };
    }
    case "cast": {
      const jutsuId = parts.jutsu ? String(parts.jutsu) : undefined;
      const list = aff?.jutsu ?? [];
      const known = jutsuId ? list.find((x) => x.id === jutsuId || (x.name && x.name.toLowerCase() === jutsuId.toLowerCase())) : undefined;
      if (list.length && jutsuId && !known) return repair(`"${jutsuId}" isn't a known/castable jutsu for this NPC.`, ["Pick from the castable jutsu in the affordances, or have the DM teach it first."]);
      if (known && known.castable === false) return repair(`${known.name ?? jutsuId} isn't castable right now (chakra/components).`, ["Choose a castable jutsu, or a non-cast action."]);
      const id = known?.id ?? jutsuId;
      if (!id) return repair("A cast needs a jutsu.", ['Provide jutsu: {"intent":"cast","jutsu":"<id>","target":"…"}.']);
      const params: Record<string, unknown> = { jutsu: id };
      const target = resolveTarget(parts.target, aff);
      if (target) params.targets = [target];
      return { status: "conformed", intent: { type: "cast", actorId, params } };
    }
    default:
      return repair(`No builder for "${type}".`, ["Use: speak, interact, goal, reflect, move, attack, cast."]);
  }
}
