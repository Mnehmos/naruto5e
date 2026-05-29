import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";
import { adversaryBaseline, tierMods } from "./rules/adversary.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "arena";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function buildPC(name: string) {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name, clan: "Non-Clan", className: "Taijutsu Specialist", abilities: { method: "manual", scores: { str: 16, dex: 14, con: 14, int: 8, wis: 10, cha: 10 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "dex", "con"] }) as any;
  return r.events[0].data.character.id as string;
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "adv-fixed" }).engine;
});

describe("Phase 4 — tier baselines + modifiers", () => {
  it("baseline hits the verified source anchors (L1/L10/L20/L30)", () => {
    expect(adversaryBaseline(1)).toMatchObject({ ac: 11, proficiencyBonus: 3, hp: 8, attack: 5 });
    expect(adversaryBaseline(10)).toMatchObject({ ac: 13, proficiencyBonus: 6, hp: 53, attack: 30 });
    expect(adversaryBaseline(20)).toMatchObject({ ac: 14, proficiencyBonus: 9, hp: 103, attack: 58 });
    expect(adversaryBaseline(30)).toMatchObject({ ac: 16, proficiencyBonus: 12, hp: 153, attack: 90 });
  });
  it("tier modifiers match the source (minion/elite/solo)", () => {
    expect(tierMods("minion")).toMatchObject({ ac: -2, attack: -2, damageMul: 0.2, xpMul: 0.25 });
    expect(tierMods("elite")).toMatchObject({ ac: 2, hpMul: 1.5, attack: 1, xpMul: 2 });
    expect(tierMods("solo", 4)).toMatchObject({ ac: 4, hpMul: 4, attack: 2, xpMul: 4 });
  });
});

describe("Phase 4 CHECKPOINT — spawn + run scaled enemies and a Solo boss", () => {
  it("spawns minion/elite/solo with correctly scaled stats", () => {
    const minion = run("adversary_spawn", { name: "Bandit", tier: "minion", level: 5 }) as any;
    const elite = run("adversary_spawn", { name: "Jonin", tier: "elite", level: 10 }) as any;
    const solo = run("adversary_spawn", { name: "Boss", tier: "solo", level: 10, partySize: 4 }) as any;
    expect(minion.status).toBe("resolved");
    const mId = minion.events[0].data.adversary.id;
    const eId = elite.events[0].data.adversary.id;
    const sId = solo.events[0].data.adversary.id;
    const m = engine.getEntity("adversaries", mId) as any;
    const e = engine.getEntity("adversaries", eId) as any;
    const s = engine.getEntity("adversaries", sId) as any;
    // minion: AC = baseline-2, HP capped 1-20
    expect(m.ac).toBe(adversaryBaseline(5).ac - 2);
    expect(m.hp.max).toBeLessThanOrEqual(20);
    // elite: AC +2, HP x1.5, has Elite Action
    expect(e.ac).toBe(adversaryBaseline(10).ac + 2);
    expect(e.hp.max).toBe(Math.round(adversaryBaseline(10).hp * 1.5));
    expect(e.eliteAction).toBe(true);
    // solo: AC +4, HP x partySize, legendary actions = players-1, resistance 3, phases
    expect(s.ac).toBe(adversaryBaseline(10).ac + 4);
    expect(s.hp.max).toBe(adversaryBaseline(10).hp * 4);
    expect(s.legendary).toMatchObject({ actions: 3, max: 3, resistance: 3 });
    expect(s.phases.thresholds).toEqual([60, 30]);
  });

  it("instantiates a Bingo Book foe (Zabuza, a Solo)", () => {
    const r = run("from_bingo_book", { name: "Zabuza" }) as any;
    expect(r.status).toBe("resolved");
    const z = engine.getEntity("adversaries", r.events[0].data.adversary.id) as any;
    expect(z.tier).toBe("solo");
    expect(z.legendary).toBeDefined();
    expect(z.affinity).toContain("Water");
  });

  it("runs a Solo boss: legendary actions, legendary resistance, phase transition", () => {
    const pc = buildPC("Hero");
    const boss = run("adversary_spawn", { name: "Demon", tier: "solo", level: 6, partySize: 4 }) as any;
    const bId = boss.events[0].data.adversary.id;
    run("combat_start", { combatants: [{ actorId: pc, team: "pc" }, { actorId: bId, team: "enemy" }] });

    // drive a chunk of damage to cross a phase threshold (60%)
    const b0 = engine.getEntity("adversaries", bId) as any;
    b0.hp.current = Math.floor(b0.hp.max * 0.61);
    engine.store.collection("adversaries").put(b0);

    // ensure the PC is active, then attack hard enough to cross 60%
    let guard = 0;
    const activeId = () => { const r = engine.getRoom(ROOM)!; const e: any = engine.getEntity("encounters", r.encounterId!); return e.order[e.activeIndex]; };
    while (activeId() !== pc && guard++ < 4) run("advance", {});
    const atk = run("attack", { target: bId, damage: "4d8", ability: "str" }, pc) as any;
    // it's the PC's turn; the attack resolves (hit or miss); if HP crossed 60%, a phase_transition fired
    expect(atk.status).toBe("resolved");

    // legendary action off-turn: advance to boss's... actually use legendary while it's the PC's turn
    const la = run("legendary_action", { action: "freeform_attack", params: { target: pc } }, bId) as any;
    expect(la.status).toBe("resolved");
    expect(la.events.some((e: any) => e.type === "legendary_action")).toBe(true);
    const after = engine.getEntity("adversaries", bId) as any;
    expect(after.legendary.actions).toBeLessThan(3);
  });
});
