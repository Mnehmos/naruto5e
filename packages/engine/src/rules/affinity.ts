/**
 * Chakra-nature affinity + Kekkei Genkai genesis, and the jutsu-learning gates.
 *
 * Design (mined from BYOND-era Naruto RP servers + the owner's spec):
 *  - 5 base natures; a character rolls 1-5 affinities at genesis on a steep rarity
 *    curve (1 common -> 5 near-impossible). Clans grant their canonical nature(s).
 *  - 2+ affinities are the BASIS for a Kekkei Genkai (combined nature), derived
 *    from element pairs (Ice = Water+Wind, etc.).
 *  - Learning is gated on rank/affinity/clan/class; generic jutsu stay open.
 *    Off-affinity is the "costly" path: gated, but unlockable via force (DM) or
 *    the favor route (favor_unlock) — mirroring RP servers where off-affinity is
 *    learnable but much harder, not impossible.
 *
 * Every table here is a TUNABLE CONSTANT — adjust freely; gameplay reads these.
 */
import { rankFromLevel } from "./abilities.js";

export const ELEMENTS = ["Fire", "Water", "Wind", "Earth", "Lightning"] as const;
export type Element = (typeof ELEMENTS)[number];

/** Kekkei Genkai recipes: a combined nature unlocked by holding both base natures. */
export const KKG_RECIPES: { name: string; elements: Element[] }[] = [
  { name: "Ice (Hyoton)", elements: ["Water", "Wind"] },
  { name: "Wood (Mokuton)", elements: ["Earth", "Water"] },
  { name: "Lava (Yoton)", elements: ["Fire", "Earth"] },
  { name: "Boil (Futton)", elements: ["Water", "Fire"] },
  { name: "Storm (Ranton)", elements: ["Lightning", "Water"] },
  { name: "Explosion (Bakuton)", elements: ["Earth", "Lightning"] },
  { name: "Scorch (Shakuton)", elements: ["Fire", "Wind"] },
  { name: "Magnet (Jiton)", elements: ["Wind", "Earth"] },
  { name: "Plasma", elements: ["Fire", "Lightning"] },
  { name: "Tempest", elements: ["Wind", "Lightning"] },
  // 3-element advanced bloodline (rolled 3 natures): the apex KKG.
  { name: "Dust (Jinton)", elements: ["Earth", "Wind", "Fire"] },
];

/** Rarity curve for the NUMBER of affinities rolled at genesis (per-mille weights). */
export const AFFINITY_COUNT_WEIGHTS: { count: number; perMille: number }[] = [
  { count: 1, perMille: 700 }, // common
  { count: 2, perMille: 220 }, // uncommon
  { count: 3, perMille: 60 }, // rare
  { count: 4, perMille: 15 }, // near-impossible
  { count: 5, perMille: 5 }, // much more near-impossible
];

/** Ninja-rank -> highest jutsu rank learnable (the rank gate). */
export const RANK_JUTSU_CAP: Record<string, string> = {
  Academy: "E",
  Genin: "C",
  Chunin: "B",
  Jonin: "A",
  Kage: "S",
  Legendary: "S",
};
const RANK_ORDER = ["E", "D", "C", "B", "A", "S"];

type Rng = { int: (min: number, max: number) => number };

export function rollAffinityCount(rng: Rng): number {
  const total = AFFINITY_COUNT_WEIGHTS.reduce((a, w) => a + w.perMille, 0);
  let roll = rng.int(1, total);
  for (const w of AFFINITY_COUNT_WEIGHTS) {
    if (roll <= w.perMille) return w.count;
    roll -= w.perMille;
  }
  return 1;
}

/** Expand clan-granted entries (which may be KKG names like "Ice") into base elements. */
export function expandToElements(list: string[]): Element[] {
  const out: Element[] = [];
  for (const entry of list) {
    if ((ELEMENTS as readonly string[]).includes(entry)) {
      if (!out.includes(entry as Element)) out.push(entry as Element);
      continue;
    }
    const recipe = KKG_RECIPES.find((r) => r.name.toLowerCase().includes(entry.toLowerCase()) || entry.toLowerCase().includes(r.name.split(" ")[0].toLowerCase()));
    if (recipe) for (const e of recipe.elements) if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** KKG names a character qualifies for, from their base affinities. */
export function deriveKKG(affinities: string[]): string[] {
  return KKG_RECIPES.filter((r) => r.elements.every((e) => affinities.includes(e))).map((r) => r.name);
}

/**
 * Resolve a KKG name to its recipe with loose matching, so a caller can pin a
 * bloodline by canonical name ("Dust (Jinton)"), short name ("Dust"), or the
 * parenthetical/native term ("Jinton"). Returns undefined for an unknown name.
 */
export function findKKGRecipe(name: string): { name: string; elements: Element[] } | undefined {
  const q = String(name ?? "").trim().toLowerCase();
  if (!q) return undefined;
  return KKG_RECIPES.find((r) => {
    const full = r.name.toLowerCase(); // "dust (jinton)"
    const short = r.name.split(" ")[0].toLowerCase(); // "dust"
    const paren = /\(([^)]+)\)/.exec(r.name)?.[1]?.toLowerCase(); // "jinton"
    return full === q || short === q || paren === q;
  });
}

/** Authored-genesis overrides: pin a bloodline/natures instead of blind-rolling. */
export type GenesisOptions = {
  /** Pin a Kekkei Genkai by name; its recipe elements are guaranteed at genesis. */
  forceKKG?: string;
  /** Pin specific base elements (e.g. an authored single-nature character). */
  forceElements?: string[];
};

/** Clan-keyed special-trait roll (dojutsu stages, etc.). Tunable. */
function rollSpecialTraits(rng: Rng, clan?: string): string[] {
  const c = (clan ?? "").toLowerCase();
  if (c === "uchiha") {
    const r = rng.int(1, 100);
    const stage = r <= 45 ? "1 tomoe" : r <= 75 ? "2 tomoe" : r <= 93 ? "3 tomoe" : "Mangekyo";
    return [`Sharingan (${stage})`];
  }
  if (c === "hyuga") return ["Byakugan"];
  if (c === "kaguya") return ["Shikotsumyaku (Dead Bone Pulse)"];
  // everyone else: a small chance of a latent gift
  return rng.int(1, 100) <= 8 ? ["Latent Talent"] : [];
}

/**
 * Roll a character's genesis: affinities (clan grant + rarity-rolled extras),
 * derived KKG, and special traits. Mutates and returns the character.
 *
 * When `opts` pins a bloodline (forceKKG) or natures (forceElements) — e.g. an
 * authored Dust Release prodigy — those elements are seeded and the random
 * rarity expansion is skipped, so genesis is deterministic: exactly the
 * clan-granted + requested natures, with the requested KKG derived. Without
 * overrides, behaviour is unchanged (blind rarity roll).
 */
export function rollGenesis(
  char: any,
  rng: Rng,
  opts: GenesisOptions = {},
): { affinity: string[]; kkg: string[]; specialTraits: string[] } {
  const seed = expandToElements(char.affinity ?? []); // clan-granted base natures
  const elements: Element[] = [...new Set(seed)] as Element[];

  // Authored override: pin the requested KKG's recipe elements and/or explicit
  // natures into the seed. (Validation/normalization of the names happens at the
  // intent layer so a bad name yields an educational rejection.)
  const forcedKKG = opts.forceKKG ? findKKGRecipe(opts.forceKKG) : undefined;
  if (forcedKKG) for (const e of forcedKKG.elements) if (!elements.includes(e)) elements.push(e);
  for (const e of opts.forceElements ?? [])
    if ((ELEMENTS as readonly string[]).includes(e) && !elements.includes(e as Element)) elements.push(e as Element);
  const pinned = !!forcedKKG || (opts.forceElements?.length ?? 0) > 0;

  // Pinned genesis is deterministic (no random extra natures); blind genesis
  // expands on the rarity curve as before.
  const count = pinned ? elements.length : Math.max(elements.length, rollAffinityCount(rng));
  const pool = ELEMENTS.filter((e) => !elements.includes(e));
  while (elements.length < count && pool.length) {
    elements.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
  }
  char.affinity = elements;
  char.kkg = deriveKKG(elements);
  char.specialTraits = [...new Set([...(char.specialTraits ?? []), ...rollSpecialTraits(rng, char.clan)])];
  return { affinity: char.affinity, kkg: char.kkg, specialTraits: char.specialTraits };
}

// ---- learning gates --------------------------------------------------------

export function rankAllows(charRank: string, jutsuRank: string): boolean {
  const cap = RANK_JUTSU_CAP[charRank] ?? "C";
  return RANK_ORDER.indexOf(jutsuRank) <= RANK_ORDER.indexOf(cap);
}

/**
 * The jutsu-rank CAP for a character — the decoupling of TITLE from TIER (bug_1780247960181).
 * The in-world rank TITLE (char.rank) is earned at the Chūnin Exam (rank_up); it is NOT
 * auto-promoted by leveling. The learnable-jutsu TIER follows LEVEL (char.rankTier, set by
 * deriveCharacter). The cap is the MORE PERMISSIVE of the two, so a strong but un-promoted
 * Genin (L5+) can still grow their jutsu ladder, while a DM/exam-set title (or a hand-built
 * test fixture that sets char.rank directly) is always honored. Backward-compatible: for an
 * L1 fixture, the level tier is "Genin" (the floor), so the explicit title wins unchanged.
 */
export function jutsuRankCap(char: { rank?: string; rankTier?: string; level?: number }): string {
  const tier = char.rankTier ?? rankFromLevel(char.level ?? 1);
  const tierCap = RANK_JUTSU_CAP[tier] ?? "C";
  const titleCap = RANK_JUTSU_CAP[char.rank ?? "Genin"] ?? "C";
  return RANK_ORDER.indexOf(tierCap) >= RANK_ORDER.indexOf(titleCap) ? tierCap : titleCap;
}

/** rankAllows for a whole character, using the decoupled (title|tier) cap. */
export function charRankAllows(char: { rank?: string; rankTier?: string; level?: number }, jutsuRank: string): boolean {
  return RANK_ORDER.indexOf(jutsuRank) <= RANK_ORDER.indexOf(jutsuRankCap(char));
}

/** Does the character have access to a jutsu's element (direct affinity OR a KKG)? */
export function hasElementAccess(char: any, element?: string | null): boolean {
  if (!element || element === "neutral") return true;
  const el = String(element);
  if ((char.affinity ?? []).includes(el)) return true;
  // KKG-named element (e.g. an "Ice" jutsu): the character holds the matching KKG
  if ((char.kkg ?? []).some((k: string) => k.toLowerCase().includes(el.toLowerCase()) || el.toLowerCase().includes(k.split(" ")[0].toLowerCase()))) return true;
  return false;
}
