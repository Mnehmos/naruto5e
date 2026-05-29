import { createEngine } from "../bootstrap.js";

/** Minimal end-to-end sanity: a trivial intent round-trips and emits IR. */
const { engine, driver } = createEngine({ dbDriver: "memory" });
// eslint-disable-next-line no-console
console.log("driver:", driver, "| jutsu:", engine.content.jutsu.length, "| actions:", engine.knownActions().length);

const result = engine.resolveIntent({
  intentId: "smoke-1",
  roomId: "room-smoke",
  submittedBy: { clientType: "system", role: "dm" },
  type: "narrate",
  params: { text: "A masked nin drops from the treeline." },
} as any);

// eslint-disable-next-line no-console
console.log(JSON.stringify(result, null, 2));

const batch = engine.resolveIntent({
  intentId: "smoke-2",
  roomId: "room-smoke",
  submittedBy: { clientType: "system", role: "dm" },
  type: "batch",
  params: {
    ops: [
      { type: "scene", params: { location: "The Bridge", mode: "scene" } },
      { type: "narrate", params: { text: "Mist rolls in." } },
      { type: "narrate", params: { text: "" } }, // will reject (educational)
    ],
  },
} as any);
// eslint-disable-next-line no-console
console.log("\nBATCH (stop-on-failure):\n", JSON.stringify(batch, null, 2));
engine.store.close();
