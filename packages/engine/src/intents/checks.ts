import { reject, rollD20 } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { abilityForSkill, canonicalSkill, type Ability } from "../rules/skills.js";
import { loadActor, actorAbilityMod, type ActorRef } from "../rules/actor.js";

/** Ch.6 — d20 + ability mod + (prof if trained) vs DC. All deterministic.
 *  Actor resolution mirrors cast/attack (loadActor), so checks work uniformly
 *  for characters AND adversaries — not just the characters collection. */
function actor(ctx: ResolveContext): ActorRef {
  const id = ctx.op.actorId;
  const ref = id ? loadActor(ctx.store, id) : undefined;
  if (!ref) throw reject("actor_required", "This check requires a valid actorId.", { actorId: id }, ["Set actorId to a character or adversary in this room."]);
  return ref;
}

const profBonus = (doc: any): number => doc.proficiencyBonus ?? 0;
const skillProficient = (doc: any, skill: string): boolean => !!doc.proficiencies?.skills?.includes(skill);
const saveProficient = (doc: any, ability: string): boolean => !!doc.proficiencies?.savingThrows?.includes(ability);
const nameOf = (doc: any): string => doc.name ?? doc.id;

export function registerCheckIntents(engine: Engine): void {
  engine.registerHandler("skill_check", (ctx) => {
    const { doc } = actor(ctx);
    const raw = String(ctx.op.params.skill ?? "");
    const skill = canonicalSkill(raw);
    if (!skill) throw reject("unknown_skill", `"${raw}" is not a valid skill.`, { skill: raw });
    const ability = abilityForSkill(skill)!;
    const proficient = skillProficient(doc, skill);
    const mod = actorAbilityMod(doc, ability) + (proficient ? profBonus(doc) : 0);
    const roll = rollD20(ctx.rng, {
      modifier: mod,
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    const success = dc !== undefined ? roll.total >= dc : undefined;
    ctx.ir.emit("roll", {
      actor: doc.id,
      data: { kind: "skill_check", skill, ability, proficient, dc, ...roll, success },
      narration: `${nameOf(doc)} ${skill} check: ${roll.total}${dc !== undefined ? ` vs DC ${dc} → ${success ? "success" : "failure"}` : ""}.`,
    });
  });

  engine.registerHandler("saving_throw", (ctx) => {
    const { doc } = actor(ctx);
    const ability = String(ctx.op.params.ability ?? "").toLowerCase() as Ability;
    if (!["str", "dex", "con", "int", "wis", "cha"].includes(ability))
      throw reject("bad_ability", `"${ctx.op.params.ability}" is not an ability.`, {}, ["Use str|dex|con|int|wis|cha."]);
    const proficient = saveProficient(doc, ability);
    const mod = actorAbilityMod(doc, ability) + (proficient ? profBonus(doc) : 0);
    const roll = rollD20(ctx.rng, {
      modifier: mod,
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    const success = dc !== undefined ? roll.total >= dc : undefined;
    ctx.ir.emit("roll", {
      actor: doc.id,
      data: { kind: "saving_throw", ability, proficient, dc, ...roll, success },
      narration: `${nameOf(doc)} ${ability.toUpperCase()} save: ${roll.total}${dc !== undefined ? ` vs DC ${dc} → ${success ? "success" : "failure"}` : ""}.`,
    });
  });

  engine.registerHandler("ability_check", (ctx) => {
    const { doc } = actor(ctx);
    const ability = String(ctx.op.params.ability ?? "").toLowerCase() as Ability;
    if (!["str", "dex", "con", "int", "wis", "cha"].includes(ability))
      throw reject("bad_ability", `"${ctx.op.params.ability}" is not an ability.`, {}, ["Use str|dex|con|int|wis|cha."]);
    const roll = rollD20(ctx.rng, {
      modifier: actorAbilityMod(doc, ability),
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    ctx.ir.emit("roll", {
      actor: doc.id,
      data: { kind: "ability_check", ability, dc, ...roll, success: dc !== undefined ? roll.total >= dc : undefined },
      narration: `${nameOf(doc)} ${ability.toUpperCase()} check: ${roll.total}${dc !== undefined ? ` vs DC ${dc} → ${roll.total >= dc ? "success" : "failure"}` : ""}.`,
    });
  });
}
