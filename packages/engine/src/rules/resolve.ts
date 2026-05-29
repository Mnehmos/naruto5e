/**
 * Damage/heal application to an actor doc (Ch.8). Pure mutation; the caller owns
 * IR + dice. Handles temp HP, the dual-pool HP track, downed (PC -> death saves)
 * vs. dead (NPC at 0, or PC massive damage = overkill >= max HP).
 */
export interface DamageOutcome {
  dealt: number;
  tempAbsorbed: number;
  downed: boolean;
  died: boolean;
  hp: { current: number; max: number; temp: number };
}

export function applyDamageDoc(doc: any, amount: number, opts: { isPC: boolean; lethal?: boolean }): DamageOutcome {
  const lethal = opts.lethal !== false;
  let remaining = Math.max(0, Math.floor(amount));
  const temp = doc.hp.temp ?? 0;
  const tempAbsorbed = Math.min(temp, remaining);
  doc.hp.temp = temp - tempAbsorbed;
  remaining -= tempAbsorbed;

  const before = doc.hp.current;
  doc.hp.current = Math.max(0, before - remaining);
  const dealt = tempAbsorbed + (before - doc.hp.current);

  let downed = false;
  let died = false;
  if (doc.hp.current === 0 && before > 0) {
    const overkill = remaining - before; // damage beyond reaching 0
    if (opts.isPC) {
      if (overkill >= doc.hp.max) {
        doc.dead = true;
        died = true;
      } else {
        if (!doc.conditions.includes("Unconscious")) doc.conditions.push("Unconscious");
        doc.deathSaves = { successes: 0, failures: 0, stable: false };
        downed = true;
      }
    } else if (lethal) {
      doc.dead = true;
      died = true;
    } else {
      if (!doc.conditions.includes("Unconscious")) doc.conditions.push("Unconscious");
      downed = true;
    }
  } else if (doc.hp.current === 0 && opts.isPC) {
    // already at 0 and taking more damage -> a failed death save's worth
    doc.deathSaves = doc.deathSaves ?? { successes: 0, failures: 0, stable: false };
    doc.deathSaves.failures = Math.min(3, (doc.deathSaves.failures ?? 0) + 1);
    if (doc.deathSaves.failures >= 3) {
      doc.dead = true;
      died = true;
    }
  }

  return { dealt, tempAbsorbed, downed, died, hp: { current: doc.hp.current, max: doc.hp.max, temp: doc.hp.temp } };
}

export function healDoc(doc: any, amount: number): { healed: number; hp: any; revived: boolean } {
  const before = doc.hp.current;
  doc.hp.current = Math.min(doc.hp.max, before + Math.max(0, Math.floor(amount)));
  let revived = false;
  if (doc.hp.current > 0 && doc.conditions?.includes?.("Unconscious")) {
    doc.conditions = doc.conditions.filter((c: string) => c !== "Unconscious");
    doc.deathSaves = { successes: 0, failures: 0, stable: false };
    revived = true;
  }
  return { healed: doc.hp.current - before, hp: doc.hp, revived };
}
