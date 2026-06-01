import { describe, it, expect, beforeEach } from "vitest";
import { createEngine } from "./bootstrap.js";
import type { Engine } from "./engine.js";

/**
 * Phase C — hidden-state primitive tests.
 *
 * Pins the invariants:
 *  - read_field on an UNMARKED field returns disposition='commit' (the field
 *    is plain, fully legible).
 *  - mark_legibility promotes a field to hidden; subsequent read returns
 *    disposition='unknown' (apparent is null) — first-class UNKNOWN.
 *  - reveal_field copies actual → apparent; read returns disposition='commit'
 *    with the apparent value.
 *  - mask_field returns apparent to null and bumps concealment; read returns
 *    unknown again.
 *  - The `actual` value NEVER appears in any emitted IR data payload.
 *  - Evidence trail records every read/reveal/mask + by-whom.
 *  - perception check (rolled vs. concealment) gates the read; on failure,
 *    disposition='unknown' even though apparent may be committed.
 */

const base = { submittedBy: { clientType: "system" as const, role: "dm" as const } };
let engine: Engine;
const ROOM = "leg-room";

function run(type: string, params: Record<string, unknown>, actorId?: string, roomId = ROOM) {
  return engine.resolveIntent({ intentId: `i_${type}_${Math.random()}`, roomId, actorId, type, params, ...base } as any);
}

function pc(): string {
  const broad = ["Perception", "Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control"];
  const r = run("character_create", {
    name: "Sasuke",
    clan: "Non-Clan",
    className: "Ninjutsu Specialist",
    abilities: { method: "manual", scores: { str: 10, dex: 14, con: 12, int: 15, wis: 14, cha: 10 } },
    classSkillChoices: broad,
    clanSkillChoices: broad,
    abilityChoices: ["int", "dex", "con"],
  }) as any;
  if (r.status !== "resolved") throw new Error("character_create rejected: " + JSON.stringify(r.reason));
  return r.events[0].data.character.id as string;
}

beforeEach(() => {
  engine = createEngine({ dbDriver: "memory", seedSalt: "legibility-fixed" }).engine;
});

/**
 * Scan every emitted IR event's data payload (recursively) for the value
 * provided as `actual`. The legibility invariant says actual MUST NEVER leak
 * via any IR payload — only `apparent` may surface.
 */
function payloadLeaks(events: any[], actualMarker: string): boolean {
  const seen = JSON.stringify(events);
  return seen.includes(actualMarker);
}

describe("Phase C — mark_legibility + read_field UNKNOWN as first-class disposition", () => {
  it("marking a field as hidden makes subsequent reads return disposition='unknown'", () => {
    const c = pc();
    // mark the character's `clan` field as hidden — actual=existing value, apparent=null
    const m = run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 12 }, c) as any;
    expect(m.status).toBe("resolved");
    expect(m.events[0].data.disposition).toBe("commit");

    // a read with no observer (skipCheck implicit) returns UNKNOWN because apparent is null
    const r = run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    expect(r.status).toBe("resolved");
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("unknown");
    expect(ev.data.knownState).toBe("unknown");
    expect(ev.data.value).toBeNull();
  });

  it("UNKNOWN never silently degrades to clean — the IR records knownState='unknown'", () => {
    const c = pc();
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "name", concealment: 10 }, c);
    const r = run("read_field", { entityKind: "characters", entityId: c, field: "name" }, c) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.knownState).toBe("unknown");
    expect(ev.data.disposition).toBe("unknown");
    // narration MUST NOT pretend the field is clean — it should say "unknown"
    expect(ev.narration.toLowerCase()).toMatch(/unknown|cannot|not/);
  });
});

describe("Phase C — reveal_field then read_field commits", () => {
  it("reveal copies actual → apparent; the next read returns disposition='commit' + the value", () => {
    const c = pc();
    // mark + reveal in sequence
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 10 }, c);

    const reveal = run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    expect(reveal.status).toBe("resolved");
    const revealEv = reveal.events.find((e: any) => e.type === "legibility_reveal");
    expect(revealEv.data.disposition).toBe("commit");

    const r = run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.knownState).toBe("known");
    expect(ev.data.value).toBe("Non-Clan");
  });

  it("mask after reveal returns the field to unknown", () => {
    const c = pc();
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 10 }, c);
    run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c);

    const mask = run("mask_field", { entityKind: "characters", entityId: c, field: "clan", bumpConcealment: 5 }, c) as any;
    expect(mask.status).toBe("resolved");
    expect(mask.events.find((e: any) => e.type === "legibility_mask").data.disposition).toBe("commit");

    const r = run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("unknown");
    expect(ev.data.knownState).toBe("unknown");
  });
});

describe("Phase C — `actual` never leaks via any IR payload", () => {
  it("a read on a hidden field with unrevealed actual NEVER surfaces the actual value", () => {
    const c = pc();
    // first set a SENTINEL on the character we can scan for
    const ent = engine.getEntity("characters", c) as any;
    ent.specialTraits = ["NEVER_LEAK_SENTINEL"];
    (engine as any).store.collection("characters").put(ent);

    run("mark_legibility", { entityKind: "characters", entityId: c, field: "specialTraits", concealment: 10 }, c);

    // many reads — none should expose the sentinel
    const allEvents: any[] = [];
    for (let i = 0; i < 5; i++) {
      const r = run("read_field", { entityKind: "characters", entityId: c, field: "specialTraits" }, c) as any;
      for (const e of r.events) allEvents.push(e);
    }
    expect(payloadLeaks(allEvents, "NEVER_LEAK_SENTINEL")).toBe(false);
  });

  it("after reveal, the apparent value MAY appear (that's the whole point); before reveal it must not", () => {
    const c = pc();
    const ent = engine.getEntity("characters", c) as any;
    ent.specialTraits = ["REVEAL_SENTINEL"];
    (engine as any).store.collection("characters").put(ent);

    run("mark_legibility", { entityKind: "characters", entityId: c, field: "specialTraits", concealment: 10 }, c);

    // Pre-reveal: should NOT leak
    const before = run("read_field", { entityKind: "characters", entityId: c, field: "specialTraits" }, c) as any;
    expect(payloadLeaks(before.events, "REVEAL_SENTINEL")).toBe(false);

    // After reveal: apparent surfaces (this is correct)
    run("reveal_field", { entityKind: "characters", entityId: c, field: "specialTraits" }, c);
    const after = run("read_field", { entityKind: "characters", entityId: c, field: "specialTraits" }, c) as any;
    expect(payloadLeaks(after.events, "REVEAL_SENTINEL")).toBe(true);
  });
});

describe("Phase C — plain (non-wrapped) fields read with disposition='commit'", () => {
  it("an unmarked field returns the literal value with knownState='plain' and disposition='commit'", () => {
    const c = pc();
    const r = run("read_field", { entityKind: "characters", entityId: c, field: "name" }, c) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.knownState).toBe("plain");
    expect(ev.data.value).toBe("Sasuke");
  });
});

describe("Phase C — perception check gates the read against concealment", () => {
  it("a failed perception check returns disposition='unknown' with reason='perception_failed'", () => {
    const c = pc();
    // create a second observer character with NO perception proficiency + low wis
    const broad = ["Stealth", "Insight", "Acrobatics", "Athletics", "Nature", "Investigation", "Survival", "Intimidation", "Chakra Control", "Deception"];
    const obs = run("character_create", {
      name: "Lee",
      clan: "Non-Clan",
      className: "Taijutsu Specialist",
      abilities: { method: "manual", scores: { str: 15, dex: 10, con: 12, int: 8, wis: 8, cha: 10 } },
      classSkillChoices: broad,
      clanSkillChoices: broad,
      abilityChoices: ["str", "con", "dex"],
    }) as any;
    expect(obs.status).toBe("resolved");
    const obsId = obs.events[0].data.character.id;

    // mark + reveal so apparent is known, but with HIGH concealment so the
    // observer's d20+WIS-mod-with-no-prof needs to clear it
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 30 }, c);
    run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c);

    // observer rolls — at WIS 8 (mod -1) and no Perception prof, they CANNOT
    // clear a DC 30 even on a nat 20 (would be 19 max).
    const r = run(
      "read_field",
      { entityKind: "characters", entityId: c, field: "clan", observerId: obsId, observerKind: "characters" },
      obsId,
    ) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("unknown");
    expect(ev.data.reason).toBe("perception_failed");
    expect(ev.data.value).toBeNull();
    expect(ev.data.check.vs).toBe(30);
  });

  it("skipCheck=true bypasses perception and returns the apparent value when known", () => {
    const c = pc();
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 30 }, c);
    run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c);

    const r = run("read_field", { entityKind: "characters", entityId: c, field: "clan", skipCheck: true }, c) as any;
    const ev = r.events.find((e: any) => e.type === "legibility_read");
    expect(ev.data.disposition).toBe("commit");
    expect(ev.data.value).toBe("Non-Clan");
  });
});

describe("Phase C — every legibility IR carries a `disposition`", () => {
  it("legibility_mark, legibility_read, legibility_reveal, legibility_mask all carry disposition", () => {
    const c = pc();
    const m = run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 10 }, c) as any;
    const r1 = run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    const v = run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    const r2 = run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;
    const k = run("mask_field", { entityKind: "characters", entityId: c, field: "clan" }, c) as any;

    for (const intent of [m, r1, v, r2, k]) {
      for (const ev of intent.events as any[]) {
        if (ev.type.startsWith("legibility_")) {
          expect(ev.data.disposition).toMatch(/commit|unknown|reject_inert|no_op_spoken/);
        }
      }
    }
  });

  it("evidence trail records mark, read, reveal, mask events on the wrapper", () => {
    const c = pc();
    run("mark_legibility", { entityKind: "characters", entityId: c, field: "clan", concealment: 10 }, c);
    run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c); // unknown
    run("reveal_field", { entityKind: "characters", entityId: c, field: "clan" }, c);
    run("read_field", { entityKind: "characters", entityId: c, field: "clan" }, c); // commit
    run("mask_field", { entityKind: "characters", entityId: c, field: "clan" }, c);

    const ent = engine.getEntity("characters", c) as any;
    const wrapper = ent.clan;
    expect(wrapper.__hidden).toBe(true);
    expect(wrapper.evidence.length).toBeGreaterThanOrEqual(5);
    const kinds = wrapper.evidence.map((e: any) => e.kind);
    expect(kinds).toContain("mark");
    expect(kinds).toContain("read");
    expect(kinds).toContain("reveal");
    expect(kinds).toContain("mask");
  });
});
