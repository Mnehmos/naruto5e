import { describe, it, expect } from "vitest";
import { conformNpcDeclaration, type ConformInput } from "./npc-intent.js";

const base: Omit<ConformInput, "declaration"> = { npcId: "npc_kakashi", actorId: "npc_kakashi", roomId: "r1", mode: "scene" };
const aff = {
  actions: [{ type: "social_speak" }, { type: "npc_interact" }, { type: "move" }, { type: "npc_set_goal" }],
  jutsu: [{ id: "fireball", name: "Fireball", castable: true }, { id: "tsunami", name: "Tsunami", castable: false }],
  threats: [{ id: "adv_1", name: "Raijū" }],
  allies: [{ id: "char_iwao", name: "Iwao" }],
  present: [{ id: "char_iwao", name: "Iwao" }],
};

describe("conformNpcDeclaration", () => {
  it("maps a structured speak JSON to social_speak with tone→volume + resolved audience", () => {
    const r = conformNpcDeclaration({ ...base, declaration: '{"intent":"speak","text":"Lower your voices.","target":"Iwao","tone":"low"}', affordances: aff });
    expect(r.status).toBe("conformed");
    if (r.status !== "conformed") return;
    expect(r.intent.type).toBe("social_speak");
    expect(r.intent.params.text).toBe("Lower your voices.");
    expect(r.intent.params.volume).toBe("whisper");
    expect(r.intent.params.audience).toEqual(["char_iwao"]); // name resolved to id
  });

  it("maps quoted prose to a social_speak attempt", () => {
    const r = conformNpcDeclaration({ ...base, declaration: 'I step between them and say, "Enough."', affordances: aff });
    expect(r.status).toBe("conformed");
    if (r.status === "conformed") expect(r.intent.type).toBe("social_speak");
  });

  it("maps a goal declaration to npc_set_goal", () => {
    const r = conformNpcDeclaration({ ...base, declaration: '{"intent":"goal","goal":"shadow the squad"}', affordances: aff });
    expect(r.status).toBe("conformed");
    if (r.status === "conformed") {
      expect(r.intent.type).toBe("npc_set_goal");
      expect((r.intent.params.goal as any).text).toBe("shadow the squad");
    }
  });

  it("maps a reflection to a journal entry (no world mutation)", () => {
    const r = conformNpcDeclaration({ ...base, declaration: "I wait and watch the genin from the treeline.", affordances: aff });
    expect(r.status).toBe("conformed");
    if (r.status === "conformed") expect(r.intent.type).toBe("npc_add_journal");
  });

  it("refuses an empty or unmappable declaration with needs_dm_repair (no canon)", () => {
    expect(conformNpcDeclaration({ ...base, declaration: "" }).status).toBe("needs_dm_repair");
    expect(conformNpcDeclaration({ ...base, declaration: "asdf qwerty zxcv." }).status).toBe("needs_dm_repair");
  });

  it("conforms a cast only when the jutsu is known + castable", () => {
    const ok = conformNpcDeclaration({ ...base, mode: "combat", declaration: '{"intent":"cast","jutsu":"fireball","target":"Raijū"}', affordances: aff });
    expect(ok.status).toBe("conformed");
    if (ok.status === "conformed") {
      expect(ok.intent.type).toBe("cast");
      expect(ok.intent.params.targets).toEqual(["adv_1"]);
    }
    const blocked = conformNpcDeclaration({ ...base, mode: "combat", declaration: '{"intent":"cast","jutsu":"tsunami"}', affordances: aff });
    expect(blocked.status).toBe("needs_dm_repair"); // not castable
    const unknown = conformNpcDeclaration({ ...base, mode: "combat", declaration: '{"intent":"cast","jutsu":"rasengan"}', affordances: aff });
    expect(unknown.status).toBe("needs_dm_repair"); // not in the kit
  });

  it("only allows attacks in combat, with a resolved target", () => {
    const scene = conformNpcDeclaration({ ...base, declaration: '{"intent":"attack","target":"Raijū"}', affordances: aff });
    expect(scene.status).toBe("needs_dm_repair"); // not combat
    const combat = conformNpcDeclaration({ ...base, mode: "combat", declaration: '{"intent":"attack","target":"Raijū"}', affordances: aff });
    expect(combat.status).toBe("conformed");
    if (combat.status === "conformed") expect(combat.intent.params.target).toBe("adv_1");
  });
});
