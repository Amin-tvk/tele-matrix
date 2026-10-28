import type { ApiFormattedText, ApiMessageEntity } from '../types';
import { ApiMessageEntityTypes } from '../types';

import { buildMessageForEvent, getClient, hasClient, onUpdate } from './client';
import { getPeerIdByUserId } from './ids';

// "@name" (someone on this server) or "@name:server" typed in a message becomes a link to that person, as
// Telegram's server does for usernames, but only once the account is known to exist. Unknown IDs are looked up
// once; the messages that mention them are rebuilt when the answer is yes

const MENTION_REGEX = /(^|[^\w@./:])@([a-z0-9._=\-/+]+(?::[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?)?)/gi;
// Formatting can wrap a mention; anything else (links, code) already decides what the text is
const WRAPPING_ENTITIES = new Set<string>([
  ApiMessageEntityTypes.Bold, ApiMessageEntityTypes.Italic, ApiMessageEntityTypes.Underline,
  ApiMessageEntityTypes.Strike, ApiMessageEntityTypes.Spoiler,
]);
const LOOKUP_TIMEOUT_MS = 8000;

const existsByUserId = new Map<string, boolean>();
const waitingEvents = new Map<string, Set<string>>();

function toUserId(name: string) {
  return `@${name.includes(':') ? name : `${name}:${getClient().getDomain()}`}`.toLowerCase();
}

async function lookUp(userId: string) {
  let exists: boolean;
  try {
    await Promise.race([
      getClient().getProfileInfo(userId),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out')), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    exists = true;
  } catch (err) {
    const { errcode, httpStatus } = err as { errcode?: string; httpStatus?: number };
    // Other servers may hide profiles from strangers; that answer still means the account is there
    exists = errcode === 'M_FORBIDDEN' || httpStatus === 403;
  }
  existsByUserId.set(userId, exists);

  const events = waitingEvents.get(userId);
  waitingEvents.delete(userId);
  if (!exists || !events || !hasClient()) return;
  events.forEach((key) => {
    const [roomId, eventId] = key.split('|');
    const room = getClient().getRoom(roomId);
    const event = room?.findEventById(eventId);
    const message = room && event ? buildMessageForEvent(room, event) : undefined;
    if (message) onUpdate({ '@type': 'updateMessage', chatId: message.chatId, id: message.id, message });
  });
}

function doesUserExist(userId: string, roomId: string, eventId: string) {
  const known = existsByUserId.get(userId);
  if (known !== undefined) return known;
  // Anyone this device has seen in a room exists
  if (getClient().getUser(userId)) {
    existsByUserId.set(userId, true);
    return true;
  }
  const waiting = waitingEvents.get(userId);
  if (waiting) {
    waiting.add(`${roomId}|${eventId}`);
  } else {
    waitingEvents.set(userId, new Set([`${roomId}|${eventId}`]));
    void lookUp(userId);
  }
  return false;
}

export function addMentionEntities(text: ApiFormattedText, roomId: string, eventId: string): ApiFormattedText {
  if (!hasClient() || !text.text.includes('@')) return text;
  const entities = text.entities || [];
  const added: ApiMessageEntity[] = [];
  for (const match of text.text.matchAll(MENTION_REGEX)) {
    const offset = match.index + match[1].length;
    const length = match[2].length + 1;
    const isCovered = entities.some((entity) => entity.offset < offset + length
      && offset < entity.offset + entity.length && !WRAPPING_ENTITIES.has(entity.type));
    if (isCovered) continue;
    const userId = toUserId(match[2]);
    if (!doesUserExist(userId, roomId, eventId)) continue;
    added.push({
      type: ApiMessageEntityTypes.MentionName, offset, length, userId: getPeerIdByUserId(userId),
    });
  }
  if (!added.length) return text;
  return { ...text, entities: [...entities, ...added].sort((a, b) => a.offset - b.offset) };
}
