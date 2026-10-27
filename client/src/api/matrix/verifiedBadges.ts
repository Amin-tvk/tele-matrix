import { EventType, Method, Preset, Visibility } from 'matrix-js-sdk';

import type { ApiChat, ApiPeer } from '../types';

import { DEBUG } from '../../config';
import { fetchIsServerAdmin } from './admin';
import {
  buildChat, buildUser, getClient, getMyUserId, getVisibleRooms, hasClient, onUpdate,
} from './client';
import { getRoomIdByGroupChatId, getUserIdByPeerId, isUserPeerId } from './ids';
import { applyProfileStories } from './stories';
import { STORIES_PROFILE_FIELD } from './storiesState';
import {
  getBadgeEmoji, getVerifiedIds, setBadgeEmoji, setVerifiedIds,
} from './verifiedState';

// Blue ticks are given by server admins. They live in one registry room that only admins can write to and anyone can
// read without joining (its history is world readable): one state event per verified user or room, keyed by its
// Matrix ID. People with the tick may pick an emoji to show instead, kept as a custom field of their own profile

const REGISTRY_ALIAS_LOCALPART = 'peyvand-verified';
const VERIFIED_EVENT = 'im.peyvand.verified';
const BADGE_PROFILE_FIELD = 'im.peyvand.badge';
const REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const REGISTRY_ROOM_VERSION = '11';
const ADMIN_POWER_LEVEL = 100;
// Rooms only let a user write state keys starting with "@" when the key is their own ID, so keys get a prefix.
// The first ticks were stored without it and are still read
const STATE_KEY_PREFIX = 'id:';

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

// A verified person's profile holds their badge emoji and their stories
async function fetchVerifiedProfile(userId: string) {
  try {
    return await getClient().http.authedRequest<Record<string, unknown>>(
      Method.Get, `/profile/${encodeURIComponent(userId)}`,
    );
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
      // Prefixed keys are newer and win over unprefixed ones for the same ID
      const isVerifiedById = new Map<string, boolean>();
      const registryEvents = events.filter(({ type }) => type === VERIFIED_EVENT);
      [false, true].forEach((isPrefixed) => {
        registryEvents
          .filter(({ state_key: key }) => key.startsWith(STATE_KEY_PREFIX) === isPrefixed)
          .forEach(({ state_key: key, content }) => {
            isVerifiedById.set(isPrefixed ? key.slice(STATE_KEY_PREFIX.length) : key, Boolean(content.verified));
          });
      });
      ids = new Set([...isVerifiedById].filter(([, isVerified]) => isVerified).map(([id]) => id));
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
    const profile = await fetchVerifiedProfile(userId);
    if (!profile) return;
    const badge = profile[BADGE_PROFILE_FIELD];
    const emoji = typeof badge === 'string' && badge ? badge : undefined;
    if (emoji !== getBadgeEmoji(userId)) changed.add(userId);
    setBadgeEmoji(userId, emoji);
    applyProfileStories(userId, profile[STORIES_PROFILE_FIELD]);
  }));
  // People whose tick was taken away lose their stories too
  [...previous].filter((id) => id.startsWith('@') && !ids.has(id)).forEach((userId) => applyProfileStories(userId, []));

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
  const stateKey = `${STATE_KEY_PREFIX}${matrixId}`;
  try {
    await client.sendStateEvent(roomId, VERIFIED_EVENT as never, content as never, stateKey);
  } catch {
    await joinRegistryAsAdmin(roomId);
    await client.sendStateEvent(roomId, VERIFIED_EVENT as never, content as never, stateKey);
  }
  // An admin's own tick may still be stored under the old unprefixed key
  if (!isVerified && matrixId === getMyUserId()) {
    await client.sendStateEvent(roomId, VERIFIED_EVENT as never, {} as never, matrixId).catch(() => undefined);
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
