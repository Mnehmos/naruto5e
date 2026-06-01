import { newId, reject } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import type { Character } from "../domain/character.js";
import { applyStandingDelta, ensureLedger, getLedger } from "../rules/standing.js";
import {
  type StandingBargainEntry,
  type StandingDebt,
  type StandingLedger,
} from "../domain/standing.js";
import { creditPool, resolveResource } from "../rules/resourcePool.js";

/**
 * Bargain surface (Phase C). The ONE cross-ruleset seam:
 *
 *  - strike_bargain — commit grant + commit price ATOMICALLY. Either both
 *    sides post or nothing posts; "silently free" deals do not exist.
 *    A bargain CAN grant a FOREIGN RESOURCE (a second-pool resource that
 *    isn't native to the current ruleset). That foreign resource creates the
 *    +entry; after acquisition the foreign ruleset's native teaching takes
 *    over (we don't author the foreign content here).
 *
 *  - call_favor — counterparty / authority collects a logged debt or
 *    spends accumulated favor against the character. Firable from NPC
 *    intents AND from the world-tick.
 *
 *  - incur_debt — light, standing-only obligation. No immediate cost; the
 *    debt sits open on the ledger until called or forgiven.
 *
 * Invariants:
 *  - Price logs ATOMICALLY with grant. If the price side would NOT log
 *    (insufficient favor/ryo, invalid debt terms), the bargain is REJECTED
 *    and disposition='reject_inert'.
 *  - Every bargain emits a `bargain` IR event with disposition ∈
 *    {commit, reject_inert}; foreign-resource grants additionally emit a
 *    `foreign_resource_grant` event with the {resource, amount} pair.
 *  - call_favor is content-agnostic — the same handler is reachable from
 *    the world-tick (tick_run) and from any NPC's intent batch.
 */

function chars(ctx: ResolveContext) {
  return ctx.store.collection<Character>("characters");
}

function loadChar(ctx: ResolveContext, id: string | undefined): Character {
  if (!id) throw reject("actor_required", "Bargain verbs need actorId (the character striking/calling).", {}, ["Set actorId to a character id."]);
  const c = chars(ctx).get(id);
  if (!c) throw reject("entity_not_found", `No character "${id}".`, { id }, ["Create the character first."]);
  return c;
}

interface PriceSpec {
  favor?: number;
  reputation?: number;
  ryo?: number;
  debt?: string; // when debt is part of the price: the terms become an open debt
}

interface GrantSpec {
  favor?: number;
  reputation?: number;
  ryo?: number;
  /** A FOREIGN RESOURCE (+entry): the +entry creates the resource pool on the
   *  character and credits the amount. Only doorway between rulesets. */
  foreignResource?: { id: string; amount: number; label?: string };
  /** Free-form access/info/item flags — the engine records them; downstream
   *  content (or the narrator) describes their effect. */
  access?: string;
  info?: string;
  item?: string;
}

/**
 * Pre-check the price side: does the character have what they're spending?
 * Returns a structured failure { ok: false, reason } so the caller can throw
 * the right educational reject (no half-applied state).
 */
function checkPriceAffordable(
  c: Character,
  ledger: StandingLedger | undefined,
  price: PriceSpec,
): { ok: true } | { ok: false; rule: string; explain: string; values: Record<string, unknown> } {
  if (price.favor && price.favor > 0) {
    if (!ledger || ledger.favor < price.favor) {
      return {
        ok: false,
        rule: "insufficient_favor",
        explain: `Bargain requires spending ${price.favor} favor; ${c.name} has ${ledger?.favor ?? 0}.`,
        values: { required: price.favor, available: ledger?.favor ?? 0 },
      };
    }
  }
  if (price.reputation && price.reputation > 0) {
    if (!ledger || ledger.reputation < price.reputation) {
      return {
        ok: false,
        rule: "insufficient_reputation",
        explain: `Bargain requires spending ${price.reputation} reputation; ${c.name} has ${ledger?.reputation ?? 0}.`,
        values: { required: price.reputation, available: ledger?.reputation ?? 0 },
      };
    }
  }
  if (price.ryo && price.ryo > 0) {
    if ((c.ryo ?? 0) < price.ryo) {
      return {
        ok: false,
        rule: "insufficient_ryo",
        explain: `Bargain requires paying ${price.ryo} ryo; ${c.name} has ${c.ryo ?? 0}.`,
        values: { required: price.ryo, available: c.ryo ?? 0 },
      };
    }
  }
  // debt: any non-empty string is valid (the terms get logged). An empty
  // string with debt-mode set is a content error.
  if ("debt" in price && (!price.debt || typeof price.debt !== "string")) {
    return {
      ok: false,
      rule: "debt_terms_required",
      explain: `Bargain with debt as part of the price requires non-empty terms (params.price.debt).`,
      values: { got: price.debt },
    };
  }
  return { ok: true };
}

function applyPrice(
  ctx: ResolveContext,
  c: Character,
  counterparty: string,
  price: PriceSpec,
  bargainId: string,
): { posted: true; debtId?: string } {
  // favor / reputation route through the standing pipeline (preserves milestone
  // gating semantics, etc.) — passive standing intentionally off here.
  if ((price.favor && price.favor > 0) || (price.reputation && price.reputation > 0)) {
    applyStandingDelta(ctx.store, c.id, counterparty, {
      favor: price.favor ? -price.favor : undefined,
      reputation: price.reputation ? -price.reputation : undefined,
      reason: `bargain price (${bargainId})`,
    });
  }
  if (price.ryo && price.ryo > 0) {
    c.ryo = Math.max(0, (c.ryo ?? 0) - price.ryo);
    chars(ctx).put(c);
  }
  let debtId: string | undefined;
  if (price.debt && typeof price.debt === "string") {
    const ledger = ensureLedger(ctx.store, c.id, counterparty);
    debtId = newId("debt");
    const debt: StandingDebt = {
      id: debtId,
      to: counterparty,
      terms: price.debt,
      incurredAt: Date.now(),
      discharged: false,
      bargainId,
    };
    ledger.debts.push(debt);
    ctx.store.collection<StandingLedger>("standings").put(ledger);
  }
  return { posted: true, debtId };
}

function applyGrant(ctx: ResolveContext, c: Character, counterparty: string, grant: GrantSpec, bargainId: string): { foreignGrant?: { resource: string; amount: number } } {
  if ((grant.favor && grant.favor > 0) || (grant.reputation && grant.reputation > 0)) {
    applyStandingDelta(ctx.store, c.id, counterparty, {
      favor: grant.favor,
      reputation: grant.reputation,
      reason: `bargain grant (${bargainId})`,
    });
  }
  if (grant.ryo && grant.ryo > 0) {
    c.ryo = (c.ryo ?? 0) + grant.ryo;
    chars(ctx).put(c);
  }
  let foreignGrant: { resource: string; amount: number } | undefined;
  if (grant.foreignResource && grant.foreignResource.amount > 0) {
    const def = resolveResource(ctx.engine.content, grant.foreignResource.id);
    // Ensure the character has a pool slot for the foreign resource. If they
    // don't, mint one capped at the granted amount — the +entry creates the
    // resource on this sheet. (Foreign ruleset's native teaching takes over
    // after acquisition.)
    const bag = (c.resources as Record<string, any>) ?? {};
    const existing = bag[def.id];
    if (!existing || typeof existing !== "object" || typeof existing.current !== "number") {
      bag[def.id] = { current: 0, max: grant.foreignResource.amount, temp: 0 };
      (c as any).resources = bag;
    }
    creditPool(c, ctx.engine.content, def.id, grant.foreignResource.amount);
    chars(ctx).put(c);
    foreignGrant = { resource: def.id, amount: grant.foreignResource.amount };
  }
  return { foreignGrant };
}

export function registerBargainIntents(engine: Engine): void {
  // ---- strike_bargain -------------------------------------------------
  engine.registerHandler("strike_bargain", (ctx) => {
    const c = loadChar(ctx, ctx.op.actorId);
    const counterparty = String(ctx.op.params.counterparty ?? ctx.op.params.authorityId ?? "");
    if (!counterparty) {
      throw reject("counterparty_required", "strike_bargain requires params.counterparty (the authority/clan/npc id).", {}, ["Name the counterparty."]);
    }
    const grants = (ctx.op.params.grants as GrantSpec) ?? {};
    const price = (ctx.op.params.price as PriceSpec) ?? {};
    const grantsDesc = String(ctx.op.params.grantsDesc ?? "");
    const priceDesc = String(ctx.op.params.priceDesc ?? "");

    // Sanity: a bargain must have BOTH a grant side and a price side. Silent
    // free deals are rejected here.
    const hasGrant =
      (grants.favor ?? 0) > 0 ||
      (grants.reputation ?? 0) > 0 ||
      (grants.ryo ?? 0) > 0 ||
      !!grants.foreignResource ||
      !!grants.access ||
      !!grants.info ||
      !!grants.item;
    const hasPrice =
      (price.favor ?? 0) > 0 ||
      (price.reputation ?? 0) > 0 ||
      (price.ryo ?? 0) > 0 ||
      typeof price.debt === "string";
    if (!hasGrant || !hasPrice) {
      throw reject(
        "bargain_requires_both_sides",
        `A bargain must commit a grant AND a price atomically — no silently-free deals.`,
        { hasGrant, hasPrice, grants, price },
        ["Include params.grants (favor/reputation/ryo/foreignResource/access/info/item) AND params.price (favor/reputation/ryo/debt)."],
      );
    }

    const ledger = getLedger(ctx.store, c.id, counterparty);
    const check = checkPriceAffordable(c, ledger, price);
    if (!check.ok) {
      // Atomic invariant: price did NOT log, so the bargain is REJECTED and
      // NOTHING posts. The disposition rides on the rejection reason itself
      // (the engine drops IR events on rejection, so we surface the inert
      // state via the structured `values.disposition`).
      throw reject(
        check.rule,
        check.explain,
        { ...check.values, disposition: "reject_inert", counterparty, bargainOp: "strike_bargain" },
        ["Reduce the price side, accept debt instead, or earn the resource first."],
      );
    }

    // Both sides post atomically.
    const bargainId = newId("bargain");
    const grantResult = applyGrant(ctx, c, counterparty, grants, bargainId);
    const priceResult = applyPrice(ctx, c, counterparty, price, bargainId);

    // Audit on the ledger (commit log).
    const led = ensureLedger(ctx.store, c.id, counterparty);
    const entry: StandingBargainEntry = {
      id: bargainId,
      counterparty,
      grants: grantsDesc || JSON.stringify(grants),
      price: priceDesc || JSON.stringify(price),
      priceBreakdown: {
        favor: price.favor,
        reputation: price.reputation,
        ryo: price.ryo,
        debt: priceResult.debtId,
      },
      at: Date.now(),
      pricePosted: true,
    };
    led.bargains.push(entry);
    ctx.store.collection<StandingLedger>("standings").put(led);

    ctx.ir.emit("bargain", {
      actor: c.id,
      data: {
        disposition: "commit",
        bargainId,
        counterparty,
        grants,
        price,
        debtId: priceResult.debtId,
      },
      narration: `${c.name} strikes a bargain with ${counterparty}: ${grantsDesc || "grants"} for ${priceDesc || "a price"}.`,
    });

    if (grantResult.foreignGrant) {
      ctx.ir.emit("foreign_resource_grant", {
        actor: c.id,
        data: {
          disposition: "commit",
          bargainId,
          counterparty,
          resource: grantResult.foreignGrant.resource,
          amount: grantResult.foreignGrant.amount,
        },
        narration: `${c.name} receives ${grantResult.foreignGrant.amount} ${grantResult.foreignGrant.resource} — a foreign resource from ${counterparty}. The foreign ruleset's teaching takes over from here.`,
      });
    }
  });

  // ---- call_favor -----------------------------------------------------
  engine.registerHandler("call_favor", (ctx) => {
    const c = loadChar(ctx, ctx.op.actorId);
    const counterparty = String(ctx.op.params.counterparty ?? ctx.op.params.authorityId ?? "");
    if (!counterparty) {
      throw reject("counterparty_required", "call_favor requires params.counterparty.", {}, ["Name who is collecting."]);
    }
    const debtId = ctx.op.params.debtId ? String(ctx.op.params.debtId) : undefined;
    const calledBy = String(ctx.op.params.calledBy ?? "npc"); // "npc" | "world_tick" | id
    const ledger = getLedger(ctx.store, c.id, counterparty);

    if (debtId) {
      // Collect a specific debt.
      if (!ledger) {
        throw reject("no_ledger", `No ledger exists for ${c.name} vs ${counterparty}.`, { counterparty, charId: c.id, disposition: "reject_inert", bargainOp: "call_favor" });
      }
      const debt = ledger.debts.find((d) => d.id === debtId);
      if (!debt) {
        throw reject("debt_not_found", `No debt "${debtId}" on the ${counterparty} ledger.`, { debtId, disposition: "reject_inert", bargainOp: "call_favor" });
      }
      if (debt.discharged) {
        throw reject("debt_already_discharged", `Debt "${debtId}" has already been discharged.`, { debtId, disposition: "reject_inert", bargainOp: "call_favor" });
      }
      debt.discharged = true;
      debt.dischargedReason = calledBy === "world_tick" ? "called_by_tick" : "called";
      ctx.store.collection<StandingLedger>("standings").put(ledger);
      ctx.ir.emit("bargain", {
        actor: c.id,
        data: {
          disposition: "commit",
          op: "call_favor",
          counterparty,
          debtId,
          terms: debt.terms,
          calledBy,
        },
        narration: `${counterparty} calls in ${c.name}'s debt: "${debt.terms}" (called by ${calledBy}).`,
      });
      return;
    }

    // No debtId — spend favor on behalf of the counterparty (a generic favor-call).
    const amount = Number(ctx.op.params.amount ?? 1);
    if (!ledger || ledger.favor < amount) {
      throw reject("insufficient_favor", `${counterparty} would call ${amount} favor — ${c.name} has ${ledger?.favor ?? 0}.`, {
        required: amount,
        available: ledger?.favor ?? 0,
        disposition: "reject_inert",
        bargainOp: "call_favor",
      });
    }
    ledger.favor -= amount;
    ctx.store.collection<StandingLedger>("standings").put(ledger);
    ctx.ir.emit("bargain", {
      actor: c.id,
      data: { disposition: "commit", op: "call_favor", counterparty, amount, favorLeft: ledger.favor, calledBy },
      narration: `${counterparty} calls in ${amount} favor from ${c.name} (called by ${calledBy}).`,
    });
  });

  // ---- incur_debt -----------------------------------------------------
  engine.registerHandler("incur_debt", (ctx) => {
    const c = loadChar(ctx, ctx.op.actorId);
    const counterparty = String(ctx.op.params.counterparty ?? ctx.op.params.authorityId ?? "");
    const terms = String(ctx.op.params.terms ?? "");
    if (!counterparty || !terms) {
      throw reject("debt_params_required", "incur_debt requires counterparty AND terms.", { counterparty, terms }, ["Pass params.counterparty and params.terms."]);
    }
    const ledger = ensureLedger(ctx.store, c.id, counterparty);
    const debtId = newId("debt");
    const debt: StandingDebt = {
      id: debtId,
      to: counterparty,
      terms,
      incurredAt: Date.now(),
      discharged: false,
    };
    ledger.debts.push(debt);
    ctx.store.collection<StandingLedger>("standings").put(ledger);
    ctx.ir.emit("bargain", {
      actor: c.id,
      data: { disposition: "commit", op: "incur_debt", counterparty, debtId, terms },
      narration: `${c.name} incurs a debt to ${counterparty}: ${terms}.`,
    });
  });

  // ---- discharge_debt (the narrator-side off-switch) ------------------
  // Used by the world-tick and by NPC handlers to mark a debt forgiven /
  // expired without a "call_favor" semantic. Distinct event kind so the IR
  // stream tells the difference between collection and forgiveness.
  engine.registerHandler("discharge_debt", (ctx) => {
    const c = loadChar(ctx, ctx.op.actorId);
    const counterparty = String(ctx.op.params.counterparty ?? "");
    const debtId = String(ctx.op.params.debtId ?? "");
    const reason = String(ctx.op.params.reason ?? "forgiven");
    if (!counterparty || !debtId) {
      throw reject("discharge_params_required", "discharge_debt requires counterparty AND debtId.", { counterparty, debtId });
    }
    const ledger = getLedger(ctx.store, c.id, counterparty);
    const debt = ledger?.debts.find((d) => d.id === debtId);
    if (!ledger || !debt) {
      throw reject("debt_not_found", `No debt "${debtId}" on ${counterparty} ledger.`, { counterparty, debtId });
    }
    if (debt.discharged) {
      ctx.ir.emit("bargain", {
        actor: c.id,
        data: { disposition: "no_op_spoken", op: "discharge_debt", counterparty, debtId, reason: "already_discharged" },
        narration: `Debt ${debtId} was already discharged.`,
      });
      return;
    }
    debt.discharged = true;
    debt.dischargedReason = reason;
    ctx.store.collection<StandingLedger>("standings").put(ledger);
    ctx.ir.emit("bargain", {
      actor: c.id,
      data: { disposition: "commit", op: "discharge_debt", counterparty, debtId, reason },
      narration: `Debt to ${counterparty} discharged (${reason}).`,
    });
  });
}
