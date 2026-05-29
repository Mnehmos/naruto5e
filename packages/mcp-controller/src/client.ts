/**
 * The MCP Controller's engine client (Architecture tier 2 / §3): a thin,
 * stateless HTTP adapter into the engine's REST API. Holds NO game state and
 * NO game logic — it translates a call into an engine request and returns the
 * engine's response. Restartable at any time with zero data loss.
 */
export interface SubmitIntentArgs {
  roomId: string;
  type: string;
  actorId?: string;
  params?: Record<string, unknown>;
  cost?: Record<string, number>;
  role?: "player" | "dm";
}

export interface BatchArgs {
  roomId: string;
  ops: Array<{ type: string; actorId?: string; params?: Record<string, unknown> }>;
  atomic?: boolean;
  role?: "player" | "dm";
}

export class EngineClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { status: "error", message: text };
    }
  }

  submitIntent(args: SubmitIntentArgs): Promise<any> {
    return this.req("POST", `/v1/rooms/${encodeURIComponent(args.roomId)}/intent`, {
      type: args.type,
      actorId: args.actorId,
      params: args.params ?? {},
      cost: args.cost,
      submittedBy: { clientType: "llm", role: args.role ?? "dm" },
    });
  }

  batch(args: BatchArgs): Promise<any> {
    return this.req("POST", `/v1/rooms/${encodeURIComponent(args.roomId)}/intent`, {
      type: "batch",
      params: { ops: args.ops, atomic: args.atomic === true },
      submittedBy: { clientType: "llm", role: args.role ?? "dm" },
    });
  }

  getRoomState(roomId: string): Promise<any> {
    return this.req("GET", `/v1/rooms/${encodeURIComponent(roomId)}/state`);
  }

  getEncounter(roomId: string): Promise<any> {
    return this.req("GET", `/v1/rooms/${encodeURIComponent(roomId)}/encounter`);
  }

  getCharacter(id: string): Promise<any> {
    return this.req("GET", `/v1/characters/${encodeURIComponent(id)}`);
  }

  getEntity(coll: string, id: string): Promise<any> {
    return this.req("GET", `/v1/entities/${encodeURIComponent(coll)}/${encodeURIComponent(id)}`);
  }

  listJutsu(query: { rank?: string; classification?: string; q?: string } = {}): Promise<any> {
    const qs = new URLSearchParams();
    if (query.rank) qs.set("rank", query.rank);
    if (query.classification) qs.set("classification", query.classification);
    if (query.q) qs.set("q", query.q);
    const s = qs.toString();
    return this.req("GET", `/v1/jutsu${s ? `?${s}` : ""}`);
  }

  listContent(kind: "clans" | "classes" | "backgrounds"): Promise<any> {
    return this.req("GET", `/v1/content/${kind}`);
  }

  health(): Promise<any> {
    return this.req("GET", `/v1/health`);
  }
}
