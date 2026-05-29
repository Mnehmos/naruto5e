import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngine } from "@naruto5e/engine";
import { buildServer } from "@naruto5e/engine/api/http";
import { EngineClient } from "@naruto5e/mcp-controller";

/**
 * The living END-TO-END test (Acceptance): always proves the CURRENT playable
 * loop, driven through the MCP controller's engine client over real REST.
 * Each phase extends this. At Phase 0 it proves controller -> engine -> IR.
 */
describe("E2E — MCP controller drives the engine", () => {
  let server: ReturnType<typeof buildServer>;
  let client: EngineClient;

  beforeAll(async () => {
    const { engine } = createEngine({ dbDriver: "memory" });
    server = buildServer(engine);
    const port = await server.listen(0);
    client = new EngineClient(`http://localhost:${port}`);
  });

  afterAll(async () => {
    await server.close();
  });

  it("submit_intent narrate resolves and returns IR", async () => {
    const r = await client.submitIntent({ roomId: "e2e", type: "narrate", params: { text: "Dawn over the Leaf." } });
    expect(r.status).toBe("resolved");
    expect(r.events[0].type).toBe("narrate");
  });

  it("batch sequences ops and stop-on-failure reports an educational rejection", async () => {
    const r = await client.batch({
      roomId: "e2e",
      ops: [
        { type: "scene", params: { location: "Training Ground 3" } },
        { type: "narrate", params: { text: "" } },
      ],
    });
    expect(r.status).toBe("rejected");
    expect(r.failedAt.index).toBe(1);
    expect(r.committed.length).toBe(1);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });

  it("scoped read reflects committed state", async () => {
    const state = await client.getRoomState("e2e");
    expect(state.room.location).toBe("Training Ground 3");
  });

  // ---- Phase 1: build a legal character through the controller ---------
  it("builds a character end-to-end via the controller and reads it back", async () => {
    const r = await client.submitIntent({
      roomId: "e2e",
      type: "character_create",
      params: {
        name: "Sakura",
        clan: "Non-Clan",
        className: "Medical-Nin",
        background: "Genius",
        abilities: { method: "standard_array", assign: { str: 8, dex: 13, con: 14, int: 15, wis: 12, cha: 10 } },
        abilityChoices: ["int", "wis", "con"],
        bgAbilityChoice: "int",
        backgroundSkillChoices: ["Ninshou", "History"],
        clanSkillChoices: ["Insight", "Persuasion"],
        classSkillChoices: ["Insight", "Nature", "Persuasion"],
      },
    });
    expect(r.status).toBe("resolved");
    const id = r.events[0].data.character.id;
    const c = await client.getCharacter(id);
    expect(c.className).toBe("Medical-Nin");
    expect(c.hitDice.type).toBe(8);
    expect(c.chakraDice.type).toBe(10);
    // type-keyed casting present
    expect(c.casting.ninjutsu).toBeDefined();
    expect(c.casting.genjutsu).toBeDefined();
    expect(c.casting.taijutsu).toBeDefined();
    expect(c.willOfFire).toBe(true);
    (globalThis as any).__sakuraId = id;
  });
});
