import { newId, reject, rollExpression } from "@naruto5e/shared";
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
import { rollGenesis, deriveKKG, findKKGRecipe, KKG_RECIPES, ELEMENTS, RANK_JUTSU_CAP } from "../rules/affinity.js";
import { levelForXp, xpToNext } from "../rules/progression.js";
import { getLedger, applyStandingDelta } from "../rules/standing.js";
import { learnGate } from "../rules/learn.js";
import { jutsuElement } from "../rules/combat.js";

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
    xp: c.xp,
    xpToNext: xpToNext(c.xp),
    willOfFire: c.willOfFire,
  };
}

/** Perform ONE level-up (pools, dice, class features, rank) and emit level_up.
 *  Shared by character_level_up and the XP auto-leveler (award_xp). */
function levelUpOnce(ctx: ResolveContext, char: Character): void {
  char.level += 1;
  char.hitDice.total = char.level;
  char.hitDice.remaining = Math.min(char.hitDice.remaining + 1, char.level);
  char.chakraDice.total = char.level;
  char.chakraDice.remaining = Math.min(char.chakraDice.remaining + 1, char.level);
  if (char.classes.length) char.classes[char.classes.length - 1].level += 1;
  const cls = char.className ? ctx.engine.content.getClass(char.className) : undefined;
  if (cls) {
    for (const f of cls.features ?? []) {
      if (f.level === char.level && !char.classFeatures.some((x) => x.name === f.name)) {
        char.classFeatures.push({ name: f.name, level: f.level, description: f.description });
      }
    }
  }
  // bump max pools, credit the per-level gain to current
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

    const requestedLevel = Number(p.level ?? 1);
    const level = Math.max(1, Math.min(20, requestedLevel));
    const levelClamped = Number.isFinite(requestedLevel) && requestedLevel !== level ? { requested: requestedLevel, clampedTo: level } : null;
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

    // Optional authored bloodline: pin a Kekkei Genkai (e.g. "Dust (Jinton)") and/or
    // explicit natures at genesis instead of the blind rarity roll. Validated here so a
    // bad name returns an educational rejection.
    const reqKKG = p.kkg != null ? String(p.kkg).trim() : "";
    let forceKKG: string | undefined;
    if (reqKKG) {
      const recipe = findKKGRecipe(reqKKG);
      if (!recipe)
        throw reject(
          "unknown_kkg",
          `No Kekkei Genkai "${reqKKG}".`,
          { kkg: reqKKG },
          [`Kekkei Genkai: ${KKG_RECIPES.map((r) => r.name).join(", ")}`],
        );
      forceKKG = recipe.name;
    }
    const reqAffinities = Array.isArray(p.affinities) ? (p.affinities as unknown[]).map((e) => String(e).trim()) : [];
    const badAffinity = reqAffinities.find((e) => !(ELEMENTS as readonly string[]).includes(e));
    if (badAffinity)
      throw reject(
        "unknown_affinity",
        `No chakra nature "${badAffinity}".`,
        { affinity: badAffinity },
        [`Natures: ${ELEMENTS.join(", ")}`],
      );

    // genesis: affinities (clan grant + authored pins, else rarity-rolled), KKG, special traits
    const genesis = rollGenesis(char, ctx.rng, { forceKKG, forceElements: reqAffinities });
    // opt-in baseline kit: ONE rank-appropriate signature per base affinity + ONE
    // per Kekkei Genkai (the "standard, then their choice" model). Picks the
    // highest-rank-<=-cap, highest-damage legal technique for each nature/KKG.
    if (ctx.op.params.autoLoadout) {
      const clanNames: string[] = (ctx.engine.content as any).clanNames?.() ?? [];
      const RV: Record<string, number> = { E: 0, D: 1, C: 2, B: 3, A: 4, S: 5 };
      const capV = RV[RANK_JUTSU_CAP[char.rank] ?? "C"] ?? 2;
      const avg = (d?: string) => {
        const m = /(\d+)d(\d+)/.exec(d ?? "");
        return m ? (Number(m[1]) * (Number(m[2]) + 1)) / 2 : 0;
      };
      const pickBest = (pred: (j: any) => boolean) =>
        ctx.engine.content.jutsu
          .filter((j: any) => (RV[j.rank] ?? 9) <= capV && !char.jutsuKnown.includes(j.id) && learnGate(char, j, clanNames).ok && pred(j))
          .sort((a: any, b: any) => (RV[b.rank] ?? 0) - (RV[a.rank] ?? 0) || avg(b.effect?.damage?.dice) - avg(a.effect?.damage?.dice))[0];
      const learn = (j: any) => {
        if (j && char.jutsuKnown.length < char.jutsuKnownCap && !char.jutsuKnown.includes(j.id)) char.jutsuKnown.push(j.id);
      };
      for (const el of char.affinity ?? []) learn(pickBest((j) => jutsuElement(j) === el && j.effect?.damage));
      for (const kkg of char.kkg ?? []) {
        const short = String(kkg).split(" ")[0];
        learn(pickBest((j) => (j.keywords ?? []).includes("KKG") && String(jutsuElement(j)).toLowerCase() === short.toLowerCase()));
      }
    }
    chars(ctx).put(char);

    const genesisRequested = forceKKG || reqAffinities.length ? { kkg: forceKKG ?? null, affinities: reqAffinities } : null;
    ctx.ir.emit("character_created", {
      actor: char.id,
      data: { character: summary(char), genesis, genesisRequested, levelClamped },
      narration: `${char.name} — ${char.rank} ${char.clan ?? ""} ${char.className ?? ""} (L${char.level}), HP ${char.hp.max}, Chakra ${char.chakra.max}. Natures: ${genesis.affinity.join("/") || "none"}${genesis.kkg.length ? ` · KKG: ${genesis.kkg.join(", ")}` : ""}${genesis.specialTraits.length ? ` · ${genesis.specialTraits.join(", ")}` : ""}.`,
    });
  });

  // favor_unlock — the sanctioned override: spend favor with an authority to gain
  // a new affinity (recomputing KKG), unlock a KKG outright, or grant a special
  // trait, justified by a narrative arc. This is how off-genesis natures/KKG are
  // earned (favor "unlocks KKG to those born without it").
  engine.registerHandler("favor_unlock", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const authorityId = String(ctx.op.params.authorityId ?? "");
    if (!authorityId) throw reject("authority_required", "favor_unlock spends favor with an authority — set authorityId.", {}, ["Name the patron/authority whose favor is spent."]);
    const what = String(ctx.op.params.what ?? "affinity"); // affinity | kkg | trait
    const value = String(ctx.op.params.value ?? "");
    const cost = Number(ctx.op.params.favorCost ?? ctx.op.params.cost ?? 3);
    const justification = String(ctx.op.params.justification ?? "a narrative arc");
    if (!value) throw reject("value_required", `favor_unlock needs a value (the ${what} to unlock).`, {}, ["Set value (e.g. an element for affinity)."]);
    const have = getLedger(ctx.store, char.id, authorityId)?.favor ?? 0;
    if (have < cost) throw reject("insufficient_favor", `${char.name} needs ${cost} favor with ${authorityId} (has ${have}).`, { required: cost, have }, ["Earn favor with that authority first, or lower the cost."]);
    applyStandingDelta(ctx.store, char.id, authorityId, { favor: -cost, reason: `unlock ${what}: ${value} (${justification})` });
    if (what === "affinity") {
      if (!char.affinity.includes(value)) char.affinity.push(value);
      char.kkg = deriveKKG(char.affinity);
    } else if (what === "kkg") {
      if (!char.kkg.includes(value)) char.kkg.push(value);
    } else if (what === "trait") {
      if (!char.specialTraits.includes(value)) char.specialTraits.push(value);
    }
    chars(ctx).put(char);
    ctx.ir.emit("favor_unlock", { actor: char.id, data: { what, value, favorSpent: cost, affinity: char.affinity, kkg: char.kkg, specialTraits: char.specialTraits }, narration: `${char.name} spends ${cost} favor with ${authorityId} to unlock ${what} "${value}" — ${justification}.` });
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
    levelUpOnce(ctx, char);
  });

  // award_xp — earned experience (scaled small->large), auto-levels when the
  // running total crosses a threshold (rules/progression.ts).
  engine.registerHandler("award_xp", (ctx) => {
    const char = loadChar(ctx, ctx.op.actorId);
    const amount = Math.round(Number(ctx.op.params.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0)
      throw reject("xp_amount_required", "award_xp needs a positive params.amount.", { amount: ctx.op.params.amount }, ["Pass amount (e.g. 50) and an optional reason."]);
    const reason = String(ctx.op.params.reason ?? "");
    char.xp = (char.xp ?? 0) + amount;
    chars(ctx).put(char);
    const targetLevel = levelForXp(char.xp);
    ctx.ir.emit("xp_awarded", {
      actor: char.id,
      data: { amount, total: char.xp, level: targetLevel, toNext: xpToNext(char.xp), reason },
      narration: `${char.name} earns ${amount} XP${reason ? ` — ${reason}` : ""} (${char.xp} total${targetLevel < 20 ? `, ${xpToNext(char.xp)} to L${targetLevel + 1}` : ""}).`,
    });
    while (char.level < targetLevel && char.level < 20) levelUpOnce(ctx, char);
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
    // Heal applies to params.targetId (an ally) when given; otherwise the actor heals self.
    const targetId = (ctx.op.params.targetId as string | undefined) ?? ctx.op.actorId;
    const char = loadChar(ctx, targetId);
    // amount may be a flat number (12) or a dice expression ("2d8+8").
    const raw = ctx.op.params.amount ?? 0;
    let amount: number;
    try {
      amount =
        typeof raw === "number"
          ? raw
          : /^-?\d+$/.test(String(raw).trim())
            ? Number(raw)
            : rollExpression(ctx.rng, String(raw)).total;
    } catch {
      amount = NaN;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw reject(
        "invalid_amount",
        `Heal amount "${String(raw)}" must be a non-negative number or dice expression.`,
        { amount: raw },
        ['Pass a number (12) or a dice expression like "2d8+8".'],
      );
    }
    amount = Math.floor(amount);
    // Repair any previously-corrupted current (e.g. a NaN written by an older build).
    if (!Number.isFinite(char.hp.current)) char.hp.current = 0;
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
