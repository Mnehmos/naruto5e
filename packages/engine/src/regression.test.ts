import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

// Regressions for bugs surfaced in Agent Synch bughunt sessions.
const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
const ROOM = "battle";
let engine: Engine;
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory" }).engine;
});
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${type}_${Math.random()}`, roomId: ROOM, type, params, actorId, ...base } as any);
}
function mkPC(name: string): string {
  const r = run("character_create", {
    name,
    clan: "Non-Clan",
    className: "Taijutsu Specialist",
    background: "Hard Worker",
    abilities: { method: "manual", scores: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } },
    abilityChoices: ["str", "dex", "con"],
    bgAbilityChoice: "str",
    clanSkillChoices: ["Athletics", "Intimidation"],
    classSkillChoices: ["Acrobatics", "Survival"],
  }) as any;
  if (r.status !== "resolved") throw new Error("mkPC rejected: " + JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}

// bug_1780152055940 (CRITICAL): a rejected ability_check wiped the entire room.
describe("rejected intents never mutate room state", () => {
  it("a rejecting ability_check leaves characters, encounter, mode, and rng intact", () => {
    const a = mkPC("Alpha");
    const b = mkPC("Bravo");
    run("combat_start", { combatants: [{ actorId: a, team: "pc" }, { actorId: b, team: "pc" }] });

    let st = engine.getRoomState(ROOM) as any;
    expect(st.characters.length).toBe(2);
    expect(st.room.mode).toBe("combat");
    expect(st.encounter).toBeTruthy();
    const rngBefore = st.room.rngState;

    // (1) reject via an unknown actorId
    const rej1 = run("ability_check", { ability: "int" }, "char_does_not_exist");
    expect(rej1.status).toBe("rejected");

    // (2) reject via a bad ability with a VALID actor
    const rej2 = run("ability_check", { ability: "bogus" }, a);
    expect(rej2.status).toBe("rejected");

    st = engine.getRoomState(ROOM) as any;
    expect(st.characters.length).toBe(2); // characters NOT erased
    expect(st.room.mode).toBe("combat"); // mode NOT reset to scene
    expect(st.encounter).toBeTruthy(); // encounter NOT dropped
    expect(st.room.rngState).toBe(rngBefore); // rng NOT reset to seed
  });
});

// bug_1780152105318 (part 1): ability_check/saving_throw actor resolution must
// match cast/attack — adversaries (not just characters) can take checks.
describe("checks resolve actors uniformly (characters AND adversaries)", () => {
  it("an adversary can roll a saving_throw and an ability_check", () => {
    const spawn = run("adversary_spawn", { name: "Oni", tier: "elite", level: 5 }) as any;
    expect(spawn.status).toBe("resolved");
    const advId = spawn.events[0].data.adversary.id as string;

    const sv = run("saving_throw", { ability: "str", dc: 10 }, advId) as any;
    expect(sv.status).toBe("resolved");
    expect(sv.events[0].data.kind).toBe("saving_throw");
    expect(Number.isFinite(sv.events[0].data.total)).toBe(true);

    const chk = run("ability_check", { ability: "dex" }, advId) as any;
    expect(chk.status).toBe("resolved");
    expect(chk.events[0].data.kind).toBe("ability_check");
    expect(Number.isFinite(chk.events[0].data.total)).toBe(true);
  });
});

// bug_1780152064662 (CRITICAL, reported): "all adversaries are flat -2 shells
// regardless of tier; spawn response != stored stats". On current code the stored
// block is tier-scaled and the response emits the same adv.* that is persisted.
// This pins that (the -2 was a correct low-level MINION mod, not all tiers).
describe("adversary stats are tier-scaled and the spawn response matches what is stored", () => {
  function mk(tier: string) {
    const r = run("adversary_spawn", { name: tier, tier, level: 6, partySize: 4 }) as any;
    expect(r.status).toBe("resolved");
    const adv = r.events[0].data.adversary;
    return { responseAttack: adv.attack, responseAc: adv.ac, doc: engine.getEntity("adversaries", adv.id) as any };
  }
  it("minion/elite/solo persist distinct save & attack; response attack/ac === stored", () => {
    const minion = mk("minion");
    const elite = mk("elite");
    const solo = mk("solo");
    // tier-distinct save bonuses — NOT a uniform -2 shell
    expect(minion.doc.saveBonus).toBe(-2);
    expect(elite.doc.saveBonus).toBe(1);
    expect(solo.doc.saveBonus).toBe(2);
    // attack & ability mods scale with tier
    expect(solo.doc.attack).toBeGreaterThan(elite.doc.attack);
    expect(elite.doc.attack).toBeGreaterThan(minion.doc.attack);
    expect(solo.doc.abilityMods.str).toBeGreaterThan(minion.doc.abilityMods.str);
    // the spawn response advertises exactly what is persisted (no advertised/stored split)
    for (const a of [minion, elite, solo]) {
      expect(a.responseAttack).toBe(a.doc.attack);
      expect(a.responseAc).toBe(a.doc.ac);
    }
  });
});

// bug_1780153780675 (HIGH): utility-delivery healing jutsu charged chakra but
// applied no effect because the heal dice weren't parsed into effect.healing.
describe("utility-delivery healing jutsu apply their effect", () => {
  it("Healing Hands heals a wounded ally (heal event + HP increase)", () => {
    const medic = mkPC("Medic");
    const ally = mkPC("Ally");
    const coll = (engine as any).store.collection("characters");
    const d = coll.get(ally);
    d.hp.current = 1; // wound the ally
    coll.put(d);
    const before = (engine.getEntity("characters", ally) as any).hp.current;

    const r = run("cast", { jutsu: "healing-hands", targets: [ally], force: true }, medic) as any;
    expect(r.status).toBe("resolved");
    const healEv = r.events.find((e: any) => e.type === "heal");
    expect(healEv).toBeTruthy();
    expect(healEv.data.target).toBe(ally);

    const after = (engine.getEntity("characters", ally) as any).hp.current;
    expect(after).toBeGreaterThan(before);
  });
});

// bug_1780152699831 (HIGH): freeform_attack didn't persist the attacker's turn
// budget, so an adversary could attack unlimited times per turn.
describe("freeform_attack is action-gated within a turn", () => {
  it("a second freeform_attack the same turn is rejected (action economy)", () => {
    const pc = mkPC("Hero");
    const spawn = run("adversary_spawn", { name: "Brute", tier: "elite", level: 4 }) as any;
    const foe = spawn.events[0].data.adversary.id as string;
    run("combat_start", { combatants: [{ actorId: foe, team: "enemy" }, { actorId: pc, team: "pc" }] });
    // ensure it's the foe's turn
    let guard = 0;
    const activeId = () => {
      const r = engine.getRoom(ROOM)!;
      const e: any = engine.getEntity("encounters", (r as any).encounterId);
      return e.order[e.activeIndex];
    };
    while (activeId() !== foe && guard++ < 5) run("advance", {});
    const a1 = run("freeform_attack", { target: pc }, foe) as any;
    expect(a1.status).toBe("resolved");
    const a2 = run("freeform_attack", { target: pc }, foe) as any;
    expect(a2.status).toBe("rejected");
    if (a2.status === "rejected") expect(a2.reason.rule).toBe("action_economy");
  });
});

// bug_1780152079128 / bug_1780154099929: re-casting the same concentration jutsu
// refreshes its slot instead of stacking a duplicate.
describe("concentration replaces the same jutsu instead of stacking", () => {
  it("casting the same concentration jutsu twice yields a single slot", () => {
    const pc = mkPC("Caster");
    // give the caster plenty of chakra and learn a concentration jutsu
    const coll = (engine as any).store.collection("characters");
    const d = coll.get(pc);
    d.chakra.current = 99;
    d.chakra.max = 99;
    coll.put(d);
    const conc = "fire-release-fox-fire";
    run("cast", { jutsu: conc, targets: [], force: true }, pc);
    run("cast", { jutsu: conc, targets: [], force: true }, pc);
    const after = engine.getEntity("characters", pc) as any;
    const slots = (after.concentration ?? []).filter((c: any) => c.jutsuId === conc);
    expect(slots.length).toBe(1);
  });
});

// bug_1780152098496 (MEDIUM): batch silently swallowed sub-intent problems —
// returned a false 'resolved' with zero events when the sub-op list key was wrong.
describe("batch surfaces problems instead of silently no-op'ing", () => {
  it("accepts `intents` as an alias for `ops`", () => {
    const r = run("batch", { intents: [{ type: "narrate", params: { text: "a" } }, { type: "narrate", params: { text: "b" } }] }) as any;
    expect(r.status).toBe("resolved");
    expect(r.events.length).toBeGreaterThanOrEqual(2);
  });
  it("rejects an empty batch instead of a false resolved", () => {
    const r = run("batch", {}) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("empty_batch");
  });
  it("propagates a sub-intent rejection (stop-on-failure)", () => {
    const pc = mkPC("Checker");
    const r = run("batch", { ops: [{ type: "ability_check", actorId: pc, params: { skill: "Perception" } }] }) as any;
    expect(r.status).toBe("rejected"); // malformed sub-op (skill, not ability) must surface
  });
});

// bug_1780152112965 (LOW): mid-combat spawns never enrolled in initiative.
describe("mid-combat spawns enroll in initiative", () => {
  it("a spawn during an active encounter joins the order", () => {
    const pc = mkPC("Hero");
    run("combat_start", { combatants: [{ actorId: pc, team: "pc" }] });
    const sp = run("adversary_spawn", { name: "Reinforcement", tier: "minion", level: 2 }) as any;
    const advId = sp.events[0].data.adversary.id as string;
    const enc: any = engine.getEntity("encounters", (engine.getRoom(ROOM) as any).encounterId);
    expect(enc.order).toContain(advId);
  });
});

// bug_1780152414482 (MEDIUM): taijutsu "your unarmed damage + XdY" dice weren't parsed.
describe("taijutsu '+XdY' bonus dice parse into effect.damage", () => {
  it("the named taijutsu carry their bonus dice", () => {
    const c = (engine as any).content;
    expect(c.getJutsu("leaf-great-flash").effect.damage.dice).toBe("7d4");
    expect(c.getJutsu("adamantine-acala").effect.damage.dice).toBe("3d10");
    expect(c.getJutsu("fist-slam").effect.damage.dice).toBe("6d6");
    expect(c.getJutsu("dragon-tail-foot").effect.damage.dice).toBe("4d8");
  });
});

// Ergonomics: NPC context summary (curated from rpg.mcp get_context).
describe("npc_context — one-read NPC summary", () => {
  it("returns attitude/closeness tiers, salient memories, interactionCount, and standing", () => {
    const pc = mkPC("Hero");
    const npcId = (run("npc_create", { name: "Tazuna", authorityId: "wave_village" }) as any).events[0].data.npc.id as string;
    run("npc_interact", { npcId, actorId: pc, beat: "shared a meal", dispositionDelta: 15, familiarityDelta: 20, importance: "low", topics: ["food"] });
    run("npc_interact", { npcId, actorId: pc, beat: "saved his life", dispositionDelta: 40, familiarityDelta: 30, importance: "defining", topics: ["rescue"], standingDelta: { authorityId: "wave_village", reputation: 25 } });

    const d = (run("npc_context", { npcId, actorId: pc, limit: 5 }) as any).events[0].data;
    expect(d.attitude).toBe("friendly"); // disposition 0+15+40 = 55
    expect(d.closeness).toBe("friend"); // familiarity 0+20+30 = 50
    expect(d.interactionCount).toBe(2);
    expect(d.salientMemories[0].summary).toBe("saved his life"); // defining first
    expect(d.salientMemories.length).toBe(2);
    expect(d.standing.reputation).toBe(25);

    // topic filter narrows recall
    const food = (run("npc_context", { npcId, actorId: pc, topic: "food" }) as any).events[0].data;
    expect(food.salientMemories.map((m: any) => m.summary)).toEqual(["shared a meal"]);
  });

  it("get_relationship surfaces derived tiers", () => {
    const pc = mkPC("Hero");
    const npcId = (run("npc_create", { name: "Rival" }) as any).events[0].data.npc.id as string;
    run("npc_interact", { npcId, actorId: pc, beat: "a tense standoff", dispositionDelta: -70 });
    const d = (run("npc_get_relationship", { npcId, actorId: pc }) as any).events[0].data;
    expect(d.tiers.attitude).toBe("hostile"); // -70
  });
});

// Ergonomics: batch dry-run previews an ordered plan without committing.
describe("batch dryRun previews without committing", () => {
  it("runs ops in order, returns IR, and rolls back state + rng", () => {
    const before = (engine.getRoomState(ROOM) as any).room.rngState;
    const ghost = {
      type: "character_create",
      params: {
        name: "Ghost",
        clan: "Non-Clan",
        className: "Taijutsu Specialist",
        background: "Hard Worker",
        abilities: { method: "manual", scores: { str: 14, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } },
        abilityChoices: ["str", "dex", "con"],
        bgAbilityChoice: "str",
        clanSkillChoices: ["Athletics", "Intimidation"],
        classSkillChoices: ["Acrobatics", "Survival"],
      },
    };
    const r = run("batch", { ops: [{ type: "narrate", params: { text: "a scene" } }, ghost], dryRun: true }) as any;
    expect(r.status).toBe("resolved");
    expect(r.dryRun).toBe(true);
    expect(r.events.length).toBeGreaterThanOrEqual(2); // narrate + character_created previewed
    // nothing persisted
    let st = engine.getRoomState(ROOM) as any;
    expect(st.characters.length).toBe(0);
    expect(st.room.rngState).toBe(before); // dice un-advanced

    // committing the same batch for real DOES persist
    const r2 = run("batch", { ops: [ghost] }) as any;
    expect(r2.status).toBe("resolved");
    st = engine.getRoomState(ROOM) as any;
    expect(st.characters.length).toBe(1);
  });

  it("a failing op in a dry-run reports the failure with dryRun:true and no state change", () => {
    const r = run("batch", { ops: [{ type: "narrate", params: { text: "ok" } }, { type: "cast", actorId: "nobody", params: { jutsu: "fire-release-fox-fire" } }], dryRun: true }) as any;
    expect(r.status).toBe("rejected");
    expect(r.dryRun).toBe(true);
    expect((engine.getRoomState(ROOM) as any).characters.length).toBe(0);
  });
});

// Ergonomics: batch ref-threading — a later op references an id an earlier op created.
describe("batch ref-threading uses earlier ops' produced ids", () => {
  it("$bind resolves a created id for a downstream op", () => {
    const r = run("batch", {
      ops: [
        { type: "npc_create", params: { name: "Gato" }, bind: "villain" },
        { type: "npc_interact", actorId: "char_x", params: { npcId: "$villain", beat: "extortion", dispositionDelta: -30 } },
      ],
    }) as any;
    expect(r.status).toBe("resolved");
    const npcId = r.events.find((e: any) => e.type === "npc_created").data.npc.id;
    const inter = r.events.find((e: any) => e.type === "npc_interaction");
    expect(inter.data.npcId).toBe(npcId); // "$villain" resolved to the just-created id
    expect(inter.data.attitude).toBe("unfriendly"); // disposition -30
  });

  it("positional $0 also resolves", () => {
    const r = run("batch", {
      ops: [
        { type: "npc_create", params: { name: "Inari" } },
        { type: "npc_interact", actorId: "char_x", params: { npcId: "$0", beat: "a greeting" } },
      ],
    }) as any;
    const npcId = r.events.find((e: any) => e.type === "npc_created").data.npc.id;
    expect(r.events.find((e: any) => e.type === "npc_interaction").data.npcId).toBe(npcId);
  });
});
