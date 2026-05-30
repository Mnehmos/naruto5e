import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import { CharacterSchema, type Character } from "../domain/character.js";
import { emptyScores } from "../rules/abilities.js";
import {
  applyBackground,
  applyClass,
  applyClan,
  deriveCharacter,
  setAbilitiesByMethod,
  type BuildSelections,
} from "../rules/character.js";

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}

function loadChar(ctx: ResolveContext, id: string | undefined): Character {
  if (!id) throw reject("actor_required", "This action requires an actorId (the character).", {}, ["Set actorId to the character id."]);
  const c = chars(ctx).get(id);
  if (!c) throw reject("entity_not_found", `No character "${id}" in this room.`, { id }, ["Create the character first (character_create)."]);
  return c;
}

function selectionsFromParams(p: Record<string, unknown>): BuildSelections {
  return {
    abilityChoices: (p.abilityChoices as any) ?? [],
    bgAbilityChoice: p.bgAbilityChoice as any,
    clanSkillChoices: (p.clanSkillChoices as any) ?? [],
    classSkillChoices: (p.classSkillChoices as any) ?? [],
    backgroundSkillChoices: (p.backgroundSkillChoices as any) ?? [],
  };
}

function summary(c: Character) {
  return {
    id: c.id,
    name: c.name,
    clan: c.clan,
    className: c.className,
    background: c.background,
    level: c.level,
    rank: c.rank,
    hp: c.hp,
    chakra: c.chakra,
    ac: c.ac,
    abilities: c.abilityTotals,
    proficiencyBonus: c.proficiencyBonus,
    casting: c.casting,
    skills: c.proficiencies.skills,
    savingThrows: c.proficiencies.savingThrows,
    jutsuKnownCap: c.jutsuKnownCap,
    willOfFire: c.willOfFire,
  };
}

export function registerCharacterIntents(engine: Engine): void {
  // ---- one-shot build (the 7-step build collapsed into one call) -------
  engine.registerHandler("character_create", (ctx) => {
    const p = ctx.op.params;
    const name = String(p.name ?? "").trim();
    if (!name) throw reject("name_required", "character_create requires params.name.", {}, ["Provide params.name."]);
    const content = ctx.engine.content;

    const clanName = p.clan as string | undefined;
    const className = p.className as string | undefined;
    const bgName = p.background as string | undefined;

    const clan = clanName ? content.getClan(clanName) : undefined;
    if (clanName && !clan)
      throw reject("unknown_clan", `No clan "${clanName}".`, { clan: clanName }, [`Clans: ${content.clanNames().join(", ")}`]);
    const cls = className ? content.getClass(className) : undefined;
    if (className && !cls)
      throw reject("unknown_class", `No class "${className}".`, { className }, [`Classes: ${content.classNames().join(", ")}`]);
    const bg = bgName ? content.getBackground(bgName) : undefined;
    if (bgName && !bg)
      throw reject("unknown_background", `No background "${bgName}".`, { background: bgName }, [`Backgrounds: ${content.backgroundNames().join(", ")}`]);

    const level = Math.max(1, Math.min(20, Number(p.level ?? 1)));
    const id = (p.id as string) || newId("char");
    if (chars(ctx).get(id)) throw reject("id_taken", `Character id "${id}" already exists.`, { id });

    let char: Character = CharacterSchema.parse({
      id,
      name,
      ownerId: p.ownerId as string | undefined,
      roomId: ctx.room.id,
      isPC: true,
      team: (p.team as string) ?? "pc",
      level,
      abilities: emptyScores(),
      hp: { current: 1, max: 1, temp: 0 },
      chakra: { current: 1, max: 1, temp: 0 },
      hitDice: { type: 6, total: level, remaining: level },
      chakraDice: { type: 6, total: level, remaining: level },
      willOfFire: true,
    });

    // 1) abilities (base)
    const abMethod = (p.abilities as any)?.method ?? p.abilityMethod ?? "manual";
    const abParams = (p.abilities as any) ?? { scores: p.scores };
    setAbilitiesByMethod(char, String(abMethod), abParams, ctx.rng);

    const sel = selectionsFromParams(p);
    // 2-3) clan + background increases & profs
    if (clan) applyClan(char, clan, sel);
    if (bg) applyBackground(char, bg, sel);
    // 4) class
    if (cls) applyClass(char, cls, sel);

    // derive while still "unbuilt" so pools fill to max, then mark built
    char = deriveCharacter(char);
    char.built = true;
    chars(ctx).put(char);

    ctx.ir.emit("character_created", {
      actor: char.id,
      data: { character: summary(char) },
      narration: `${char.name} — ${char.rank} ${char.clan ?? ""} ${char.className ?? ""} (L${char.level}), HP ${char.hp.max}, Chakra ${char.chakra.max}.`,
    });
  });

  // ---- granular 7-step build ops --------------------------------------
  engine.registerHandler("character_set_abilities", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    setAbilitiesByMethod(char, String(ctx.op.params.method ?? "manual"), ctx.op.params, ctx.rng);
    deriveCharacter(char);
    chars(ctx).put(char);
    ctx.ir.emit("character_updated", { actor: char.id, data: { abilities: char.abilityTotals, hp: char.hp, chakra: char.chakra } });
  });

  engine.registerHandler("character_set_clan", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const clan = ctx.engine.content.getClan(String(ctx.op.params.clan ?? ""));
    if (!clan) throw reject("unknown_clan", `No clan "${ctx.op.params.clan}".`, {}, [`Clans: ${ctx.engine.content.clanNames().join(", ")}`]);
    applyClan(char, clan, selectionsFromParams(ctx.op.params));
    deriveCharacter(char);
    chars(ctx).put(char);
    ctx.ir.emit("character_updated", { actor: char.id, data: { clan: char.clan, abilities: char.abilityTotals, traits: char.clanTraits } });
  });

  engine.registerHandler("character_set_class", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const cls = ctx.engine.content.getClass(String(ctx.op.params.className ?? ""));
    if (!cls) throw reject("unknown_class", `No class "${ctx.op.params.className}".`, {}, [`Classes: ${ctx.engine.content.classNames().join(", ")}`]);
    applyClass(char, cls, selectionsFromParams(ctx.op.params));
    deriveCharacter(char);
    chars(ctx).put(char);
    ctx.ir.emit("character_updated", { actor: char.id, data: { className: char.className, hp: char.hp, chakra: char.chakra } });
  });

  engine.registerHandler("character_set_background", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const bg = ctx.engine.content.getBackground(String(ctx.op.params.background ?? ""));
    if (!bg) throw reject("unknown_background", `No background "${ctx.op.params.background}".`, {}, [`Backgrounds: ${ctx.engine.content.backgroundNames().join(", ")}`]);
    applyBackground(char, bg, selectionsFromParams(ctx.op.params));
    deriveCharacter(char);
    chars(ctx).put(char);
    ctx.ir.emit("character_updated", { actor: char.id, data: { background: char.background, skills: char.proficiencies.skills } });
  });

  engine.registerHandler("character_finalize", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    deriveCharacter(char); // fill pools to max while still unbuilt
    char.built = true;
    chars(ctx).put(char);
    ctx.ir.emit("character_created", { actor: char.id, data: { character: summary(char) }, narration: `${char.name} is ready.` });
  });

  // ---- progression -----------------------------------------------------
  engine.registerHandler("character_add_mission_points", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const amount = Number(ctx.op.params.amount ?? 0);
    char.missionPoints += amount;
    chars(ctx).put(char);
    ctx.ir.emit("mission_points", { actor: char.id, data: { missionPoints: char.missionPoints, gained: amount } });
  });

  engine.registerHandler("character_level_up", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    if (char.level >= 20) throw reject("max_level", `${char.name} is already level 20.`, { level: 20 });
    char.level += 1;
    char.hitDice.total = char.level;
    char.hitDice.remaining = Math.min(char.hitDice.remaining + 1, char.level);
    char.chakraDice.total = char.level;
    char.chakraDice.remaining = Math.min(char.chakraDice.remaining + 1, char.level);
    if (char.classes.length) char.classes[char.classes.length - 1].level += 1;
    // grant any newly-available class features
    const cls = char.className ? ctx.engine.content.getClass(char.className) : undefined;
    if (cls) {
      for (const f of cls.features ?? []) {
        if (f.level === char.level && !char.classFeatures.some((x) => x.name === f.name)) {
          char.classFeatures.push({ name: f.name, level: f.level, description: f.description });
        }
      }
    }
    // preserve current pool ratios sensibly: bump max, add the per-level gain to current
    const before = { hp: char.hp.max, ck: char.chakra.max };
    char.built = true;
    deriveCharacter(char);
    char.hp.current += Math.max(0, char.hp.max - before.hp);
    char.chakra.current += Math.max(0, char.chakra.max - before.ck);
    chars(ctx).put(char);
    ctx.ir.emit("level_up", {
      actor: char.id,
      data: { level: char.level, rank: char.rank, hp: char.hp, chakra: char.chakra, proficiencyBonus: char.proficiencyBonus },
      narration: `${char.name} reaches level ${char.level} (${char.rank}).`,
    });
  });

  // ---- Will of Fire (session-layer covenant, Ch.3) --------------------
  engine.registerHandler("will_of_fire", (ctx) => {
    const opName = String(ctx.op.params.op ?? "grant");
    if (opName === "reset_mission") {
      // refresh all PCs in the room on a mission boundary
      const all = chars(ctx).find((c) => c.roomId === ctx.room.id && c.isPC);
      for (const c of all) {
        c.willOfFire = true;
        chars(ctx).put(c);
      }
      ctx.ir.emit("will_of_fire", { data: { op: "reset_mission", count: all.length }, narration: "The Will of Fire burns anew for the squad." });
      return;
    }
    const char = loadChar(ctx, ctx.op.actorId);
    switch (opName) {
      case "grant":
        char.willOfFire = true;
        chars(ctx).put(char);
        ctx.ir.emit("will_of_fire", { actor: char.id, data: { has: true, op: "grant" }, narration: `${char.name} is awarded the Will of Fire.` });
        break;
      case "spend": {
        if (!char.willOfFire) throw reject("no_will_of_fire", `${char.name} does not currently hold the Will of Fire.`, {}, ["Earn it through compelling play first."]);
        char.willOfFire = false;
        chars(ctx).put(char);
        ctx.ir.emit("will_of_fire", { actor: char.id, data: { has: false, op: "spend", use: ctx.op.params.use }, narration: `${char.name} spends the Will of Fire: ${ctx.op.params.use ?? "a decisive moment"}.` });
        break;
      }
      case "gift": {
        const toId = String(ctx.op.params.to ?? "");
        const to = chars(ctx).get(toId);
        if (!char.willOfFire) throw reject("no_will_of_fire", `${char.name} has no Will of Fire to give.`, {});
        if (!to) throw reject("entity_not_found", `No character "${toId}" to gift to.`, { to: toId });
        char.willOfFire = false;
        to.willOfFire = true;
        chars(ctx).put(char);
        chars(ctx).put(to);
        ctx.ir.emit("will_of_fire", { actor: char.id, data: { op: "gift", from: char.id, to: to.id }, narration: `${char.name} gives their Will of Fire to ${to.name}.` });
        break;
      }
      default:
        throw reject("bad_wof_op", `Unknown will_of_fire op "${opName}".`, { op: opName }, ["Use grant | spend | gift | reset_mission."]);
    }
  });

  // ---- resource mutations (also used by combat/rest) ------------------
  engine.registerHandler("character_spend_chakra", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const amount = Number(ctx.op.params.amount ?? 0);
    if (amount > char.chakra.current)
      throw reject("chakra_affordability", `${char.name} has ${char.chakra.current} chakra; needs ${amount}.`, { required: amount, available: char.chakra.current, shortfall: amount - char.chakra.current }, ["Rest to recover chakra, or spend less."]);
    char.chakra.current -= amount;
    chars(ctx).put(char);
    ctx.ir.emit("resource", { actor: char.id, data: { kind: "chakra", delta: -amount, current: char.chakra.current } });
  });

  engine.registerHandler("character_heal", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const amount = Number(ctx.op.params.amount ?? 0);
    const before = char.hp.current;
    char.hp.current = Math.min(char.hp.max, char.hp.current + amount);
    if (char.hp.current > 0 && char.conditions.includes("Unconscious")) {
      char.conditions = char.conditions.filter((c) => c !== "Unconscious");
    }
    const healed = char.hp.current - before;
    chars(ctx).put(char);
    ctx.ir.emit("heal", {
      actor: char.id,
      data: { amount: healed, hp: char.hp, revived: before === 0 && char.hp.current > 0 },
      narration: `${char.name} is healed for ${healed} (${char.hp.current}/${char.hp.max} HP)${before === 0 && char.hp.current > 0 ? " — back on their feet!" : ""}.`,
    });
  });
}
