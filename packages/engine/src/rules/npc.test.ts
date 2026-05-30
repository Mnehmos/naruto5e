import { describe, it, expect } from "vitest";
import { dispositionTier, familiarityTier, salientMemories } from "./npc.js";

describe("NPC social tiers", () => {
  it("dispositionTier maps the -100..100 scale to attitudes", () => {
    expect(dispositionTier(-100)).toBe("hostile");
    expect(dispositionTier(-60)).toBe("hostile");
    expect(dispositionTier(-40)).toBe("unfriendly");
    expect(dispositionTier(0)).toBe("neutral");
    expect(dispositionTier(40)).toBe("friendly");
    expect(dispositionTier(80)).toBe("helpful");
  });
  it("familiarityTier maps the 0..100 scale to closeness", () => {
    expect(familiarityTier(0)).toBe("stranger");
    expect(familiarityTier(20)).toBe("acquaintance");
    expect(familiarityTier(50)).toBe("friend");
    expect(familiarityTier(90)).toBe("close_friend");
  });
});

describe("salientMemories", () => {
  const mem = [
    { summary: "met at the bridge", importance: "low", topics: ["intro"] },
    { summary: "argued about pay", importance: "notable", topics: ["money"] },
    { summary: "saved his life", importance: "defining", topics: ["rescue"] },
    { summary: "small talk", importance: "low", topics: ["weather"] },
  ];
  it("orders by importance desc, then recency (append order) desc", () => {
    const out = salientMemories(mem);
    expect(out[0].summary).toBe("saved his life"); // defining first
    expect(out[1].summary).toBe("argued about pay"); // notable next
    expect(out[2].summary).toBe("small talk"); // both low -> later one first
    expect(out[3].summary).toBe("met at the bridge");
  });
  it("filters by minImportance", () => {
    const out = salientMemories(mem, { minImportance: "notable" });
    expect(out.map((m) => m.summary)).toEqual(["saved his life", "argued about pay"]);
  });
  it("filters by topic and respects limit", () => {
    expect(salientMemories(mem, { topic: "rescue" }).map((m) => m.summary)).toEqual(["saved his life"]);
    expect(salientMemories(mem, { limit: 2 }).length).toBe(2);
  });
});
