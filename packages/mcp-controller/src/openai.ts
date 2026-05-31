/**
 * Minimal, zero-dependency OpenAI Chat Completions client for the NPC-agent layer.
 *
 * The engine is deterministic and hosts no LLM; the controller is the Node process
 * in the MCP tool path, so the actual model call for an invoked NPC lives here. We
 * deliberately send NO temperature — gpt-5.x reasoning models manage their own
 * sampling (and reject temperature != 1), matching the .env contract.
 */
export interface OpenAIChatResult {
  text: string;
  finishReason?: string;
  usage?: { prompt?: number; completion?: number; total?: number };
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export async function openaiChat(params: {
  model: string;
  messages: { role: string; content: string }[];
  maxCompletionTokens?: number;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<OpenAIChatResult> {
  const apiKey = params.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set — add it to .env to invoke NPC agents.");

  const body: Record<string, unknown> = { model: params.model, messages: params.messages };
  // No temperature on purpose (reasoning models manage sampling). max_completion_tokens
  // is the modern field (gpt-5.x); omit by default so reasoning isn't starved.
  if (params.maxCompletionTokens) body.max_completion_tokens = params.maxCompletionTokens;

  const signal = params.timeoutMs ? AbortSignal.timeout(params.timeoutMs) : undefined;
  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status} ${resp.statusText}: ${errText.slice(0, 500)}`);
  }
  const json: any = await resp.json();
  const choice = json.choices?.[0];
  return {
    text: String(choice?.message?.content ?? "").trim(),
    finishReason: choice?.finish_reason,
    usage: { prompt: json.usage?.prompt_tokens, completion: json.usage?.completion_tokens, total: json.usage?.total_tokens },
  };
}
