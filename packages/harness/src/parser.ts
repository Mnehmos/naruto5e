/**
 * Deterministic NL -> intent parser (the offline fallback DM brain). Maps common
 * phrasings onto engine intents, resolving actor/target names to ids via a name
 * index built from room state. The Anthropic-backed brain (dm.ts) supersedes
 * this when an API key is present; this guarantees the harness runs offline and
 * gives the LLM path a tested deterministic baseline.
 */
export interface ParsedIntent {
  type: string;
  actorId?: string;
  params: Record<string, unknown>;
}

export type NameIndex = Map<string, string>; // lowercased name -> id

export function buildNameIndex(state: any): NameIndex {
  const idx: NameIndex = new Map();
  for (const c of state?.characters ?? []) idx.set(String(c.name).toLowerCase(), c.id);
  for (const a of state?.adversaries ?? []) idx.set(String(a.name).toLowerCase(), a.id);
  return idx;
}

function findId(idx: NameIndex, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const k = name.trim().toLowerCase();
  if (idx.has(k)) return idx.get(k);
  for (const [n, id] of idx) if (n.includes(k) || k.includes(n)) return id;
  return undefined;
}

export function parse(utterance: string, idx: NameIndex, jutsuNames: string[] = []): ParsedIntent[] {
  const s = utterance.trim();
  const low = s.toLowerCase();

  // explicit narration
  const nm = s.match(/^narrate:?\s*(.+)$/i);
  if (nm) return [{ type: "narrate", params: { text: nm[1] } }];

  if (/^(advance|next turn|end turn)\b/i.test(low)) return [{ type: "advance", params: {} }];
  if (/\b(start|begin) combat\b/.test(low)) return [{ type: "combat_start", params: {} }];
  if (/\bend combat\b/.test(low)) return [{ type: "combat_end", params: {} }];
  if (/\b(long rest)\b/.test(low)) return [{ type: "rest", actorId: anyActor(idx), params: { type: "long", missionBoundary: true } }];
  if (/\b(short rest|rest)\b/.test(low)) return [{ type: "rest", actorId: anyActor(idx), params: { type: "short", spendHitDice: 1, spendChakraDice: 1 } }];

  // "<actor> casts <jutsu> at <target>"
  const cast = s.match(/^(.+?)\s+casts?\s+(.+?)(?:\s+(?:at|on)\s+(.+))?$/i);
  if (cast) {
    const jutsu = matchJutsu(cast[2], jutsuNames) ?? cast[2].trim();
    return [{ type: "cast", actorId: findId(idx, cast[1]), params: { jutsu, targets: cast[3] ? [findId(idx, cast[3])].filter(Boolean) : [] } }];
  }
  // "<actor> attacks <target>"
  const atk = s.match(/^(.+?)\s+(?:attacks?|strikes?|hits?)\s+(.+)$/i);
  if (atk) return [{ type: "attack", actorId: findId(idx, atk[1]), params: { target: findId(idx, atk[2]), damage: "1d6" } }];
  // "<actor> moves to x,y"
  const mv = s.match(/^(.+?)\s+moves?\s+to\s+(\d+)\s*,\s*(\d+)/i);
  if (mv) return [{ type: "move", actorId: findId(idx, mv[1]), params: { to: { x: Number(mv[2]), y: Number(mv[3]) } } }];

  // default: treat as narration
  return [{ type: "narrate", params: { text: s } }];
}

function anyActor(idx: NameIndex): string | undefined {
  return idx.values().next().value;
}
function matchJutsu(name: string, names: string[]): string | undefined {
  const k = name.trim().toLowerCase();
  return names.find((n) => n.toLowerCase() === k) ?? names.find((n) => n.toLowerCase().includes(k));
}
