/**
 * Educational failures (Architecture §11): "No bare rejections anywhere in the
 * engine. Every 'no' carries what/why/where/how-to-fix." A handler that needs
 * to reject throws an `EngineError` carrying the named rule, the explanation
 * (with actual numbers), structured values, and concrete fix suggestions. The
 * intent pipeline catches it and shapes the four-part rejection return.
 */
import type { RejectionReason } from "./intent.js";

export interface EngineErrorInit {
  values?: Record<string, unknown>;
  suggestions?: string[];
}

export class EngineError extends Error {
  readonly rule: string;
  readonly explain: string;
  readonly values?: Record<string, unknown>;
  readonly suggestions: string[];

  constructor(rule: string, explain: string, init: EngineErrorInit = {}) {
    super(`[${rule}] ${explain}`);
    this.name = "EngineError";
    this.rule = rule;
    this.explain = explain;
    this.values = init.values;
    this.suggestions = init.suggestions ?? [];
  }

  get reason(): RejectionReason {
    return { rule: this.rule, explain: this.explain, values: this.values };
  }
}

/** Convenience constructor: `throw reject("chakra_affordability", "...", {...})`. */
export function reject(
  rule: string,
  explain: string,
  values?: Record<string, unknown>,
  suggestions?: string[],
): EngineError {
  return new EngineError(rule, explain, { values, suggestions });
}

/** A validation failure surfaced as an educational rule rather than a stack trace. */
export function notFound(entity: string, id: string): EngineError {
  return new EngineError(
    "entity_not_found",
    `No ${entity} exists with id "${id}".`,
    { values: { entity, id }, suggestions: [`Create the ${entity} first, or check the id.`] },
  );
}
