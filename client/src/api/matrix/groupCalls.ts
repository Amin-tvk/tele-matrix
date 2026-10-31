import type { Room } from 'matrix-js-sdk';
import { MatrixEvent, Method } from 'matrix-js-sdk';

import {
  buildUser, getChatIdForRoom, getClient, getMyUserId, hasClient, onUpdate, sendMessageUpdate,
} from './client';
import { GROUP_CALL_MEMBER_EVENT, GROUP_CALL_SIGNAL_EVENT } from './constants';
import { getPeerIdByUserId, getRoomIdByGroupChatId, getUserIdByPeerId } from './ids';

// Voice chats in groups, without a media server: every participant connects to every other one directly (WebRTC
// mesh, fine up to about six people), set up on the main thread. Who is in a call is announced with small room
// events (joined, still here, left), sent unencrypted so they neither ring nor count as unread; the connection
// set-up between two devices goes as to-device messages. The first join of a call stays in the chat as its entry

// Participants say they are still there every minute; one silent this long has dropped out
export const GROUP_CALL_MEMBER_TIMEOUT_MS = 150 * 1000;
const PRUNE_INTERVAL_MS = 20 * 1000;
// How far back a chat's history is read for a call in progress
const SCAN_EVENTS_LIMIT = 300;

type MemberAction = 'join' | 'ping' | 'leave';

type Member = {
  userId: string;
  deviceId: string;
  callId: string;
  lastSeen: number;
};

type CallInfo = {
  callId: string;
  startEventId?: string;
  members: Map<string, Member>;
};

const callsByRoomId = new Map<string, CallInfo>();
let pruneInterval: ReturnType<typeof setInterval> | undefined;

function memberKey(userId: string, deviceId: string) {
  return `${userId}|${deviceId}`;
}

function getRoomForChat(chatId: string) {
  const roomId = getRoomIdByGroupChatId(chatId);
  return roomId ? getClient().getRoom(roomId) || undefined : undefined;
}

function announce(room: Room) {
  const info = callsByRoomId.get(room.roomId);
  const members = info ? [...info.members.values()] : [];
  // The call screen shows everyone by name, including people this device hasn't seen yet
  new Set(members.map(({ userId }) => userId)).forEach((userId) => {
    const user = buildUser(userId, room);
    onUpdate({ '@type': 'updateUser', id: user.id, user });
  });
  onUpdate({
    '@type': 'updateMatrixGroupCall',
    chatId: getChatIdForRoom(room),
    callId: members.length ? info!.callId : undefined,
    participants: members.map(({ userId, deviceId }) => ({
      peerId: getPeerIdByUserId(userId), userId, deviceId,
    })),
  });
}

// The call's entry in the chat shows its length once everyone has left
function refreshStartEntry(room: Room, info: CallInfo) {
  const start = info.startEventId ? room.findEventById(info.startEventId) : undefined;
  if (start) sendMessageUpdate(room, start);
}

function applyMemberEvent(room: Room, event: MatrixEvent, now: number) {
  const content = event.getContent();
  const sender = event.getSender();
  const { call_id: callId, device_id: deviceId, action } = content as {
    call_id?: string; device_id?: string; action?: MemberAction;
  };
  if (!sender || !callId || !deviceId || !action) return false;
  const ts = event.getTs();
  if (action !== 'leave' && now - ts > GROUP_CALL_MEMBER_TIMEOUT_MS) return false;

  let info = callsByRoomId.get(room.roomId);
  if (!info || (info.callId !== callId && (action !== 'leave'))) {
    // A newer call replaces one nobody is in anymore
    if (info && info.members.size && info.callId !== callId) return false;
    info = { callId, members: new Map() };
    callsByRoomId.set(room.roomId, info);
  }
  if (info.callId !== callId) return false;
  if (content.started) info.startEventId = event.getId();

  const key = memberKey(sender, deviceId);
  if (action === 'leave') {
    info.members.delete(key);
  } else {
    info.members.set(key, {
      userId: sender, deviceId, callId, lastSeen: ts,
    });
  }
  return true;
}

export function handleGroupCallMemberEvent(event: MatrixEvent, room: Room) {
  if (!applyMemberEvent(room, event, Date.now())) return;
  const info = callsByRoomId.get(room.roomId);
  announce(room);
  if (info && !info.members.size) refreshStartEntry(room, info);
  startPruning();
}

// Rebuilds who is in a call from the chat's recent history, e.g. after the app starts
function scanRoom(room: Room) {
  const events = room.getLiveTimeline().getEvents().slice(-SCAN_EVENTS_LIMIT)
    .filter((event) => event.getType() === GROUP_CALL_MEMBER_EVENT);
  const now = Date.now();
  callsByRoomId.delete(room.roomId);
  events.forEach((event) => applyMemberEvent(room, event, now));
  pruneRoom(room, now);
}

function pruneRoom(room: Room, now: number) {
  const info = callsByRoomId.get(room.roomId);
  if (!info) return false;
  let changed = false;
  info.members.forEach((member, key) => {
    if (now - member.lastSeen > GROUP_CALL_MEMBER_TIMEOUT_MS) {
      info.members.delete(key);
      changed = true;
    }
  });
  return changed;
}

function startPruning() {
  if (pruneInterval) return;
  pruneInterval = setInterval(() => {
    if (!hasClient()) return;
    const now = Date.now();
    callsByRoomId.forEach((info, roomId) => {
      const room = getClient().getRoom(roomId);
      if (!room || !pruneRoom(room, now)) return;
      announce(room);
      if (!info.members.size) refreshStartEntry(room, info);
    });
  }, PRUNE_INTERVAL_MS);
}

export function stopGroupCalls() {
  clearInterval(pruneInterval);
  pruneInterval = undefined;
  callsByRoomId.clear();
}

// For the call's entry in the chat: its length once it is over
export function getGroupCallDuration(room: Room, callId: string, startTs: number) {
  const info = callsByRoomId.get(room.roomId);
  if (info?.callId === callId && info.members.size) return undefined;
  let lastTs = startTs;
  room.getLiveTimeline().getEvents().forEach((event) => {
    if (event.getType() === GROUP_CALL_MEMBER_EVENT && event.getContent().call_id === callId) {
      lastTs = Math.max(lastTs, event.getTs());
    }
  });
  return Math.max(1, Math.round((lastTs - startTs) / 1000));
}

/* Methods for the main thread */

type RawEvent = ConstructorParameters<typeof MatrixEvent>[0];

// The server's latest call events for the room: the local history may not have them after a cold start or a gap
async function fetchRecentMemberEvents(room: Room) {
  const filter = JSON.stringify({ types: [GROUP_CALL_MEMBER_EVENT] });
  const { chunk } = await getClient().http.authedRequest<{ chunk: RawEvent[] }>(
    Method.Get, `/rooms/${encodeURIComponent(room.roomId)}/messages`,
    { dir: 'b', limit: String(SCAN_EVENTS_LIMIT), filter },
  );
  return chunk.map((raw) => new MatrixEvent(raw)).reverse();
}

export async function fetchMatrixGroupCall({ chatId }: { chatId: string }) {
  const room = getRoomForChat(chatId);
  if (!room) return undefined;
  try {
    const events = await fetchRecentMemberEvents(room);
    const now = Date.now();
    const previous = callsByRoomId.get(room.roomId);
    callsByRoomId.delete(room.roomId);
    events.forEach((event) => applyMemberEvent(room, event, now));
    pruneRoom(room, now);
    // Keep where the call's entry is, if the server's page didn't reach back to it
    const info = callsByRoomId.get(room.roomId);
    if (info && !info.startEventId && previous?.callId === info.callId) info.startEventId = previous.startEventId;
  } catch {
    scanRoom(room);
  }
  announce(room);
  startPruning();
  const info = callsByRoomId.get(room.roomId);
  return {
    callId: info?.members.size ? info.callId : undefined,
    participantsCount: info?.members.size || 0,
    myUserId: getMyUserId(),
    myDeviceId: getClient().getDeviceId() || '',
  };
}

export async function sendMatrixGroupCallMember({
  chatId, callId, action, isStart,
}: { chatId: string; callId: string; action: MemberAction; isStart?: boolean }) {
  const room = getRoomForChat(chatId);
  if (!room) return false;
  const content = {
    call_id: callId, device_id: getClient().getDeviceId(), action, ...(isStart && { started: true }),
  };
  // Sent as is even in encrypted chats: it carries no secrets and must not count as a message
  const txnId = `gc${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  await getClient().http.authedRequest(
    Method.Put,
    `/rooms/${encodeURIComponent(room.roomId)}/send/${encodeURIComponent(GROUP_CALL_MEMBER_EVENT)}/${txnId}`,
    undefined,
    content,
  );
  return true;
}

export async function sendMatrixGroupCallSignal({ userId, deviceId, content }: {
  userId: string; deviceId: string; content: Record<string, unknown>;
}) {
  const matrixUserId = userId.startsWith('@') ? userId : getUserIdByPeerId(userId);
  if (!matrixUserId) return false;
  const contentMap = new Map([[matrixUserId, new Map([[deviceId, {
    ...content, from_device_id: getClient().getDeviceId(),
  }]])]]);
  await getClient().sendToDevice(GROUP_CALL_SIGNAL_EVENT, contentMap);
  return true;
}

export function handleGroupCallSignal(event: MatrixEvent) {
  const sender = event.getSender();
  const content = event.getContent();
  if (!sender || (sender === getMyUserId() && content.from_device_id === getClient().getDeviceId())) return;
  onUpdate({
    '@type': 'updateMatrixGroupCallSignal',
    fromUserId: sender,
    fromDeviceId: String(content.from_device_id || ''),
    content,
  });
}
