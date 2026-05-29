/**
 * The DM brain (Architecture tier 3) — the sole write-path for play. It parses
 * player natural language into structured intents and submits them through the
 * MCP controller's engine client (the thin adapter into engine REST). It never
 * holds authoritative state (reads from the engine) and never does the engine's
 * arithmetic — it declares what is attempted; the engine decides what happens.
 *
 * Two modes:
 *   - LLM mode (ANTHROPIC_API_KEY set + @anthropic-ai/sdk installed): Claude
 *     parses NL into tool calls, which route to the engine; IR is narrated back.
 *   - Deterministic fallback (offline): the rules-based parser (parser.ts). This
 *     keeps the harness runnable + testable with no key.
 */
import { EngineClient } from "@naruto5e/mcp-controller";
import { buildNameIndex, parse, type ParsedIntent } from "./parser.js";

export interface DMTurn {
  utterance: string;
  intents: ParsedIntent[];
  narration: string[];
  rejections: { rule: string; explain: string; suggestions: string[] }[];
  mode: "llm" | "fallback";
}

const SYSTEM_PROMPT = `You are the Dungeon Master (DM) for a game of Naruto 5e, the sole write-path into a deterministic engine.
Rules of your role:
- Players declare intent in fiction; you conform it into LEGAL engine operations and submit them via the submit_intent tool.
- The engine owns all dice and outcomes — you NEVER invent numbers. You declare what is attempted.
- Every engine rejection is educational (named rule + numbers + how to fix). Read it, re-conform, and narrate the correction as a story beat.
- After resolving, narrate the resulting IR events as vivid, concise prose.
Available engine actions include: narrate, scene, character_create, jutsu_learn, cast, attack, move, dash, dodge, advance, combat_start, combat_end, rest, mission_post, mission_resolve, adversary_spawn, from_bingo_book, legendary_action, grant_reputation, npc_interact, jutsu_build, freeform, and more — all via submit_intent {roomId, type, actorId?, params}.`;

export class DMBrain {
  private client: EngineClient;
  private jutsuNames: string[] = [];
  private anthropic: any = null;
  private model: string;

  constructor(engineUrl: string, opts: { model?: string } = {}) {
    this.client = new EngineClient(engineUrl);
    this.model = opts.model ?? process.env.NARUTO_DM_MODEL ?? "claude-opus-4-8";
  }

  private async ensureLLM(): Promise<boolean> {
    if (this.anthropic) return true;
    if (!process.env.ANTHROPIC_API_KEY) return false;
    try {
      const mod = await import("@anthropic-ai/sdk");
      const Anthropic = (mod as any).default ?? (mod as any).Anthropic;
      this.anthropic = new Anthropic();
      return true;
    } catch {
      return false;
    }
  }

  private async loadJutsuNames(): Promise<void> {
    if (this.jutsuNames.length) return;
    const c = await this.client.listJutsu({});
    this.jutsuNames = (c.jutsu ?? []).map((j: any) => j.name).filter(Boolean);
  }

  private collect(result: any, narration: string[], rejections: any[]): void {
    if (!result) return;
    if (result.status === "resolved") {
      for (const e of result.events ?? []) if (e.narration) narration.push(e.narration);
    } else if (result.status === "rejected") {
      rejections.push({ rule: result.reason?.rule, explain: result.reason?.explain, suggestions: result.suggestions ?? [] });
    }
  }

  /** Resolve one player utterance into engine ops + narration. */
  async respond(roomId: string, utterance: string): Promise<DMTurn> {
    await this.loadJutsuNames();
    const narration: string[] = [];
    const rejections: any[] = [];

    if (await this.ensureLLM()) {
      return this.respondLLM(roomId, utterance, narration, rejections);
    }

    // ---- deterministic fallback ----
    const state = await this.client.getRoomState(roomId);
    const idx = buildNameIndex(state);
    const intents = parse(utterance, idx, this.jutsuNames);
    for (const it of intents) {
      const r = await this.client.submitIntent({ roomId, type: it.type, actorId: it.actorId, params: it.params, role: "dm" });
      this.collect(r, narration, rejections);
    }
    return { utterance, intents, narration, rejections, mode: "fallback" };
  }

  private async respondLLM(roomId: string, utterance: string, narration: string[], rejections: any[]): Promise<DMTurn> {
    const state = await this.client.getRoomState(roomId);
    const tools = [
      {
        name: "submit_intent",
        description: "Submit a structured Naruto 5e intent to the engine. type is any engine action; params is type-specific.",
        input_schema: {
          type: "object",
          properties: { type: { type: "string" }, actorId: { type: "string" }, params: { type: "object" } },
          required: ["type"],
        },
      },
    ];
    const intents: ParsedIntent[] = [];
    const messages: any[] = [
      { role: "user", content: `Room state:\n${JSON.stringify(stateDigest(state))}\n\nPlayer: ${utterance}` },
    ];
    for (let step = 0; step < 8; step++) {
      const resp = await this.anthropic.messages.create({ model: this.model, max_tokens: 1024, system: SYSTEM_PROMPT, tools, messages });
      const toolUses = (resp.content ?? []).filter((b: any) => b.type === "tool_use");
      for (const b of resp.content ?? []) if (b.type === "text" && b.text.trim()) narration.push(b.text.trim());
      if (toolUses.length === 0) break;
      messages.push({ role: "assistant", content: resp.content });
      const toolResults: any[] = [];
      for (const tu of toolUses) {
        const inp = tu.input ?? {};
        intents.push({ type: inp.type, actorId: inp.actorId, params: inp.params ?? {} });
        const r = await this.client.submitIntent({ roomId, type: inp.type, actorId: inp.actorId, params: inp.params ?? {}, role: "dm" });
        this.collect(r, narration, rejections);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(r).slice(0, 2000) });
      }
      messages.push({ role: "user", content: toolResults });
    }
    return { utterance, intents, narration, rejections, mode: "llm" };
  }
}

function stateDigest(state: any): any {
  return {
    room: { mode: state.room?.mode, location: (state.room as any)?.location },
    characters: (state.characters ?? []).map((c: any) => ({ id: c.id, name: c.name, hp: c.hp, chakra: c.chakra, team: c.team })),
    adversaries: (state.adversaries ?? []).map((a: any) => ({ id: a.id, name: a.name, hp: a.hp, tier: a.tier, team: a.team })),
    encounter: state.encounter ? { round: state.encounter.round, turn: state.encounter.order?.[state.encounter.activeIndex] } : null,
  };
}
