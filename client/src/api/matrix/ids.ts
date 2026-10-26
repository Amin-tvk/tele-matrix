import { buildRoomChatId, buildUserPeerId } from './peerIds';
import { getValue, setValue } from './store';

// Telegram UI identifies users by positive numeric strings, other chats by negative ones
// and messages by numbers ordered within a chat. Matrix identifiers are mapped onto these:
// users and rooms through a stable hash, events through their timestamp in milliseconds

export function getPeerIdByUserId(userId: string) {
  const peerId = buildUserPeerId(userId);
  setValue(`u:${peerId}`, userId);
  return peerId;
}

export function getUserIdByPeerId(peerId: string) {
  return getValue(`u:${peerId}`);
}

export function getChatIdByRoomId(roomId: string) {
  const chatId = buildRoomChatId(roomId);
  setValue(`r:${chatId}`, roomId);
  return chatId;
}

export function getRoomIdByGroupChatId(chatId: string) {
  return getValue(`r:${chatId}`);
}

export function isUserPeerId(peerId: string) {
  return !peerId.startsWith('-');
}

export function getMessageId(roomId: string, eventId: string, timestamp: number) {
  const known = getValue(`e:${eventId}`);
  if (known) return Number(known);

  let candidate = Math.floor(timestamp) || Date.now();
  while (getValue(`m:${roomId}:${candidate}`)) {
    candidate++;
  }

  setValue(`e:${eventId}`, String(candidate));
  setValue(`m:${roomId}:${candidate}`, eventId);
  return candidate;
}

export function findMessageId(eventId: string) {
  const known = getValue(`e:${eventId}`);
  return known ? Number(known) : undefined;
}

export function getEventId(roomId: string, messageId: number) {
  return getValue(`m:${roomId}:${messageId}`);
}

// Encodes `mxc://server/mediaId` into an identifier usable in Telegram media hashes
export function encodeMxc(mxc: string) {
  return mxc.replace(/^mxc:\/\//, '');
}

export function decodeMxc(id: string) {
  return `mxc://${id}`;
}

let localCounter = 0;
const LOCAL_ID_STEPS = 998;
const LOCAL_ID_DIVIDER = 1000;

// Local (pending) message IDs must stay fractional; timestamps leave about three decimal digits of precision
export function getNextLocalMessageId(lastMessageId = Date.now()) {
  localCounter = (localCounter % LOCAL_ID_STEPS) + 1;
  return Math.floor(lastMessageId) + localCounter / LOCAL_ID_DIVIDER;
}
