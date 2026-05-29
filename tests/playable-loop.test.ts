import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createEngine } from "@naruto5e/engine";
import { buildServer } from "@naruto5e/engine/api/http";
import { EngineClient } from "@naruto5e/mcp-controller";

/**
 * THE LIVING END-TO-END TEST (Acceptance). Proves the current playable loop,
 * driven entirely through the MCP controller's engine client over real REST,
 * with the websocket IR verified against the intent-response IR. Extended each
 * phase. Phase 2 proves: create characters -> start an encounter -> jutsu casts
 * (correct chakra, dice-resolved) -> an unaffordable action is rejected with an
 * educational failure -> a batch turn emits ordered IR -> WS IR == response IR.
 */
const ROOM = "loop";

describe("E2E playable loop (controller + WS)", () => {
  let server: ReturnType<typeof buildServer>;
  let client: EngineClient;
  let ws: WebSocket;
  let engineRef: ReturnType<typeof createEngine>["engine"];
  const irMessages: any[] = [];

  beforeAll(async () => {
    const { engine } = createEngine({ dbDriver: "memory", seedSalt: "loop-fixed" });
    engineRef = engine;
    server = buildServer(engine);
    const port = await server.listen(0);
    client = new EngineClient(`http://localhost:${port}`);
    ws = new WebSocket(`ws://localhost:${port}/v1/rooms/${ROOM}/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "ir") irMessages.push(m);
    });
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    ws.close();
    await server.close();
  });

  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  async function buildPC(name: string, clan: string, className: string, scores: any, team = "pc") {
    const r = await client.submitIntent({
      roomId: ROOM,
      type: "character_create",
      params: { name, clan, className, abilities: { method: "manual", scores }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["str", "dex", "con"], team },
    });
    expect(r.status).toBe("resolved");
    return r.events[0].data.character.id as string;
  }
  async function active(): Promise<string> {
    const e = await client.getEncounter(ROOM);
    return e.encounter.order[e.encounter.activeIndex];
  }
  const waitWS = () => new Promise((r) => setTimeout(r, 30));

  it("runs the full loop end to end through the controller", async () => {
    // 1) create characters + spawn an enemy
    const haku = await buildPC("Haku", "Yuki", "Ninjutsu Specialist", { str: 10, dex: 16, con: 14, int: 16, wis: 10, cha: 8 });
    await buildPC("Naruto", "Uzumaki", "Taijutsu Specialist", { str: 14, dex: 12, con: 15, int: 8, wis: 10, cha: 12 });
    const bandit = await buildPC("Bandit", "Non-Clan", "Genjutsu Specialist", { str: 8, dex: 8, con: 8, int: 10, wis: 10, cha: 10 }, "enemy");

    // pick a cheap save+damage jutsu from the catalog and teach it
    const jutsuList = (await client.listJutsu({ classification: "Ninjutsu" })).jutsu;
    const saveJutsu = jutsuList.find((j: any) => j.effect?.delivery === "save" && j.effect?.damage && (j.cost ?? 99) <= 6);
    expect(saveJutsu).toBeTruthy();
    const learn = await client.submitIntent({ roomId: ROOM, actorId: haku, type: "jutsu_learn", params: { jutsu: saveJutsu.id } });
    expect(learn.status).toBe("resolved");

    // 2) start the encounter (initiative is the turn authority)
    const start = await client.submitIntent({ roomId: ROOM, type: "combat_start", params: { combatants: [{ actorId: haku, team: "pc" }, { actorId: bandit, team: "enemy" }] } });
    expect(start.status).toBe("resolved");

    // advance until it's Haku's turn
    let guard = 0;
    while ((await active()) !== haku && guard++ < 6) await client.submitIntent({ roomId: ROOM, type: "advance" });
    expect(await active()).toBe(haku);

    // 3) a jutsu cast — chakra deducted, dice-resolved
    const chakraBefore = (await client.getCharacter(haku)).chakra.current;
    irMessages.length = 0;
    const cast = await client.submitIntent({ roomId: ROOM, actorId: haku, type: "cast", params: { jutsu: saveJutsu.id, targets: [bandit] } });
    expect(cast.status).toBe("resolved");
    expect(cast.events.map((e: any) => e.type)).toContain("cast");
    expect(cast.events.some((e: any) => e.type === "save" || e.type === "damage")).toBe(true);
    const chakraAfter = (await client.getCharacter(haku)).chakra.current;
    expect(chakraAfter).toBe(chakraBefore - saveJutsu.cost);

    // 4) WS IR matches the intent-response IR (observers converge on identical state)
    await waitWS();
    const matching = irMessages.find((m) => JSON.stringify(m.events) === JSON.stringify(cast.events));
    expect(matching).toBeTruthy();

    // 5) an unaffordable action -> educational failure
    while ((await active()) !== haku && guard++ < 12) await client.submitIntent({ roomId: ROOM, type: "advance" });
    const expensive = (await client.listJutsu({ rank: "S" })).jutsu.find((j: any) => (j.cost ?? 0) > 20);
    const broke = await client.submitIntent({ roomId: ROOM, actorId: haku, type: "cast", params: { jutsu: expensive.id, targets: [bandit], force: true } });
    expect(broke.status).toBe("rejected");
    expect(broke.reason.rule).toBe("chakra_affordability");
    expect(broke.reason.values.required).toBe(expensive.cost);
    expect(broke.suggestions.length).toBeGreaterThan(0);

    // 6) a batch turn emits ordered IR — end Haku's turn, cycle back for a fresh budget
    await client.submitIntent({ roomId: ROOM, type: "advance" });
    guard = 0;
    while ((await active()) !== haku && guard++ < 6) await client.submitIntent({ roomId: ROOM, type: "advance" });
    expect(await active()).toBe(haku);
    const batch = await client.batch({
      roomId: ROOM,
      ops: [
        { type: "move", actorId: haku, params: { distance: 5 } },
        { type: "dodge", actorId: haku, params: {} },
        { type: "advance", params: {} },
      ],
    });
    expect(batch.status).toBe("resolved");
    const seqs = batch.events.map((e: any) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(batch.events[0].type).toBe("move");
  });

  // ---- Phase 4: fight a real tiered adversary through the controller ---
  it("spawns a Bingo Book Solo boss and fights it (adversary uses the same combat surface)", async () => {
    const room = "boss-fight";
    const hero = (await client.submitIntent({
      roomId: room,
      type: "character_create",
      params: { name: "Kakashi", clan: "Hatake", className: "Ninjutsu Specialist", abilities: { method: "manual", scores: { str: 12, dex: 16, con: 14, int: 16, wis: 12, cha: 12 } }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int"] },
    })).events[0].data.character.id;

    const spawn = await client.submitIntent({ roomId: room, type: "from_bingo_book", params: { name: "Zabuza", partySize: 1 } });
    expect(spawn.status).toBe("resolved");
    const boss = spawn.events[0].data.adversary.id;
    expect(spawn.events[0].data.adversary.legendary).toBeDefined();

    const start = await client.submitIntent({ roomId: room, type: "combat_start", params: { combatants: [{ actorId: hero, team: "pc" }, { actorId: boss, team: "enemy" }] } });
    expect(start.status).toBe("resolved");

    // get to the hero's turn, then strike the boss
    const activeIn = async () => (await client.getEncounter(room)).encounter.order[(await client.getEncounter(room)).encounter.activeIndex];
    let g = 0;
    while ((await activeIn()) !== hero && g++ < 4) await client.submitIntent({ roomId: room, type: "advance" });
    const atk = await client.submitIntent({ roomId: room, actorId: hero, type: "attack", params: { target: boss, damage: "2d6", ability: "dex" } });
    expect(atk.status).toBe("resolved");
    expect(atk.events.some((e: any) => e.type === "attack")).toBe(true);

    // the boss takes a Legendary Action off-turn (it's still the hero's turn)
    const la = await client.submitIntent({ roomId: room, actorId: boss, type: "legendary_action", params: { action: "freeform_attack", params: { target: hero } } });
    expect(la.status).toBe("resolved");
    expect(la.events.some((e: any) => e.type === "legendary_action")).toBe(true);
  });
});
