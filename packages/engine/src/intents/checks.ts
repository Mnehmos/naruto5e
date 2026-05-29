import { reject, rollD20 } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { abilityMod } from "../rules/abilities.js";
import { abilityForSkill, canonicalSkill, type Ability } from "../rules/skills.js";

/** Ch.6 — d20 + ability mod + (prof if trained) vs DC. All deterministic. */
function actor(ctx: ResolveContext): Character {
  const id = ctx.op.actorId;
  const c = id ? ctx.store.collection<Character>("characters").get(id) : undefined;
  if (!c) throw reject("actor_required", "This check requires a valid actorId.", { actorId: id }, ["Set actorId to a character."]);
  return c;
}

function abMod(c: Character, ability: Ability): number {
  const totals = c.abilityTotals ?? c.abilities;
  return abilityMod(totals[ability]);
}

export function registerCheckIntents(engine: Engine): void {
  engine.registerHandler("skill_check", (ctx) => {
    const c = actor(ctx);
    const raw = String(ctx.op.params.skill ?? "");
    const skill = canonicalSkill(raw);
    if (!skill) throw reject("unknown_skill", `"${raw}" is not a valid skill.`, { skill: raw });
    const ability = abilityForSkill(skill)!;
    const proficient = c.proficiencies.skills.includes(skill);
    const mod = abMod(c, ability) + (proficient ? c.proficiencyBonus : 0);
    const roll = rollD20(ctx.rng, {
      modifier: mod,
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    const success = dc !== undefined ? roll.total >= dc : undefined;
    ctx.ir.emit("roll", {
      actor: c.id,
      data: { kind: "skill_check", skill, ability, proficient, dc, ...roll, success },
      narration: `${c.name} ${skill} check: ${roll.total}${dc !== undefined ? ` vs DC ${dc} → ${success ? "success" : "failure"}` : ""}.`,
    });
  });

  engine.registerHandler("saving_throw", (ctx) => {
    const c = actor(ctx);
    const ability = String(ctx.op.params.ability ?? "").toLowerCase() as Ability;
    if (!["str", "dex", "con", "int", "wis", "cha"].includes(ability))
      throw reject("bad_ability", `"${ctx.op.params.ability}" is not an ability.`, {}, ["Use str|dex|con|int|wis|cha."]);
    const proficient = c.proficiencies.savingThrows.includes(ability);
    const mod = abMod(c, ability) + (proficient ? c.proficiencyBonus : 0);
    const roll = rollD20(ctx.rng, {
      modifier: mod,
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    const success = dc !== undefined ? roll.total >= dc : undefined;
    ctx.ir.emit("roll", {
      actor: c.id,
      data: { kind: "saving_throw", ability, proficient, dc, ...roll, success },
      narration: `${c.name} ${ability.toUpperCase()} save: ${roll.total}${dc !== undefined ? ` vs DC ${dc} → ${success ? "success" : "failure"}` : ""}.`,
    });
  });

  engine.registerHandler("ability_check", (ctx) => {
    const c = actor(ctx);
    const ability = String(ctx.op.params.ability ?? "").toLowerCase() as Ability;
    if (!["str", "dex", "con", "int", "wis", "cha"].includes(ability))
      throw reject("bad_ability", `"${ctx.op.params.ability}" is not an ability.`, {}, ["Use str|dex|con|int|wis|cha."]);
    const roll = rollD20(ctx.rng, {
      modifier: abMod(c, ability),
      advantage: !!ctx.op.params.advantage,
      disadvantage: !!ctx.op.params.disadvantage,
      bonus: Number(ctx.op.params.bonus ?? 0),
    });
    const dc = ctx.op.params.dc !== undefined ? Number(ctx.op.params.dc) : undefined;
    ctx.ir.emit("roll", {
      actor: c.id,
      data: { kind: "ability_check", ability, dc, ...roll, success: dc !== undefined ? roll.total >= dc : undefined },
    });
  });
}
