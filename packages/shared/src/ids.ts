import { randomUUID } from "node:crypto";

/** Generate a fresh id. Prefixed for readability in logs/IR. */
export function newId(prefix = "id"): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export { randomUUID };
