// Who has the blue tick, as last read from the server's registry; kept free of imports so builders can read it

let verifiedIds = new Set<string>();
const badgeEmojis = new Map<string, string>();

export function isVerifiedId(id: string) {
  return verifiedIds.has(id);
}

export function getVerifiedIds() {
  return verifiedIds;
}

export function setVerifiedIds(ids: Set<string>) {
  verifiedIds = ids;
}

// Approved people may show an emoji of their choice instead of the tick
export function getBadgeEmoji(userId: string) {
  return verifiedIds.has(userId) ? badgeEmojis.get(userId) : undefined;
}

export function setBadgeEmoji(userId: string, emoji: string | undefined) {
  if (emoji) badgeEmojis.set(userId, emoji);
  else badgeEmojis.delete(userId);
}
