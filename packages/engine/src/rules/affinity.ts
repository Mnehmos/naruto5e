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
 */
export function rollGenesis(char: any, rng: Rng): { affinity: string[]; kkg: string[]; specialTraits: string[] } {
  const seed = expandToElements(char.affinity ?? []); // clan-granted base natures
  const elements: Element[] = [...new Set(seed)] as Element[];
  const count = Math.max(elements.length, rollAffinityCount(rng));
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

/** Does the character have access to a jutsu's element (direct affinity OR a KKG)? */
export function hasElementAccess(char: any, element?: string | null): boolean {
  if (!element || element === "neutral") return true;
  const el = String(element);
  if ((char.affinity ?? []).includes(el)) return true;
  // KKG-named element (e.g. an "Ice" jutsu): the character holds the matching KKG
  if ((char.kkg ?? []).some((k: string) => k.toLowerCase().includes(el.toLowerCase()) || el.toLowerCase().includes(k.split(" ")[0].toLowerCase()))) return true;
  return false;
}
