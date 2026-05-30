import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

function mkEngine(): Engine {
  return createEngine({ dbDriver: "memory" }).engine;
}

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };

describe("Phase 0 — intent pipeline", () => {
  let engine: Engine;
  beforeEach(() => {
    engine = mkEngine();
  });

  it("round-trips a trivial intent and emits ordered IR", () => {
    const r = engine.resolveIntent({
      intentId: "i1",
      roomId: "r1",
      type: "narrate",
      params: { text: "Hello" },
      ...base,
    } as any);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.events).toHaveLength(1);
      expect(r.events[0].type).toBe("narrate");
      expect(r.events[0].seq).toBe(0);
      expect(r.events[0].narration).toBe("Hello");
    }
  });

  it("rejects with a four-part educational failure (no bare rejections)", () => {
    const r = engine.resolveIntent({
      intentId: "i2",
      roomId: "r1",
      type: "narrate",
      params: { text: "   " },
      ...base,
    } as any);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason.rule).toBe("empty_narration");
      expect(r.reason.explain).toMatch(/non-empty/);
      expect(r.committed).toEqual([]);
      expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });

  it("rejects unknown actions with a did-you-mean", () => {
    const r = engine.resolveIntent({ intentId: "i3", roomId: "r1", type: "frobnicate", params: {}, ...base } as any);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason.rule).toBe("unknown_action");
      // the rejection surfaces the full action vocabulary so the verb is discoverable
      expect(r.suggestions.join(" ")).toContain("narrate");
    }
  });

  it("batch is sequenced; stop-on-failure commits prior ops and returns remaining", () => {
    const r = engine.resolveIntent({
      intentId: "b1",
      roomId: "r1",
      type: "batch",
      params: {
        ops: [
          { type: "scene", params: { location: "Bridge" } },
          { type: "narrate", params: { text: "Mist rolls in." } },
          { type: "narrate", params: { text: "" } },
          { type: "narrate", params: { text: "unreached" } },
        ],
      },
      ...base,
    } as any);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.failedAt?.index).toBe(2);
      // ops 0 and 1 committed (scene + narrate)
      expect(r.committed.length).toBe(2);
      expect(r.remaining.length).toBe(2); // failing op + the unreached one
    }
    // committed state persisted: scene location applied
    const state = engine.getRoomState("r1") as any;
    expect(state.room.location).toBe("Bridge");
  });

  it("atomic batch rolls back entirely on any failure", () => {
    const r = engine.resolveIntent({
      intentId: "b2",
      roomId: "r2",
      type: "batch",
      params: {
        atomic: true,
        ops: [
          { type: "scene", params: { location: "Should Not Persist" } },
          { type: "narrate", params: { text: "" } }, // fails
        ],
      },
      ...base,
    } as any);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.committed).toEqual([]);
    const state = engine.getRoomState("r2") as any;
    expect(state.room.location).toBeUndefined();
  });
});

describe("Phase 0 — deterministic dice", () => {
  it("same seed reproduces identical resolution", () => {
    const a = createEngine({ dbDriver: "memory", seedSalt: "fixed" }).engine;
    const b = createEngine({ dbDriver: "memory", seedSalt: "fixed" }).engine;
    // exercise the rng deterministically via a handler-free path: roll directly
    const ra = (a as any).getRng(a.ensureRoom("x"));
    const rb = (b as any).getRng(b.ensureRoom("x"));
    const seqA = Array.from({ length: 10 }, () => ra.die(20));
    const seqB = Array.from({ length: 10 }, () => rb.die(20));
    expect(seqA).toEqual(seqB);
  });
});
