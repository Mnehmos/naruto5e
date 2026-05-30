/**
 * NPC social helpers — derive human-readable tiers from the numeric familiarity
 * (0..100) and disposition (-100..100) scales, and select the most salient
 * memories for LLM context injection. Deterministic: recency uses array order
 * (memories are appended in interaction order), never a wall-clock.
 */
export type Attitude = "hostile" | "unfriendly" | "neutral" | "friendly" | "helpful";
export type Closeness = "stranger" | "acquaintance" | "friend" | "close_friend";

export function dispositionTier(n: number): Attitude {
  if (n <= -60) return "hostile";
  if (n <= -20) return "unfriendly";
  if (n < 20) return "neutral";
  if (n < 60) return "friendly";
  return "helpful";
}

export function familiarityTier(n: number): Closeness {
  if (n < 10) return "stranger";
  if (n < 35) return "acquaintance";
  if (n < 70) return "friend";
  return "close_friend";
}

const IMPORTANCE_RANK: Record<string, number> = { low: 0, notable: 1, defining: 2 };

export interface MemoryLike {
  summary: string;
  importance?: string;
  topics?: string[];
  [k: string]: unknown;
}

/** Most-salient-first memories: importance desc, then recency (append order) desc. */
export function salientMemories(
  memories: MemoryLike[],
  opts: { limit?: number; minImportance?: string; topic?: string } = {},
): MemoryLike[] {
  const minRank = opts.minImportance ? IMPORTANCE_RANK[opts.minImportance] ?? 0 : 0;
  const ranked = memories
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => (IMPORTANCE_RANK[m.importance ?? "low"] ?? 0) >= minRank)
    .filter(({ m }) => (opts.topic ? (m.topics ?? []).includes(opts.topic) : true))
    .sort(
      (a, b) =>
        (IMPORTANCE_RANK[b.m.importance ?? "low"] ?? 0) - (IMPORTANCE_RANK[a.m.importance ?? "low"] ?? 0) || b.i - a.i,
    )
    .map(({ m }) => m);
  return opts.limit && opts.limit > 0 ? ranked.slice(0, opts.limit) : ranked;
}
