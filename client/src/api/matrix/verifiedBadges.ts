import { EventType, Method, Preset, Visibility } from 'matrix-js-sdk';

import type { ApiChat, ApiPeer } from '../types';

import { DEBUG } from '../../config';
import { fetchIsServerAdmin } from './admin';
import {
  buildChat, buildUser, getClient, getMyUserId, getVisibleRooms, hasClient, onUpdate,
} from './client';
import { getRoomIdByGroupChatId, getUserIdByPeerId, isUserPeerId } from './ids';
import {
  getBadgeEmoji, getVerifiedIds, setBadgeEmoji, setVerifiedIds,
} from './verifiedState';

// Blue ticks are given by server admins. They live in one registry room that only admins can write to and anyone can
// read without joining (its history is world readable): one state event per verified user or room, keyed by its
// Matrix ID. People with the tick may pick an emoji to show instead, kept as a custom field of their own profile

const REGISTRY_ALIAS_LOCALPART = 'peyvand-verified';
const VERIFIED_EVENT = 'im.peyvand.verified';
const BADGE_PROFILE_FIELD = 'im.peyvand.badge';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const REGISTRY_ROOM_VERSION = '11';
const ADMIN_POWER_LEVEL = 100;

type StateEvent = { type: string; state_key: string; content: { verified?: boolean } };

let registryRoomId: string | undefined;
let refreshInterval: ReturnType<typeof setInterval> | undefined;

function getRegistryAlias() {
  return `#${REGISTRY_ALIAS_LOCALPART}:${getClient().getDomain()}`;
}

async function resolveRegistryRoomId() {
  if (registryRoomId) return registryRoomId;
  try {
    const { room_id: roomId } = await getClient().getRoomIdForAlias(getRegistryAlias());
    registryRoomId = roomId;
    return roomId;
  } catch {
    // No tick has been given on this server yet
    return undefined;
  }
}

async function fetchBadgeEmoji(userId: string) {
  try {
    const profile = await getClient().http.authedRequest<Record<string, unknown>>(
      Method.Get, `/profile/${encodeURIComponent(userId)}`,
    );
    const emoji = profile[BADGE_PROFILE_FIELD];
    return typeof emoji === 'string' && emoji ? emoji : undefined;
  } catch {
    return undefined;
  }
}

function announceChanges(changedIds: string[]) {
  if (!changedIds.length) return;
  changedIds.filter((id) => id.startsWith('@')).forEach((userId) => {
    const user = buildUser(userId);
    onUpdate({ '@type': 'updateUser', id: user.id, user });
  });
  // Direct chats carry their person's tick as well
  getVisibleRooms().forEach((room) => {
    const chat = buildChat(room);
    onUpdate({ '@type': 'updateChat', id: chat.id, chat });
  });
}

export async function refreshVerifiedBadges() {
  if (!hasClient()) return;
  const roomId = await resolveRegistryRoomId();
  let ids = new Set<string>();
  if (roomId) {
    try {
      const events = await getClient().http.authedRequest<StateEvent[]>(
        Method.Get, `/rooms/${encodeURIComponent(roomId)}/state`,
      );
      ids = new Set(events
        .filter(({ type, content }) => type === VERIFIED_EVENT && content.verified)
        .map(({ state_key: stateKey }) => stateKey));
    } catch (err) {
      if (DEBUG) console.warn('[matrix] Reading the verified registry failed', err);
      return;
    }
  }

  const previous = getVerifiedIds();
  const changed = new Set([...ids].filter((id) => !previous.has(id)));
  [...previous].filter((id) => !ids.has(id)).forEach((id) => changed.add(id));
  setVerifiedIds(ids);

  await Promise.all([...ids].filter((id) => id.startsWith('@')).map(async (userId) => {
    const emoji = await fetchBadgeEmoji(userId);
    if (emoji !== getBadgeEmoji(userId)) changed.add(userId);
    setBadgeEmoji(userId, emoji);
  }));

  announceChanges([...changed]);
}

export function startVerifiedBadgesPolling() {
  void refreshVerifiedBadges();
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => void refreshVerifiedBadges(), REFRESH_INTERVAL_MS);
}

function getMatrixIdForPeer(peer: Pick<ApiPeer, 'id'> | Pick<ApiChat, 'id'>) {
  return isUserPeerId(peer.id) ? getUserIdByPeerId(peer.id) : getRoomIdByGroupChatId(peer.id);
}

async function createRegistryRoom() {
  const { room_id: roomId } = await getClient().createRoom({
    room_alias_name: REGISTRY_ALIAS_LOCALPART,
    name: 'Peyvand verified accounts',
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    room_version: REGISTRY_ROOM_VERSION,
    initial_state: [{
      type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'world_readable' },
    }],
    power_level_content_override: {
      events_default: ADMIN_POWER_LEVEL,
      state_default: ADMIN_POWER_LEVEL,
      events: { [VERIFIED_EVENT]: ADMIN_POWER_LEVEL },
    },
  });
  registryRoomId = roomId;
  return roomId;
}

// Another server admin created the registry: the admin API lets this admin in with full rights
async function joinRegistryAsAdmin(roomId: string) {
  await getClient().http.authedRequest(
    Method.Post, `/v1/rooms/${encodeURIComponent(roomId)}/make_room_admin`, undefined,
    { user_id: getMyUserId() }, { prefix: '/_synapse/admin' },
  );
}

// The admin panel names people and channels by their Matrix ID, the chat menu by the chat
export async function setPeerVerified({ peer, matrixId: givenMatrixId, isVerified }: {
  peer?: Pick<ApiPeer, 'id'>;
  matrixId?: string;
  isVerified: boolean;
}) {
  if (!await fetchIsServerAdmin()) return false;
  const matrixId = givenMatrixId || (peer && getMatrixIdForPeer(peer));
  if (!matrixId) return false;

  const client = getClient();
  const roomId = await resolveRegistryRoomId() || await createRegistryRoom();
  const content = isVerified ? { verified: true, by: getMyUserId() } : {};
  try {
    await client.sendStateEvent(roomId, VERIFIED_EVENT as never, content as never, matrixId);
  } catch {
    await joinRegistryAsAdmin(roomId);
    await client.sendStateEvent(roomId, VERIFIED_EVENT as never, content as never, matrixId);
  }
  await refreshVerifiedBadges();
  return true;
}

export async function setMyBadgeEmoji({ emoji }: { emoji?: string }) {
  const userId = getMyUserId();
  const path = `/profile/${encodeURIComponent(userId)}/${BADGE_PROFILE_FIELD}`;
  const client = getClient();
  if (emoji) {
    await client.http.authedRequest(Method.Put, path, undefined, { [BADGE_PROFILE_FIELD]: emoji });
  } else {
    await client.http.authedRequest(Method.Delete, path);
  }
  setBadgeEmoji(userId, emoji);
  announceChanges([userId]);
  return true;
}
