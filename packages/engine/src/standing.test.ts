import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "leaf";
function run(type: string, params: Record<string, unknown>, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: ROOM, actorId, type, params, ...base } as any);
}
function pc() {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", { name: "Sasuke", clan: "Non-Clan", className: "Ninjutsu Specialist", abilities: { method: "manual", scores: { str: 10, dex: 14, con: 12, int: 15, wis: 12, cha: 10 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int", "dex", "con"] }) as any;
  return r.events[0].data.character.id as string;
}
beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "standing-fixed" }).engine;
});

describe("Phase 6 — Standing / RPP", () => {
  it("reputation gates access; favor is spendable and capped", () => {
    const c = pc();
    run("grant_reputation", { authorityId: "leaf_village", amount: 50, reason: "saved the bridge" }, c);
    const gate = run("check_access", { authorityId: "leaf_village", minReputation: 40, what: "Chunin exam slot" }, c) as any;
    expect(gate.events[0].data.offered).toBe(true);

    const low = run("check_access", { authorityId: "leaf_village", minReputation: 80, what: "a forbidden scroll" }, c) as any;
    expect(low.events[0].data.offered).toBe(false);

    // favor cap (default 10)
    run("grant_favor", { authorityId: "leaf_village", amount: 25 }, c);
    const ledgers = run("get_ledgers", {}, c) as any;
    const leaf = ledgers.events[0].data.ledgers.find((l: any) => l.authorityId === "leaf_village");
    expect(leaf.favor).toBe(leaf.favorCap); // clamped
    expect(leaf.descriptor).toMatch(/honored|trusted/);

    const spend = run("spend_favor", { authorityId: "leaf_village", amount: 3, on: "be taught Chidori" }, c) as any;
    expect(spend.status).toBe("resolved");
    const over = run("spend_favor", { authorityId: "leaf_village", amount: 999, on: "everything" }, c) as any;
    expect(over.status).toBe("rejected");
    expect(over.reason.rule).toBe("insufficient_favor");
  });

  it("the rogue path: defect craters the village ledger and opens a patron ledger", () => {
    const c = pc();
    run("grant_reputation", { authorityId: "leaf_village", amount: 40 }, c);
    const r = run("defect", { fromAuthority: "leaf_village", toAuthority: "orochimaru" }, c) as any;
    expect(r.status).toBe("resolved");
    const ledgers = run("get_ledgers", {}, c) as any;
    const leaf = ledgers.events[0].data.ledgers.find((l: any) => l.authorityId === "leaf_village");
    const oro = ledgers.events[0].data.ledgers.find((l: any) => l.authorityId === "orochimaru");
    expect(leaf.hostile).toBe(true);
    expect(leaf.reputation).toBeLessThan(0);
    expect(oro.authorityType).toBe("patron");
    expect(oro.reputation).toBeGreaterThan(0);
  });
});
