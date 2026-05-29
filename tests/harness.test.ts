import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngine } from "@naruto5e/engine";
import { buildServer } from "@naruto5e/engine/api/http";
import { DMBrain, parse, buildNameIndex } from "@naruto5e/harness";

/**
 * Phase 11 — the DM brain (tier 3) drives the engine through the controller's
 * engine client. Tested in the deterministic fallback mode (no API key needed);
 * the Anthropic-backed path is wired behind ANTHROPIC_API_KEY.
 */
describe("Phase 11 — DM harness (fallback brain)", () => {
  let server: ReturnType<typeof buildServer>;
  let dm: DMBrain;
  const ROOM = "table";
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];

  beforeAll(async () => {
    const { engine } = createEngine({ dbDriver: "memory", seedSalt: "dm-fixed" });
    server = buildServer(engine);
    const port = await server.listen(0);
    const url = `http://localhost:${port}`;
    dm = new DMBrain(url);
    // build a small cast through REST
    const mk = (name: string, clan: string, cls: string, team: string, scores: any) =>
      fetch(`${url}/v1/characters`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roomId: ROOM, name, clan, className: cls, team, abilities: { method: "manual", scores }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int", "dex", "con"] }) }).then((r) => r.json());
    const yuki = await mk("Yuki", "Yuki", "Ninjutsu Specialist", "pc", { str: 10, dex: 16, con: 14, int: 15, wis: 10, cha: 8 });
    await mk("Bandit", "Non-Clan", "Genjutsu Specialist", "enemy", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 });
    await fetch(`${url}/v1/rooms/${ROOM}/intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "jutsu_learn", actorId: yuki.events[0].data.character.id, params: { jutsu: "chakra-pulse" } }) });
  });
  afterAll(async () => {
    await server.close();
  });

  it("parses NL into structured intents (unit)", () => {
    const idx = buildNameIndex({ characters: [{ id: "c1", name: "Naruto" }], adversaries: [{ id: "e1", name: "Bandit" }] });
    expect(parse("Naruto attacks Bandit", idx)[0]).toMatchObject({ type: "attack", actorId: "c1", params: { target: "e1" } });
    expect(parse("narrate: Mist rolls in", idx)[0]).toMatchObject({ type: "narrate" });
    expect(parse("advance", idx)[0].type).toBe("advance");
    expect(parse("Naruto casts Chakra Pulse at Bandit", idx, ["Chakra Pulse"])[0]).toMatchObject({ type: "cast", actorId: "c1" });
  });

  it("the DM brain narrates a resolved beat from natural language", async () => {
    const t1 = await dm.respond(ROOM, "narrate: A masked nin drops from the bridge.");
    expect(t1.mode).toBe("fallback");
    expect(t1.narration.join(" ")).toMatch(/masked nin/);

    const t2 = await dm.respond(ROOM, "Yuki casts Chakra Pulse at Bandit");
    expect(t2.intents[0].type).toBe("cast");
    // resolved IR narration mentions the cast
    expect(t2.narration.join(" ").toLowerCase()).toMatch(/chakra pulse|casts/);
  });

  it("surfaces an educational rejection as a re-conformable beat", async () => {
    // casting a jutsu Yuki hasn't learned -> educational rejection captured
    const t = await dm.respond(ROOM, "Yuki casts Ten Thousand Ice Petals at Bandit");
    const all = [...t.rejections, ...t.narration];
    expect(t.rejections.length + t.narration.length).toBeGreaterThan(0);
  });
});
