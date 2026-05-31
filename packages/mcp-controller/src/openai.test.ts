import { describe, it, expect, vi, afterEach } from "vitest";
import { openaiChat } from "./openai.js";

// The NPC-agent provider call. Deterministic via a mocked fetch — no network.
describe("openaiChat", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts {model, messages} with NO temperature, and parses the reply", async () => {
    let sent: any;
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "I bar the door." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await openaiChat({ model: "gpt-5.4-mini", messages: [{ role: "user", content: "go" }], apiKey: "sk-test" });
    expect(r.text).toBe("I bar the door.");
    expect(r.finishReason).toBe("stop");
    expect(r.usage?.total).toBe(15);
    expect(sent.model).toBe("gpt-5.4-mini");
    expect(sent.messages).toHaveLength(1);
    expect("temperature" in sent).toBe(false); // no temperature by design (reasoning models)
    expect("max_completion_tokens" in sent).toBe(false); // omitted unless explicitly set
  });

  it("sends max_completion_tokens only when provided", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }));
    await openaiChat({ model: "m", messages: [], maxCompletionTokens: 256, apiKey: "sk-test" });
    expect(sent.max_completion_tokens).toBe(256);
  });

  it("throws a clear, key-named error when OPENAI_API_KEY is absent", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(openaiChat({ model: "m", messages: [] })).rejects.toThrow(/OPENAI_API_KEY/);
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });

  it("surfaces a non-2xx response as an error with status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad model", { status: 404, statusText: "Not Found" })));
    await expect(openaiChat({ model: "nope", messages: [], apiKey: "sk-test" })).rejects.toThrow(/OpenAI 404/);
  });
});
