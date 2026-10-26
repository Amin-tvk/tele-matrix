// Pure mapping of Matrix identifiers to the numeric peer IDs used by the UI.
// Shared by the API worker and the service worker

const ID_BASE = 10_000_000_000n;
const ID_RANGE = 2n ** 46n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 2n ** 64n - 1n;

function hashToNumber(value: string) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  return (ID_BASE + (hash % ID_RANGE)).toString();
}

export function buildUserPeerId(userId: string) {
  return hashToNumber(`user:${userId}`);
}

export function buildRoomChatId(roomId: string) {
  return `-${hashToNumber(`room:${roomId}`)}`;
}
