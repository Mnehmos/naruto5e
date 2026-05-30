/**
 * Social hearing / eavesdropping — catered to our system: it reuses our grid
 * positions (5ft Chebyshev squares, as combat.ts), our Stealth/Perception skill
 * proficiencies + ability mods, our Deafened condition, and ninja traits
 * (Silent Killing). Deterministic: all rolls come from the room RNG.
 *
 * Unpositioned actors are treated as co-located (distance 0) so the system is
 * usable in a plain scene without a full spatial setup.
 */
import { rollD20, type Rng } from "@naruto5e/shared";
import { actorAbilityMod } from "./actor.js";

export type Volume = "whisper" | "talk" | "shout";
export const VOLUME_RANGE: Record<Volume, number> = { whisper: 10, talk: 30, shout: 120 }; // feet

export function gridDistance(a?: { x: number; y: number }, b?: { x: number; y: number }): number {
  if (!a || !b) return 0; // unpositioned -> co-located in-scene
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5;
}

function hasTrait(doc: any, re: RegExp): boolean {
  return [...(doc.traits ?? []), ...(doc.clanTraits ?? [])].some((t: string) => re.test(String(t)));
}

function skillMod(doc: any, ability: "dex" | "wis", skill: string): number {
  const prof = doc.proficiencies?.skills?.includes?.(skill) ? doc.proficiencyBonus ?? 0 : 0;
  return actorAbilityMod(doc, ability) + prof;
}

export interface HearResult {
  listenerId: string;
  heard: boolean;
  clarity: "clear" | "faint" | "none";
  distance: number;
  roll?: { stealth: number; perception: number };
  reason?: string;
}

/**
 * Who hears a speaker. Within clearRange (half the volume's range) listeners hear
 * automatically; out to the full range it's an opposed Stealth(speaker) vs
 * Perception(listener) roll (eavesdrop). Beyond range, or if Deafened, no.
 * Silent Killing makes the speaker effectively unheard except on a winning
 * Perception roll (the speaker rolls Stealth even inside clearRange, at +10).
 */
export function resolveSpeech(
  rng: Rng,
  speaker: any,
  listeners: any[],
  opts: { volume: Volume; concealment?: number },
): HearResult[] {
  const range = Math.max(1, Math.round(VOLUME_RANGE[opts.volume] * (1 - Math.min(0.9, Math.max(0, opts.concealment ?? 0)))));
  const clearRange = range / 2;
  const silent = hasTrait(speaker, /silent killing/i);
  const out: HearResult[] = [];
  for (const L of listeners) {
    const distance = gridDistance(speaker.position, L.position);
    if ((L.conditions ?? []).includes("Deafened")) {
      out.push({ listenerId: L.id, heard: false, clarity: "none", distance, reason: "deafened" });
      continue;
    }
    if (distance > range) {
      out.push({ listenerId: L.id, heard: false, clarity: "none", distance, reason: "out of range" });
      continue;
    }
    if (distance <= clearRange && !silent) {
      out.push({ listenerId: L.id, heard: true, clarity: "clear", distance });
      continue;
    }
    // borderline distance, or a Silent-Killing speaker: opposed roll
    const s = rollD20(rng, { modifier: skillMod(speaker, "dex", "Stealth") + (silent ? 10 : 0) });
    const p = rollD20(rng, { modifier: skillMod(L, "wis", "Perception") });
    const heard = p.total >= s.total;
    out.push({ listenerId: L.id, heard, clarity: heard ? "faint" : "none", distance, roll: { stealth: s.total, perception: p.total } });
  }
  return out;
}
