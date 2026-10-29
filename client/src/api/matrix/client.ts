import type {
  MatrixClient, MatrixEvent, Room, RoomMember, User,
} from 'matrix-js-sdk';
import {
  ClientEvent,
  createClient,
  EventType,
  HttpApiEvent,
  IndexedDBStore,
  MatrixEventEvent,
  Method,
  NotificationCountType,
  PendingEventOrdering,
  RelationType,
  RoomEvent,
  RoomMemberEvent,
  SyncState,
  UserEvent,
} from 'matrix-js-sdk';

import type {
  ApiChat, ApiMessage, ApiUpdate, ApiUser, ApiUserStatus,
} from '../types';
import type { ChatContext } from './builders';
import type { MatrixSession } from './session';
import { MAIN_THREAD_ID } from '../types/messages';

import { DEBUG } from '../../config';
import Deferred from '../../util/Deferred';
import { omitUndefined } from '../../util/iteratees';
import { pause } from '../../util/schedulers';
import { sendApiUpdate } from '../gramjs/updates/apiUpdateEmitter';
import {
  buildApiChatFromRoom,
  buildApiMessage,
  buildApiUser,
  buildReactions,
  countPostViews,
  getMemberTag,
  getReplyTargetEventId,
  isDisplayableEvent,
  isRoomChannel,
} from './builders';
import {
  addCommentToSummary, areCommentsEnabled, getCommentRootEventId, getCommentsChatId, getKnownCommentRootId,
  getThreadSummary, isCommentEvent, removeCommentFromSummary, setThreadSummaryCount,
} from './comments';
import {
  CALL_EVENT_PREFIX, INITIAL_SYNC_LIMIT, MEMBER_TAG_EVENT, MEMBER_TAG_KEY_PREFIX, PERMISSIONS_EVENT,
  QUICK_REACTION_EVENT, SYNC_POLL_TIMEOUT_MS,
} from './constants';
import {
  cacheSecretStorageKeyCallback, getSecretStorageKeyCallback, handleKeyUploadConflict, markDeviceBroken,
} from './encryption';
import { handleFoldersAccountData } from './folders';
import {
  findMessageId, getChatIdByRoomId, getEventId, getMessageId, getPeerIdByUserId, getRoomIdByGroupChatId, getUserIdByPeerId,
  isUserPeerId,
} from './ids';
import { getCachedUserStatus, startLastSeenPolling, stopLastSeenPolling } from './lastSeen';
import { fetchWithDeadline, setKeyUploadConflictHandler } from './network';
import { handleReactionUsageAccountData } from './reactionUsage';
import { getRoomTtlSeconds, isExpiredEvent } from './retention';
import { buildSessionData, setSession } from './session';
import {
  clearStore, flushStore, getValue, loadStore, setStoreName, setValue,
} from './store';
import { handleStoryViewEvent } from './stories';
import { STORY_VIEW_EVENT } from './storiesState';
import { setTodoCompleterHandler, TODO_UPDATE_EVENT } from './todo';
import { watchDeviceVerificationRequests } from './verification';
import { startVerifiedBadgesPolling } from './verifiedBadges';

let client: MatrixClient | undefined;
let myUserId = '';
let syncDeferred = new Deferred<void>();
let isSyncPrepared = false;

const dmUserIdByRoomId = new Map<string, string>();
const dmRoomIdByUserId = new Map<string, string>();
const announcedChatIds = new Set<string>();
const announcedUserIds = new Set<string>();
const reactionTargets = new Map<string, string>();
const lastUnreadCounts = new Map<string, number>();
const pendingSends = new Map<string, (event: MatrixEvent) => void>();
const undecryptableEventIds = new Set<string>();

export function getClient() {
  if (!client) throw new Error('Matrix client is not started');
  return client;
}

export function hasClient() {
  return Boolean(client);
}

export function getMyUserId() {
  return myUserId;
}

export function getMyPeerId() {
  return getPeerIdByUserId(myUserId);
}

export function waitForSync() {
  return syncDeferred.promise;
}

export function onUpdate(update: ApiUpdate) {
  sendApiUpdate(update);

  // The UI applies read state only through thread read state updates, so the chat's one is forwarded there
  if (update['@type'] === 'updateChat' && update.readState) {
    const readState = Object.fromEntries(
      Object.entries(update.readState).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(readState).length) {
      sendApiUpdate({
        '@type': 'updateThreadReadState', chatId: update.id, threadId: MAIN_THREAD_ID, readState,
      });
    }
  }
}

/* Session lifecycle */

export async function startClient(session: MatrixSession, isFreshLogin?: boolean) {
  setSession(session);
  myUserId = session.userId;
  syncDeferred = new Deferred<void>();
  isSyncPrepared = false;

  setStoreName(`peyvand-matrix:${session.userId}`);
  await loadStore();

  const store = new IndexedDBStore({
    indexedDB: self.indexedDB,
    dbName: `peyvand-sync:${session.userId}`,
  });

  setKeyUploadConflictHandler(handleKeyUploadConflict);
  client = createClient({
    baseUrl: session.homeserver,
    accessToken: session.accessToken,
    userId: session.userId,
    deviceId: session.deviceId,
    store,
    timelineSupport: true,
    useAuthorizationHeader: true,
    fetchFn: fetchWithDeadline,
    cryptoCallbacks: {
      getSecretStorageKey: getSecretStorageKeyCallback,
      cacheSecretStorageKey: cacheSecretStorageKeyCallback,
    },
  });

  // The main screen starts rendering while local stores open; data requests wait for the first sync anyway
  onUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateReady' });
  onUpdate({ '@type': 'updateSession', sessionData: buildSessionData(session) });

  await Promise.all([
    store.startup().catch((err) => {
      if (DEBUG) console.warn('[matrix] IndexedDB store startup failed', err);
    }),
    initCrypto(client, session, isFreshLogin),
  ]);

  subscribeToClient(client);
  watchDeviceVerificationRequests(client);

  onUpdate({ '@type': 'updateApiReady' });
  onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  void sendCurrentUser();

  await client.startClient({
    lazyLoadMembers: true,
    initialSyncLimit: INITIAL_SYNC_LIMIT,
    pollTimeout: SYNC_POLL_TIMEOUT_MS,
    pendingEventOrdering: PendingEventOrdering.Detached,
  });

  if (isFreshLogin && DEBUG) console.log('[matrix] Started client after login');
}

// Each device keeps its own crypto store. Accounts signed in before that use one store per user
const CRYPTO_PREFIX_KEY = 'crypto-prefix';
const CRYPTO_INIT_ATTEMPTS = 3;
const CRYPTO_RETRY_DELAY_MS = 1000;
const STORE_ACCOUNT_MISMATCH_RE = /account in the store doesn.t match/i;
const CRYPTO_DATABASE_SUFFIX = '::matrix-sdk-crypto';

function getCryptoDatabasePrefix(userId: string, deviceId: string) {
  return `peyvand-crypto:${userId}:${deviceId}`;
}

function getLegacyCryptoDatabasePrefix(userId: string) {
  return `peyvand-crypto:${userId}`;
}

function getCurrentCryptoDatabasePrefix(userId: string) {
  return getValue(CRYPTO_PREFIX_KEY) || getLegacyCryptoDatabasePrefix(userId);
}

// The crypto store holds this device's identity and every message key it received. It is never deleted
// because opening it failed: a new identity under the same device ID can't be published (the server keeps
// the old keys), so no one could send this device message keys anymore
// Names of the crypto stores on this browser, or undefined where the browser can't list them
async function getCryptoDatabaseNames() {
  try {
    const databases = await self.indexedDB.databases();
    return new Set(databases.map(({ name }) => name));
  } catch {
    return undefined;
  }
}

async function hasPublishedDeviceKeys(currentClient: MatrixClient, { userId, deviceId }: MatrixSession) {
  try {
    const response = await currentClient.http.authedRequest<{
      device_keys?: Record<string, Record<string, unknown>>;
    }>(Method.Post, '/keys/query', undefined, { device_keys: { [userId]: [deviceId] } });
    return Boolean(response.device_keys?.[userId]?.[deviceId]);
  } catch {
    return false;
  }
}

async function initCrypto(currentClient: MatrixClient, session: MatrixSession, isFreshLogin?: boolean) {
  const ownPrefix = getCryptoDatabasePrefix(session.userId, session.deviceId);
  const legacyPrefix = getLegacyCryptoDatabasePrefix(session.userId);
  // Chosen by the stores that exist rather than only the remembered one: the reminder may not have been saved
  // if the browser closed right after sign-in, and opening another, empty store would recreate the identity
  const databaseNames = isFreshLogin ? undefined : await getCryptoDatabaseNames();
  const hasStore = (prefix: string) => databaseNames?.has(`${prefix}${CRYPTO_DATABASE_SUFFIX}`);
  let prefix = getValue(CRYPTO_PREFIX_KEY);
  if (!prefix || (databaseNames && !hasStore(prefix))) {
    prefix = isFreshLogin || hasStore(ownPrefix) || (databaseNames && !hasStore(legacyPrefix))
      ? ownPrefix : legacyPrefix;
  }
  // This device's keys are gone. If the server already has keys for it, a new identity under the same
  // device ID can't receive messages again
  if (databaseNames && !hasStore(prefix) && await hasPublishedDeviceKeys(currentClient, session)) {
    markDeviceBroken(session.deviceId);
  }

  for (let attempt = 1; attempt <= CRYPTO_INIT_ATTEMPTS; attempt++) {
    try {
      await currentClient.initRustCrypto({ cryptoDatabasePrefix: prefix });
      setValue(CRYPTO_PREFIX_KEY, prefix);
      void flushStore();
      return;
    } catch (err) {
      // A store left from an earlier sign-in on this browser belongs to another device; this one gets its own
      if (STORE_ACCOUNT_MISMATCH_RE.test(String(err)) && prefix !== ownPrefix) {
        prefix = ownPrefix;
        attempt--;
        continue;
      }
      if (DEBUG) console.warn(`[matrix] Failed to initialize crypto (attempt ${attempt})`, err);
      await pause(CRYPTO_RETRY_DELAY_MS * attempt);
    }
  }
  // Encrypted rooms stay unreadable until the next start, but the keys are kept for it
}

/* Auto-delete */

const EXPIRY_SWEEP_INTERVAL_MS = 60 * 1000;
let expirySweepInterval: ReturnType<typeof setInterval> | undefined;
const expiredEventIds = new Set<string>();

// Messages in auto-deleting chats disappear from open chats as they expire, before the server purges them
function sweepExpiredMessages() {
  if (!client) return;
  const now = Date.now();
  getVisibleRooms().forEach((room) => {
    if (!getRoomTtlSeconds(room)) return;
    const ids: number[] = [];
    room.getLiveTimeline().getEvents().forEach((event) => {
      const eventId = event.getId();
      if (!eventId || expiredEventIds.has(eventId) || !isExpiredEvent(event, room, now)) return;
      expiredEventIds.add(eventId);
      const messageId = findMessageId(eventId);
      if (messageId) ids.push(messageId);
    });
    if (ids.length) onUpdate({ '@type': 'deleteMessages', chatId: getChatIdForRoom(room), ids });
  });
}

function startExpirySweep() {
  stopExpirySweep();
  expirySweepInterval = setInterval(sweepExpiredMessages, EXPIRY_SWEEP_INTERVAL_MS);
}

function stopExpirySweep() {
  if (expirySweepInterval) clearInterval(expirySweepInterval);
  expirySweepInterval = undefined;
  expiredEventIds.clear();
}

export async function stopClient(shouldClearData: boolean) {
  const currentClient = client;
  client = undefined;
  stopReconnectProbes();
  stopLastSeenPolling();
  stopExpirySweep();
  if (currentClient) {
    currentClient.stopClient();
    currentClient.removeAllListeners();
    if (shouldClearData) {
      try {
        await currentClient.clearStores({
          cryptoDatabasePrefix: getCurrentCryptoDatabasePrefix(currentClient.getUserId()!),
        });
      } catch {
        // Ignore
      }
    }
  }
  if (shouldClearData) await clearStore();

  setSession(undefined);
  myUserId = '';
  isSyncPrepared = false;
  dmUserIdByRoomId.clear();
  dmRoomIdByUserId.clear();
  announcedChatIds.clear();
  announcedUserIds.clear();
  reactionTargets.clear();
  lastUnreadCounts.clear();
  pendingSends.clear();
  undecryptableEventIds.clear();
}

async function sendCurrentUser() {
  const currentUser = await fetchCurrentApiUser();
  if (!currentUser) return;
  onUpdate({
    '@type': 'updateCurrentUser',
    currentUser,
    currentUserFullInfo: {},
  });
}

export async function fetchCurrentApiUser(): Promise<ApiUser | undefined> {
  if (!client) return undefined;
  let displayName: string | undefined;
  let avatarUrl: string | undefined;
  try {
    const profile = await client.getProfileInfo(myUserId);
    displayName = profile.displayname;
    avatarUrl = profile.avatar_url;
  } catch {
    const user = client.getUser(myUserId);
    displayName = user?.displayName;
    avatarUrl = user?.avatarUrl;
  }
  announcedUserIds.add(myUserId);
  return buildApiUser(myUserId, displayName, avatarUrl, myUserId);
}

/* Direct chats */

function getRoomActivityTs(room: Room) {
  return room.getLastActiveTimestamp() || 0;
}

function getRoomPeopleCount(room: Room) {
  return room.getJoinedMemberCount() + room.getInvitedMemberCount();
}

export function computeDirectRooms() {
  if (!client) return false;
  const previous = new Map(dmUserIdByRoomId);
  dmUserIdByRoomId.clear();
  dmRoomIdByUserId.clear();

  const direct = (client.getAccountData(EventType.Direct)?.getContent() || {});
  const candidates: [string, Room][] = [];

  Object.entries(direct).forEach(([userId, roomIds]) => {
    if (!Array.isArray(roomIds)) return;
    roomIds.forEach((roomId) => {
      const room = client!.getRoom(roomId);
      if (room) candidates.push([userId, room]);
    });
  });

  // Invites and joins flagged as direct by the inviter, before `m.direct` is updated
  client.getRooms().forEach((room) => {
    if (previous.has(room.roomId)) {
      candidates.push([previous.get(room.roomId)!, room]);
      return;
    }
    const memberEvent = room.getMember(myUserId)?.events.member;
    const inviter = memberEvent?.getSender();
    if (memberEvent?.getContent().is_direct && inviter && inviter !== myUserId) {
      candidates.push([inviter, room]);
      return;
    }
    // Rooms this account created as a direct chat, while the invite is still pending
    room.currentState.getStateEvents(EventType.RoomMember).forEach((event) => {
      const invitee = event.getStateKey();
      if (event.getSender() === myUserId && invitee && invitee !== myUserId && event.getContent().is_direct) {
        candidates.push([invitee, room]);
      }
    });
  });

  candidates.forEach(([userId, room]) => {
    const membership = room.getMyMembership();
    if (membership !== 'join' && membership !== 'invite') return;
    if (room.isSpaceRoom()) return;
    const peopleCount = getRoomPeopleCount(room);
    if (userId === myUserId ? peopleCount > 1 : peopleCount > 2) return;

    const existingRoomId = dmRoomIdByUserId.get(userId);
    if (existingRoomId && existingRoomId !== room.roomId) {
      const existingRoom = client!.getRoom(existingRoomId);
      if (existingRoom && getRoomActivityTs(existingRoom) >= getRoomActivityTs(room)) return;
      dmUserIdByRoomId.delete(existingRoomId);
    }
    dmUserIdByRoomId.set(room.roomId, userId);
    dmRoomIdByUserId.set(userId, room.roomId);
  });

  // A room shown as a group before it was recognized as a direct chat now lives under the user's ID
  dmUserIdByRoomId.forEach((userId, roomId) => {
    if (previous.has(roomId)) return;
    const groupChatId = getChatIdByRoomId(roomId);
    if (announcedChatIds.delete(groupChatId)) onUpdate({ '@type': 'updateChatLeave', id: groupChatId });
  });

  return previous.size !== dmUserIdByRoomId.size
    || [...dmUserIdByRoomId].some(([roomId, userId]) => previous.get(roomId) !== userId);
}

export function getDmUserId(room: Room) {
  return dmUserIdByRoomId.get(room.roomId);
}

export function getDmRoomIdForUser(userId: string) {
  return dmRoomIdByUserId.get(userId);
}

export function setDmRoom(userId: string, roomId: string) {
  dmUserIdByRoomId.set(roomId, userId);
  dmRoomIdByUserId.set(userId, roomId);
  const groupChatId = getChatIdByRoomId(roomId);
  if (announcedChatIds.delete(groupChatId)) onUpdate({ '@type': 'updateChatLeave', id: groupChatId });
}

export function getChatIdForRoom(room: Room) {
  const dmUserId = dmUserIdByRoomId.get(room.roomId);
  return dmUserId ? getPeerIdByUserId(dmUserId) : getChatIdByRoomId(room.roomId);
}

export function getRoomByChatId(chatId: string) {
  if (!client) return undefined;
  if (isUserPeerId(chatId)) {
    const userId = getUserIdByPeerId(chatId);
    const roomId = userId ? dmRoomIdByUserId.get(userId) : undefined;
    return roomId ? client.getRoom(roomId) || undefined : undefined;
  }
  const roomId = getRoomIdByGroupChatId(chatId);
  return roomId ? client.getRoom(roomId) || undefined : undefined;
}

export function isRoomVisible(room: Room) {
  const membership = room.getMyMembership();
  if (membership !== 'join' && membership !== 'invite') return false;
  if (room.isSpaceRoom()) return false;
  const tombstone = room.currentState.getStateEvents(EventType.RoomTombstone, '');
  if (tombstone) {
    const successor = client?.getRoom(tombstone.getContent().replacement_room);
    if (successor?.getMyMembership() === 'join') return false;
  }
  return true;
}

export function getVisibleRooms() {
  return client ? client.getRooms().filter(isRoomVisible) : [];
}

/* Builders bound to the client state */

export function resolvePeerId(userId: string) {
  return getPeerIdByUserId(userId);
}

export function getChatContext(room: Room): ChatContext {
  const dmUserId = dmUserIdByRoomId.get(room.roomId);
  return {
    chatId: getChatIdForRoom(room),
    isPrivate: Boolean(dmUserId),
    isChannel: !dmUserId && isRoomChannel(room),
    myUserId,
    resolvePeerId,
  };
}

// Profiles of users we share no room with (found through search), which the sync never delivers
const knownProfiles = new Map<string, { displayName?: string; avatarUrl?: string }>();

export function rememberProfile(userId: string, displayName?: string | null, avatarUrl?: string | null) {
  knownProfiles.set(userId, { displayName: displayName || undefined, avatarUrl: avatarUrl || undefined });
}

export function buildUser(userId: string, room?: Room): ApiUser {
  const user = client?.getUser(userId);
  const member = room?.getMember(userId);
  const known = knownProfiles.get(userId);
  // Members who have not joined yet carry no display name, the profile lookup does
  // The SDK falls back to the raw user ID for names it does not know yet
  const userName = user?.displayName && user.displayName !== userId ? user.displayName : undefined;
  const memberName = member?.rawDisplayName && member.rawDisplayName !== userId ? member.rawDisplayName : undefined;
  const displayName = userName || memberName || known?.displayName;
  const avatarUrl = user?.avatarUrl || member?.getMxcAvatarUrl() || known?.avatarUrl;
  return buildApiUser(userId, displayName, avatarUrl, myUserId, userId !== myUserId);
}

export function buildChat(room: Room): ApiChat {
  const dmUserId = dmUserIdByRoomId.get(room.roomId);
  return buildApiChatFromRoom(room, myUserId, dmUserId, dmUserId ? buildUser(dmUserId, room) : undefined);
}

export function buildUserStatus(userId: string): ApiUserStatus | undefined {
  return getCachedUserStatus(userId);
}

export function getDirectUserIds() {
  return [...dmRoomIdByUserId.keys()];
}

// The server cannot see inside encrypted events, so it counts encrypted reactions, edits and other hidden
// events as unread messages. For encrypted rooms the count is taken from the messages actually shown
export function getUnreadCount(room: Room) {
  const serverCount = room.getUnreadNotificationCount(NotificationCountType.Total) || 0;
  if (!serverCount || !room.hasEncryptionStateEvent()) return serverCount;

  const readUpTo = room.getEventReadUpTo(myUserId);
  const events = room.getLiveTimeline().getEvents();
  const readIndex = readUpTo ? events.findIndex((event) => event.getId() === readUpTo) : -1;
  // Without the read position in the loaded timeline only the server knows how much is unread
  if (readIndex === -1) return serverCount;

  const context = getChatContext(room);
  return events.slice(readIndex + 1).filter((event) => (
    event.getSender() !== myUserId && isDisplayableEvent(event, context, room)
  )).length;
}

export function buildReadState(room: Room) {
  const context = getChatContext(room);
  const unreadCount = getUnreadCount(room);
  const unreadMentionsCount = room.getUnreadNotificationCount(NotificationCountType.Highlight) || 0;
  const lastReadInboxMessageId = getReadUpToMessageId(room, myUserId);
  const lastReadOutboxMessageId = getOthersReadUpToMessageId(room, context);

  return {
    unreadCount,
    unreadMentionsCount,
    lastReadInboxMessageId,
    lastReadOutboxMessageId,
  };
}

function getMessageIdForEventId(room: Room, eventId: string) {
  const known = findMessageId(eventId);
  if (known) return known;
  const event = room.findEventById(eventId);
  return event ? getMessageId(room.roomId, eventId, event.getTs()) : undefined;
}

function getReadUpToMessageId(room: Room, userId: string) {
  const eventId = room.getEventReadUpTo(userId);
  return eventId ? getMessageIdForEventId(room, eventId) : undefined;
}

const MAX_MEMBERS_FOR_OUTBOX_RECEIPTS = 50;

function getOthersReadUpToMessageId(room: Room, context: ChatContext) {
  const members = room.getJoinedMembers();
  if (members.length > MAX_MEMBERS_FOR_OUTBOX_RECEIPTS) return undefined;

  let maxId: number | undefined;
  members.forEach((member) => {
    if (member.userId === myUserId) return;
    const id = getReadUpToMessageId(room, member.userId);
    if (id && (!maxId || id > maxId)) maxId = id;
  });

  void context;
  return maxId;
}

export function getLastMessage(room: Room) {
  const events = room.getLiveTimeline().getEvents();
  const context = getChatContext(room);
  for (let i = events.length - 1; i >= 0; i--) {
    const message = buildApiMessage(events[i], room, context);
    if (message) return message;
  }
  return undefined;
}

/* Comments under channel posts */

const announcedCommentsChatIds = new Set<string>();

// The virtual discussion chat holding a channel's comments; never listed among the chats
export function buildCommentsChat(room: Room): ApiChat {
  const channel = buildChat(room);
  return omitUndefined<ApiChat>({
    id: getCommentsChatId(room.roomId),
    type: 'chatTypeSuperGroup',
    title: channel.title,
    avatarPhotoId: channel.avatarPhotoId,
    membersCount: channel.membersCount,
    creationDate: channel.creationDate,
    adminRights: channel.adminRights,
    isOwner: channel.isOwner,
    // Like a discussion group commented in without joining, which keeps it out of the chat list
    isNotJoined: true,
  });
}

export function announceCommentsChat(room: Room) {
  const chat = buildCommentsChat(room);
  if (announcedCommentsChatIds.has(chat.id)) return chat.id;
  announcedCommentsChatIds.add(chat.id);
  onUpdate({ '@type': 'updateChat', id: chat.id, chat });
  return chat.id;
}

// Gives a channel post its comments button with the number of comments
export function announceCommentsInfo(room: Room, postEvent: MatrixEvent) {
  const postEventId = postEvent.getId();
  const messageId = postEventId ? findMessageId(postEventId) : undefined;
  if (!messageId) return;
  const commentsChatId = announceCommentsChat(room);
  const { count, recentSenders } = getThreadSummary(postEvent);
  onUpdate({
    '@type': 'updateThreadInfo',
    threadInfo: {
      isCommentsInfo: true,
      chatId: commentsChatId,
      originChannelId: getChatIdForRoom(room),
      originMessageId: messageId,
      messagesCount: count,
      recentReplierIds: recentSenders.map((userId) => getPeerIdByUserId(userId)),
    },
  });
}

const requestedSummaryIds = new Set<string>();

// Posts from /sync come without the number of comments, which the server adds when asked for the post itself
async function fetchExactThreadSummary(room: Room, postEvent: MatrixEvent) {
  const postId = postEvent.getId()!;
  if (requestedSummaryIds.has(postId)) return;
  requestedSummaryIds.add(postId);
  try {
    const raw = await client!.fetchRoomEvent(room.roomId, postId);
    const bundled = raw.unsigned?.['m.relations']?.[RelationType.Thread] as
      { count?: number; latest_event?: { sender?: string } } | undefined;
    setThreadSummaryCount(postId, bundled?.count || 0, bundled?.latest_event?.sender);
    announceCommentsInfo(room, postEvent);
  } catch {
    requestedSummaryIds.delete(postId);
  }
}

function isChannelPost(event: MatrixEvent) {
  return event.getType() === EventType.RoomMessage && !event.isRedacted()
    && event.getRelation()?.rel_type !== RelationType.Replace;
}

export function announceCommentThreads(room: Room, messages: ApiMessage[]) {
  if (!isRoomChannel(room) || !areCommentsEnabled(room)) return;
  messages.forEach(({ id, content }) => {
    if (content.action) return;
    const eventId = getEventId(room.roomId, Math.floor(id));
    const event = eventId ? room.findEventById(eventId) : undefined;
    if (!event || !isChannelPost(event)) return;
    announceCommentsInfo(room, event);
    if (!getThreadSummary(event).isExact) void fetchExactThreadSummary(room, event);
  });
}

// Turning comments on gives the posts already on screen their comment buttons
function announceTimelineCommentThreads(room: Room) {
  if (!isRoomChannel(room) || !areCommentsEnabled(room)) return;
  room.getLiveTimeline().getEvents().filter(isChannelPost).forEach((event) => {
    announceCommentsInfo(room, event);
    if (!getThreadSummary(event).isExact) void fetchExactThreadSummary(room, event);
  });
}

export function rememberReactionTargets(room: Room) {
  room.getLiveTimeline().getEvents().forEach((event) => {
    if (event.getType() !== EventType.Reaction) return;
    const relation = event.getRelation();
    if (relation?.event_id) reactionTargets.set(event.getId()!, relation.event_id);
  });
}

/* Prefetching reply targets so replies can reference message IDs */

export async function ensureReplyTargetsKnown(room: Room, events: MatrixEvent[]) {
  const unknown = new Set<string>();
  events.forEach((event) => {
    const targetId = getReplyTargetEventId(event);
    if (targetId && !findMessageId(targetId) && !room.findEventById(targetId)) unknown.add(targetId);
    if (targetId && !findMessageId(targetId)) {
      const target = room.findEventById(targetId);
      if (target) getMessageId(room.roomId, targetId, target.getTs());
    }
  });

  await Promise.all([...unknown].map(async (eventId) => {
    try {
      const raw = await getClient().fetchRoomEvent(room.roomId, eventId);
      if (raw.origin_server_ts) getMessageId(room.roomId, eventId, raw.origin_server_ts);
    } catch {
      // Target may be inaccessible
    }
  }));
}

/* Announcing entities to the UI */

export function announceUser(userId: string, room?: Room) {
  if (announcedUserIds.has(userId)) return;
  announcedUserIds.add(userId);
  const user = buildUser(userId, room);
  onUpdate({ '@type': 'updateUser', id: user.id, user });
  const status = buildUserStatus(userId);
  if (status) onUpdate({ '@type': 'updateUserStatus', userId: user.id, status });
}

setTodoCompleterHandler(announceUser);

export function markUsersAnnounced(userIds: string[]) {
  userIds.forEach((userId) => announcedUserIds.add(userId));
}

export function markChatAnnounced(chatId: string) {
  announcedChatIds.add(chatId);
}

function announceChat(room: Room, isForced?: boolean) {
  const chatId = getChatIdForRoom(room);
  const dmUserId = getDmUserId(room);
  if (dmUserId) announceUser(dmUserId, room);

  const chat = buildChat(room);
  onUpdate({
    '@type': 'updateChat',
    id: chatId,
    chat,
    readState: buildReadState(room),
  });

  if (!announcedChatIds.has(chatId) || isForced) {
    announcedChatIds.add(chatId);
    onUpdate({ '@type': 'updateChatJoin', id: chatId });
    const lastMessage = getLastMessage(room);
    if (lastMessage) {
      onUpdate({ '@type': 'updateChatLastMessage', id: chatId, lastMessage });
    }
  }
}

function sendUpdatedChat(room: Room) {
  if (!isSyncPrepared || !isRoomVisible(room)) return;
  onUpdate({ '@type': 'updateChat', id: getChatIdForRoom(room), chat: buildChat(room) });
}

/* Sending */

export function waitForRemoteEcho(txnId: string) {
  return new Promise<MatrixEvent>((resolve) => {
    pendingSends.set(txnId, resolve);
  });
}

export function cancelRemoteEcho(txnId: string) {
  pendingSends.delete(txnId);
}

/* Client events */

function subscribeToClient(matrixClient: MatrixClient) {
  matrixClient.on(ClientEvent.Sync, handleSync);
  matrixClient.on(RoomEvent.Timeline, handleTimeline);
  matrixClient.on(RoomEvent.Redaction, handleRedaction);
  matrixClient.on(RoomEvent.Receipt, handleReceipt);
  matrixClient.on(RoomEvent.MyMembership, handleMyMembership);
  matrixClient.on(RoomEvent.Name, sendUpdatedChat);
  matrixClient.on(RoomEvent.Tags, (event, room) => handleTags(room));
  matrixClient.on(RoomMemberEvent.Typing, handleTyping);
  matrixClient.on(RoomMemberEvent.Name, handleMemberUpdate);
  matrixClient.on(UserEvent.DisplayName, handleUserProfile);
  matrixClient.on(UserEvent.AvatarUrl, handleUserProfile);
  matrixClient.on(ClientEvent.AccountData, handleAccountData);
  matrixClient.on(ClientEvent.ToDeviceEvent, handleToDeviceEvent);
  matrixClient.on(MatrixEventEvent.Decrypted, handleDecrypted);
  matrixClient.on(HttpApiEvent.SessionLoggedOut, handleLoggedOut);
}

// Short hiccups recover within a couple of seconds; the "waiting for network" state is only shown after that
const CONNECTING_STATE_DELAY_MS = 2500;
let connectingStateTimeout: ReturnType<typeof setTimeout> | undefined;
let isConnectingStateShown = false;

// The SDK retries every 5-10 seconds; probing more often brings the connection back sooner after an outage
const RECONNECT_PROBE_INTERVAL_MS = 3000;
let reconnectProbeInterval: ReturnType<typeof setInterval> | undefined;

function startReconnectProbes() {
  if (reconnectProbeInterval) return;
  reconnectProbeInterval = setInterval(retryConnectionNow, RECONNECT_PROBE_INTERVAL_MS);
}

function stopReconnectProbes() {
  clearInterval(reconnectProbeInterval);
  reconnectProbeInterval = undefined;
}

function scheduleConnectingState() {
  startReconnectProbes();
  if (connectingStateTimeout || isConnectingStateShown) return;
  connectingStateTimeout = setTimeout(() => {
    connectingStateTimeout = undefined;
    isConnectingStateShown = true;
    onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
  }, CONNECTING_STATE_DELAY_MS);
}

function clearConnectingState() {
  stopReconnectProbes();
  clearTimeout(connectingStateTimeout);
  connectingStateTimeout = undefined;
  if (!isConnectingStateShown) return;
  isConnectingStateShown = false;
  onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });
}

// Reconnects right away when the device regains connectivity instead of waiting for the next retry
export function retryConnectionNow() {
  const syncState = client?.getSyncState();
  if (syncState === SyncState.Error || syncState === SyncState.Reconnecting) {
    client!.retryImmediately();
  } else {
    stopReconnectProbes();
  }
}

self.addEventListener('online', retryConnectionNow);

function handleSync(state: SyncState, prevState: SyncState | null) {
  if (state === SyncState.Prepared || (state === SyncState.Syncing && !isSyncPrepared)) {
    isSyncPrepared = true;
    computeDirectRooms();
    getVisibleRooms().forEach(rememberReactionTargets);
    autoJoinInvites();
    startLastSeenPolling();
    startVerifiedBadgesPolling();
    startExpirySweep();
    syncDeferred.resolve();
    // The config may have been loaded before the account data arrived
    onUpdate({ '@type': 'updateConfig' });
    stopReconnectProbes();
    clearTimeout(connectingStateTimeout);
    connectingStateTimeout = undefined;
    isConnectingStateShown = false;
    onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateReady' });
    return;
  }

  if (state === SyncState.Error || state === SyncState.Reconnecting) {
    scheduleConnectingState();
    return;
  }

  if (state === SyncState.Syncing) {
    if (prevState === SyncState.Error || prevState === SyncState.Reconnecting) {
      clearConnectingState();
    }
    sendChangedUnreadCounts();
    saveSyncCacheThrottled();
  }
}

const SYNC_CACHE_SAVE_INTERVAL_MS = 15000;
let lastSyncCacheSaveAt = 0;

// The SDK persists its sync cache only every few minutes; a stale cache replays already-handled events on reload
function saveSyncCacheThrottled() {
  if (!client || Date.now() - lastSyncCacheSaveAt < SYNC_CACHE_SAVE_INTERVAL_MS) return;
  lastSyncCacheSaveAt = Date.now();
  void client.store.save(true).catch(() => undefined);
}

function sendChangedUnreadCounts() {
  getVisibleRooms().forEach((room) => {
    const count = getUnreadCount(room);
    if (lastUnreadCounts.get(room.roomId) === count) return;
    const isFirst = !lastUnreadCounts.has(room.roomId);
    lastUnreadCounts.set(room.roomId, count);
    if (isFirst) return;
    onUpdate({
      '@type': 'updateChat',
      id: getChatIdForRoom(room),
      chat: {},
      readState: {
        unreadCount: count,
        unreadMentionsCount: room.getUnreadNotificationCount(NotificationCountType.Highlight) || 0,
      },
    });
  });
}

let unreadCountsTimeout: ReturnType<typeof setTimeout> | undefined;

function scheduleUnreadCountsUpdate() {
  if (unreadCountsTimeout) return;
  unreadCountsTimeout = setTimeout(() => {
    unreadCountsTimeout = undefined;
    sendChangedUnreadCounts();
  }, 0);
}

export function rememberUnreadCount(room: Room) {
  lastUnreadCounts.set(room.roomId, getUnreadCount(room));
}

function autoJoinInvites() {
  if (!client) return;
  client.getRooms()
    .filter((room) => room.getMyMembership() === 'invite')
    .forEach((room) => {
      void client!.joinRoom(room.roomId).catch(() => undefined);
    });
}

function handleTimeline(
  event: MatrixEvent,
  room: Room | undefined,
  toStartOfTimeline: boolean | undefined,
  removed: boolean,
  data: { liveEvent?: boolean },
) {
  if (!room || toStartOfTimeline || removed || !data.liveEvent || !isSyncPrepared) return;
  void handleLiveEvent(event, room);
}

async function handleLiveEvent(event: MatrixEvent, room: Room) {
  if (event.isEncrypted()) {
    await client?.decryptEventIfNeeded(event);
  }

  const type = event.getType();
  const relation = event.getRelation();

  if (type === EventType.Direct) return;

  if (type === EventType.RoomMember || type === EventType.RoomPowerLevels || type === EventType.RoomAvatar
    || type === EventType.RoomName || type === EventType.RoomTopic || type === PERMISSIONS_EVENT) {
    if (type === EventType.RoomMember && computeDirectRooms()) {
      announceChat(room, true);
    } else if (type === EventType.RoomMember) {
      // The SDK applies the sync summary with the new member count only after processing the events
      setTimeout(() => sendUpdatedChat(room), 0);
    } else {
      sendUpdatedChat(room);
      if (type === EventType.RoomPowerLevels) announceTimelineCommentThreads(room);
    }
    if (type === EventType.RoomMember && event.getStateKey()) {
      const userId = event.getStateKey()!;
      announcedUserIds.delete(userId);
      announceUser(userId, room);
    }
  }

  if (type === MEMBER_TAG_EVENT) {
    const userId = event.getStateKey()?.slice(MEMBER_TAG_KEY_PREFIX.length);
    if (event.getStateKey()?.startsWith(MEMBER_TAG_KEY_PREFIX) && userId) {
      onUpdate({
        '@type': 'updateChatParticipantRank',
        id: getChatIdForRoom(room),
        userId: getPeerIdByUserId(userId),
        rank: getMemberTag(room, userId) || '',
      });
    }
    return;
  }

  if (type.startsWith(CALL_EVENT_PREFIX)) {
    handleCallEvent(event, room);
    return;
  }

  if (!isRoomVisible(room)) return;

  const context = getChatContext(room);
  if (!announcedChatIds.has(context.chatId)) {
    announceChat(room);
  }

  if (type === EventType.Reaction && relation?.event_id) {
    reactionTargets.set(event.getId()!, relation.event_id);
    sendReactionsUpdate(room, relation.event_id);
    return;
  }

  if (type === TODO_UPDATE_EVENT && relation?.event_id) {
    const target = room.findEventById(relation.event_id);
    // Encrypted updates join the relations only after decryption listeners have run
    if (target) setTimeout(() => sendMessageUpdate(room, target), 0);
    return;
  }

  if (relation?.rel_type === RelationType.Replace && relation.event_id) {
    const target = room.findEventById(relation.event_id);
    if (target) sendMessageUpdate(room, target);
    return;
  }

  const txnId = event.getUnsigned().transaction_id;
  const pendingResolve = txnId ? pendingSends.get(txnId) : undefined;
  if (pendingResolve) {
    pendingSends.delete(txnId!);
    pendingResolve(event);
    return;
  }

  await ensureReplyTargetsKnown(room, [event]);
  const message = buildApiMessage(event, room, { ...context, withComments: true });
  if (!message) return;

  if (event.isDecryptionFailure()) undecryptableEventIds.add(event.getId()!);

  const sender = event.getSender();
  if (sender) announceUser(sender, room);

  const commentRootId = isCommentEvent(event) ? getCommentRootEventId(event) : undefined;
  if (commentRootId) announceCommentsChat(room);

  onUpdate({
    '@type': 'newMessage',
    chatId: message.chatId,
    id: message.id,
    message,
  });

  if (commentRootId) {
    const post = room.findEventById(commentRootId);
    if (post && addCommentToSummary(post, event)) announceCommentsInfo(room, post);
  } else if (context.isChannel && areCommentsEnabled(room)) {
    announceCommentsInfo(room, event);
  }
}

// Calls only happen in private chats; the main thread runs the call and answers through `sendMatrixCallEvent`
function handleCallEvent(event: MatrixEvent, room: Room) {
  const sender = event.getSender();
  const dmUserId = getDmUserId(room);
  if (!sender || !dmUserId || (sender !== dmUserId && sender !== myUserId)) return;
  onUpdate({
    '@type': 'updateMatrixCallEvent',
    userId: getPeerIdByUserId(dmUserId),
    isOwn: sender === myUserId,
    eventType: event.getType(),
    content: event.getContent(),
    age: event.getLocalAge(),
  });
}

function sendMessageUpdate(room: Room, event: MatrixEvent) {
  const message = buildApiMessage(event, room, { ...getChatContext(room), withComments: true });
  if (!message) return;
  onUpdate({
    '@type': 'updateMessage',
    chatId: message.chatId,
    id: message.id,
    message,
    isFull: true,
  });
}

export function buildMessageForEvent(room: Room, event: MatrixEvent): ApiMessage | undefined {
  return buildApiMessage(event, room, { ...getChatContext(room), withComments: true });
}

function sendReactionsUpdate(room: Room, targetEventId: string) {
  const target = room.findEventById(targetEventId);
  const messageId = findMessageId(targetEventId);
  if (!target || !messageId) return;
  const reactions = buildReactions(room, target, getChatContext(room)) || { results: [] };
  onUpdate({
    '@type': 'updateMessageReactions',
    chatId: getKnownCommentRootId(targetEventId) ? getCommentsChatId(room.roomId) : getChatIdForRoom(room),
    id: messageId,
    reactions,
  });
}

function handleRedaction(event: MatrixEvent, room: Room) {
  if (!isSyncPrepared) return;
  const redactedId = event.event.redacts || event.getContent().redacts;
  if (!redactedId || !isRoomVisible(room)) return;

  const reactionTarget = reactionTargets.get(redactedId);
  if (reactionTarget) {
    reactionTargets.delete(redactedId);
    // Relations are updated after the redaction is applied
    setTimeout(() => sendReactionsUpdate(room, reactionTarget), 0);
    return;
  }

  const messageId = findMessageId(redactedId);
  if (!messageId) return;
  const commentRootId = getKnownCommentRootId(redactedId);
  onUpdate({
    '@type': 'deleteMessages',
    chatId: commentRootId ? getCommentsChatId(room.roomId) : getChatIdForRoom(room),
    ids: [messageId],
  });
  if (commentRootId) {
    removeCommentFromSummary(commentRootId, redactedId);
    const post = room.findEventById(commentRootId);
    if (post) announceCommentsInfo(room, post);
  }
}

const VIEWS_UPDATE_POSTS = 50;

// Someone read up to a point in a channel: the latest posts get their new view counts
function announcePostViews(room: Room, chatId: string) {
  room.getLiveTimeline().getEvents().slice(-VIEWS_UPDATE_POSTS).forEach((post) => {
    const postId = post.getId();
    const messageId = postId ? findMessageId(postId) : undefined;
    if (!messageId || post.isState() || isCommentEvent(post)) return;
    onUpdate({
      '@type': 'updateMessage', chatId, id: messageId, message: { viewsCount: countPostViews(room, post) },
    });
  });
}

function handleReceipt(event: MatrixEvent, room: Room) {
  if (!isSyncPrepared || !isRoomVisible(room)) return;
  const content = event.getContent() as Record<string, Record<string, Record<string, unknown>>>;
  const readers = new Set<string>();
  Object.values(content).forEach((receiptTypes) => {
    Object.values(receiptTypes).forEach((users) => {
      Object.keys(users).forEach((userId) => readers.add(userId));
    });
  });

  const chatId = getChatIdForRoom(room);
  if (isRoomChannel(room)) announcePostViews(room, chatId);
  const readState: Record<string, number | undefined> = {};
  if (readers.has(myUserId)) {
    readState.lastReadInboxMessageId = getReadUpToMessageId(room, myUserId);
    readState.unreadCount = getUnreadCount(room);
  }
  if ([...readers].some((userId) => userId !== myUserId)) {
    readState.lastReadOutboxMessageId = getOthersReadUpToMessageId(room, getChatContext(room));
  }
  if (!Object.keys(readState).length) return;

  onUpdate({
    '@type': 'updateChat',
    id: chatId,
    chat: {},
    readState,
  });
}

function handleMyMembership(room: Room, membership: string, prevMembership?: string) {
  if (!isSyncPrepared) return;

  if (membership === 'invite') {
    void client?.joinRoom(room.roomId).catch(() => undefined);
    return;
  }

  computeDirectRooms();

  if (membership === 'join' && prevMembership !== 'join') {
    rememberUnreadCount(room);
    announceChat(room, true);
    return;
  }

  if (membership === 'leave' || membership === 'ban') {
    const chatId = getChatIdForRoom(room);
    announcedChatIds.delete(chatId);
    onUpdate({ '@type': 'updateChatLeave', id: chatId });
  }
}

function handleTags(room: Room) {
  if (!isSyncPrepared || !isRoomVisible(room)) return;
  sendUpdatedChat(room);
  onUpdate({
    '@type': 'updateChatListType',
    id: getChatIdForRoom(room),
    folderId: room.tags['m.lowpriority'] ? 1 : 0,
  });
  sendPinnedChats();
}

export function getPinnedChatIds() {
  return getVisibleRooms()
    .filter((room) => room.tags['m.favourite'])
    .sort((a, b) => (a.tags['m.favourite'].order ?? 1) - (b.tags['m.favourite'].order ?? 1))
    .map(getChatIdForRoom);
}

function sendPinnedChats() {
  onUpdate({ '@type': 'updatePinnedChatIds', ids: getPinnedChatIds() });
}

function handleTyping(event: MatrixEvent, member: RoomMember) {
  if (!isSyncPrepared || member.userId === myUserId || !client) return;
  const room = client.getRoom(member.roomId);
  if (!room || !isRoomVisible(room)) return;
  announceUser(member.userId, room);
  onUpdate({
    '@type': 'updateChatTypingStatus',
    id: getChatIdForRoom(room),
    peerId: getPeerIdByUserId(member.userId),
    typingStatus: member.typing ? { type: 'typing', timestamp: Date.now() } : undefined,
  });
}

function handleMemberUpdate(event: MatrixEvent, member: RoomMember) {
  if (!isSyncPrepared || !announcedUserIds.has(member.userId) || !client) return;
  const room = client.getRoom(member.roomId) || undefined;
  const user = buildUser(member.userId, room);
  onUpdate({ '@type': 'updateUser', id: user.id, user });
}

function handleUserProfile(event: MatrixEvent | undefined, user: User) {
  if (!announcedUserIds.has(user.userId)) return;
  const apiUser = buildUser(user.userId);
  onUpdate({ '@type': 'updateUser', id: apiUser.id, user: apiUser });
  if (user.userId === myUserId) void sendCurrentUser();
  const dmRoomId = dmRoomIdByUserId.get(user.userId);
  const dmRoom = dmRoomId ? client?.getRoom(dmRoomId) : undefined;
  if (dmRoom) sendUpdatedChat(dmRoom);
}

function handleToDeviceEvent(event: MatrixEvent) {
  const sender = event.getSender();
  if (event.getType() === STORY_VIEW_EVENT && sender) handleStoryViewEvent(sender, event.getContent());
}

function handleAccountData(event: MatrixEvent) {
  if (isSyncPrepared) handleFoldersAccountData(event);
  // The config holds the quick reaction, which may have been changed on another device
  if (isSyncPrepared && event.getType() === QUICK_REACTION_EVENT) onUpdate({ '@type': 'updateConfig' });
  if (isSyncPrepared) handleReactionUsageAccountData(event);
  if (event.getType() !== EventType.Direct || !isSyncPrepared) return;
  if (computeDirectRooms()) {
    getVisibleRooms().forEach((room) => announceChat(room, true));
  }
}

const KEYS_MISSING_PROMPT_INTERVAL_MS = 10 * 60 * 1000;
let lastKeysMissingPromptAt = 0;

// Messages this device cannot read mean it has not restored the account's keys yet, so the recovery prompt is shown again
function requestRecoveryPrompt() {
  if (Date.now() - lastKeysMissingPromptAt < KEYS_MISSING_PROMPT_INTERVAL_MS) return;
  lastKeysMissingPromptAt = Date.now();
  onUpdate({ '@type': 'updateEncryptionKeysMissing' });
}

function handleDecrypted(event: MatrixEvent) {
  const eventId = event.getId();
  const roomId = event.getRoomId();
  if (!eventId || !roomId || !client || !isSyncPrepared) return;
  // A decrypted event may turn out to be a hidden one, such as a reaction, which changes the unread count
  scheduleUnreadCountsUpdate();
  if (event.isDecryptionFailure()) requestRecoveryPrompt();
  if (!undecryptableEventIds.has(eventId) || event.isDecryptionFailure()) return;
  undecryptableEventIds.delete(eventId);
  const room = client.getRoom(roomId);
  if (room) sendMessageUpdate(room, event);
}

export function markUndecryptable(event: MatrixEvent) {
  if (event.isDecryptionFailure()) undecryptableEventIds.add(event.getId()!);
}

function handleLoggedOut() {
  onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateBroken' });
}
