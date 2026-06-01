/**
 * A unified "actor" view over combatants. Phase 2 actors are characters; Phase 4
 * adds adversaries (a trimmed sheet). Both submit intent into the same
 * combat_action surface (the architecture's symmetry principle), so combat reads
 * actors through these accessors regardless of which collection they live in.
 */
import { abilityMod } from "./abilities.js";
import type { Ability } from "./skills.js";
import type { Store } from "../store/types.js";
import { buffModTotal } from "./buffs.js";

export interface ActorRef {
  doc: any;
  coll: "characters" | "adversaries";
}

export function loadActor(store: Store, id: string): ActorRef | undefined {
  const c = store.collection("characters").get(id);
  if (c) return { doc: c, coll: "characters" };
  const a = store.collection("adversaries").get(id);
  if (a) return { doc: a, coll: "adversaries" };
  return undefined;
}

export function saveActor(store: Store, ref: ActorRef): void {
  store.collection(ref.coll).put(ref.doc);
}

export function actorAbilityMod(doc: any, ability: Ability): number {
  const totals = doc.abilityTotals ?? doc.abilities ?? {};
  if (typeof totals[ability] === "number") return abilityMod(totals[ability]);
  // adversaries may store ability MODIFIERS directly
  const mods = doc.abilityMods ?? {};
  if (typeof mods[ability] === "number") return mods[ability];
  return 0;
}

export interface CastingTrack {
  ability: string;
  mod: number;
  attack: number;
  saveDC: number;
}

/** Casting numbers for a jutsu classification (Nin=INT, Gen=WIS, Tai=STR/DEX). */
export function actorCasting(doc: any, classification: string): CastingTrack {
  const cls = classification.toLowerCase();
  if (doc.casting) {
    if (cls === "genjutsu") return doc.casting.genjutsu;
    if (cls === "taijutsu" || cls === "bukijutsu") return doc.casting.taijutsu;
    return doc.casting.ninjutsu; // ninjutsu / hijutsu / medical default
  }
  // adversary fallback: derive from prof + a primary mod
  const prof = doc.proficiencyBonus ?? 3;
  let mod: number;
  if (cls === "genjutsu") mod = actorAbilityMod(doc, "wis");
  else if (cls === "taijutsu" || cls === "bukijutsu") mod = Math.max(actorAbilityMod(doc, "str"), actorAbilityMod(doc, "dex"));
  else mod = actorAbilityMod(doc, "int");
  return { ability: cls, mod, attack: prof + mod, saveDC: 8 + prof + mod };
}

export function actorAC(doc: any): number {
  const base = doc.ac ?? 10;
  // Phase B — active buffs may add to AC.  Empty activeBuffs → zero delta,
  // preserving every existing combat-test numeric.
  return base + buffModTotal(doc, "ac");
}

export function actorAffinity(doc: any): string[] {
  return doc.affinity ?? [];
}
