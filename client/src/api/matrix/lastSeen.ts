import { Method } from 'matrix-js-sdk';

import type {
  ApiInputPrivacyRules, ApiPrivacyKey, ApiPrivacySettings, ApiUserStatus,
} from '../types';

import {
  getClient, getDirectUserIds, hasClient, onUpdate,
} from './client';
import {
  getChatIdByRoomId, getPeerIdByUserId, getRoomIdByGroupChatId, getUserIdByPeerId,
} from './ids';

// Last seen comes from the server's peyvand_last_seen module instead of Matrix presence: it applies each user's
// privacy rules before answering, so a hidden user only shows up as "recently", "within a week" and so on

const LAST_SEEN_PREFIX = '/_synapse/client/peyvand/last_seen';
const PRIVACY_EVENT = 'im.peyvand.privacy';
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const POLL_INTERVAL_MS = 30 * 1000;
// Users stay polled for a while after the UI last showed them
const INTEREST_TTL_MS = 10 * 60 * 1000;
const FETCH_BATCH_DELAY_MS = 300;
const MAX_USERS_PER_REQUEST = 200;

type ServerStatus = {
  state: 'online' | 'offline' | 'recently' | 'last_week' | 'last_month' | 'long_ago';
  expires_ts?: number;
  last_active_ts?: number;
};

type StoredRules = {
  visibility?: ApiPrivacySettings['visibility'];
  allowUsers?: string[];
  blockUsers?: string[];
  allowRooms?: string[];
  blockRooms?: string[];
};

const statusByUserId = new Map<string, ApiUserStatus>();
const interestByUserId = new Map<string, number>();
const pendingUserIds = new Set<string>();
let fetchTimeout: ReturnType<typeof setTimeout> | undefined;
let pollInterval: ReturnType<typeof setInterval> | undefined;
let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

function request<T>(method: Method, path: string, query?: Record<string, string | string[]>) {
  return getClient().http.authedRequest<T>(method, path, query, undefined, { prefix: LAST_SEEN_PREFIX });
}

function buildStatus({ state, expires_ts: expiresTs, last_active_ts: lastActiveTs }: ServerStatus): ApiUserStatus {
  switch (state) {
    case 'online':
      return { type: 'userStatusOnline', expires: Math.floor((expiresTs || Date.now()) / 1000) };
    case 'offline':
      return lastActiveTs
        ? { type: 'userStatusOffline', wasOnline: Math.floor(lastActiveTs / 1000) }
        : { type: 'userStatusEmpty' };
    case 'recently':
      return { type: 'userStatusRecently' };
    case 'last_week':
      return { type: 'userStatusLastWeek' };
    case 'last_month':
      return { type: 'userStatusLastMonth' };
    default:
      return { type: 'userStatusEmpty' };
  }
}

function isSameStatus(a: ApiUserStatus | undefined, b: ApiUserStatus) {
  return a?.type === b.type && a.wasOnline === b.wasOnline
    && (b.type !== 'userStatusOnline' || Math.abs((a.expires || 0) - (b.expires || 0)) < POLL_INTERVAL_MS / 1000);
}

async function fetchStatuses(userIds: string[]) {
  if (!hasClient() || !userIds.length) return;
  for (let i = 0; i < userIds.length; i += MAX_USERS_PER_REQUEST) {
    const chunk = userIds.slice(i, i + MAX_USERS_PER_REQUEST);
    try {
      const { statuses } = await request<{ statuses: Record<string, ServerStatus> }>(
        Method.Get, '/status', { user_id: chunk },
      );
      Object.entries(statuses).forEach(([userId, serverStatus]) => {
        const status = buildStatus(serverStatus);
        if (isSameStatus(statusByUserId.get(userId), status)) return;
        statusByUserId.set(userId, status);
        onUpdate({ '@type': 'updateUserStatus', userId: getPeerIdByUserId(userId), status });
      });
    } catch {
      // Statuses are refreshed on the next poll
    }
  }
}

function scheduleFetch(userId: string) {
  pendingUserIds.add(userId);
  if (fetchTimeout) return;
  fetchTimeout = setTimeout(() => {
    fetchTimeout = undefined;
    const userIds = [...pendingUserIds];
    pendingUserIds.clear();
    void fetchStatuses(userIds);
  }, FETCH_BATCH_DELAY_MS);
}

// Returns the last known status and keeps the user refreshed while the UI shows them
export function getCachedUserStatus(userId: string) {
  const isKnown = interestByUserId.has(userId);
  interestByUserId.set(userId, Date.now());
  if (!isKnown || !statusByUserId.has(userId)) scheduleFetch(userId);
  return statusByUserId.get(userId);
}

function pollStatuses() {
  const now = Date.now();
  interestByUserId.forEach((requestedAt, userId) => {
    if (now - requestedAt > INTEREST_TTL_MS) interestByUserId.delete(userId);
  });
  const userIds = new Set([...interestByUserId.keys(), ...getDirectUserIds()]);
  void fetchStatuses([...userIds]);
}

export function startLastSeenPolling() {
  stopLastSeenPolling();
  pollStatuses();
  pollInterval = setInterval(pollStatuses, POLL_INTERVAL_MS);
}

export function stopLastSeenPolling() {
  if (pollInterval) clearInterval(pollInterval);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  pollInterval = undefined;
  heartbeatInterval = undefined;
  statusByUserId.clear();
  interestByUserId.clear();
}

function sendHeartbeat(isOnline: boolean) {
  if (!hasClient()) return Promise.resolve();
  return request(Method.Post, '/heartbeat', isOnline ? undefined : { offline: '1' }).catch(() => undefined);
}

export async function updateIsOnline(isOnline: boolean) {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = isOnline ? setInterval(() => void sendHeartbeat(true), HEARTBEAT_INTERVAL_MS) : undefined;
  await sendHeartbeat(isOnline);
}

/* Privacy settings */

function readStoredPrivacy() {
  const event = getClient().getAccountData(PRIVACY_EVENT as never);
  return event?.getContent<Record<string, StoredRules>>() || {};
}

function buildPrivacySettings(rules: StoredRules = {}): ApiPrivacySettings {
  return {
    visibility: rules.visibility || 'everybody',
    allowUserIds: (rules.allowUsers || []).map(getPeerIdByUserId),
    blockUserIds: (rules.blockUsers || []).map(getPeerIdByUserId),
    allowChatIds: (rules.allowRooms || []).map(getChatIdByRoomId),
    blockChatIds: (rules.blockRooms || []).map(getChatIdByRoomId),
    botsPrivacy: 'none',
  };
}

// Only last seen is enforced by the server; other Telegram privacy keys have no Matrix counterpart
export function fetchPrivacySettings(privacyKey: ApiPrivacyKey) {
  const rules = privacyKey === 'lastSeen' ? readStoredPrivacy().lastSeen : undefined;
  return Promise.resolve({ rules: buildPrivacySettings(rules) });
}

export async function setPrivacySettings(privacyKey: ApiPrivacyKey, rules: ApiInputPrivacyRules) {
  const stored: StoredRules = {
    visibility: rules.visibility,
    allowUsers: (rules.allowedUsers || []).map(({ id }) => getUserIdByPeerId(id)).filter(Boolean),
    blockUsers: (rules.blockedUsers || []).map(({ id }) => getUserIdByPeerId(id)).filter(Boolean),
    allowRooms: (rules.allowedChats || []).map(({ id }) => getRoomIdByGroupChatId(id)).filter(Boolean),
    blockRooms: (rules.blockedChats || []).map(({ id }) => getRoomIdByGroupChatId(id)).filter(Boolean),
  };
  if (privacyKey === 'lastSeen') {
    await getClient().setAccountData(PRIVACY_EVENT as never, { ...readStoredPrivacy(), lastSeen: stored } as never);
  }
  return { rules: buildPrivacySettings(stored) };
}
