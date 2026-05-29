import { reject, rollExpression } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { deriveCharacter } from "../rules/character.js";

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}
function loadChar(ctx: ResolveContext): Character {
  const c = chars(ctx).get(String(ctx.op.actorId));
  if (!c) throw reject("actor_required", "This action requires a valid actorId.", {}, ["Set actorId to a character."]);
  return c;
}

const STARTING_RYO: Record<string, number> = { caster: 80, hybrid: 120, martial: 150 };

/** Ch.5 — equipment & the Ryo economy (inventory, equip/AC, consumables, buy/sell). */
export function registerEquipmentIntents(engine: Engine): void {
  engine.registerHandler("item_give", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const item = ctx.engine.content.getItem(key);
    if (!item) throw reject("unknown_item", `No item "${key}" in the catalog.`, { item: key }, ["Check /v1/jutsu-style catalog or use a known item id."]);
    const qty = Number(ctx.op.params.qty ?? 1);
    c.equipment.push({ ...structuredClone(item), equipped: false, qty });
    chars(ctx).put(c);
    ctx.ir.emit("item_gained", { actor: c.id, data: { item: item.name, qty }, narration: `${c.name} receives ${qty}× ${item.name}.` });
  });

  engine.registerHandler("item_remove", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const idx = c.equipment.findIndex((e: any) => e.id === key || e.name?.toLowerCase() === key.toLowerCase());
    if (idx < 0) throw reject("not_carried", `${c.name} isn't carrying "${key}".`, { item: key });
    const [removed] = c.equipment.splice(idx, 1);
    chars(ctx).put(c);
    ctx.ir.emit("item_removed", { actor: c.id, data: { item: (removed as any).name } });
  });

  engine.registerHandler("equip", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const item = c.equipment.find((e: any) => e.id === key || e.name?.toLowerCase() === key.toLowerCase()) as any;
    if (!item) throw reject("not_carried", `${c.name} isn't carrying "${key}".`, { item: key }, ["Acquire it first (item_give / buy)."]);
    if (item.type === "armor") {
      for (const e of c.equipment as any[]) if (e.type === "armor") e.equipped = false;
    }
    item.equipped = true;
    deriveCharacter(c); // recompute AC from armor
    chars(ctx).put(c);
    ctx.ir.emit("equip", { actor: c.id, data: { item: item.name, ac: c.ac }, narration: `${c.name} equips ${item.name} (AC ${c.ac}).` });
  });

  engine.registerHandler("unequip", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const item = c.equipment.find((e: any) => (e.id === key || e.name?.toLowerCase() === key.toLowerCase()) && e.equipped) as any;
    if (!item) throw reject("not_equipped", `${c.name} doesn't have "${key}" equipped.`, { item: key });
    item.equipped = false;
    deriveCharacter(c);
    chars(ctx).put(c);
    ctx.ir.emit("unequip", { actor: c.id, data: { item: item.name, ac: c.ac } });
  });

  engine.registerHandler("use_consumable", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const item = c.equipment.find((e: any) => (e.id === key || e.name?.toLowerCase() === key.toLowerCase()) && e.type === "consumable") as any;
    if (!item) throw reject("no_consumable", `${c.name} has no consumable "${key}".`, { item: key });
    if ((item.charges ?? 0) <= 0 && (item.qty ?? 0) <= 0) throw reject("no_charges", `"${item.name}" has no charges left.`, {});
    const eff = item.effect?.onUse;
    let applied: any = { kind: eff?.kind };
    if (eff?.kind === "restore_chakra") {
      const amt = rollExpression(ctx.rng, eff.amount).total;
      c.chakra.current = Math.min(c.chakra.max, c.chakra.current + amt);
      applied.amount = amt;
    } else if (eff?.kind === "restore_hp") {
      const amt = rollExpression(ctx.rng, eff.amount).total;
      c.hp.current = Math.min(c.hp.max, c.hp.current + amt);
      applied.amount = amt;
    } else {
      applied = { ...eff }; // damage/obscure/condition: DM applies the area effect in combat
    }
    // consume
    if (item.qty && item.qty > 1) item.qty -= 1;
    else {
      const idx = c.equipment.indexOf(item);
      if (idx >= 0) c.equipment.splice(idx, 1);
    }
    chars(ctx).put(c);
    ctx.ir.emit("use_consumable", { actor: c.id, data: { item: item.name, applied, hp: c.hp, chakra: c.chakra }, narration: `${c.name} uses ${item.name}.` });
  });

  engine.registerHandler("buy", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const item = ctx.engine.content.getItem(key);
    if (!item) throw reject("unknown_item", `No item "${key}".`, { item: key });
    const qty = Number(ctx.op.params.qty ?? 1);
    const discount = Number(ctx.op.params.discountPercent ?? 0);
    const unit = Math.max(0, Math.round((item.valueRyo ?? 0) * (1 - discount / 100)));
    const price = unit * qty;
    if (c.ryo < price) throw reject("insufficient_ryo", `${item.name} costs ${price} Ryo; ${c.name} has ${c.ryo}.`, { required: price, available: c.ryo, shortfall: price - c.ryo }, ["Sell something, take a mission, or buy less."]);
    c.ryo -= price;
    c.equipment.push({ ...structuredClone(item), equipped: false, qty });
    chars(ctx).put(c);
    ctx.ir.emit("buy", { actor: c.id, data: { item: item.name, qty, price, ryo: c.ryo }, narration: `${c.name} buys ${qty}× ${item.name} for ${price} Ryo.` });
  });

  engine.registerHandler("sell", (ctx) => {
    const c = loadChar(ctx);
    const key = String(ctx.op.params.item ?? "");
    const idx = c.equipment.findIndex((e: any) => e.id === key || e.name?.toLowerCase() === key.toLowerCase());
    if (idx < 0) throw reject("not_carried", `${c.name} isn't carrying "${key}".`, { item: key });
    const item = c.equipment[idx] as any;
    const sellRate = Number(ctx.op.params.sellRate ?? 0.5);
    const gain = Math.round((item.valueRyo ?? 0) * sellRate);
    c.equipment.splice(idx, 1);
    c.ryo += gain;
    chars(ctx).put(c);
    ctx.ir.emit("sell", { actor: c.id, data: { item: item.name, gain, ryo: c.ryo }, narration: `${c.name} sells ${item.name} for ${gain} Ryo.` });
  });

  engine.registerHandler("grant_starting_wealth", (ctx) => {
    const c = loadChar(ctx);
    const cls = c.className ? ctx.engine.content.getClass(c.className) : undefined;
    const arch = (cls?.archetype as string) ?? "hybrid";
    const wallet = Number(ctx.op.params.bonus ?? 0);
    c.ryo = (STARTING_RYO[arch] ?? 100) + wallet;
    chars(ctx).put(c);
    ctx.ir.emit("starting_wealth", { actor: c.id, data: { ryo: c.ryo, archetype: arch }, narration: `${c.name} starts with ${c.ryo} Ryo.` });
  });

  engine.registerHandler("choose_pack", (ctx) => {
    const c = loadChar(ctx);
    const pack = String(ctx.op.params.pack ?? "Explorer's Pack");
    const PACKS: Record<string, string[]> = {
      "Explorer's Pack": ["ration", "ninja-wire"],
      "Burglar's Pack": ["smoke-bomb", "ninja-wire"],
      "Diplomat's Pack": ["ration"],
      "Scholar's Pack": ["ration"],
      "Entertainment Pack": ["ration"],
    };
    const items = PACKS[pack] ?? [];
    for (const id of items) {
      const item = ctx.engine.content.getItem(id);
      if (item) c.equipment.push({ ...structuredClone(item), equipped: false, qty: 1 });
    }
    chars(ctx).put(c);
    ctx.ir.emit("pack_chosen", { actor: c.id, data: { pack, items }, narration: `${c.name} takes the ${pack}.` });
  });
}
