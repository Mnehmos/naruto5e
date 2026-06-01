import { reject, type Rng } from "@naruto5e/shared";
import type { Engine } from "../engine.js";
import type { ResolveContext } from "./registry.js";
import {
  applyMask,
  applyReveal,
  getApparent,
  isHidden,
  lookupEntity,
  markHidden,
  persistEntity,
  pushEvidence,
  setApparent,
} from "../rules/legibility.js";

/**
 * Generic hidden-state verbs (Phase C). Four intents form the contract:
 *
 *  - mark_legibility — promote a plain field to a HiddenField (idempotent).
 *  - read_field      — APPARENT-only read; emits `legibility_read` with
 *                      disposition `unknown` if apparent is null, else `commit`.
 *                      Optionally rolls a perception check against `concealment`;
 *                      a failed check returns disposition `unknown` even when
 *                      apparent is committed (the observer doesn't see it).
 *  - reveal_field    — copy actual → apparent (one-way truth-cement); emits
 *                      `legibility_reveal` with disposition `commit`.
 *  - mask_field      — set apparent to null and bump concealment; emits
 *                      `legibility_mask` with disposition `commit`.
 *
 * Invariants (the seam contract):
 *  - `read_field` MUST emit exactly one terminal IR event whose disposition
 *    is in {commit, unknown}. Never silently degrades from unknown to a
 *    legible value.
 *  - No intent ever surfaces the `actual` value to the caller. Reveal is the
 *    only path that copies actual → apparent; the caller still reads
 *    apparent in subsequent intents.
 *  - All four emit a `disposition` field on the IR event data payload.
 */

function requireParams(p: Record<string, unknown>): { entityKind: string; entityId: string; field: string } {
  const entityKind = String(p.entityKind ?? "");
  const entityId = String(p.entityId ?? "");
  const field = String(p.field ?? "");
  if (!entityKind || !entityId || !field) {
    throw reject(
      "legibility_params_required",
      "Hidden-state verbs require entityKind, entityId, and field.",
      { entityKind, entityId, field },
      ["Pass params { entityKind, entityId, field }; field uses dotted path notation (e.g. \"stain\" or \"memo.disposition\")."],
    );
  }
  return { entityKind, entityId, field };
}

function loadEntity(ctx: ResolveContext, p: { entityKind: string; entityId: string; field: string }) {
  const ent = lookupEntity(ctx.store, p.entityKind, p.entityId);
  if (!ent) {
    throw reject(
      "entity_not_found",
      `No ${p.entityKind} with id "${p.entityId}" — cannot read/reveal/mask its "${p.field}" field.`,
      { entityKind: p.entityKind, entityId: p.entityId },
      [`Create the ${p.entityKind} first, or check the id.`],
    );
  }
  return ent;
}

/**
 * Roll a Perception check against concealment. Returns { ok, roll, total }.
 * Pure helper: caller decides what to do with a failure (most use `unknown`
 * disposition). If no actorId / no rng available, defaults to ok=true (a
 * narrator-declared read where the engine isn't told to gate it).
 */
function perceptionCheck(rng: Rng, observerMod: number, concealment: number): { ok: boolean; roll: number; total: number } {
  const roll = rng.int(1, 20);
  const total = roll + observerMod;
  return { ok: total >= concealment, roll, total };
}

/** Extract the observer's perception modifier from a character/npc/adversary. */
function observerPerceptionMod(observer: any | undefined): number {
  if (!observer) return 0;
  // characters carry abilityTotals + proficiencies; perception is wis-based + prof.
  const wis = observer.abilityTotals?.wis ?? observer.abilities?.wis;
  const wisMod = typeof wis === "number" ? Math.floor((wis - 10) / 2) : 0;
  const prof = observer.proficiencies?.skills?.includes?.("Perception") ? observer.proficiencyBonus ?? 0 : 0;
  return wisMod + prof;
}

export function registerLegibilityIntents(engine: Engine): void {
  // ---- mark_legibility ------------------------------------------------
  engine.registerHandler("mark_legibility", (ctx) => {
    const p = requireParams(ctx.op.params);
    const ent = loadEntity(ctx, p);
    const wasHidden = isHidden(ent, p.field);
    const concealment = ctx.op.params.concealment != null ? Number(ctx.op.params.concealment) : undefined;
    const apparent = "apparent" in ctx.op.params ? ctx.op.params.apparent : undefined;
    const wrapper = markHidden(ent, p.field, { concealment, apparent });
    pushEvidence(wrapper, { kind: "mark", observerId: ctx.op.actorId, disposition: "commit", note: wasHidden ? "already_hidden" : "marked" });
    persistEntity(ctx.store, p.entityKind, ent);
    ctx.ir.emit("legibility_mark", {
      actor: ctx.op.actorId,
      data: {
        disposition: "commit",
        entityKind: p.entityKind,
        entityId: p.entityId,
        field: p.field,
        concealment: wrapper.concealment,
        alreadyHidden: wasHidden,
      },
      narration: `${p.entityKind}/${p.entityId}.${p.field} is now hidden (concealment ${wrapper.concealment}).`,
    });
  });

  // ---- read_field -----------------------------------------------------
  engine.registerHandler("read_field", (ctx) => {
    const p = requireParams(ctx.op.params);
    const ent = loadEntity(ctx, p);
    const { value, knownState } = getApparent(ent, p.field);

    // Plain (un-wrapped) field: pass-through with disposition=commit. The
    // legibility primitive treats non-wrapped fields as fully legible so
    // existing content doesn't have to migrate.
    if (knownState === "plain") {
      ctx.ir.emit("legibility_read", {
        actor: ctx.op.actorId,
        data: {
          disposition: "commit",
          entityKind: p.entityKind,
          entityId: p.entityId,
          field: p.field,
          value,
          knownState: "plain",
        },
        narration: `${p.entityKind}/${p.entityId}.${p.field}: ${String(value)}.`,
      });
      return;
    }

    // Hidden field: optionally roll a perception check; on failure or null
    // apparent, return UNKNOWN as a first-class disposition.
    const observer = ctx.op.params.observerId
      ? lookupEntity(ctx.store, String(ctx.op.params.observerKind ?? "characters"), String(ctx.op.params.observerId))
      : undefined;
    const skipCheck = ctx.op.params.skipCheck === true || !observer;
    const wrapperRaw = (ent as any);
    // Walk to wrapper for evidence appending + concealment value.
    const parts = p.field.split(".");
    let owner: any = wrapperRaw;
    for (let i = 0; i < parts.length - 1; i++) owner = owner?.[parts[i]];
    const wrapper = owner?.[parts[parts.length - 1]];

    let checkInfo: { roll: number; total: number; vs: number } | undefined;
    if (!skipCheck) {
      const mod = observerPerceptionMod(observer);
      const concealment = wrapper.concealment ?? 10;
      const r = perceptionCheck(ctx.rng, mod, concealment);
      checkInfo = { roll: r.roll, total: r.total, vs: concealment };
      if (!r.ok) {
        pushEvidence(wrapper, { kind: "read", observerId: ctx.op.actorId, disposition: "unknown", note: `perception ${r.total} vs ${concealment}` });
        persistEntity(ctx.store, p.entityKind, ent);
        ctx.ir.emit("legibility_read", {
          actor: ctx.op.actorId,
          data: {
            disposition: "unknown",
            entityKind: p.entityKind,
            entityId: p.entityId,
            field: p.field,
            value: null,
            knownState: "unknown",
            reason: "perception_failed",
            check: checkInfo,
          },
          narration: `${ctx.op.actorId ?? "An observer"} tries to read ${p.field} but cannot make it out (perception ${r.total} vs ${concealment}).`,
        });
        return;
      }
    }

    if (knownState === "unknown") {
      // Apparent is null even though the check succeeded — the world doesn't
      // know yet (e.g. no one has revealed this fact). First-class UNKNOWN.
      pushEvidence(wrapper, { kind: "read", observerId: ctx.op.actorId, disposition: "unknown", note: "apparent_null" });
      persistEntity(ctx.store, p.entityKind, ent);
      ctx.ir.emit("legibility_read", {
        actor: ctx.op.actorId,
        data: {
          disposition: "unknown",
          entityKind: p.entityKind,
          entityId: p.entityId,
          field: p.field,
          value: null,
          knownState: "unknown",
          reason: "apparent_null",
          check: checkInfo,
        },
        narration: `${p.field} is unknown — nothing about it has surfaced yet.`,
      });
      return;
    }

    // knownState === "known": commit the apparent value (and stamp lastReadAs).
    setApparent(ent, p.field, value);
    pushEvidence(wrapper, { kind: "read", observerId: ctx.op.actorId, apparent: value, disposition: "commit" });
    persistEntity(ctx.store, p.entityKind, ent);
    ctx.ir.emit("legibility_read", {
      actor: ctx.op.actorId,
      data: {
        disposition: "commit",
        entityKind: p.entityKind,
        entityId: p.entityId,
        field: p.field,
        value,
        knownState: "known",
        check: checkInfo,
      },
      narration: `${p.field} reads as: ${JSON.stringify(value)}.`,
    });
  });

  // ---- reveal_field ---------------------------------------------------
  engine.registerHandler("reveal_field", (ctx) => {
    const p = requireParams(ctx.op.params);
    const ent = loadEntity(ctx, p);
    const partial = Array.isArray(ctx.op.params.partial) ? (ctx.op.params.partial as string[]) : undefined;
    const wrapper = applyReveal(ent, p.field, partial);
    pushEvidence(wrapper, {
      kind: "reveal",
      observerId: ctx.op.actorId,
      apparent: wrapper.apparent,
      disposition: "commit",
      note: partial ? `partial:${partial.join(",")}` : "full",
    });
    persistEntity(ctx.store, p.entityKind, ent);
    ctx.ir.emit("legibility_reveal", {
      actor: ctx.op.actorId,
      data: {
        disposition: "commit",
        entityKind: p.entityKind,
        entityId: p.entityId,
        field: p.field,
        apparent: wrapper.apparent,
        partial: partial ?? null,
      },
      narration: `${p.field} is revealed.`,
    });
  });

  // ---- mask_field -----------------------------------------------------
  engine.registerHandler("mask_field", (ctx) => {
    const p = requireParams(ctx.op.params);
    const ent = loadEntity(ctx, p);
    const bump = ctx.op.params.bumpConcealment != null ? Number(ctx.op.params.bumpConcealment) : 5;
    const wrapper = applyMask(ent, p.field, bump);
    pushEvidence(wrapper, { kind: "mask", observerId: ctx.op.actorId, disposition: "commit", note: `bump+${bump}` });
    persistEntity(ctx.store, p.entityKind, ent);
    ctx.ir.emit("legibility_mask", {
      actor: ctx.op.actorId,
      data: {
        disposition: "commit",
        entityKind: p.entityKind,
        entityId: p.entityId,
        field: p.field,
        concealment: wrapper.concealment,
      },
      narration: `${p.field} is masked (concealment ${wrapper.concealment}).`,
    });
  });
}
