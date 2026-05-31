/**
 * The jutsu-learning gate as a pure predicate, shared by jutsu_learn (throws on
 * failure) and jutsu_learnable / autoLoadout (filters). Axes: rank, clan
 * (Hijutsu), class (Medical), affinity (elemental). `force` (DM) and favor
 * bypass all of these at the call site — this just reports the constraint.
 */
import { jutsuElement } from "./combat.js";
import { rankAllows, hasElementAccess, RANK_JUTSU_CAP } from "./affinity.js";

export interface LearnGateResult {
  ok: boolean;
  rule?: string;
  explain?: string;
  suggestions?: string[];
  element?: string | null;
}

export function learnGate(char: any, jutsu: any, clanNames: string[]): LearnGateResult {
  const kws = (jutsu.keywords ?? []).map((k: string) => k.toLowerCase());
  const prereq = String(jutsu.prerequisites ?? "").toLowerCase();

  if (!rankAllows(char.rank, jutsu.rank)) {
    return { ok: false, rule: "rank_too_high", explain: `${char.name} is ${char.rank}; ${jutsu.name} is rank ${jutsu.rank} (your cap is ${RANK_JUTSU_CAP[char.rank] ?? "C"}).`, suggestions: ["Rank up first, or pass force:true (DM)."] };
  }
  const namedClan = clanNames.find((cn) => prereq.includes(cn.toLowerCase()));
  if (kws.includes("hijutsu") && namedClan && (char.clan ?? "").toLowerCase() !== namedClan.toLowerCase()) {
    return { ok: false, rule: "clan_locked", explain: `${jutsu.name} is a ${namedClan} clan secret; ${char.name} is ${char.clan ?? "clanless"}.`, suggestions: ["Only the matching clan learns it (or force:true / favor)."] };
  }
  if (kws.includes("medical") && char.className !== "Medical-Nin") {
    return { ok: false, rule: "class_locked", explain: `${jutsu.name} is a Medical art; only a Medical-Nin can learn it (${char.name} is a ${char.className}).`, suggestions: ["Multiclass into Medical-Nin, or pass force:true."] };
  }
  const el = jutsuElement(jutsu);
  if (el && el !== "neutral" && !hasElementAccess(char, el)) {
    return { ok: false, rule: "off_affinity", explain: `${jutsu.name} is ${el}-natured; ${char.name}'s natures are [${(char.affinity ?? []).join(", ") || "none"}]${(char.kkg ?? []).length ? ` (KKG ${char.kkg.join(", ")})` : ""}.`, suggestions: ["Off-affinity is the hard path: force:true (DM), or favor_unlock the nature."], element: el };
  }
  return { ok: true, element: el };
}
