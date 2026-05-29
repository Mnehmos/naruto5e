import type { Store } from "../store/types.js";
import type { Encounter } from "../domain/encounter.js";
import type { Room } from "../domain/room.js";

/** The active combatant in a room (the turn authority), or undefined out of combat. */
export function activeCombatantId(store: Store, roomId: string): string | undefined {
  const room = store.collection<Room>("rooms").get(roomId);
  if (!room?.encounterId) return undefined;
  const enc = store.collection<Encounter>("encounters").get(room.encounterId);
  if (!enc || enc.status !== "active") return undefined;
  return enc.order[enc.activeIndex];
}

export function activeEncounter(store: Store, roomId: string): Encounter | undefined {
  const room = store.collection<Room>("rooms").get(roomId);
  if (!room?.encounterId) return undefined;
  const enc = store.collection<Encounter>("encounters").get(room.encounterId);
  return enc && enc.status === "active" ? enc : undefined;
}
