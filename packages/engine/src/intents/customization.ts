import { reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { deriveCharacter } from "../rules/character.js";
import { checkMulticlassPrereq } from "../rules/multiclass.js";
import { ABILITIES, type Ability } from "../rules/skills.js";

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}
function loadChar(ctx: ResolveContext): Character {
  const c = chars(ctx).get(String(ctx.op.actorId));
  if (!c) throw reject("actor_required", "This action requires a valid actorId.", {}, ["Set actorId to a character."]);
  return c;
}

const FEAT_LEVELS = [4, 8, 12, 16, 19];

/** Ch.13 — multiclassing + feats (the ASI-or-feat choice). */
export function registerCustomizationIntents(engine: Engine): void {
  engine.registerHandler("character_multiclass", (ctx) => {
    const c = loadChar(ctx);
    if (c.level >= 20) throw reject("max_level", `${c.name} is already level 20.`, {});
    const intoName = String(ctx.op.params.intoClass ?? "");
    const cls = ctx.engine.content.getClass(intoName);
    if (!cls) throw reject("unknown_class", `No class "${intoName}".`, {}, [`Classes: ${ctx.engine.content.classNames().join(", ")}`]);
    const pre = checkMulticlassPrereq(c, cls);
    if (!pre.ok) {
      throw reject("multiclass_prereq", `${c.name} doesn't meet the prereq to enter ${cls.name}: ${pre.detail}.`, { needed: pre.needed, abilities: c.abilityTotals }, [
        `Raise ${pre.needed.map((n) => n.ability.toUpperCase()).join("/")} to 13+, or pick a class you qualify for.`,
      ]);
    }
    c.level += 1;
    const existing = c.classes.find((x) => x.className === cls.name);
    if (existing) existing.level += 1;
    else {
      c.classes.push({ className: cls.name, level: 1, hitDie: cls.hitDie, chakraDie: cls.chakraDie, archetype: cls.archetype });
      // grant the new class's L1 features
      for (const f of cls.features ?? []) if (f.level === 1) c.classFeatures.push({ name: f.name, level: 1, description: f.description });
    }
    const before = { hp: c.hp.max, ck: c.chakra.max };
    deriveCharacter(c);
    c.hp.current += Math.max(0, c.hp.max - before.hp);
    c.chakra.current += Math.max(0, c.chakra.max - before.ck);
    chars(ctx).put(c);
    ctx.ir.emit("multiclass", {
      actor: c.id,
      data: { level: c.level, classes: c.classes, hp: c.hp, chakra: c.chakra, jutsuKnownCap: c.jutsuKnownCap },
      narration: `${c.name} takes a level in ${cls.name} (now ${c.classes.map((x) => `${x.className} ${x.level}`).join(" / ")}).`,
    });
  });

  engine.registerHandler("ability_score_improvement", (ctx) => {
    const c = loadChar(ctx);
    const plan = (ctx.op.params.plan as { ability: string; amount: number }[]) ?? [];
    const total = plan.reduce((s, p) => s + p.amount, 0);
    if (total !== 2) throw reject("asi_invalid", `An ASI grants +2 total (e.g. +2 to one, or +1 to two); got +${total}.`, { plan }, ["Use plan: [{ability,amount}] summing to 2."]);
    for (const p of plan) {
      const ab = p.ability.toLowerCase() as Ability;
      if (!ABILITIES.includes(ab)) throw reject("bad_ability", `"${p.ability}" is not an ability.`, {});
      const cur = (c.abilityTotals ?? c.abilities)[ab];
      if (cur + p.amount > 20) throw reject("ability_cap", `${ab.toUpperCase()} would exceed 20.`, { ability: ab, current: cur }, ["Pick a different ability."]);
      c.abilityBonuses[ab] = (c.abilityBonuses[ab] ?? 0) + p.amount;
    }
    deriveCharacter(c);
    chars(ctx).put(c);
    ctx.ir.emit("ability_score_improvement", { actor: c.id, data: { abilities: c.abilityTotals, plan }, narration: `${c.name} improves ${plan.map((p) => `+${p.amount} ${p.ability.toUpperCase()}`).join(", ")}.` });
  });

  engine.registerHandler("take_feat", (ctx) => {
    const c = loadChar(ctx);
    const feat = ctx.engine.content.getFeat(String(ctx.op.params.feat ?? ""));
    if (!feat) throw reject("unknown_feat", `No feat "${ctx.op.params.feat}".`, {}, ["Query the feat catalog (/v1/content not yet exposed; use known names)."]);
    if (c.feats.includes(feat.name)) throw reject("feat_owned", `${c.name} already has ${feat.name}.`, {});
    // prerequisite validation
    const pre = feat.prerequisite;
    if (pre) {
      const totals = c.abilityTotals ?? c.abilities;
      for (const [ab, min] of Object.entries(pre.abilities ?? {})) {
        if (totals[ab as Ability] < (min as number)) {
          throw reject("feat_prereq", `${feat.name} requires ${ab.toUpperCase()} ${min}; ${c.name} has ${totals[ab as Ability]}.`, { ability: ab, min, has: totals[ab as Ability] }, [`Raise ${ab.toUpperCase()} to ${min}+.`]);
        }
      }
      if (pre.level && c.level < pre.level) throw reject("feat_prereq", `${feat.name} requires level ${pre.level}; ${c.name} is ${c.level}.`, { needed: pre.level, has: c.level }, ["Level up first."]);
      if (pre.clan && c.clan?.toLowerCase() !== String(pre.clan).toLowerCase()) throw reject("feat_prereq", `${feat.name} requires the ${pre.clan} clan.`, { clan: pre.clan }, ["This feat is clan-restricted."]);
    }
    // apply the feat's ability increase (choice)
    if (feat.abilityIncrease) {
      const inc = feat.abilityIncrease;
      const pick = (ctx.op.params.abilityChoice as Ability) ?? inc.options[0];
      if (!inc.options.includes(pick)) throw reject("feat_ability_choice", `${feat.name} grants +${inc.amount} to one of [${inc.options.join(", ")}].`, { options: inc.options }, [`Provide abilityChoice: one of ${inc.options.join(", ")}.`]);
      const cur = (c.abilityTotals ?? c.abilities)[pick];
      if (cur + inc.amount <= 20) c.abilityBonuses[pick] = (c.abilityBonuses[pick] ?? 0) + inc.amount;
    }
    c.feats.push(feat.name);
    c.classFeatures.push({ name: `Feat: ${feat.name}`, level: c.level, description: feat.description });
    deriveCharacter(c);
    chars(ctx).put(c);
    ctx.ir.emit("feat_taken", {
      actor: c.id,
      data: { feat: feat.name, category: feat.category, abilities: c.abilityTotals, atFeatLevel: FEAT_LEVELS.includes(c.level) },
      narration: `${c.name} gains the ${feat.name} feat.`,
    });
  });
}
