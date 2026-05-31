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

// NPC goals drive autonomous off-screen behavior through the rest-embedded tick.
describe("NPC goals + tick", () => {
  it("an undermine goal drops the target's standing, progresses, and is remembered", () => {
    const pc = mkPC("Hero");
    const npcId = (run("npc_create", {
      name: "Gato",
      authorityId: "wave_village",
      goals: [{ text: "ruin the hero's name", drive: "undermine", targetActorId: pc, targetAuthorityId: "wave_village", intensity: 2 }],
    }) as any).events[0].data.npc.id as string;

    const tickEv = (run("tick_run", { magnitude: "large" }) as any).events.find((e: any) => e.type === "tick");
    const standing = tickEv.data.tick.consequenceDeltas.standing;
    expect(standing.some((s: any) => s.charId === pc && s.authorityId === "wave_village" && s.reputationDelta < 0)).toBe(true);

    const npc = engine.getEntity("npcs", npcId) as any;
    expect(npc.goals[0].progress).toBeGreaterThan(0); // large tick * intensity 2

    const rel = engine.getEntity("npc_relationships", `${npcId}:${pc}`) as any;
    expect(rel.memories.some((m: any) => (m.topics ?? []).includes("undermine"))).toBe(true);
  });

  it("a goal-less NPC still uses the generic tick behavior (no crash)", () => {
    mkPC("Hero");
    run("npc_create", { name: "Townsfolk" });
    const tickEv = (run("tick_run", { magnitude: "small" }) as any).events.find((e: any) => e.type === "tick");
    expect(tickEv.data.tick.agentsCalled.length).toBeGreaterThanOrEqual(1);
  });
});

// Social-stealth: who overhears an exchange (ninja eavesdropping), and NPC memory of it.
describe("social_speak eavesdropping", () => {
  it("a co-located NPC overhears and remembers what was said", () => {
    const pc = mkPC("Hero");
    const npcId = (run("npc_create", { name: "Spy" }) as any).events[0].data.npc.id as string;
    const r = run("social_speak", { actorId: pc, text: "the scroll is hidden in the mill", volume: "talk", topics: ["secret"] }) as any;
    expect(r.status).toBe("resolved");
    expect(r.events[0].data.heardBy).toContain(npcId);
    const rel = engine.getEntity("npc_relationships", `${npcId}:${pc}`) as any;
    expect(rel.memories.some((m: any) => (m.topics ?? []).includes("overheard") && m.summary.includes("the scroll"))).toBe(true);
  });

  it("an out-of-range NPC does not overhear a whisper", () => {
    const pc = mkPC("Hero");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.position = { x: 0, y: 0 };
    cc.put(c);
    const npcId = (run("npc_create", { name: "Distant", position: { x: 50, y: 0 } }) as any).events[0].data.npc.id as string;
    const r = run("social_speak", { actorId: pc, text: "psst", volume: "whisper" }) as any;
    expect(r.events[0].data.heardBy).not.toContain(npcId);
  });
});

// LLM-agent seam: agent_context assembles an actor's turn context + legal moves.
describe("agent_context turn seam", () => {
  const giveJutsu = (id: string, chakra: number) => {
    const pc = mkPC("Hero");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.jutsuKnown = ["fire-release-fox-fire"];
    c.chakra = { current: chakra, max: 30, temp: 0 };
    cc.put(c);
    return pc;
  };
  it("returns identity, scene, and castable-jutsu affordances", () => {
    const pc = giveJutsu("fox", 30);
    const d = (run("agent_context", {}, pc) as any).events[0].data;
    expect(d.identity.name).toBe("Hero");
    expect(d.scene.mode).toBe("scene");
    expect(d.affordances.canAct).toBe(true);
    const fox = d.affordances.jutsu.find((j: any) => j.id === "fire-release-fox-fire");
    expect(fox?.castable).toBe(true);
  });
  it("flags a jutsu the actor can't afford", () => {
    const pc = giveJutsu("fox", 0);
    const d = (run("agent_context", {}, pc) as any).events[0].data;
    const fox = d.affordances.jutsu.find((j: any) => j.id === "fire-release-fox-fire");
    expect(fox?.castable).toBe(false);
    expect(fox?.blockedBy).toBe("chakra");
  });
});

// bug_1780205302421 (HIGH, found in high-tier playtest): freeform_attack ignored
// incapacitating conditions, so a Paralyzed/Stunned adversary could still attack.
describe("freeform_attack honors incapacitating conditions", () => {
  it("a Paralyzed adversary cannot freeform_attack", () => {
    const pc = mkPC("Hero");
    const foe = (run("adversary_spawn", { name: "Brute", tier: "elite", level: 5 }) as any).events[0].data.adversary.id as string;
    run("condition", { target: foe, condition: "Paralyzed" });
    const r = run("freeform_attack", { target: pc }, foe) as any;
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason.rule).toBe("incapacitated");
  });
});

// Genesis (affinity roll + KKG) and the multi-axis jutsu-learn gate.
describe("affinity genesis + jutsu-learn gates", () => {
  it("genesis derives KKG from a clan's combo natures (Yuki -> Water+Wind -> Ice)", () => {
    const r = run("character_create", {
      name: "Haku2", clan: "Yuki", className: "Ninjutsu Specialist", background: "Hard Worker",
      abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 16, wis: 12, cha: 8 } },
      bgAbilityChoice: "dex", classSkillChoices: ["Nature", "Stealth", "Perception"],
    }) as any;
    const c = engine.getEntity("characters", r.events[0].data.character.id) as any;
    expect(c.affinity.length).toBeGreaterThanOrEqual(1);
    expect(c.affinity).toEqual(expect.arrayContaining(["Water", "Wind"]));
    expect(c.kkg).toContain("Ice (Hyoton)");
  });

  it("authored genesis: a requested KKG is pinned deterministically (Jinton -> Earth+Wind+Fire -> Dust)", () => {
    const r = run("character_create", {
      name: "Iwao", clan: "Non-Clan", className: "Ninjutsu Specialist", background: "Genius",
      abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 15, wis: 12, cha: 8 } },
      abilityChoices: ["int", "con", "dex"], bgAbilityChoice: "int",
      backgroundSkillChoices: ["History", "Nature"], classSkillChoices: ["Chakra Control", "Perception", "Stealth"],
      clanSkillChoices: ["Acrobatics", "Athletics"],
      kkg: "Jinton", // loose name (parenthetical/native term) resolves to Dust (Jinton)
    }) as any;
    expect(r.status).toBe("resolved");
    expect(r.events[0].data.genesisRequested).toEqual({ kkg: "Dust (Jinton)", affinities: [] });
    const c = engine.getEntity("characters", r.events[0].data.character.id) as any;
    expect(c.affinity).toEqual(expect.arrayContaining(["Earth", "Wind", "Fire"]));
    expect(c.kkg).toContain("Dust (Jinton)");
    // deterministic: exactly the recipe's three natures, no random extras
    expect(c.affinity.length).toBe(3);
    // born with the bloodline -> can learn the gated D-rank Dust art at Genin (cap C)
    expect((run("jutsu_learn", { jutsu: "dust-release-d" }, c.id) as any).status).toBe("resolved");
  });

  it("authored genesis: an unknown KKG name is an educational rejection", () => {
    const r = run("character_create", {
      name: "NoSuch", clan: "Non-Clan", className: "Ninjutsu Specialist", background: "Genius",
      abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 15, wis: 12, cha: 8 } },
      abilityChoices: ["int", "con", "dex"], bgAbilityChoice: "int",
      backgroundSkillChoices: ["History", "Nature"], classSkillChoices: ["Chakra Control", "Perception", "Stealth"],
      clanSkillChoices: ["Acrobatics", "Athletics"],
      kkg: "Sand Release",
    }) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("unknown_kkg");
    expect(r.suggestions.join(" ")).toContain("Dust (Jinton)");
  });

  it("off-affinity elemental jutsu is gated; force (DM) overrides", () => {
    const pc = mkPC("Mizu");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.affinity = ["Water"]; c.kkg = []; c.rank = "Jonin"; // Water only, high rank (isolate the affinity gate)
    cc.put(c);
    const blocked = run("jutsu_learn", { jutsu: "fire-release-fox-fire" }, pc) as any; // Fire
    expect(blocked.status).toBe("rejected");
    expect(blocked.reason.rule).toBe("off_affinity");
    const forced = run("jutsu_learn", { jutsu: "fire-release-fox-fire", force: true }, pc) as any;
    expect(forced.status).toBe("resolved");
  });

  it("rank gates a jutsu above the character's ninja-rank cap", () => {
    const bRank = (engine as any).content.jutsu.find((j: any) => j.rank === "B");
    expect(bRank).toBeTruthy();
    const pc = mkPC("Rookie"); // Genin (cap C)
    const r = run("jutsu_learn", { jutsu: bRank.id }, pc) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("rank_too_high");
  });

  it("favor_unlock refuses without enough favor (the sanctioned override has a price)", () => {
    const pc = mkPC("Seeker");
    const r = run("favor_unlock", { authorityId: "leaf_village", what: "affinity", value: "Fire", favorCost: 3 }, pc) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("insufficient_favor");
  });
});

// ① jutsu discovery — what an actor can LEARN, gated by rank + affinity.
describe("jutsu_learnable discovery", () => {
  it("lists only gate-legal jutsu (rank cap + affinity)", () => {
    const pc = mkPC("Disc");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.affinity = ["Fire"];
    c.kkg = [];
    c.rank = "Genin";
    cc.put(c);
    const d = (run("jutsu_learnable", {}, pc) as any).events[0].data;
    expect(d.rankCap).toBe("C");
    expect(d.jutsu.length).toBeGreaterThan(0);
    const otherBases = ["Water", "Wind", "Earth", "Lightning"];
    for (const j of d.jutsu) {
      expect(["E", "D", "C"]).toContain(j.rank); // rank gate
      expect(otherBases.includes(j.element)).toBe(false); // no off-affinity leak
    }
  });
});

// ② condition saves — attack-delivery rider conditions now force a save (+ LR), and
// save-to-end fires at the start of the afflicted's turn.
describe("condition saves + durations", () => {
  it("an attack-delivery rider condition forces a save (closes the no-save lock)", () => {
    const pc = mkPC("Striker");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.jutsuKnown = ["leaf-great-flash"];
    c.rank = "Jonin";
    c.chakra = { current: 50, max: 50, temp: 0 };
    cc.put(c);
    const ac = (engine as any).store.collection("adversaries");
    const foeId = (run("adversary_spawn", { name: "Dummy", tier: "minion", level: 3 }) as any).events[0].data.adversary.id as string;
    const foe = ac.get(foeId);
    foe.ac = 1; // guarantee the attack lands so we reach the rider
    ac.put(foe);
    const r = run("cast", { jutsu: "leaf-great-flash", targets: [foeId] }, pc) as any;
    expect(r.events.find((e: any) => e.type === "attack")?.data.hit).toBe(true);
    expect(r.events.some((e: any) => e.type === "save" && e.data.vs === "Paralyzed")).toBe(true);
  });

  it("a save-to-end condition is re-rolled at the start of the afflicted's turn", () => {
    const pc = mkPC("Hero");
    const foeId = (run("adversary_spawn", { name: "Bound", tier: "minion", level: 3 }) as any).events[0].data.adversary.id as string;
    run("combat_start", { combatants: [{ actorId: pc, team: "pc" }, { actorId: foeId, team: "enemy" }] });
    const ac = (engine as any).store.collection("adversaries");
    const foe = ac.get(foeId);
    foe.conditions = ["Paralyzed"];
    foe.conditionStates = [{ name: "Paralyzed", saveAbility: "con", dc: 13, saveToEnd: true }];
    ac.put(foe);
    let sawSave = false;
    for (let i = 0; i < 6 && !sawSave; i++) {
      const r = run("advance", {}) as any;
      if (r.events?.some((e: any) => e.type === "save" && e.data.vs === "Paralyzed" && e.data.saveToEnd)) sawSave = true;
    }
    expect(sawSave).toBe(true);
  });
});

// polish — half-on-save damage reports the raw dice total in `rolled`.
describe("damage IR rolled == raw dice total", () => {
  it("half-on-save keeps rolled as the raw roll", () => {
    const pc = mkPC("Caster");
    const cc = (engine as any).store.collection("characters");
    const c = cc.get(pc);
    c.jutsuKnown = ["fire-release-hellfire-rejection"];
    c.affinity = ["Fire"];
    c.rank = "Jonin";
    c.chakra = { current: 50, max: 50, temp: 0 };
    cc.put(c);
    const foeId = (run("adversary_spawn", { name: "Dummy", tier: "minion", level: 3 }) as any).events[0].data.adversary.id as string;
    const r = run("cast", { jutsu: "fire-release-hellfire-rejection", targets: [foeId] }, pc) as any;
    const dmg = r.events.find((e: any) => e.type === "damage" && Array.isArray(e.data.rolls));
    if (dmg) expect(dmg.data.rolled).toBe(dmg.data.rolls.reduce((a: number, b: number) => a + b, 0));
  });
});

// KKG techniques — catalog present, element-locked to the bloodline, 3-element +75%.
describe("KKG techniques", () => {
  it("are catalog-present and locked to KKG holders", () => {
    const c = (engine as any).content;
    const ice = c.getJutsu("ice-release-d");
    expect(ice).toBeTruthy();
    expect(ice.effect.damage.dice).toBe("2d6");
    const pc = mkPC("Hot");
    const cc = (engine as any).store.collection("characters");
    const ch = cc.get(pc);
    ch.affinity = ["Fire"];
    ch.kkg = [];
    ch.rank = "Jonin";
    cc.put(ch);
    const blocked = run("jutsu_learn", { jutsu: "ice-release-d" }, pc) as any;
    expect(blocked.status).toBe("rejected");
    expect(blocked.reason.rule).toBe("off_affinity");
    const ch2 = cc.get(pc);
    ch2.kkg = ["Ice (Hyoton)"];
    ch2.affinity = ["Water", "Wind"];
    cc.put(ch2);
    expect((run("jutsu_learn", { jutsu: "ice-release-d" }, pc) as any).status).toBe("resolved");
  });

  it("3-element Dust hits markedly harder than a 2-element KKG at the same rank", () => {
    const c = (engine as any).content;
    const avg = (s: string) => {
      const m = /(\d+)d(\d+)/.exec(s)!;
      return Number(m[1]) * (Number(m[2]) + 1) / 2;
    };
    expect(avg(c.getJutsu("dust-release-s").effect.damage.dice)).toBeGreaterThan(avg(c.getJutsu("ice-release-s").effect.damage.dice) * 1.5);
  });

  it("autoLoadout grants a signature per affinity + per KKG", () => {
    const r = run("character_create", {
      name: "Yukihime", clan: "Yuki", className: "Ninjutsu Specialist", background: "Hard Worker", level: 7,
      abilities: { method: "manual", scores: { str: 10, dex: 14, con: 14, int: 16, wis: 12, cha: 8 } },
      bgAbilityChoice: "dex", classSkillChoices: ["Nature", "Stealth", "Perception"], autoLoadout: true,
    }) as any;
    const ch = engine.getEntity("characters", r.events[0].data.character.id) as any;
    const known: string[] = ch.jutsuKnown ?? [];
    expect(known.some((id) => id.startsWith("ice-release-"))).toBe(true); // KKG signature
    expect(known.length).toBeGreaterThanOrEqual(2); // + affinity signatures
  });
});

// npc_decide — the NPC analogue of agent_context: assemble a decision prompt
// (dominant goal + who's present + how the NPC regards them + a legal-move menu).
describe("npc_decide assembles an NPC decision prompt", () => {
  it("returns the dominant goal, present PCs with regard, and a legal-move menu", () => {
    const pc = mkPC("Sakura");
    const npcR = run("npc_create", {
      name: "Danzo",
      authorityId: "anbu",
      goals: [
        { text: "discredit the Hokage", drive: "undermine", targetActorId: pc, intensity: 3 },
        { text: "appear loyal", drive: "scheme", intensity: 1 },
      ],
    }) as any;
    expect(npcR.status).toBe("resolved");
    const npcId = npcR.events[0].data.npc.id as string;
    // a prior beat: the NPC sours on the PC (disposition -30 -> "unfriendly")
    run("npc_interact", { npcId, beat: "caught them eavesdropping", dispositionDelta: -30, importance: "notable" }, pc);

    const d = run("npc_decide", { npcId }) as any;
    expect(d.status).toBe("resolved");
    const data = d.events[0].data;
    expect(data.dominantGoal?.drive).toBe("undermine"); // highest intensity wins
    const sakura = data.scene.present.find((p: any) => p.actorId === pc);
    expect(sakura?.attitude).toBe("unfriendly");
    expect(sakura?.remembers).toContain("caught them eavesdropping");
    expect(data.affordances.actions.some((a: any) => a.type === "social_speak")).toBe(true);
    expect(data.affordances.actions.some((a: any) => a.type === "npc_set_goal")).toBe(true);
    expect(data.contextSummary).toMatch(/discredit the Hokage/);
  });

  it("rejects an unknown NPC educationally", () => {
    const d = run("npc_decide", { npcId: "npc_nope" }) as any;
    expect(d.status).toBe("rejected");
    expect(d.reason.rule).toBe("entity_not_found");
  });
});

// Campaign/world layer above rooms.
describe("campaign management", () => {
  it("creates, advances the clock, logs, and composes a dashboard", () => {
    const pc = mkPC("Hero");
    const camp = (run("campaign_create", { name: "Land of Waves", party: [pc], arc: "The Bridge", factionsOfNote: ["wave_village"] }) as any).events[0].data.campaign.id as string;
    run("campaign_log", { campaignId: camp, beat: "met Tazuna" });
    run("campaign_advance_day", { campaignId: camp, days: 2, arc: "Zabuza Returns" });
    const d = (run("campaign_get", { campaignId: camp }) as any).events[0].data;
    expect(d.campaign.day).toBe(3); // 1 + 2
    expect(d.campaign.arc).toBe("Zabuza Returns");
    expect(d.party[0].name).toBe("Hero");
    expect(d.recentJournal.some((j: any) => j.beat === "met Tazuna")).toBe(true);
  });
});
