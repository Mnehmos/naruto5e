import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createEngine } from "@naruto5e/engine";
import { buildServer } from "@naruto5e/engine/api/http";

/** Phase 10 — the engine serves the role-aware web app shell at /. */
describe("Phase 10 — web renderer is served", () => {
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

  it("GET / returns the app shell HTML that subscribes to the IR stream", async () => {
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Hidden Hand(?:&nbsp;|\s)5e/);
    expect(html).toMatch(/\/v1\/rooms\/.*\/stream/); // subscribes to the IR websocket
    expect(html.toLowerCase()).toMatch(/canvas/); // the tactical map
  });
});
