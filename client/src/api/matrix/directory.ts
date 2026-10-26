import {
  EventType, JoinRule, Method, Visibility,
} from 'matrix-js-sdk';

import type { ApiChat } from '../types';

import { getServerName } from './builders';
import {
  buildChat, buildReadState, getClient, getRoomByChatId, markChatAnnounced, onUpdate,
} from './client';
import { encodeMxc, getChatIdByRoomId, getRoomIdByGroupChatId } from './ids';
import { waitForRoom } from './methods';

// Groups and channels on any Matrix server can be found by their address (#name:server)
// and joined, like public Telegram groups found by username

type RoomPreview = {
  alias?: string;
  viaServers: string[];
};

const MATRIX_TO_PREFIX = /^https?:\/\/matrix\.to\/#\//;

const previewsByRoomId = new Map<string, RoomPreview>();

// Accepts "#name:server", "!roomid:server" and matrix.to links to either
function parseRoomAddress(query: string) {
  const address = decodeURIComponent(query.trim().replace(MATRIX_TO_PREFIX, '').split('?')[0]);
  if (/^[#!][^:\s]+:[^\s]+$/.test(address)) return address;
  return undefined;
}

type RoomSummary = {
  room_id: string;
  name?: string;
  avatar_url?: string;
  num_joined_members?: number;
  room_type?: string;
  canonical_alias?: string;
};

// Other servers can be slow or unreachable for a while; searches shouldn't hang on them
const REMOTE_TIMEOUT_MS = 6000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs = REMOTE_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timed out')), timeoutMs);
    }),
  ]);
}

// Room summary (MSC3266): name, avatar and member count of a room we haven't joined, from any server
function fetchRoomSummary(address: string, viaServers: string[]) {
  return getClient().http.authedRequest<RoomSummary>(
    Method.Get,
    `/room_summary/${encodeURIComponent(address)}`,
    { via: viaServers },
    undefined,
    { prefix: '/_matrix/client/v1' },
  );
}

export async function findRoomByAddress(query: string): Promise<ApiChat | undefined> {
  const address = parseRoomAddress(query);
  if (!address) return undefined;

  const client = getClient();
  const viaServers = [getServerName(address)];
  const alias = address.startsWith('#') ? address : undefined;

  let summary = await withTimeout(fetchRoomSummary(address, viaServers)).catch(() => undefined);
  if (!summary && alias) {
    const resolved = await withTimeout(client.getRoomIdForAlias(alias)).catch(() => undefined);
    if (resolved) {
      summary = { room_id: resolved.room_id };
      viaServers.push(...resolved.servers.slice(0, 2));
    }
  }
  if (!summary && !alias) summary = { room_id: address };
  if (!summary) return undefined;

  // Spaces aren't chats
  if (summary.room_type) return undefined;

  const roomId = summary.room_id;
  const joinedRoom = client.getRoom(roomId);
  if (joinedRoom?.getMyMembership() === 'join') return buildChat(joinedRoom);

  previewsByRoomId.set(roomId, { alias, viaServers: [...new Set(viaServers)] });
  return buildPreviewChat({ ...summary, canonical_alias: alias || summary.canonical_alias });
}

function buildPreviewChat(summary: RoomSummary): ApiChat {
  const alias = summary.canonical_alias;
  const chatId = getChatIdByRoomId(summary.room_id);
  const chat: ApiChat = {
    id: chatId,
    type: 'chatTypeSuperGroup',
    title: summary.name || alias || summary.room_id,
    avatarPhotoId: summary.avatar_url ? encodeMxc(summary.avatar_url) : undefined,
    membersCount: summary.num_joined_members,
    isNotJoined: true,
    // The join action requires one; Matrix joins by room address instead
    accessHash: '0',
    usernames: alias ? [{ username: alias, isActive: true }] : undefined,
    hasUsername: alias ? true : undefined,
  };
  onUpdate({ '@type': 'updateChat', id: chatId, chat });
  return chat;
}

const PUBLIC_ROOMS_LIMIT = 10;

// Public groups and channels of this server, matched by name, topic or address
export async function searchPublicRooms(query: string) {
  const client = getClient();
  const { chunk } = await withTimeout(client.publicRooms({
    limit: PUBLIC_ROOMS_LIMIT,
    filter: { generic_search_term: query },
  }));
  return chunk
    .filter((room) => !room.room_type && client.getRoom(room.room_id)?.getMyMembership() !== 'join')
    .map((room) => {
      previewsByRoomId.set(room.room_id, { alias: room.canonical_alias, viaServers: [client.getDomain()!] });
      return buildPreviewChat(room);
    });
}

export async function joinChannel({ channelId }: { channelId: string; accessHash: string }) {
  const roomId = getRoomIdByGroupChatId(channelId);
  if (!roomId) return undefined;

  const preview = previewsByRoomId.get(roomId);
  await getClient().joinRoom(preview?.alias || roomId, { viaServers: preview?.viaServers });
  previewsByRoomId.delete(roomId);

  const room = await waitForRoom(roomId);
  if (!room) return undefined;

  const chat = buildChat(room);
  markChatAnnounced(chat.id);
  onUpdate({
    '@type': 'updateChat', id: chat.id, chat, readState: buildReadState(room),
  });
  onUpdate({ '@type': 'updateChatJoin', id: chat.id });
  return { type: 'ok' as const };
}

// Public address of a group or channel: a room alias on this server. A group with an address is public:
// anyone, on any Matrix server, can find it in the room directory and join without an invite
// Accepts "name" as well as a full "#name:server" address
function getAddressLocalpart(username: string) {
  return username.replace(/^#/, '').split(':')[0];
}

export async function checkChatUsername({ chat, username }: { chat: ApiChat; username: string }) {
  const client = getClient();
  try {
    const alias = `#${getAddressLocalpart(username)}:${client.getDomain()}`;
    const { room_id: roomId } = await client.getRoomIdForAlias(alias);
    return { result: roomId === getRoomIdByGroupChatId(chat.id), error: undefined };
  } catch (err) {
    if ((err as { errcode?: string }).errcode === 'M_NOT_FOUND') return { result: true, error: undefined };
    return undefined;
  }
}

export async function setChatUsername({ chat, username }: { chat: ApiChat; username: string }) {
  const room = getRoomByChatId(chat.id);
  if (!room) return undefined;

  const client = getClient();
  const domain = client.getDomain()!;
  const oldAlias = room.getCanonicalAlias();
  const alias = username ? `#${getAddressLocalpart(username)}:${domain}` : undefined;

  if (alias && alias !== oldAlias) {
    await client.createAlias(alias, room.roomId);
  }
  await client.sendStateEvent(room.roomId, EventType.RoomCanonicalAlias, alias ? { alias } : {}, '');
  const joinRule = alias ? JoinRule.Public : JoinRule.Invite;
  await client.sendStateEvent(room.roomId, EventType.RoomJoinRules, { join_rule: joinRule }, '');
  // A server may allow only admins to list rooms; the address works without the listing
  await client.setRoomDirectoryVisibility(room.roomId, alias ? Visibility.Public : Visibility.Private)
    .catch(() => undefined);
  if (oldAlias && oldAlias !== alias && getServerName(oldAlias) === domain) {
    await client.deleteAlias(oldAlias).catch(() => undefined);
  }

  onUpdate({
    '@type': 'updateChat',
    id: chat.id,
    chat: { usernames: alias ? [{ username: alias, isActive: true, isEditable: true }] : [] },
  });
  return true;
}
