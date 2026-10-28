import type { MatrixEvent, Room } from 'matrix-js-sdk';

// Auto-delete ("delete messages after…") is the Matrix room retention policy: an `m.room.retention` state event
// whose `max_lifetime` says how long messages live. The server purges older messages and stops serving them; the
// app hides them the moment they expire

export const RETENTION_EVENT = 'm.room.retention';

// Seconds messages live in the room, or 0 when they are kept
export function getRoomTtlSeconds(room: Room) {
  const lifetime = room.currentState.getStateEvents(RETENTION_EVENT, '')?.getContent().max_lifetime;
  return typeof lifetime === 'number' && lifetime > 0 ? Math.round(lifetime / 1000) : 0;
}

export function isExpiredEvent(event: MatrixEvent, room: Room, now = Date.now()) {
  if (event.isState()) return false;
  const ttl = getRoomTtlSeconds(room);
  return ttl > 0 && event.getTs() < now - ttl * 1000;
}
