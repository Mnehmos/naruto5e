import { describe, it, expect } from "vitest";
import { Rng } from "@naruto5e/shared";
import { resolveSpeech, gridDistance } from "./social.js";

const mk = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  position: { x: 0, y: 0 },
  conditions: [] as string[],
  proficiencies: { skills: [] as string[] },
  abilityTotals: { dex: 10, wis: 10 },
  proficiencyBonus: 2,
  ...over,
});

describe("social hearing", () => {
  it("gridDistance treats unpositioned actors as co-located", () => {
    expect(gridDistance(undefined, { x: 5, y: 5 })).toBe(0);
    expect(gridDistance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(15);
  });

  it("co-located listeners hear clearly", () => {
    const r = resolveSpeech(new Rng(1), mk("s"), [mk("a")], { volume: "talk" });
    expect(r[0].heard).toBe(true);
    expect(r[0].clarity).toBe("clear");
  });

  it("a listener beyond the volume range can't hear", () => {
    const far = mk("a", { position: { x: 20, y: 0 } }); // 100ft > talk(30)
    const r = resolveSpeech(new Rng(1), mk("s"), [far], { volume: "talk" });
    expect(r[0].heard).toBe(false);
    expect(r[0].reason).toBe("out of range");
  });

  it("a Deafened listener never hears, even a shout point-blank", () => {
    const r = resolveSpeech(new Rng(1), mk("s"), [mk("a", { conditions: ["Deafened"] })], { volume: "shout" });
    expect(r[0].heard).toBe(false);
    expect(r[0].reason).toBe("deafened");
  });

  it("Silent Killing forces an opposed roll even point-blank (no auto-clear)", () => {
    const speaker = mk("s", { traits: ["Silent Killing"] });
    const r = resolveSpeech(new Rng(1), speaker, [mk("a")], { volume: "talk" });
    expect(r[0].roll).toBeDefined();
  });

  it("concealment shrinks the audible range (Hidden Mist)", () => {
    const mid = mk("a", { position: { x: 4, y: 0 } }); // 20ft
    const mist = resolveSpeech(new Rng(1), mk("s"), [mid], { volume: "talk", concealment: 0.8 }); // range -> ~6ft
    expect(mist[0].reason).toBe("out of range");
  });
});
