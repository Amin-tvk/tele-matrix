import {
  EventType, Method, MsgType, Preset, Visibility,
} from 'matrix-js-sdk';

import { DEBUG } from '../../config';
import { fetchIsServerAdmin } from './admin';
import { getClient, getMyUserId, hasClient } from './client';
import { ensureDirectRoomForUser } from './methods';

// Anyone can raise an emergency alert. It goes as a direct message to the people server admins named for it, kept
// in a registry room only admins can write to and anyone can read without joining (like the blue-tick registry).
// While nobody is named, the registry's admins get it

const REGISTRY_ALIAS_LOCALPART = 'peyvand-emergency';
const RECIPIENTS_EVENT = 'im.peyvand.emergency_recipients';
const REGISTRY_ROOM_VERSION = '11';
const ADMIN_POWER_LEVEL = 100;
const POWER_LEVELS_EVENT: string = EventType.RoomPowerLevels;
// Marks the message so clients can tell an alert from ordinary text
export const EMERGENCY_KEY = 'im.peyvand.emergency';

type StateEvent = { type: string; state_key: string; content: Record<string, unknown> };

export type EmergencyRecipients = {
  userIds: string[];
  // Nobody was named, so the registry's admins are used
  isDefault: boolean;
};

let registryRoomId: string | undefined;

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
    return undefined;
  }
}

async function createRegistryRoom() {
  const { room_id: roomId } = await getClient().createRoom({
    room_alias_name: REGISTRY_ALIAS_LOCALPART,
    name: 'Peyvand emergency contacts',
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    room_version: REGISTRY_ROOM_VERSION,
    initial_state: [{
      type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'world_readable' },
    }],
    power_level_content_override: {
      events_default: ADMIN_POWER_LEVEL,
      state_default: ADMIN_POWER_LEVEL,
      events: { [RECIPIENTS_EVENT]: ADMIN_POWER_LEVEL },
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

// Called once a server admin is signed in, so alerts have somewhere to go before anyone was named
export async function ensureEmergencyRegistry() {
  if (!hasClient() || await resolveRegistryRoomId()) return;
  if (!await fetchIsServerAdmin()) return;
  try {
    await createRegistryRoom();
  } catch (err) {
    // eslint-disable-next-line no-console
    if (DEBUG) console.warn('[matrix] Creating the emergency registry failed', err);
  }
}

export async function fetchEmergencyRecipients(): Promise<EmergencyRecipients> {
  const roomId = await resolveRegistryRoomId();
  if (!roomId) return { userIds: [], isDefault: true };
  const events = await getClient().http.authedRequest<StateEvent[]>(
    Method.Get, `/rooms/${encodeURIComponent(roomId)}/state`,
  );
  const named = events.find(({ type, state_key: key }) => type === RECIPIENTS_EVENT && key === '')?.content.user_ids;
  const userIds = Array.isArray(named) ? named.filter((id): id is string => typeof id === 'string') : [];
  if (userIds.length) return { userIds, isDefault: false };

  const powerLevels = events.find(({ type }) => type === POWER_LEVELS_EVENT)?.content.users as
    Record<string, number> | undefined;
  const admins = Object.entries(powerLevels || {})
    .filter(([, level]) => level >= ADMIN_POWER_LEVEL)
    .map(([userId]) => userId);
  return { userIds: admins, isDefault: true };
}

// Accepts full IDs or bare usernames on this server; returns the list as saved, or undefined for a non-admin
export async function setEmergencyRecipients({ userIds }: { userIds: string[] }) {
  if (!await fetchIsServerAdmin()) return undefined;
  const domain = getClient().getDomain();
  const normalized = [...new Set(userIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (id.includes(':') ? id : `${id}:${domain}`))
    .map((id) => (id.startsWith('@') ? id : `@${id}`))
    .map((id) => id.toLowerCase()))];

  const client = getClient();
  const roomId = await resolveRegistryRoomId() || await createRegistryRoom();
  const content = { user_ids: normalized, by: getMyUserId() };
  try {
    await client.sendStateEvent(roomId, RECIPIENTS_EVENT as never, content as never, '');
  } catch {
    await joinRegistryAsAdmin(roomId);
    await client.sendStateEvent(roomId, RECIPIENTS_EVENT as never, content as never, '');
  }
  return normalized;
}

// Returns how many people the alert reached and how many could not be reached
export async function sendEmergencyAlert() {
  const client = getClient();
  const myUserId = getMyUserId();
  const { userIds } = await fetchEmergencyRecipients();
  const recipients = userIds.filter((userId) => userId !== myUserId);
  if (!recipients.length) return { sent: 0, failed: 0, hasRecipients: false };

  const myName = client.getUser(myUserId)?.displayName || myUserId.slice(1).split(':')[0];
  const time = new Date().toLocaleString('en-GB', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const body = `🚨 EMERGENCY ALERT\n${myName} (${myUserId}) has declared an emergency.\nSent ${time}.`;
  const content = {
    msgtype: MsgType.Text,
    body,
    format: 'org.matrix.custom.html',
    formatted_body: `<b>🚨 EMERGENCY ALERT</b><br>${escapeHtml(myName)} (${escapeHtml(myUserId)}) `
      + `has declared an emergency.<br>Sent ${escapeHtml(time)}.`,
    [EMERGENCY_KEY]: { user_id: myUserId, ts: Date.now() },
  };

  const results = await Promise.allSettled(recipients.map(async (userId) => {
    const room = await ensureDirectRoomForUser(userId);
    if (!room) throw new Error(`No chat with ${userId}`);
    await client.sendEvent(room.roomId, EventType.RoomMessage, content as never);
  }));
  const failed = results.filter(({ status }) => status === 'rejected').length;
  // eslint-disable-next-line no-console
  if (DEBUG && failed) console.warn('[matrix] Some emergency alerts failed', results);
  return { sent: results.length - failed, failed, hasRecipients: true };
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
