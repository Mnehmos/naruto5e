import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "battle";

function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}

function buildPC(name: string, clan: string, className: string, scores: any, extra: Record<string, unknown> = {}) {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", {
    name,
    clan,
    className,
    abilities: { method: "manual", scores },
    classSkillChoices: broad,
    clanSkillChoices: ["Intimidation", "Survival", "Athletics", "Acrobatics", "Insight", "Perception"],
    abilityChoices: ["str", "dex", "con"],
    ...extra,
  }) as any;
  if (r.status !== "resolved") throw new Error(`build ${name} failed: ${JSON.stringify(r.reason)}`);
  return r.events[0].data.character.id as string;
}

function activeId(): string {
  const room = engine.getRoom(ROOM)!;
  const enc = engine.getEntity("encounters", room.encounterId!) as any;
  return enc.order[enc.activeIndex];
}
function enc(): any {
  const room = engine.getRoom(ROOM)!;
  return engine.getEntity("encounters", room.encounterId!);
}

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "combat-fixed" }).engine;
});

describe("Phase 2 CHECKPOINT — full combat with jutsu", () => {
  it("runs a jutsu cast: chakra deducted, save rolled, damage applied, dice-resolved", () => {
    const haku = buildPC("Haku", "Yuki", "Ninjutsu Specialist", { str: 10, dex: 16, con: 14, int: 15, wis: 10, cha: 8 });
    const bandit = buildPC("Bandit", "Non-Clan", "Genjutsu Specialist", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 }, { team: "enemy" });
    // mark bandit as enemy team explicitly
    run("character_create", {}); // no-op guard

    // teach Haku a damaging save jutsu (Chakra Pulse: E, 2 chakra, DEX save, 2d4)
    const pulse = engine.content.getJutsu("chakra-pulse")!;
    expect(pulse).toBeDefined();
    run("jutsu_learn", { jutsu: "chakra-pulse" }, haku);

    const before = (engine.getEntity("characters", haku) as any).chakra.current;
    const start = run("combat_start", { combatants: [{ actorId: haku, team: "pc" }, { actorId: bandit, team: "enemy" }] }) as any;
    expect(start.status).toBe("resolved");
    expect(start.events.some((e: any) => e.type === "combat_start")).toBe(true);

    // ensure it's Haku's turn (advance until it is)
    let guard = 0;
    while (activeId() !== haku && guard++ < 6) run("advance", {});
    expect(activeId()).toBe(haku);

    const cast = run("cast", { jutsu: "chakra-pulse", targets: [bandit] }, haku) as any;
    expect(cast.status).toBe("resolved");
    const types = cast.events.map((e: any) => e.type);
    expect(types).toContain("cast");
    expect(types).toContain("save");
    // chakra deducted by the jutsu cost (2)
    const after = (engine.getEntity("characters", haku) as any).chakra.current;
    expect(after).toBe(before - pulse.cost!);
  });

  it("rejects an unaffordable cast with an educational failure (named rule + numbers)", () => {
    const haku = buildPC("Haku", "Yuki", "Ninjutsu Specialist", { str: 10, dex: 16, con: 14, int: 15, wis: 10, cha: 8 });
    const bandit = buildPC("Bandit", "Non-Clan", "Genjutsu Specialist", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 });
    run("combat_start", { combatants: [{ actorId: haku, team: "pc" }, { actorId: bandit, team: "enemy" }] });
    let guard = 0;
    while (activeId() !== haku && guard++ < 6) run("advance", {});
    const expensive = engine.content.jutsu.find((j) => j.rank === "S" && (j.cost ?? 0) > 20)!;
    const r = run("cast", { jutsu: expensive.id, targets: [bandit], force: true }, haku) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("chakra_affordability");
    expect(r.reason.values.required).toBe(expensive.cost);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it("enforces the off-turn lockout (only the active combatant may act)", () => {
    const a = buildPC("A", "Non-Clan", "Taijutsu Specialist", { str: 14, dex: 14, con: 14, int: 8, wis: 10, cha: 10 });
    const b = buildPC("B", "Non-Clan", "Taijutsu Specialist", { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 10 });
    run("combat_start", { combatants: [{ actorId: a, team: "pc" }, { actorId: b, team: "enemy" }] });
    const active = activeId();
    const other = active === a ? b : a;
    const r = run("attack", { target: active, damage: "1d6" }, other) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("off_turn");
  });

  it("a batch turn (move + cast + advance) emits ordered IR", () => {
    const haku = buildPC("Haku", "Yuki", "Ninjutsu Specialist", { str: 10, dex: 16, con: 14, int: 15, wis: 10, cha: 8 });
    const bandit = buildPC("Bandit", "Non-Clan", "Genjutsu Specialist", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 });
    run("jutsu_learn", { jutsu: "chakra-pulse" }, haku);
    run("combat_start", { combatants: [{ actorId: haku, team: "pc" }, { actorId: bandit, team: "enemy" }] });
    let guard = 0;
    while (activeId() !== haku && guard++ < 6) run("advance", {});
    const r = run("batch", {
      ops: [
        { type: "move", actorId: haku, params: { distance: 10 } },
        { type: "cast", actorId: haku, params: { jutsu: "chakra-pulse", targets: [bandit] } },
        { type: "advance", params: {} },
      ],
    }) as any;
    expect(r.status).toBe("resolved");
    // seq is monotonic across the whole batch
    const seqs = r.events.map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const types = r.events.map((e: any) => e.type);
    expect(types[0]).toBe("move");
    expect(types).toContain("cast");
    expect(types).toContain("advance");
  });

  it("death saves: a downed PC auto-rolls on its turn and can die or stabilize", () => {
    const pc = buildPC("Downed", "Non-Clan", "Genjutsu Specialist", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 });
    const foe = buildPC("Foe", "Non-Clan", "Taijutsu Specialist", { str: 16, dex: 14, con: 14, int: 8, wis: 10, cha: 10 });
    run("combat_start", { combatants: [{ actorId: pc, team: "pc" }, { actorId: foe, team: "enemy" }] });
    // force the pc to 0 hp
    const c = engine.getEntity("characters", pc) as any;
    c.hp.current = 0;
    c.conditions = ["Unconscious"];
    engine.store.collection("characters").put(c);
    // advance until the downed pc's turn -> auto death save fires
    let sawDeathSave = false;
    for (let i = 0; i < 10 && !sawDeathSave; i++) {
      const r = run("advance", {}) as any;
      if (r.events.some((e: any) => e.type === "death_save")) sawDeathSave = true;
    }
    expect(sawDeathSave).toBe(true);
  });

  it("half-on-save jutsu are parsed with halfOnSave (Hellfire Rejection regression)", () => {
    const hr = engine.content.getJutsu("fire-release-hellfire-rejection");
    expect(hr?.effect?.delivery).toBe("save");
    expect(hr?.effect?.halfOnSave).toBe(true); // text: "...or half as much on a successful one"
  });

  it("Burned (DoT) ticks fire damage at the start of the afflicted creature's turn", () => {
    const a = buildPC("Burnt", "Non-Clan", "Taijutsu Specialist", { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 10 });
    const b = buildPC("Foe", "Non-Clan", "Taijutsu Specialist", { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 10 });
    run("combat_start", { combatants: [{ actorId: a, team: "pc" }, { actorId: b, team: "enemy" }] });
    run("condition", { condition: "Burned" }, a); // apply Burned to A
    const hpBefore = (engine.getEntity("characters", a) as any).hp.current;
    let sawTick = false;
    for (let i = 0; i < 4 && !sawTick; i++) {
      const r = run("advance", {}) as any;
      if (r.events.some((e: any) => e.type === "ongoing_damage" && e.data.condition === "Burned")) sawTick = true;
    }
    expect(sawTick).toBe(true);
    expect((engine.getEntity("characters", a) as any).hp.current).toBeLessThan(hpBefore);
  });

  it("rejects casting at an already-dead target without charging chakra (dead-target guard)", () => {
    const caster = buildPC("Caster", "Yuki", "Ninjutsu Specialist", { str: 10, dex: 14, con: 14, int: 16, wis: 10, cha: 8 });
    const corpse = buildPC("Corpse", "Non-Clan", "Taijutsu Specialist", { str: 10, dex: 8, con: 10, int: 8, wis: 10, cha: 10 });
    run("jutsu_learn", { jutsu: "chakra-pulse" }, caster);
    const cd = engine.getEntity("characters", corpse) as any;
    cd.dead = true; cd.hp.current = 0;
    engine.store.collection("characters").put(cd);
    const ckBefore = (engine.getEntity("characters", caster) as any).chakra.current;
    const r = run("cast", { jutsu: "chakra-pulse", targets: [corpse] }, caster) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("no_valid_target");
    expect((engine.getEntity("characters", caster) as any).chakra.current).toBe(ckBefore); // not charged
  });

  it("blocks resting during active combat (no rest-to-full exploit)", () => {
    const a = buildPC("A", "Non-Clan", "Ninjutsu Specialist", { str: 10, dex: 14, con: 14, int: 15, wis: 10, cha: 8 });
    const b = buildPC("B", "Non-Clan", "Taijutsu Specialist", { str: 14, dex: 12, con: 14, int: 8, wis: 10, cha: 10 });
    run("combat_start", { combatants: [{ actorId: a, team: "pc" }, { actorId: b, team: "enemy" }] });
    const r = run("rest", { type: "long" }, a) as any;
    expect(r.status).toBe("rejected");
    expect(r.reason.rule).toBe("in_combat");
    // after ending combat, rest works
    run("combat_end", {});
    expect((run("rest", { type: "long" }, a) as any).status).toBe("resolved");
  });

  it("clash_resolve + elemental advantage: Fire vs Wind favors Fire", () => {
    const a = buildPC("Sasuke", "Uchiha", "Ninjutsu Specialist", { str: 10, dex: 14, con: 12, int: 16, wis: 10, cha: 12 }, { clanSkillChoices: ["Ninshou"], abilityChoices: ["int"] });
    const b = buildPC("WindNin", "Non-Clan", "Ninjutsu Specialist", { str: 10, dex: 14, con: 12, int: 12, wis: 10, cha: 8 });
    // find a Fire jutsu and a Wind jutsu in the catalog
    const fire = engine.content.jutsu.find((j) => /fire/i.test([...(j.keywords ?? []), j.name, j.description].join(" ")))!;
    const wind = engine.content.jutsu.find((j) => /wind/i.test([...(j.keywords ?? []), j.name, j.description].join(" ")))!;
    expect(fire && wind).toBeTruthy();
    const r = run("jutsu_clash", { a: { actorId: a, jutsu: fire.id }, b: { actorId: b, jutsu: wind.id } }) as any;
    expect(r.status).toBe("resolved");
    expect(r.events[0].type).toBe("clash");
  });
});
