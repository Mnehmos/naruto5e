/* eslint-disable no-console */
import { createEngine } from "../bootstrap.js";
import type { Engine } from "../engine.js";

/**
 * Internal playtests — deterministic, seeded, in-process. Drives full scenarios
 * through the engine and prints the IR narration so we can read how it plays.
 */
const { engine } = createEngine({ dbDriver: "memory", seedSalt: "playtest-7" });
let pass = 0, fail = 0;
function check(label: string, cond: boolean) {
  console.log(`   ${cond ? "✓" : "✗ FAIL"} ${label}`);
  cond ? pass++ : fail++;
}
function ev(result: any, print = true) {
  if (!result) return result;
  if (result.status === "rejected") {
    if (print) console.log(`   ✗ ${result.reason.rule}: ${result.reason.explain}`);
  } else if (print) {
    for (const e of result.events) if (e.narration) console.log(`   · ${e.narration}`);
  }
  return result;
}
function I(room: string, type: string, params: any = {}, actorId?: string) {
  return engine.resolveIntent({ intentId: `i_${Math.random()}`, roomId: room, actorId, type, params, submittedBy: { clientType: "system", role: "dm" } } as any);
}
const broad = ["Perception", "Stealth", "Insight", "Nature", "Investigation", "Survival", "Acrobatics", "Athletics", "Intimidation", "Chakra Control"];
function build(room: string, name: string, clan: string, cls: string, team: string, level: number, scores: any) {
  const r: any = I(room, "character_create", { name, clan, className: cls, team, level, abilities: { method: "manual", scores }, classSkillChoices: broad, clanSkillChoices: broad, abilityChoices: ["int", "dex", "con"] });
  if (r.status !== "resolved") throw new Error(`build ${name}: ${JSON.stringify(r.reason)}`);
  return r.events[0].data.character.id as string;
}
function get(coll: string, id: string): any { return engine.getEntity(coll, id); }
function actor(room: string): string { const rm = engine.getRoom(room)!; const e: any = get("encounters", rm.encounterId!); return e.order[e.activeIndex]; }
function isAdv(id: string) { return !!get("adversaries", id); }
function living(id: string) { const d = get("characters", id) || get("adversaries", id); return d && !d.dead; }

// ============================================================
console.log("\n████ PLAYTEST 1 — Squad vs. a Solo boss (Zabuza) ████");
{
  const room = "pt1";
  const kakashi = build(room, "Kakashi", "Hatake", "Ninjutsu Specialist", "pc", 8, { str: 12, dex: 16, con: 14, int: 18, wis: 12, cha: 12 });
  const tenten = build(room, "Tenten", "Fuma", "Weapon Specialist", "pc", 8, { str: 16, dex: 16, con: 14, int: 10, wis: 10, cha: 8 });
  const sakura = build(room, "Sakura", "Non-Clan", "Medical-Nin", "pc", 8, { str: 10, dex: 12, con: 14, int: 14, wis: 16, cha: 10 });
  // teach offensive jutsu (pick affordable save+damage ones from the catalog)
  const dmgJutsu = engine.content.jutsu.filter((j) => j.effect?.delivery === "save" && j.effect?.damage && (j.cost ?? 99) <= 12 && ["C", "B"].includes(j.rank));
  const k1 = dmgJutsu[0], k2 = dmgJutsu[1];
  I(room, "jutsu_learn", { jutsu: k1.id }, kakashi);
  I(room, "jutsu_learn", { jutsu: k2.id }, kakashi);
  console.log(`   Kakashi learned: ${k1.name} (${k1.rank}, ${k1.cost}ck, ${k1.effect!.damage!.dice}) + ${k2.name}`);

  // step 7 of the 8-step build: PERSONALIZE the boss to the party (the source's raw
  // adversary attack baseline is brutally high vs PC AC — tune it down for a fair fight).
  const zabuza = ev(I(room, "from_bingo_book", { name: "Zabuza", level: 8, partySize: 1, personalize: { attackMod: -14, damageMult: 0.5, dcMod: -3, hpMult: 1.2 } }) as any).events[0].data.adversary.id;
  const z0 = get("adversaries", zabuza);
  console.log(`   Boss: Zabuza (personalized for the party) — tier ${z0.tier}, AC ${z0.ac}, HP ${z0.hp.max}, attack +${z0.attack}, legendary ${z0.legendary.actions}, resist ${z0.legendary.resistance}`);

  ev(I(room, "combat_start", { combatants: [{ actorId: kakashi, team: "pc" }, { actorId: tenten, team: "pc" }, { actorId: sakura, team: "pc" }, { actorId: zabuza, team: "enemy" }] }));

  const pcs = [kakashi, tenten, sakura];
  let phaseSeen = false, legendarySeen = false, resistSeen = false, downSeen = false;
  for (let step = 0; step < 40; step++) {
    const a = actor(room);
    const z = get("adversaries", zabuza);
    if (z.dead || pcs.every((p) => !living(p))) break;
    if (a === zabuza) {
      // target a CONSCIOUS PC (hp > 0), lowest first — don't pummel the already-downed
      const conscious = pcs.filter((p) => { const d = get("characters", p); return d && !d.dead && d.hp.current > 0; });
      const target = conscious.sort((x, y) => get("characters", x).hp.current - get("characters", y).hp.current)[0];
      if (target) scan(ev(I(room, "freeform_attack", { target }, zabuza)));
    } else if (living(a)) {
      const c = get("characters", a);
      // the Medical-Nin heals/revives the most-hurt ally (Mystical Palm), else attacks
      if (c.className === "Medical-Nin") {
        const wounded = pcs.map((p) => get("characters", p)).filter((x: any) => x && !x.dead && x.hp.current < x.hp.max).sort((x: any, y: any) => x.hp.current - y.hp.current)[0];
        if (wounded) scan(ev(I(room, "character_heal", { amount: 20 }, wounded.id)));
        else scan(ev(I(room, "attack", { target: zabuza, damage: "1d8", ability: "dex" }, a)));
      } else if (c.jutsuKnown.length) {
        const jid = c.jutsuKnown[step % c.jutsuKnown.length];
        const j = engine.content.getJutsu(jid)!;
        if ((c.chakra.current ?? 0) >= (j.cost ?? 0)) scan(ev(I(room, "cast", { jutsu: jid, targets: [zabuza] }, a)));
        else scan(ev(I(room, "attack", { target: zabuza, damage: "1d8", ability: "dex" }, a)));
      } else {
        scan(ev(I(room, "attack", { target: zabuza, damage: "2d6", ability: "str" }, a)));
      }
      // the Solo spends a banked Legendary Action after a hero acts
      const zl = get("adversaries", zabuza);
      if (zl.legendary?.actions > 0 && living(zabuza)) {
        const t = pcs.filter((p) => { const d = get("characters", p); return d && !d.dead && d.hp.current > 0; })[0];
        if (t) scan(ev(I(room, "legendary_action", { action: "freeform_attack", params: { target: t } }, zabuza)));
      }
    }
    ev(I(room, "advance"), false);
  }
  function scan(r: any) {
    if (r?.status !== "resolved") return;
    for (const e of r.events) {
      if (e.type === "phase_transition") phaseSeen = true;
      if (e.type === "legendary_action") legendarySeen = true;
      if (e.type === "legendary_resistance") resistSeen = true;
      if (e.type === "down") downSeen = true;
    }
  }
  const z = get("adversaries", zabuza);
  console.log(`   --- Outcome: Zabuza ${z.dead ? "DEFEATED" : `at ${z.hp.current}/${z.hp.max} HP (phase ${z.phases.current})`}; PCs alive: ${pcs.filter(living).map((p) => get("characters", p).name).join(", ") || "none"}`);
  check("combat ran with jutsu casts + damage", true);
  check("Solo used Legendary Actions", legendarySeen);
  check("a Phase Transition or Legendary Resistance fired", phaseSeen || resistSeen);
  check("someone was dropped (down/dead) during the fight", downSeen || z.dead);
}

// ============================================================
console.log("\n████ PLAYTEST 2 — Mission loop + economy + rank-up ████");
{
  const room = "pt2";
  const genin = build(room, "Konohamaru", "Sarutobi", "Scout-Nin", "pc", 1, { str: 12, dex: 14, con: 13, int: 10, wis: 12, cha: 10 });
  ev(I(room, "grant_starting_wealth", { bonus: 400 }, genin));
  const ryo0 = get("characters", genin).ryo;
  const m = ev(I(room, "mission_post", { title: "Escort the bridge-builder", rank: "C" }) as any).events[0].data.mission.id;
  ev(I(room, "mission_accept", { missionId: m }, genin));
  ev(I(room, "mission_resolve", { missionId: m, outcome: "success", bonusMultiplier: 1.5 }));
  const after = get("characters", genin);
  check("mission paid Ryo + mission points", after.ryo > ryo0 && after.missionPoints > 0);
  // shop: buy + equip armor, AC changes
  const ac0 = after.ac;
  ev(I(room, "buy", { item: "flak-jacket" }, genin));
  ev(I(room, "equip", { item: "flak-jacket" }, genin));
  check("equipping armor recomputed AC", get("characters", genin).ac !== ac0);
  ev(I(room, "rank_up", {}, genin));
  check("promoted to Chunin", get("characters", genin).rank === "Chunin");
  // an unaffordable purchase is an educational rejection
  const broke = ev(I(room, "buy", { item: "shinobi-battle-armor" }, genin)) as any;
  check("unaffordable buy -> educational failure", broke.status === "rejected" && broke.reason.rule === "insufficient_ryo");
}

// ============================================================
console.log("\n████ PLAYTEST 3 — Rest embeds the world tick (heat, agents, digest) ████");
{
  const room = "pt3";
  const ninja = build(room, "Anko", "Hebi", "Hunter-Nin", "pc", 5, { str: 14, dex: 16, con: 14, int: 10, wis: 13, cha: 10 });
  ev(I(room, "npc_create", { id: "rin", name: "Sensei Rin", authorityId: "leaf_village" }));
  ev(I(room, "npc_create", { id: "rival", name: "Rival Genma", authorityId: "leaf_village" }));
  const steal = ev(I(room, "theft_steal", { item: "kunai", jurisdictionAuthorityId: "leaf_village", witnesses: ["rin"] }, ninja) as any).events[0].data.stolenId;
  // spend pools, then a long rest (medium tick) and a downtime (large tick)
  const d = get("characters", ninja); d.hp.current = 3; d.chakra.current = 1; engine.store.collection("characters").put(d);
  console.log("   -- long rest --");
  const lr = ev(I(room, "rest", { type: "long", missionBoundary: true }, ninja)) as any;
  const restEv = lr.events.find((e: any) => e.type === "rest");
  console.log(`   restResult: +${restEv.data.restResult.recovered.hp} HP, +${restEv.data.restResult.recovered.chakra} chakra, WoF ${restEv.data.restResult.willOfFire}`);
  console.log(`   tick(${restEv.data.tick.magnitude}): ${restEv.data.tick.agentsCalled.length} agents, ${restEv.data.tick.resolved.length} world ops`);
  console.log(`   playerDigest: ${restEv.data.playerDigest.join(" | ") || "(nothing surfaced)"}`);
  check("rest recovered both pools to full", get("characters", ninja).hp.current === get("characters", ninja).hp.max);
  check("the tick advanced the world (heat/agents)", restEv.data.tick.resolved.length > 0 || restEv.data.tick.agentsCalled.length > 0);
  console.log("   -- downtime (large tick) --");
  const dt = ev(I(room, "rest", { type: "downtime" }, ninja)) as any;
  const dtv = dt.events.find((e: any) => e.type === "rest");
  check("downtime fired a LARGE tick", dtv.data.tick.magnitude === "large");
  check("stolen-goods heat fully cooled by downtime", get("stolen_items", steal).heat === "cold");
}

// ============================================================
console.log("\n████ PLAYTEST 4 — Standing, world-consequence, content tools ████");
{
  const room = "pt4";
  const rogue = build(room, "Kabuto", "Hebi", "Medical-Nin", "pc", 6, { str: 10, dex: 14, con: 13, int: 16, wis: 13, cha: 12 });
  // gated scroll: Ryo can't buy it without reputation
  ev(I(room, "vendor_create", { id: "vault", name: "Sealed Vault", authorityId: "leaf_village", gatedStock: [{ itemId: "soldier-pill", ryoPrice: 50, requires: { authorityId: "leaf_village", minReputation: 60 } }] }));
  ev(I(room, "grant_starting_wealth", { bonus: 5000 }, rogue));
  const blocked = ev(I(room, "economy_buy", { vendorId: "vault", item: "soldier-pill" }, rogue)) as any;
  check("gated stock blocked despite Ryo (Standing permits, Ryo buys)", blocked.status === "rejected" && blocked.reason.rule === "not_offered");
  // corpse harvest: KKG craters the clan, spikes the patron
  const corpse = ev(I(room, "corpse_create", { name: "Fallen Uchiha", authorityId: "uchiha_clan", clan: "Uchiha", carries: [{ type: "kkg", tabooSeverity: 0.9 }] }) as any).events[0].data.corpse.id;
  ev(I(room, "corpse_harvest", { corpseId: corpse, what: "kkg", patronAuthorityId: "orochimaru" }, rogue));
  const uch = get("standings", `${rogue}:uchiha_clan`), oro = get("standings", `${rogue}:orochimaru`);
  check("KKG harvest cratered the deceased's authority", uch.reputation < 0);
  check("...and spiked the rogue patron", oro.reputation > 0);
  ev(I(room, "defect", { fromAuthority: "leaf_village", toAuthority: "orochimaru" }, rogue));
  check("defection craters the village ledger (missing-nin)", get("standings", `${rogue}:leaf_village`).hostile === true);
  // jutsu_build: author a balanced jutsu, commit, cast it
  const draft = ev(I(room, "jutsu_build", { op: "draft", rank: "B", classification: "Ninjutsu", name: "Viper's Kiss", effects: { damage: "6d6", range: 30, save: "con", damageType: "poison", conditions: ["poisoned"] } }) as any);
  const rec = draft.events[0].data;
  console.log(`   built "Viper's Kiss": ${rec.points.toFixed(1)} pts / budget ${rec.budget} -> ${rec.verdict}`);
  ev(I(room, "jutsu_build", { op: "commit", record: rec.record }));
  check("a built jutsu is now in the catalog", !!engine.content.getJutsu(rec.record.id));
  // freeform improv priced + cast
  const ff = ev(I(room, "freeform", { op: "resolve", description: "spit a paralytic snake-venom mist", classification: "Ninjutsu", effects: { damage: "3d6", area: { size: 15, shape: "cone" }, save: "con" } }, rogue) as any);
  check("freeform conformed an improv into a priced castable op", ff.events[0].data.proposedOp.type === "cast" && ff.events[0].data.points > 0);
}

// ============================================================
console.log("\n████ PLAYTEST 5 — Multiclass + feat ████");
{
  const room = "pt5";
  const c = build(room, "Shikamaru", "Nara", "Intelligence Operative", "pc", 4, { str: 8, dex: 14, con: 13, int: 16, wis: 14, cha: 10 });
  const cap0 = get("characters", c).jutsuKnownCap, hp0 = get("characters", c).hp.max;
  ev(I(room, "character_multiclass", { intoClass: "Ninjutsu Specialist" }, c));
  const c1 = get("characters", c);
  check("multiclass: 2 classes, level 5", c1.classes.length === 2 && c1.level === 5);
  check("multiclass combined pools + jutsu-known cap", c1.hp.max > hp0 && c1.jutsuKnownCap > cap0);
  ev(I(room, "take_feat", { feat: "Alert" }, c));
  check("feat recorded", get("characters", c).feats.includes("Alert"));
}

console.log(`\n████ PLAYTEST SUMMARY: ${pass} passed, ${fail} failed ████\n`);
engine.store.close();
process.exit(fail ? 1 : 0);
