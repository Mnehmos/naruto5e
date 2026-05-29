import { describe, it, expect, afterAll, beforeAll } from "vitest";
import WebSocket from "ws";
import { createEngine } from "@naruto5e/engine";
import { buildServer } from "@naruto5e/engine/api/http";

/**
 * Phase 0 CHECKPOINT: a trivial intent round-trips through REST and the same IR
 * streams over the websocket — proving the engine's two surfaces converge on
 * identical events (Architecture §6: "the submitting client and all observers
 * converge on identical state").
 */
describe("Phase 0 CHECKPOINT — intent round-trips + IR over WS", () => {
  let server: ReturnType<typeof buildServer>;
  let port: number;

  beforeAll(async () => {
    const { engine } = createEngine({ dbDriver: "memory" });
    server = buildServer(engine);
    port = await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it("WS receives the same IR returned by POST /intent", async () => {
    const roomId = "ws-room";
    const ws = new WebSocket(`ws://localhost:${port}/v1/rooms/${roomId}/stream`);

    const subscribed = new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribed") resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    await subscribed;

    const irPromise = new Promise<any>((resolve) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ir") resolve(msg);
      });
    });

    const resp = await fetch(`http://localhost:${port}/v1/rooms/${roomId}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "narrate", params: { text: "The bridge groans in the mist." } }),
    });
    const result = await resp.json();
    expect(result.status).toBe("resolved");

    const irMsg = await irPromise;
    expect(irMsg.roomId).toBe(roomId);
    // The WS IR is exactly the response IR.
    expect(irMsg.events).toEqual(result.events);
    expect(irMsg.events[0].type).toBe("narrate");

    ws.close();
  });

  it("scoped state read reflects committed mutations", async () => {
    const roomId = "ws-room-2";
    await fetch(`http://localhost:${port}/v1/rooms/${roomId}/intent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "scene", params: { location: "Hokage Tower", mode: "scene" } }),
    });
    const state = await (await fetch(`http://localhost:${port}/v1/rooms/${roomId}/state`)).json();
    expect(state.room.location).toBe("Hokage Tower");
  });
});
