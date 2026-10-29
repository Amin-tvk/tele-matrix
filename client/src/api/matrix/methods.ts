import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  Direction,
  EventType,
  MatrixEvent as MatrixEventClass,
  MsgType,
  NotificationCountType,
  Preset,
  PushRuleKind,
  RelationType,
  TimelineWindow,
  Visibility,
} from 'matrix-js-sdk';

import type { ForwardMessagesParams, SendMessageParams, ThreadId } from '../../types';
import type {
  ApiAttachment,
  ApiChat,
  ApiChatBannedRights,
  ApiChatMember,
  ApiDraft,
  ApiGlobalMessageSearchType,
  ApiMessage,
  ApiMessageEntity,
  ApiMessageSearchType,
  ApiNewMediaTodo,
  ApiNotifyPeerType,
  ApiOnProgress,
  ApiPeer,
  ApiPeerNotifySettings,
  ApiReaction,
  ApiSendMessageAction,
  ApiSession,
  ApiSticker,
  ApiThreadInfo,
  ApiTodoItem,
  ApiUser,
  ApiUserStatus,
} from '../types';
import type { PackImage } from './stickersState';
import { ApiMessageEntityTypes, MAIN_THREAD_ID } from '../types';

import { MUTE_INDEFINITE_TIMESTAMP, SCHEDULED_WHEN_ONLINE } from '../../config';
import { getEmojiOnlyCountForMessage } from '../../global/helpers/getEmojiOnlyCountForMessage';
import buildUploadingMedia from '../../util/buildUploadingMedia';
import { addTimestampEntities } from '../../util/dates/timestamp';
import { omitUndefined, unique } from '../../util/iteratees';
import { getMessageKey } from '../../util/keys/messageKey';
import { getServerTime } from '../../util/serverTime';
import {
  buildApiChatMember,
  buildApiUser,
  buildApiUserStatus,
  countPostViews,
  getLocalpart,
  getMemberTag,
  getReplyTargetEventId,
  getRoomPowerLevels,
  isDisplayableEvent,
  isMentioningUser,
  isRoomChannel,
  normalizeReactionKey,
  POWER_LEVEL_ADMIN,
} from './builders';
import {
  announceCommentsChat,
  announceCommentsInfo,
  announceCommentThreads,
  announceUser,
  buildChat,
  buildCommentsChat,
  buildMessageForEvent,
  buildReadState,
  buildUser,
  buildUserStatus,
  computeDirectRooms,
  ensureReplyTargetsKnown,
  fetchCurrentApiUser,
  getChatContext,
  getChatIdForRoom,
  getClient,
  getDmUserId,
  getMyPeerId,
  getMyUserId,
  getPinnedChatIds,
  getRoomByChatId,
  getVisibleRooms,
  hasClient,
  markChatAnnounced,
  markUndecryptable,
  markUsersAnnounced,
  onUpdate,
  rememberProfile,
  rememberUnreadCount,
  setDmRoom,
  waitForSync,
} from './client';
import {
  areCommentsEnabled, COMMENT_EVENT, getThreadSummary, isCommentEvent, isCommentsChatId, setThreadSummary,
} from './comments';
import {
  DEVICE_DISPLAY_NAME, FORWARD_KEY, MEMBER_TAG_EVENT, MEMBER_TAG_KEY_PREFIX, PERMISSIONS_EVENT, PUSH_APP_ID, PUSH_GATEWAY_URL, ROUND_VIDEO_KEY,
  THUMBNAIL_SEPARATOR,
} from './constants';
import { findRoomByAddress, searchPublicRooms, withTimeout } from './directory';
import { buildHtmlFromFormattedText } from './html';
import {
  decodeMxc,
  encodeMxc,
  findMessageId,
  getEventId,
  getMessageId,
  getNextLocalMessageId,
  getPeerIdByUserId,
  getUserIdByPeerId,
  isUserPeerId,
} from './ids';
import { uploadContent, uploadFile } from './media';
import { recordReactionUsage } from './reactionUsage';
import { RETENTION_EVENT } from './retention';
import { retryOnNetworkError } from './retry';
import { scheduleRoomEvent } from './scheduled';
import { addRecentSticker } from './stickers';
import {
  findPackImage, getShortNameBySetId, LOTTIE_MIME, PACK_KEY, STICKER_MARKER, VIDEO_STICKER_MIME,
} from './stickersState';
import { FORWARDED_STORY_KEY, getUserStories, STORY_REPLY_KEY } from './storiesState';
import { buildTodoContent, buildTodoUpdateContent, TODO_UPDATE_EVENT } from './todo';

const WINDOW_PAGE_SIZE = 50;
const MAX_PAGINATION_ROUNDS = 30;
const ROOM_WAIT_TIMEOUT_MS = 15000;
const TYPING_TIMEOUT_MS = 6000;
const WAVEFORM_MAX_TELEGRAM = 31;
const WAVEFORM_MAX_MATRIX = 1024;
const USER_DIRECTORY_LIMIT = 20;

function getServerFromUserId(userId: string) {
  return userId.slice(userId.indexOf(':') + 1);
}
const TEXT_DEFAULT_EMOJI_START = 0x2000;
const TEXT_DEFAULT_EMOJI_END = 0x2BFF;

const pendingTxnIds = new Set<string>();
const sentEventIds = new Set<string>();

export function isPendingTransaction(txnId?: string) {
  return Boolean(txnId && pendingTxnIds.has(txnId));
}

export function consumeSentEvent(eventId: string) {
  return sentEventIds.delete(eventId);
}

/* Helpers */

function requireRoom(chat: Pick<ApiChat, 'id'> | Pick<ApiPeer, 'id'>) {
  return getRoomByChatId(chat.id);
}

function getUserIdForPeer(peer: Pick<ApiPeer, 'id'>) {
  return getUserIdByPeerId(peer.id);
}

export function waitForRoom(roomId: string) {
  const client = getClient();
  return new Promise<Room | undefined>((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const room = client.getRoom(roomId);
      if (room && room.getMyMembership() === 'join') {
        resolve(room);
        return;
      }
      if (Date.now() - startedAt > ROOM_WAIT_TIMEOUT_MS) {
        resolve(room || undefined);
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function updateDirectAccountData(userId: string, roomId: string) {
  const client = getClient();
  const direct = { ...(client.getAccountData(EventType.Direct)?.getContent() || {}) } as Record<string, string[]>;
  direct[userId] = unique([roomId, ...(direct[userId] || [])]);
  await client.setAccountData(EventType.Direct, direct);
}

async function ensureRoomForChat(chat: ApiChat) {
  const existing = requireRoom(chat);
  if (existing) return existing;
  if (!isUserPeerId(chat.id)) return undefined;

  const userId = getUserIdByPeerId(chat.id);
  if (!userId) return undefined;

  const myUserId = getMyUserId();
  const { room_id: roomId } = await getClient().createRoom({
    is_direct: userId !== myUserId,
    invite: userId !== myUserId ? [userId] : undefined,
    preset: Preset.TrustedPrivateChat,
    visibility: Visibility.Private,
  });
  setDmRoom(userId, roomId);
  await updateDirectAccountData(userId, roomId);
  const room = await waitForRoom(roomId);
  setDmRoom(userId, roomId);
  return room;
}

function collectUserIds(events: MatrixEvent[]) {
  const userIds = new Set<string>();
  events.forEach((event) => {
    const sender = event.getSender();
    if (sender) userIds.add(sender);
    if (event.getType() === EventType.RoomMember && event.getStateKey()) userIds.add(event.getStateKey()!);
    const forwardSender = event.getContent()[FORWARD_KEY]?.sender;
    if (typeof forwardSender === 'string') userIds.add(forwardSender);
  });
  return userIds;
}

function buildUsers(userIds: Iterable<string>, room?: Room) {
  const users: ApiUser[] = [];
  const userStatusesById: Record<string, ApiUserStatus> = {};
  const ids: string[] = [];
  for (const userId of userIds) {
    const user = buildUser(userId, room);
    users.push(user);
    ids.push(userId);
    const status = buildUserStatus(userId);
    if (status) userStatusesById[user.id] = status;
  }
  markUsersAnnounced(ids);
  return { users, userStatusesById };
}

function isRoomArchived(room: Room) {
  return Boolean(room.tags['m.lowpriority']);
}

function isRoomMuted(room: Room) {
  const rules = getClient().pushRules?.global;
  if (!rules) return false;
  const roomRule = rules.room?.find((rule) => rule.rule_id === room.roomId);
  if (roomRule && roomRule.enabled && !roomRule.actions.includes('notify' as never)) return true;
  const overrideRule = rules.override?.find((rule) => rule.rule_id === room.roomId);
  return Boolean(overrideRule?.enabled && !overrideRule.actions.includes('notify' as never));
}

function buildNotifySettings(room: Room): ApiPeerNotifySettings | undefined {
  return isRoomMuted(room) ? { mutedUntil: MUTE_INDEFINITE_TIMESTAMP } : undefined;
}

function buildMentions(entities: ApiMessageEntity[] | undefined) {
  const userIds = (entities || [])
    .filter((entity): entity is Extract<ApiMessageEntity, { userId: string }> => (
      entity.type === ApiMessageEntityTypes.MentionName
    ))
    .map((entity) => getUserIdByPeerId(entity.userId))
    .filter(Boolean);
  return { user_ids: unique(userIds) };
}

const USERNAME_MENTION_REGEX = /(^|[^\w@])@([a-z0-9._=\-/]+(?::[a-z0-9.-]+)?)/gi;

// Telegram clients send "@username" as plain text and let the server resolve it. Matrix only notifies users
// named in m.mentions, so usernames of room members are turned into proper mentions here
function addUsernameMentions(text: string, entities: ApiMessageEntity[] | undefined, room?: Room) {
  if (!room || !text.includes('@')) return entities;
  const domain = getClient().getDomain();
  const added: ApiMessageEntity[] = [];
  for (const match of text.matchAll(USERNAME_MENTION_REGEX)) {
    const name = match[2].replace(/[.:-]+$/, '');
    const offset = match.index + match[1].length;
    const length = name.length + 1;
    const userId = name.includes(':') ? `@${name.toLowerCase()}` : `@${name.toLowerCase()}:${domain}`;
    const member = room.getMember(userId);
    if (!member || member.membership !== 'join') continue;
    const overlaps = (entities || []).some((entity) => (
      entity.offset < offset + length && offset < entity.offset + entity.length
    ));
    if (overlaps) continue;
    added.push({
      type: ApiMessageEntityTypes.MentionName, offset, length, userId: getPeerIdByUserId(userId),
    });
  }
  if (!added.length) return entities;
  return [...(entities || []), ...added].sort((a, b) => a.offset - b.offset);
}

function buildTextContent(text: string, entities?: ApiMessageEntity[], room?: Room) {
  entities = addUsernameMentions(text, entities, room);
  const html = buildHtmlFromFormattedText({ text, entities }, getUserIdByPeerId);
  return omitUndefined({
    msgtype: MsgType.Text,
    body: text,
    format: html ? 'org.matrix.custom.html' : undefined,
    formatted_body: html,
    'm.mentions': buildMentions(entities),
  });
}

function getEventIdForMessage(room: Room, messageId: number) {
  return getEventId(room.roomId, Math.floor(messageId));
}

/* Auth and session */

export async function fetchCurrentUser() {
  const currentUser = await fetchCurrentApiUser();
  if (!currentUser) return;
  onUpdate({ '@type': 'updateCurrentUser', currentUser, currentUserFullInfo: {} });
}

/* Chats */

export async function fetchChats({
  limit, archived, withPinned,
}: {
  limit: number;
  offsetDate?: number;
  offsetPeer?: ApiPeer;
  offsetId?: number;
  archived?: boolean;
  withPinned?: boolean;
  lastLocalServiceMessageId?: number;
}) {
  await waitForSync();
  void limit;

  const rooms = getVisibleRooms()
    .filter((room) => (archived ? isRoomArchived(room) : !isRoomArchived(room)))
    .sort((a, b) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0));

  const chats: ApiChat[] = [];
  const messages: ApiMessage[] = [];
  const lastMessageByChatId: Record<string, number> = {};
  const threadReadStatesById: Record<string, ReturnType<typeof buildReadState>> = {};
  const threadInfos: ApiThreadInfo[] = [];
  const notifyExceptionById: Record<string, ApiPeerNotifySettings> = {};
  const draftsById: Record<string, ApiDraft> = {};
  const userIds = new Set<string>([getMyUserId()]);

  rooms.forEach((room) => {
    const chat = buildChat(room);
    chats.push(chat);
    markChatAnnounced(chat.id);
    rememberUnreadCount(room);

    const dmUserId = getDmUserId(room);
    if (dmUserId) userIds.add(dmUserId);

    const events = room.getLiveTimeline().getEvents();
    const context = getChatContext(room);
    for (let i = events.length - 1; i >= 0; i--) {
      const message = buildMessageForEvent(room, events[i]);
      // A comment isn't its channel's last message
      if (message && message.chatId === chat.id) {
        markUndecryptable(events[i]);
        messages.push(message);
        lastMessageByChatId[chat.id] = message.id;
        collectUserIds([events[i]]).forEach((userId) => userIds.add(userId));
        break;
      }
    }
    void context;

    threadReadStatesById[chat.id] = buildReadState(room);
    threadInfos.push({
      isCommentsInfo: false,
      chatId: chat.id,
      threadId: MAIN_THREAD_ID,
      lastMessageId: lastMessageByChatId[chat.id],
    });

    const notifySettings = buildNotifySettings(room);
    if (notifySettings) notifyExceptionById[chat.id] = notifySettings;
  });

  const { users, userStatusesById } = buildUsers(userIds);
  const chatIds = chats.map(({ id }) => id);
  const pinnedIds = getPinnedChatIds().filter((id) => chatIds.includes(id));

  return {
    chatIds,
    chats,
    users,
    userStatusesById,
    draftsById,
    orderedPinnedIds: withPinned ? pinnedIds : undefined,
    totalChatCount: chatIds.length,
    lastMessageByChatId,
    messages,
    notifyExceptionById,
    nextOffsetId: undefined,
    nextOffsetPeerId: undefined,
    nextOffsetDate: undefined,
    isFullyLoaded: true as const,
    threadReadStatesById,
    threadInfos,
  };
}

// Saved Messages are a regular note-to-self room, without Telegram's per-source dialogs
export function fetchSavedChats() {
  return Promise.resolve({
    chatIds: [] as string[],
    chats: [] as ApiChat[],
    users: [] as ApiUser[],
    userStatusesById: {},
    draftsById: {},
    orderedPinnedIds: [] as string[],
    totalChatCount: 0,
    lastMessageByChatId: {},
    messages: [] as ApiMessage[],
    notifyExceptionById: {},
    nextOffsetId: undefined,
    nextOffsetPeerId: undefined,
    nextOffsetDate: undefined,
    isFullyLoaded: true as const,
    threadReadStatesById: {},
    threadInfos: [] as ApiThreadInfo[],
  });
}

export async function fetchChat({ type, user }: {
  type: 'user' | 'self' | 'support'; user?: ApiUser; shouldRequestUpdate?: boolean;
}) {
  await waitForSync();
  const peerId = type === 'self' ? getMyPeerId() : user?.id;
  if (!peerId) return undefined;
  const room = getRoomByChatId(peerId);
  if (room) {
    const chatId = getChatIdForRoom(room);
    const roomChat = buildChat(room);
    markChatAnnounced(chatId);
    onUpdate({
      '@type': 'updateChat', id: chatId, chat: roomChat, readState: buildReadState(room),
    });
    return { chatId, chat: roomChat };
  }

  const userId = getUserIdByPeerId(peerId);
  if (!userId) return undefined;
  const apiUser = buildUser(userId);
  const chat: ApiChat = {
    id: peerId,
    type: 'chatTypePrivate',
    title: apiUser.firstName || getLocalpart(userId),
    avatarPhotoId: apiUser.avatarPhotoId,
  };
  // The DM room is created on the first sent message; until then the UI keeps this preview chat
  onUpdate({ '@type': 'updateChat', id: peerId, chat });
  return { chatId: peerId, chat };
}

export async function requestChatUpdate({ chat }: { chat: ApiChat; lastLocalMessage?: ApiMessage; noLastMessage?: boolean }) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return;
  onUpdate({
    '@type': 'updateChat',
    id: chat.id,
    chat: buildChat(room),
    readState: buildReadState(room),
  });
}

function buildMembers(room: Room) {
  const members: ApiChatMember[] = [];
  const adminMembersById: Record<string, ApiChatMember> = {};
  room.getJoinedMembers().forEach((member) => {
    const apiMember = buildApiChatMember(member, room);
    members.push(apiMember);
    if (apiMember.isAdmin || apiMember.isOwner) adminMembersById[apiMember.userId] = apiMember;
  });
  return { members, adminMembersById };
}

export async function fetchFullChat(chat: ApiChat) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;

  await room.loadMembersIfNeeded().catch(() => undefined);
  const { members, adminMembersById } = buildMembers(room);
  const topic = room.currentState.getStateEvents(EventType.RoomTopic, '')?.getContent()?.topic;
  const { userStatusesById } = buildUsers(room.getJoinedMembers().map(({ userId }) => userId), room);
  const fullChat = buildChat(room);
  // A channel with comments links to its discussion chat, which links back
  const isCommentsChat = isCommentsChatId(chat.id);
  const hasComments = isCommentsChat || (isRoomChannel(room) && areCommentsEnabled(room));
  const commentsChat = hasComments ? buildCommentsChat(room) : undefined;
  if (commentsChat) announceCommentsChat(room);
  const linkedChatId = isCommentsChat ? fullChat.id : commentsChat?.id;

  return {
    fullInfo: {
      linkedChatId,
      about: topic,
      members,
      adminMembersById,
      canViewMembers: true,
      // Matrix accepts any emoji as a reaction, so groups get the same full picker as private chats
      enabledReactions: { type: 'all' as const, areCustomAllowed: true as const },
      onlineCount: Object.values(userStatusesById).filter(({ type }) => type === 'userStatusOnline').length,
      isPreHistoryHidden: false,
    },
    chats: commentsChat && !isCommentsChat ? [fullChat, commentsChat] : [fullChat],
    userStatusesById,
    groupCall: undefined,
    membersCount: room.getJoinedMemberCount(),
    isForumAsMessages: undefined,
  };
}

export async function fetchMembers({
  chat, memberFilter, query,
}: {
  chat: ApiChat;
  memberFilter?: string;
  offset?: number;
  query?: string;
}) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;
  await room.loadMembersIfNeeded().catch(() => undefined);

  const lowerQuery = query?.toLowerCase();
  let { members } = buildMembers(room);
  if (memberFilter === 'admin') {
    members = members.filter(({ isAdmin, isOwner }) => isAdmin || isOwner);
  } else if (memberFilter === 'kicked') {
    members = room.getMembersWithMembership('ban').map((member) => buildApiChatMember(member, room));
  }
  if (lowerQuery) {
    members = members.filter(({ userId }) => {
      const matrixUserId = getUserIdByPeerId(userId) || '';
      const member = room.getMember(matrixUserId);
      return matrixUserId.toLowerCase().includes(lowerQuery) || member?.name.toLowerCase().includes(lowerQuery);
    });
  }

  const { users, userStatusesById } = buildUsers(
    members.map(({ userId }) => getUserIdByPeerId(userId)).filter(Boolean), room,
  );
  return {
    members, users, userStatusesById, chats: [],
  };
}

export async function fetchContactList() {
  await waitForSync();
  const myUserId = getMyUserId();
  const userIds = new Set<string>();
  getVisibleRooms().forEach((room) => {
    room.getJoinedMembers().forEach(({ userId }) => {
      if (userId !== myUserId) userIds.add(userId);
    });
  });
  const { users, userStatusesById } = buildUsers(userIds);
  return { users, userStatusesById };
}

export async function searchChats({ query }: { query: string }) {
  await waitForSync();
  const lowerQuery = query.trim().toLowerCase().replace(/^@/, '');
  if (!lowerQuery) return undefined;

  const accountResultIds: string[] = [];
  const globalResultIds: string[] = [];
  const chats: ApiChat[] = [];
  const userIds = new Set<string>();

  // A group or channel address on any server (#name:server), or public groups of this server by name
  const addressedChat = await findRoomByAddress(query).catch(() => undefined);
  const publicChats = addressedChat ? [addressedChat] : await searchPublicRooms(query.trim()).catch(() => []);
  publicChats.forEach((chat) => {
    chats.push(chat);
    globalResultIds.push(chat.id);
  });

  getVisibleRooms().forEach((room) => {
    const chat = buildChat(room);
    if (chat.title.toLowerCase().includes(lowerQuery)) {
      chats.push(chat);
      accountResultIds.push(chat.id);
      const dmUserId = getDmUserId(room);
      if (dmUserId) userIds.add(dmUserId);
    }
  });

  try {
    const { results } = await getClient().searchUserDirectory({ term: query.trim(), limit: USER_DIRECTORY_LIMIT });
    results.forEach((result) => {
      const peerId = getPeerIdByUserId(result.user_id);
      if (accountResultIds.includes(peerId)) return;
      userIds.add(result.user_id);
      globalResultIds.push(peerId);
      // Keep profile data from the directory for users we do not share rooms with
      rememberProfile(result.user_id, result.display_name, result.avatar_url);
    });
  } catch {
    // Directory search is optional
  }

  // Exact IDs resolve through the profile API even when the directory does not list the user
  const exactLocalpart = lowerQuery.split(':')[0];
  if (/^[a-z0-9._=\-/+]+$/.test(exactLocalpart)) {
    const client = getClient();
    const exactUserId = lowerQuery.includes(':') ? `@${lowerQuery}` : `@${lowerQuery}:${client.getDomain()}`;
    const exactPeerId = getPeerIdByUserId(exactUserId);
    if (!userIds.has(exactUserId) && exactUserId !== getMyUserId()) {
      try {
        const profile = await withTimeout(client.getProfileInfo(exactUserId));
        rememberProfile(exactUserId, profile.displayname, profile.avatar_url);
        userIds.add(exactUserId);
        globalResultIds.unshift(exactPeerId);
      } catch (err) {
        // Other servers (matrix.org among them) hide profiles from people who share no room with the user,
        // so only a definite "not found" means the user doesn't exist
        const isRemote = getServerFromUserId(exactUserId) !== client.getDomain();
        if (isRemote && !isMissingRemoteUser(err)) {
          userIds.add(exactUserId);
          globalResultIds.unshift(exactPeerId);
        }
      }
    }
  }

  // Results are rendered from global state, so every found user is sent to the UI first
  const users = [...userIds].map((userId) => buildUser(userId));
  users.forEach((user) => onUpdate({ '@type': 'updateUser', id: user.id, user }));
  markUsersAnnounced([...userIds]);
  return {
    accountResultIds: unique(accountResultIds),
    globalResultIds: unique(globalResultIds),
    users,
    chats,
  };
}

// A remote profile that is hidden still belongs to a real user; a missing one, or a server that can't be reached
// (a mistyped domain, say), doesn't, so no chat is started that could never deliver
function isMissingRemoteUser(err: unknown) {
  const { errcode, httpStatus, message } = (err || {}) as { errcode?: string; httpStatus?: number; message?: string };
  return errcode === 'M_NOT_FOUND' || (httpStatus !== undefined && httpStatus >= 500) || message === 'Timed out';
}

export async function getChatByUsername(username: string) {
  await waitForSync();
  const client = getClient();

  // Links carry either a full address or the local part of one on this server
  const address = username.startsWith('#') || username.startsWith('!') || username.includes('matrix.to')
    ? username : undefined;
  const addressedChat = address ? await findRoomByAddress(address).catch(() => undefined) : undefined;
  if (addressedChat) return { chat: addressedChat, user: undefined };

  const cleaned = username.replace(/^@/, '');
  const userId = cleaned.includes(':') ? `@${cleaned}` : `@${cleaned}:${client.getDomain()}`;
  try {
    type Profile = { displayname?: string; avatar_url?: string };
    const profile = await withTimeout(client.getProfileInfo(userId)).catch((err: { errcode?: string }): Profile => {
      // Profiles on other servers may be hidden; the user can still be messaged
      if (getServerFromUserId(userId) !== client.getDomain() && !isMissingRemoteUser(err)) return {};
      throw err;
    });
    rememberProfile(userId, profile.displayname, profile.avatar_url);
    const user = buildUser(userId);
    onUpdate({ '@type': 'updateUser', id: user.id, user });
    const chatResult = await fetchChat({ type: 'user', user });
    return chatResult ? { chat: chatResult.chat, user } : undefined;
  } catch {
    return undefined;
  }
}

async function createRoomForChat({
  title, about, userIds, isChannel,
}: { title: string; about?: string; userIds: string[]; isChannel?: boolean }) {
  const client = getClient();
  const { room_id: roomId } = await client.createRoom({
    name: title,
    topic: about || undefined,
    invite: userIds,
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    initial_state: [{ type: EventType.RoomHistoryVisibility, state_key: '', content: { history_visibility: 'shared' } }],
    power_level_content_override: isChannel ? { events_default: POWER_LEVEL_ADMIN } : undefined,
  });
  const room = await waitForRoom(roomId);
  if (!room) return undefined;
  computeDirectRooms();
  const chat = buildChat(room);
  markChatAnnounced(chat.id);
  onUpdate({ '@type': 'updateChat', id: chat.id, chat, readState: buildReadState(room) });
  onUpdate({ '@type': 'updateChatJoin', id: chat.id });
  return chat;
}

export async function createGroupChat({ title, users }: { title: string; users: ApiUser[] }) {
  const userIds = users.map(getUserIdForPeer).filter(Boolean);
  const chat = await createRoomForChat({ title, userIds });
  return chat ? { chat, missingUsers: [] } : undefined;
}

export async function createChannel({
  title, about, users, isBroadcast,
}: {
  title: string; about?: string; users?: ApiUser[]; isBroadcast?: true; isMegagroup?: true;
}) {
  const userIds = (users || []).map(getUserIdForPeer).filter(Boolean);
  const chat = await createRoomForChat({
    title, about, userIds, isChannel: Boolean(isBroadcast),
  });
  return chat ? { channel: chat, missingUsers: [] } : undefined;
}

export async function addChatMembers(chat: ApiChat, users: ApiUser[]) {
  const room = requireRoom(chat);
  if (!room) return undefined;
  const client = getClient();
  await Promise.all(users.map((user) => {
    const userId = getUserIdForPeer(user);
    return userId ? client.invite(room.roomId, userId).catch(() => undefined) : undefined;
  }));
  return [];
}

export async function deleteChatMember(chat: ApiChat, user: ApiUser) {
  const room = requireRoom(chat);
  const userId = getUserIdForPeer(user);
  if (!room || !userId) return undefined;
  await getClient().kick(room.roomId, userId);
  return true;
}

// Telegram removes group members by banning them from viewing messages, which keeps them in the
// "Removed users" list until unblocked. Restricting messages maps to a power level below the sending level
export async function updateChatMemberBannedRights({
  chat, peer, bannedRights,
}: { chat: ApiChat; peer: ApiPeer; bannedRights: ApiChatBannedRights; untilDate?: number }) {
  const room = requireRoom(chat);
  const userId = getUserIdForPeer(peer);
  if (!room || !userId) return undefined;
  const client = getClient();

  if (bannedRights.viewMessages) {
    await client.ban(room.roomId, userId);
    return true;
  }

  if (room.getMember(userId)?.membership === 'ban') {
    await client.unban(room.roomId, userId);
  }

  const levels = getRoomPowerLevels(room);
  const level = levels.getUserLevel(userId);
  const isMuted = Boolean(bannedRights.sendMessages || bannedRights.sendPlain);
  if (isMuted && level >= levels.messageLevel) {
    await client.setPowerLevel(room.roomId, userId, levels.messageLevel - 1);
  } else if (!isMuted && level < levels.messageLevel) {
    // When the group lets nobody write, an exception lifts this member to the writing level
    const isGroupMuted = levels.messageLevel > levels.usersDefault && levels.messageLevel < POWER_LEVEL_ADMIN;
    await client.setPowerLevel(room.roomId, userId, isGroupMuted ? levels.messageLevel : levels.usersDefault);
  }
  return true;
}

// Ordinary members' rights (the group's permissions screen) become the room's power levels. Writing stays above
// the members' level but below admins', or the group would turn into a channel
const MUTED_GROUP_LEVEL = 1;

export async function updateChatDefaultBannedRights({
  chat, bannedRights,
}: { chat: ApiChat; bannedRights: ApiChatBannedRights }) {
  const room = requireRoom(chat);
  if (!room || isRoomChannel(room)) return undefined;
  const client = getClient();
  const content = { ...(room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() || {}) };
  const { usersDefault } = getRoomPowerLevels(room);
  const events: Record<string, number> = { ...(content.events || {}) };
  const setLevel = (types: string[], isBanned: boolean | undefined, bannedLevel: number) => {
    types.forEach((type) => {
      events[type] = isBanned ? bannedLevel : usersDefault;
    });
  };

  const isMuted = Boolean(bannedRights.sendMessages || bannedRights.sendPlain);
  setLevel([EventType.RoomMessage, EventType.RoomMessageEncrypted], isMuted, usersDefault + MUTED_GROUP_LEVEL);
  setLevel([EventType.Sticker], isMuted || bannedRights.sendStickers || bannedRights.sendGifs,
    usersDefault + MUTED_GROUP_LEVEL);
  setLevel([EventType.Reaction], bannedRights.sendReactions, usersDefault + MUTED_GROUP_LEVEL);
  setLevel([EventType.RoomPinnedEvents], bannedRights.pinMessages, POWER_LEVEL_ADMIN);
  setLevel([EventType.RoomName, EventType.RoomAvatar, EventType.RoomTopic], bannedRights.changeInfo,
    POWER_LEVEL_ADMIN);
  setLevel([MEMBER_TAG_EVENT], bannedRights.editRank, POWER_LEVEL_ADMIN);
  const nextContent = {
    ...content,
    events,
    invite: bannedRights.inviteUsers ? POWER_LEVEL_ADMIN : usersDefault,
  };

  const banned = Object.fromEntries(Object.entries(bannedRights).filter(([key, value]) => key !== 'untilDate' && value));
  const permissions = room.currentState.getStateEvents(PERMISSIONS_EVENT, '')?.getContent();
  await Promise.all([
    client.sendStateEvent(room.roomId, EventType.RoomPowerLevels, nextContent as never, ''),
    JSON.stringify(permissions?.banned || {}) === JSON.stringify(banned)
      ? undefined
      : client.sendStateEvent(room.roomId, PERMISSIONS_EVENT as never, { banned } as never, ''),
  ]);
  return true;
}

async function leaveRoom(chat: Pick<ApiChat, 'id'>) {
  const room = requireRoom(chat);
  if (!room) return undefined;
  const client = getClient();
  await client.leave(room.roomId);
  await client.forget(room.roomId).catch(() => undefined);
  onUpdate({ '@type': 'updateChatLeave', id: chat.id });
  return true;
}

export function leaveChannel({ chat }: { chat: ApiChat }) {
  return leaveRoom(chat);
}

export async function deleteChatUser({ chat, user }: { chat: ApiChat; user: ApiUser; shouldRevokeHistory?: boolean }) {
  if (user.id === getMyPeerId()) return leaveRoom(chat);
  return deleteChatMember(chat, user);
}

export function deleteChat({ chatId }: { chatId: string }) {
  return leaveRoom({ id: chatId });
}

export function deleteChannel(chat: ApiChat) {
  return leaveRoom(chat);
}

export async function deleteHistory({ chat }: { chat: ApiPeer; shouldDeleteForAll?: boolean; maxId?: number }) {
  await leaveRoom(chat);
  onUpdate({ '@type': 'deleteHistory', chatId: chat.id });
}

export async function updateChatTitle(chat: ApiChat, title: string) {
  const room = requireRoom(chat);
  if (!room) return;
  await getClient().setRoomName(room.roomId, title);
}

export async function updateChatAbout(chat: ApiChat, about: string) {
  const room = requireRoom(chat);
  if (!room) return;
  await getClient().setRoomTopic(room.roomId, about);
  onUpdate({
    '@type': 'updateChatFullInfo',
    id: chat.id,
    fullInfo: { about },
  });
}

export async function editChatPhoto({ chatId, photo }: { chatId: string; accessHash?: string; photo?: File }) {
  const room = getRoomByChatId(chatId);
  if (!room) return undefined;
  const client = getClient();
  if (!photo) {
    await client.sendStateEvent(room.roomId, EventType.RoomAvatar, {}, '');
    return true;
  }
  const url = await uploadContent(photo, photo.name || 'avatar.jpg', photo.type || 'image/jpeg');
  await client.sendStateEvent(room.roomId, EventType.RoomAvatar, { url }, '');
  return true;
}

export async function toggleChatPinned({ chat, shouldBePinned }: { chat: ApiChat; shouldBePinned: boolean }) {
  const room = requireRoom(chat);
  if (!room) return;
  const client = getClient();
  if (shouldBePinned) {
    await client.setRoomTag(room.roomId, 'm.favourite', { order: 0.5 });
  } else {
    await client.deleteRoomTag(room.roomId, 'm.favourite');
  }
}

export async function toggleChatArchived({ chat, folderId }: { chat: ApiChat; folderId: number }) {
  const room = requireRoom(chat);
  if (!room) return undefined;
  const client = getClient();
  if (folderId === 1) {
    await client.setRoomTag(room.roomId, 'm.lowpriority', { order: 0.5 });
  } else {
    await client.deleteRoomTag(room.roomId, 'm.lowpriority');
  }
  return true;
}

export async function updateChatNotifySettings({
  chat, settings,
}: {
  chat: ApiChat | ApiUser;
  settings: Partial<ApiPeerNotifySettings>;
}) {
  const room = requireRoom(chat);
  if (!room) return;
  const client = getClient();
  const shouldMute = Boolean(settings.mutedUntil && settings.mutedUntil > getServerTime());

  if (shouldMute) {
    await client.addPushRule('global', PushRuleKind.Override, room.roomId, {
      actions: [],
      conditions: [{ kind: 'event_match', key: 'room_id', pattern: room.roomId }],
    } as never);
  } else {
    await client.deletePushRule('global', PushRuleKind.Override, room.roomId).catch(() => undefined);
    await client.deletePushRule('global', PushRuleKind.RoomSpecific, room.roomId).catch(() => undefined);
  }

  onUpdate({
    '@type': 'updateChatNotifySettings',
    chatId: chat.id,
    settings: shouldMute ? { mutedUntil: MUTE_INDEFINITE_TIMESTAMP } : { mutedUntil: 0 },
  });
}

export async function updateChatAdmin({
  chat, user, adminRights, rank,
}: { chat: ApiChat; user: ApiUser; adminRights: Record<string, unknown>; rank?: string }) {
  const room = requireRoom(chat);
  const userId = getUserIdForPeer(user);
  if (!room || !userId) return undefined;
  const isAdmin = Object.values(adminRights).some(Boolean);
  await getClient().setPowerLevel(room.roomId, userId, isAdmin ? POWER_LEVEL_ADMIN : 0);
  if (rank !== undefined && rank.trim() !== (getMemberTag(room, userId) || '')) {
    await setMemberTag(room, userId, rank);
  }
  return true;
}

function setMemberTag(room: Room, userId: string, tag: string) {
  const trimmed = tag.trim();
  return getClient().sendStateEvent(room.roomId, MEMBER_TAG_EVENT as never, (trimmed ? { tag: trimmed } : {}) as never, `${MEMBER_TAG_KEY_PREFIX}${userId}`);
}

export async function editChatParticipantRank({
  chat, peer, rank,
}: { chat: ApiChat; peer: ApiPeer; rank: string }) {
  const room = requireRoom(chat);
  const userId = getUserIdForPeer(peer);
  if (!room || !userId) return undefined;
  await setMemberTag(room, userId, rank);
  return true;
}

/* Messages */

async function loadEventWindow(room: Room, anchorEventId: string | undefined, anchorTs: number | undefined, {
  olderCount, newerCount,
}: { olderCount: number; newerCount: number }) {
  const client = getClient();
  const context = getChatContext(room);
  const timelineWindow = new TimelineWindow(client, room.getUnfilteredTimelineSet(), { windowLimit: Infinity });

  try {
    await timelineWindow.load(anchorEventId, WINDOW_PAGE_SIZE);
  } catch {
    await timelineWindow.load(undefined, WINDOW_PAGE_SIZE);
    anchorEventId = undefined;
  }

  const countDisplayable = (events: MatrixEvent[]) => events.filter((event) => isDisplayableEvent(event, context, room)).length;
  const getAnchorIndex = (events: MatrixEvent[]) => {
    if (anchorEventId) {
      const index = events.findIndex((event) => event.getId() === anchorEventId);
      if (index !== -1) return index;
    }
    if (anchorTs) {
      const index = events.findIndex((event) => event.getTs() >= anchorTs);
      return index === -1 ? events.length : index;
    }
    return events.length;
  };

  for (let i = 0; i < MAX_PAGINATION_ROUNDS; i++) {
    const events = timelineWindow.getEvents();
    if (countDisplayable(events.slice(0, getAnchorIndex(events))) >= olderCount) break;
    if (!timelineWindow.canPaginate(Direction.Backward)) break;
    if (!await timelineWindow.paginate(Direction.Backward, WINDOW_PAGE_SIZE)) break;
  }

  if (newerCount > 0) {
    for (let i = 0; i < MAX_PAGINATION_ROUNDS; i++) {
      const events = timelineWindow.getEvents();
      if (countDisplayable(events.slice(getAnchorIndex(events))) >= newerCount) break;
      if (!timelineWindow.canPaginate(Direction.Forward)) break;
      if (!await timelineWindow.paginate(Direction.Forward, WINDOW_PAGE_SIZE)) break;
    }
  }

  return timelineWindow.getEvents();
}

async function buildMessagesFromEvents(room: Room, events: MatrixEvent[]) {
  const client = getClient();
  await Promise.all(events.map((event) => (event.isEncrypted() ? client.decryptEventIfNeeded(event) : undefined)));
  await ensureReplyTargetsKnown(room, events);

  const messages: ApiMessage[] = [];
  const usedEvents: MatrixEvent[] = [];
  events.forEach((event) => {
    const message = buildMessageForEvent(room, event);
    if (!message) return;
    markUndecryptable(event);
    messages.push(message);
    usedEvents.push(event);
  });
  return { messages, usedEvents };
}

export async function fetchMessages({
  chat, threadId, offsetId, addOffset = 0, limit,
}: {
  chat: ApiChat;
  threadId?: ThreadId;
  offsetId?: number;
  isSavedDialog?: boolean;
  addOffset?: number;
  limit: number;
}) {
  await waitForSync();
  if (isCommentsChatId(chat.id)) {
    return fetchComments({
      chat, threadId, offsetId, addOffset, limit,
    });
  }
  const room = requireRoom(chat);
  if (!room) {
    return {
      messages: [], users: [], chats: [], count: 0, topics: [],
    };
  }

  const roundedOffsetId = offsetId ? Math.floor(offsetId) : undefined;
  const anchorEventId = roundedOffsetId ? getEventIdForMessage(room, roundedOffsetId) : undefined;
  const newerCount = addOffset < 0 ? -addOffset : 0;
  const olderCount = Math.max(limit - newerCount, 0) + Math.max(addOffset, 0);

  const events = await loadEventWindow(room, anchorEventId, roundedOffsetId, {
    olderCount: olderCount + 1,
    newerCount: newerCount + 1,
  });
  const { messages, usedEvents } = await buildMessagesFromEvents(room, events);
  // Comments under channel posts belong to the channel's discussion chat
  const chatMessages = messages.filter(({ chatId }) => chatId === chat.id);
  announceCommentThreads(room, chatMessages);

  // Telegram semantics: messages sorted newest first, starting after `offsetId` shifted by `addOffset`
  const sorted = chatMessages.sort((a, b) => b.id - a.id);
  let position = 0;
  if (offsetId) {
    position = sorted.findIndex(({ id }) => id < offsetId);
    if (position === -1) position = sorted.length;
  }
  const start = Math.max(0, position + addOffset);
  const slice = sorted.slice(start, start + limit);
  const sliceIds = new Set(slice.map(({ id }) => id));

  const { users } = buildUsers(collectUserIds(usedEvents.filter((event) => (
    sliceIds.has(findMessageId(event.getId()!)!)
  ))), room);

  const isStartReached = !room.getLiveTimeline().getPaginationToken(Direction.Backward)
    && slice.length < limit;

  return {
    messages: slice,
    users,
    chats: [],
    count: isStartReached ? slice.length : undefined,
    topics: [],
  };
}

/* Comments under channel posts */

const COMMENTS_PAGE_SIZE = 100;
const MAX_COMMENTS = 2000;

async function loadComments(room: Room, postEventId: string) {
  const client = getClient();
  const events: MatrixEvent[] = [];
  let from: string | undefined;
  do {
    const result = await client.relations(room.roomId, postEventId, RelationType.Thread, COMMENT_EVENT, {
      dir: Direction.Backward, limit: COMMENTS_PAGE_SIZE, from,
    });
    events.push(...result.events.filter(isCommentEvent));
    from = result.nextBatch || undefined;
  } while (from && events.length < MAX_COMMENTS);
  return events;
}

async function fetchComments({
  chat, threadId, offsetId, addOffset = 0, limit,
}: {
  chat: ApiChat; threadId?: ThreadId; offsetId?: number; addOffset?: number; limit: number;
}) {
  const room = requireRoom(chat);
  const postEventId = room && threadId ? getEventIdForMessage(room, Number(threadId)) : undefined;
  if (!room || !postEventId) {
    return {
      messages: [], users: [], chats: [], count: 0, topics: [],
    };
  }

  const events = await loadComments(room, postEventId);
  setThreadSummary(postEventId, events);
  const post = room.findEventById(postEventId);
  if (post) announceCommentsInfo(room, post);

  const { messages, usedEvents } = await buildMessagesFromEvents(room, events);
  const sorted = messages.sort((a, b) => b.id - a.id);
  let position = 0;
  if (offsetId) {
    position = sorted.findIndex(({ id }) => id < offsetId);
    if (position === -1) position = sorted.length;
  }
  const start = Math.max(0, position + addOffset);
  const slice = sorted.slice(start, start + limit);
  const { users } = buildUsers(collectUserIds(usedEvents), room);

  return {
    messages: slice,
    users,
    chats: [],
    count: sorted.length,
    topics: [],
  };
}

// Opening a post's comments: the post on top, shown in the channel's discussion chat
export async function fetchDiscussionMessage({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  await waitForSync();
  const room = requireRoom(chat);
  const postEventId = room ? getEventIdForMessage(room, messageId) : undefined;
  if (!room || !postEventId || !areCommentsEnabled(room)) return undefined;

  const [post] = await fetchEventsByIds(room, [postEventId]);
  const postMessage = post ? buildMessageForEvent(room, post) : undefined;
  if (!post || !postMessage) return undefined;

  const comments = await loadComments(room, postEventId);
  setThreadSummary(postEventId, comments);
  // The oldest comment marks where the thread's history starts
  const oldest = comments.reduce<MatrixEvent | undefined>((result, event) => (
    !result || event.getTs() < result.getTs() ? event : result
  ), undefined);
  const firstMessageId = oldest ? getMessageId(room.roomId, oldest.getId()!, oldest.getTs()) : messageId;

  const commentsChatId = announceCommentsChat(room);
  const topMessage: ApiMessage = { ...postMessage, chatId: commentsChatId };
  const { count, recentSenders } = getThreadSummary(post);
  const threadInfo: ApiThreadInfo = {
    isCommentsInfo: false,
    chatId: commentsChatId,
    threadId: messageId,
    fromChannelId: chat.id,
    fromMessageId: messageId,
    messagesCount: count,
    recentReplierIds: recentSenders.map((userId) => getPeerIdByUserId(userId)),
  };

  return {
    messages: [topMessage],
    topMessages: [topMessage],
    threadId: messageId,
    threadReadState: { unreadCount: 0 },
    threadInfo,
    lastMessageId: undefined,
    chatId: commentsChatId,
    firstMessageId,
  };
}

// Comments are switched by letting subscribers send the comment event type
export async function setChannelComments({ chat, isEnabled }: { chat: ApiChat; isEnabled: boolean }) {
  const room = requireRoom(chat);
  if (!room) return false;
  const client = getClient();
  // In an encrypted room every event is sent as the same encrypted type, so posting can't be told from commenting
  if (isEnabled && await isRoomEncrypted(room)) return 'encrypted' as const;

  const content = { ...(room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() || {}) };
  const events: Record<string, number> = { ...(content.events || {}) };
  if (isEnabled) {
    events[COMMENT_EVENT] = 0;
    // Subscribers react to comments and delete their own
    events[EventType.Reaction] ??= 0;
    events[EventType.RoomRedaction] ??= 0;
  } else {
    events[COMMENT_EVENT] = POWER_LEVEL_ADMIN;
  }
  await client.sendStateEvent(room.roomId, EventType.RoomPowerLevels, { ...content, events }, '');

  const commentsChatId = announceCommentsChat(room);
  onUpdate({
    '@type': 'updateChatFullInfo',
    id: chat.id,
    fullInfo: { linkedChatId: isEnabled ? commentsChatId : undefined },
  });
  return true;
}

async function fetchEventsByIds(room: Room, eventIds: string[]) {
  const client = getClient();
  return Promise.all(eventIds.map(async (eventId) => {
    const local = room.findEventById(eventId);
    if (local) return local;
    try {
      const raw = await client.fetchRoomEvent(room.roomId, eventId);
      const event = new MatrixEventClass(raw);
      if (event.isEncrypted()) await client.decryptEventIfNeeded(event);
      return event;
    } catch {
      return undefined;
    }
  }));
}

export async function fetchMessage({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  await waitForSync();
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, messageId) : undefined;
  if (!room || !eventId) return undefined;
  const [event] = await fetchEventsByIds(room, [eventId]);
  if (!event) return 'MESSAGE_DELETED' as const;
  const { messages, usedEvents } = await buildMessagesFromEvents(room, [event]);
  if (!messages[0]) return 'MESSAGE_DELETED' as const;
  const { users } = buildUsers(collectUserIds(usedEvents), room);
  return { message: messages[0], users };
}

export async function fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;
  const eventIds = messageIds.map((id) => getEventIdForMessage(room, id)).filter(Boolean);
  const events = (await fetchEventsByIds(room, eventIds)).filter(Boolean);
  const { messages } = await buildMessagesFromEvents(room, events);
  return messages;
}

/* Message search */

// Matrix has no server-side search for encrypted rooms, so history is paged from the server
// and matched on this device after decryption. A search continues from where the previous page stopped
const SEARCH_PAGE_SIZE = 100;
const SEARCH_MAX_PAGES_PER_REQUEST = 30;

type SearchMatch = { message: ApiMessage; event: MatrixEvent };
// `from` is the pagination token to continue with: `undefined` for the newest event, `null` once the start is reached
type SearchState = { from: string | null | undefined; pending: SearchMatch[] };
const searchStates = new Map<string, SearchState>();

type MessageSearchType = ApiMessageSearchType | ApiGlobalMessageSearchType;

function matchesSearch(message: ApiMessage, type: MessageSearchType | undefined, lowerQuery: string) {
  const { content } = message;
  if (lowerQuery) {
    const haystack = [
      content.text?.text, content.document?.fileName, content.audio?.title, content.audio?.performer,
    ].filter(Boolean).join('\n').toLowerCase();
    if (!haystack.includes(lowerQuery)) return false;
  }

  switch (type) {
    case 'media':
      return Boolean(content.photo || (content.video && !content.video.isRound && !content.video.isGif));
    case 'documents':
      return Boolean(content.document);
    case 'links':
      return Boolean(content.text?.entities?.some((entity) => (
        entity.type === ApiMessageEntityTypes.Url || entity.type === ApiMessageEntityTypes.TextUrl
      )) || /https?:\/\//i.test(content.text?.text || ''));
    case 'audio':
      return Boolean(content.audio);
    case 'voice':
      return Boolean(content.voice || content.video?.isRound);
    case 'gif':
      return Boolean(content.video?.isGif);
    case 'polls':
    case 'profilePhoto':
    case 'channels':
    case 'publicPosts':
      return false;
    default:
      return Boolean(lowerQuery) || Boolean(content.text);
  }
}

async function searchRoom(room: Room, {
  type, query, fromUserId, offsetId, limit,
}: {
  type?: MessageSearchType; query: string; fromUserId?: string; offsetId?: number; limit: number;
}) {
  const client = getClient();
  const lowerQuery = query.trim().toLowerCase();
  const getKey = (id?: number) => `${room.roomId}|${type}|${lowerQuery}|${fromUserId}|${id || 0}`;
  const state: SearchState = (offsetId && searchStates.get(getKey(offsetId))) || { from: undefined, pending: [] };
  let { from } = state;
  const found = [...state.pending];

  const mapper = client.getEventMapper({ preventReEmit: true, decrypt: true });
  for (let page = 0; page < SEARCH_MAX_PAGES_PER_REQUEST && found.length < limit && from !== null; page++) {
    const response = await client.createMessagesRequest(room.roomId, from ?? null, SEARCH_PAGE_SIZE, Direction.Backward);
    const events = response.chunk.map(mapper)
      .filter((event) => !fromUserId || event.getSender() === fromUserId);
    const { messages, usedEvents } = await buildMessagesFromEvents(room, events);
    messages.forEach((message, index) => {
      if (offsetId && message.id >= offsetId) return;
      if (matchesSearch(message, type, lowerQuery)) found.push({ message, event: usedEvents[index] });
    });
    from = response.end && response.chunk.length ? response.end : null;
  }

  found.sort((a, b) => b.message.id - a.message.id);
  const slice = found.slice(0, limit);
  const rest = found.slice(limit);
  const lastId = slice[slice.length - 1]?.message.id;
  if (lastId) searchStates.set(getKey(lastId), { from, pending: rest });

  return {
    messages: slice.map(({ message }) => message),
    usedEvents: slice.map(({ event }) => event),
    isComplete: from === null && !rest.length,
  };
}

export async function searchMessagesInChat({
  peer, type, query = '', offsetId, limit, fromPeer,
}: {
  peer: ApiPeer;
  isSavedDialog?: boolean;
  type?: MessageSearchType;
  query?: string;
  threadId?: ThreadId;
  offsetId?: number;
  addOffset?: number;
  limit: number;
  minDate?: number;
  maxDate?: number;
  fromPeer?: ApiPeer;
}) {
  await waitForSync();
  const room = requireRoom(peer);
  if (!room) {
    return {
      messages: [] as ApiMessage[], topics: [], userStatusesById: {}, totalCount: 0, nextOffsetId: undefined,
    };
  }

  const fromUserId = fromPeer ? getUserIdByPeerId(fromPeer.id) : undefined;
  const { messages, usedEvents, isComplete } = await searchRoom(room, {
    type, query, fromUserId, offsetId, limit,
  });
  const { users, userStatusesById } = buildUsers(collectUserIds(usedEvents), room);
  users.forEach((user) => onUpdate({ '@type': 'updateUser', id: user.id, user }));

  const nextOffsetId = !isComplete && messages.length ? messages[messages.length - 1].id : undefined;
  return {
    messages,
    topics: [],
    userStatusesById,
    // The exact number is unknown until the whole history is scanned
    totalCount: isComplete ? messages.length : messages.length + 1,
    nextOffsetId,
  };
}

export async function searchMessagesGlobal({
  query, type = 'text', limit,
}: {
  query: string;
  offsetRate?: number;
  offsetPeer?: ApiPeer;
  offsetId?: number;
  limit: number;
  type?: ApiGlobalMessageSearchType;
  context?: string;
  minDate?: number;
  maxDate?: number;
}) {
  await waitForSync();
  const lowerQuery = query.trim().toLowerCase();
  const results: ApiMessage[] = [];
  const userIds = new Set<string>();

  // Searches the history already loaded on this device, which covers recent messages of every chat
  getVisibleRooms().forEach((room) => {
    room.getLiveTimeline().getEvents().forEach((event) => {
      const message = buildMessageForEvent(room, event);
      if (!message || !matchesSearch(message, type, lowerQuery)) return;
      results.push(message);
      const sender = event.getSender();
      if (sender) userIds.add(sender);
    });
  });

  results.sort((a, b) => b.date - a.date || b.id - a.id);
  const messages = results.slice(0, limit);
  const { users, userStatusesById } = buildUsers(userIds);
  users.forEach((user) => onUpdate({ '@type': 'updateUser', id: user.id, user }));
  return {
    messages,
    topics: [],
    userStatusesById,
    totalCount: messages.length,
    nextOffsetId: undefined,
  };
}

export function sendMessageLocal(params: SendMessageParams) {
  if (params.scheduledAt === SCHEDULED_WHEN_ONLINE) params = { ...params, scheduledAt: undefined };
  const {
    chat, lastMessageId, text, entities, replyInfo, attachment, sticker, gif, groupedId, wasDrafted, todo,
  } = params;
  if (!chat) return undefined;

  const media = attachment ? buildUploadingMedia(attachment) : undefined;
  const formattedText = text ? addTimestampEntities({ text, entities, emojiOnlyCount: undefined }) : undefined;
  const replyToMsgId = replyInfo?.type === 'message' ? replyInfo.replyToMsgId : undefined;
  const replyToTopId = replyInfo?.type === 'message' ? replyInfo.replyToTopId : undefined;
  const { scheduledAt } = params;

  const message: ApiMessage = omitUndefined<ApiMessage>({
    id: getNextLocalMessageId(lastMessageId || Date.now()),
    chatId: chat.id,
    content: omitUndefined({
      text: formattedText,
      ...media,
      sticker,
      video: gif || media?.video,
      todo: todo ? { mediaType: 'todo' as const, todo: todo.todo } : undefined,
    }),
    date: scheduledAt || getServerTime(),
    isScheduled: scheduledAt ? true : undefined,
    isOutgoing: chat.type !== 'chatTypeChannel',
    senderId: getMyPeerId(),
    replyInfo: replyToMsgId ? { type: 'message', replyToMsgId, replyToTopId }
      : replyInfo?.type === 'story' ? { type: 'story', peerId: replyInfo.peerId, storyId: replyInfo.storyId } : undefined,
    groupedId,
    isInAlbum: groupedId && media && (media.photo || media.video) ? true : undefined,
    isForwardingAllowed: true,
    // Shown with a clock until the server has it, like in Telegram
    sendingState: 'messageSendingStatePending',
  });

  const emojiOnlyCount = getEmojiOnlyCountForMessage(message.content, message.groupedId);
  if (emojiOnlyCount && message.content.text) message.content.text.emojiOnlyCount = emojiOnlyCount;

  onUpdate({
    '@type': scheduledAt ? 'newScheduledMessage' : 'newMessage',
    id: message.id,
    chatId: chat.id,
    message,
    wasDrafted,
  });

  return Promise.resolve(message);
}

function getImageDimensions(attachment: ApiAttachment) {
  const dimensions = attachment.quick || attachment.sourceDimensions;
  return dimensions ? { w: dimensions.width, h: dimensions.height } : {};
}

// The room's encryption setting may be known only to the crypto engine (the SDK's own sends ask it too)
async function isRoomEncrypted(room: Room) {
  const client = getClient();
  return client.isRoomEncrypted(room.roomId)
    || Boolean(await client.getCrypto()?.isEncryptionEnabledInRoom(room.roomId));
}

const STILL_THUMBNAIL_MAX_SIDE = 800;

// The server has no thumbnails for an untyped GIF, so other apps get the first frame to show until it loads
async function uploadStillThumbnail(blob: Blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, STILL_THUMBNAIL_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const still = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const { url } = await uploadFile(still, 'thumbnail.jpg', 'image/jpeg', false);
    return { thumbnail_url: url, thumbnail_info: { mimetype: 'image/jpeg', size: still.size, w, h } };
  } catch {
    // Thumbnail is optional
    return undefined;
  }
}

async function buildAttachmentContent(
  room: Room, attachment: ApiAttachment, localMessage: ApiMessage, onProgress?: ApiOnProgress,
) {
  const isEncrypted = await isRoomEncrypted(room);
  const blob: Blob = attachment.blob
    || await fetch(attachment.compressedBlobUrl || attachment.blobUrl).then((response) => response.blob());
  const messageKey = getMessageKey(localMessage);
  const progress: ApiOnProgress | undefined = onProgress ? Object.assign((value: number) => {
    onProgress(value, messageKey);
  }, { get isCanceled() { return onProgress.isCanceled; } }) : undefined;

  const { mimeType, filename } = attachment;
  const isGifPhoto = !attachment.shouldSendAsFile && mimeType === 'image/gif';
  // Synapse renders animated thumbnails of every size, frame by frame, before it answers an image/gif upload
  // (a minute for a big GIF, past the CDN's timeout). Untyped uploads skip that, like encrypted files do
  const uploadMimeType = isGifPhoto && !isEncrypted ? 'application/octet-stream' : mimeType;
  const uploaded = await uploadFile(blob, filename, uploadMimeType, isEncrypted, progress);
  const source = uploaded.file ? { file: uploaded.file } : { url: uploaded.url };
  const baseInfo = { mimetype: mimeType, size: blob.size };

  if (attachment.voice) {
    return {
      msgtype: MsgType.Audio,
      body: filename || 'Voice message',
      ...source,
      info: { ...baseInfo, duration: Math.round(attachment.voice.duration * 1000) },
      'org.matrix.msc1767.audio': {
        duration: Math.round(attachment.voice.duration * 1000),
        waveform: attachment.voice.waveform.map((value) => Math.round(
          (value / WAVEFORM_MAX_TELEGRAM) * WAVEFORM_MAX_MATRIX,
        )),
      },
      'org.matrix.msc3245.voice': {},
    };
  }

  if (attachment.audio) {
    return {
      msgtype: MsgType.Audio,
      body: filename,
      filename,
      ...source,
      info: { ...baseInfo, duration: Math.round(attachment.audio.duration * 1000) },
    };
  }

  if (!attachment.shouldSendAsFile && mimeType.startsWith('image/')) {
    return {
      msgtype: MsgType.Image,
      body: filename,
      filename,
      ...source,
      info: {
        ...baseInfo,
        ...getImageDimensions(attachment),
        ...(isGifPhoto && !isEncrypted ? await uploadStillThumbnail(blob) : undefined),
      },
    };
  }

  if (!attachment.shouldSendAsFile && mimeType.startsWith('video/')) {
    let thumbnail: Record<string, unknown> = {};
    if (attachment.previewBlobUrl) {
      try {
        const previewBlob = await fetch(attachment.previewBlobUrl).then((r) => r.blob());
        const uploadedThumbnail = await uploadFile(previewBlob, 'thumbnail.jpg', previewBlob.type || 'image/jpeg', isEncrypted);
        thumbnail = {
          ...(uploadedThumbnail.file ? { thumbnail_file: uploadedThumbnail.file } : { thumbnail_url: uploadedThumbnail.url }),
          thumbnail_info: {
            mimetype: previewBlob.type || 'image/jpeg', size: previewBlob.size, ...getImageDimensions(attachment),
          },
        };
      } catch {
        // Thumbnail is optional
      }
    }
    return {
      msgtype: MsgType.Video,
      body: filename,
      filename,
      ...source,
      info: {
        ...baseInfo,
        ...getImageDimensions(attachment),
        duration: attachment.quick?.duration ? Math.round(attachment.quick.duration * 1000) : undefined,
        ...thumbnail,
      },
      // Telegram-style round video messages; other Matrix clients show them as regular videos
      ...(attachment.isRoundVideo && { [ROUND_VIDEO_KEY]: true }),
    };
  }

  return {
    msgtype: MsgType.File,
    body: filename,
    filename,
    ...source,
    info: baseInfo,
  };
}

async function sendRoomEvent(room: Room, type: string, content: Record<string, unknown>) {
  const client = getClient();
  const txnId = client.makeTxnId();
  pendingTxnIds.add(txnId);
  try {
    // Resent with the same transaction ID after a dropped connection, so the server never stores it twice
    const { event_id: eventId } = await retryOnNetworkError(() => {
      const failed = room.getPendingEvents().find((event) => event.getTxnId() === txnId);
      return failed
        ? client.resendEvent(failed, room)
        : client.sendEvent(room.roomId, type as never, content as never, txnId);
    });
    sentEventIds.add(eventId);
    return { eventId, txnId };
  } finally {
    pendingTxnIds.delete(txnId);
  }
}

function buildSentEvent(room: Room, eventId: string, type: string, content: Record<string, unknown>) {
  const existing = room.findEventById(eventId);
  if (existing && !existing.status) return existing;
  return new MatrixEventClass({
    event_id: eventId,
    type,
    content,
    sender: getMyUserId(),
    room_id: room.roomId,
    origin_server_ts: Date.now(),
  });
}

// Views of channel posts come from read receipts, which reach every member, so they are counted here
export function fetchMessageViews({ chat, ids }: { chat: ApiChat; ids: number[]; shouldIncrement?: boolean }) {
  const room = requireRoom(chat);
  if (!room || !isRoomChannel(room)) return Promise.resolve(undefined);
  const viewsInfo = ids.flatMap((id) => {
    const eventId = getEventIdForMessage(room, id);
    const event = eventId ? room.findEventById(eventId) : undefined;
    return event ? [{ id, views: countPostViews(room, event) }] : [];
  });
  return Promise.resolve({ viewsInfo });
}

// Auto-delete: the room's retention policy; the server needs `retention` enabled to purge old messages
export async function setHistoryTtl({ peer, period }: { peer: ApiPeer; period: number }) {
  const existing = getRoomByChatId(peer.id);
  const room = existing || (isUserPeerId(peer.id)
    ? await ensureRoomForChat({ id: peer.id, type: 'chatTypePrivate', title: '' }) : undefined);
  if (!room) return undefined;
  await getClient().sendStateEvent(
    room.roomId, RETENTION_EVENT as never, (period > 0 ? { max_lifetime: period * 1000 } : {}) as never, '',
  );
  onUpdate({ '@type': 'updatePeerHistoryTtl', id: peer.id, ttlPeriod: period > 0 ? period : undefined });
  return true;
}

// A forwarded story is sent as its picture or video, marked with the story so Tele opens the story itself
function buildForwardedStoryContent(
  story: { id: number; peerId: string }, text: string | undefined, entities: ApiMessageEntity[] | undefined, room: Room,
): Record<string, unknown> {
  const ownerId = getUserIdByPeerId(story.peerId);
  const stored = ownerId ? getUserStories(ownerId).find(({ id }) => id === story.id) : undefined;
  const caption = text ? buildTextContent(text, entities, room) : undefined;
  return {
    ...(stored?.content || { msgtype: MsgType.Text }),
    body: caption?.body || (stored ? 'Story' : 'A story'),
    ...(caption?.formatted_body && { format: caption.format, formatted_body: caption.formatted_body }),
    [FORWARDED_STORY_KEY]: { user_id: ownerId, story_id: story.id },
  };
}

// A sticker from a pack goes with the pack's details; one seen only in a message is rebuilt from what the UI has
function buildStickerContent(sticker: ApiSticker): Record<string, unknown> {
  const found = findPackImage(sticker.id);
  if (found) {
    return {
      body: found.image.body || sticker.emoji || 'Sticker',
      url: found.image.url,
      info: found.image.info || {},
      [PACK_KEY]: found.shortName,
    };
  }
  const [mediaId, thumbnailId] = sticker.id.split(THUMBNAIL_SEPARATOR);
  const pack = 'shortName' in sticker.stickerSetInfo ? sticker.stickerSetInfo.shortName
    : 'id' in sticker.stickerSetInfo ? getShortNameBySetId(sticker.stickerSetInfo.id) : undefined;
  return omitUndefined({
    body: sticker.emoji || 'Sticker',
    url: decodeMxc(mediaId),
    info: omitUndefined({
      w: sticker.width,
      h: sticker.height,
      mimetype: sticker.isLottie ? LOTTIE_MIME : sticker.isVideo ? VIDEO_STICKER_MIME : 'image/webp',
      thumbnail_url: thumbnailId ? decodeMxc(thumbnailId) : undefined,
    }),
    [PACK_KEY]: pack,
  });
}

export async function sendMessage(params: SendMessageParams, onProgress?: ApiOnProgress) {
  // Matrix can't hold a message until the other person comes online, so "send when online" sends it now
  if (params.scheduledAt === SCHEDULED_WHEN_ONLINE) params = { ...params, scheduledAt: undefined };
  const { chat } = params;
  if (!chat) return undefined;

  const localMessage = params.localMessage || await sendMessageLocal(params);
  if (!localMessage) return undefined;

  try {
    const room = await ensureRoomForChat(chat);
    if (!room) throw new Error('Chat is not available');

    const { text, entities, attachment, replyInfo } = params;
    let content: Record<string, unknown>;

    if (attachment) {
      content = await buildAttachmentContent(room, attachment, localMessage, onProgress);
      if (text) {
        const textContent = buildTextContent(text, entities, room);
        content = {
          ...content,
          body: textContent.body,
          format: textContent.format,
          formatted_body: textContent.formatted_body,
          'm.mentions': textContent['m.mentions'],
        };
      }
    } else if (params.sticker) {
      content = buildStickerContent(params.sticker);
    } else if (params.story) {
      content = buildForwardedStoryContent(params.story, text, entities, room);
    } else if (params.gif) {
      return undefined;
    } else if (params.todo) {
      content = buildTodoContent(params.todo);
    } else {
      content = buildTextContent(text || '', entities, room);
    }

    const replyToMsgId = replyInfo?.type === 'message' ? replyInfo.replyToMsgId : undefined;
    const replyEventId = replyToMsgId ? getEventIdForMessage(room, replyToMsgId) : undefined;
    const isComment = isCommentsChatId(chat.id);
    // Commenting on a post doesn't notify its author; replying to another comment does
    const isCommentOnPost = isComment && replyToMsgId === (
      (replyInfo?.type === 'message' && replyInfo.replyToTopId) || replyToMsgId
    );
    if (replyInfo?.type === 'story') {
      const ownerId = getUserIdByPeerId(replyInfo.peerId);
      if (ownerId) content[STORY_REPLY_KEY] = { user_id: ownerId, story_id: replyInfo.storyId };
    }
    if (replyEventId && !isCommentOnPost) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyEventId } };
      // Like in Telegram, the author of the replied message gets notified
      const replySender = room.findEventById(replyEventId)?.getSender();
      if (replySender && replySender !== getMyUserId()) {
        const mentions = (content['m.mentions'] || {}) as { user_ids?: string[] };
        content['m.mentions'] = { ...mentions, user_ids: unique([...(mentions.user_ids || []), replySender]) };
      }
    }

    // A comment is a thread reply to its post, and a reply to another comment when quoting one
    if (isComment) {
      const replyToTopId = replyInfo?.type === 'message' ? replyInfo.replyToTopId : undefined;
      const postEventId = getEventIdForMessage(room, replyToTopId || replyToMsgId!);
      content['m.relates_to'] = {
        rel_type: RelationType.Thread,
        event_id: postEventId,
        is_falling_back: !replyEventId || replyEventId === postEventId,
        'm.in_reply_to': { event_id: replyEventId || postEventId },
      };
    }
    // Comments are one event type, so a sticker there goes as an image marked as a sticker
    if (params.sticker && isComment) {
      content = { ...content, msgtype: MsgType.Image, [STICKER_MARKER]: true };
    }
    const eventType = isComment ? COMMENT_EVENT : params.sticker ? EventType.Sticker : EventType.RoomMessage;

    if (params.scheduledAt) {
      const scheduled = await scheduleRoomEvent(room, eventType, content, params.scheduledAt);
      if (!scheduled) throw new Error('Failed to schedule the message');
      onUpdate({
        '@type': 'updateScheduledMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message: scheduled,
      });
      return scheduled;
    }

    const { eventId } = await sendRoomEvent(room, eventType, content);
    if (params.sticker) {
      void addRecentSticker(content as PackImage, content[PACK_KEY] as string | undefined)
        .then(() => onUpdate({ '@type': 'updateRecentStickers' }));
    }
    const event = buildSentEvent(room, eventId, eventType, content);
    getMessageId(room.roomId, eventId, event.getTs());
    const message = buildMessageForEvent(room, event);
    if (!message) throw new Error('Failed to build sent message');

    onUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message,
    });
    return message;
  } catch (err) {
    if (onProgress?.isCanceled) return undefined;
    onUpdate({
      '@type': params.scheduledAt ? 'updateScheduledMessageSendFailed' : 'updateMessageSendFailed',
      chatId: chat.id,
      localId: localMessage.id,
      error: err instanceof Error ? err.message : 'Failed to send',
    });
    return undefined;
  }
}

export async function editMessage({
  chat, message, text, entities,
}: {
  chat: ApiChat;
  message: ApiMessage;
  text: string;
  entities?: ApiMessageEntity[];
  noWebPage?: boolean;
}) {
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, message.id) : undefined;
  if (!room || !eventId) return undefined;

  const original = room.findEventById(eventId);
  const originalContent = original?.getContent() || {};
  const newText = buildTextContent(text, entities, room);
  const newContent = originalContent.msgtype && originalContent.msgtype !== MsgType.Text
    ? {
      ...originalContent, body: newText.body, format: newText.format, formatted_body: newText.formatted_body,
    }
    : newText;
  delete (newContent as Record<string, unknown>)['m.relates_to'];

  onUpdate({
    '@type': 'updateMessage',
    chatId: chat.id,
    id: message.id,
    message: {
      content: { ...message.content, text: addTimestampEntities({ text, entities }) },
      isEdited: true,
      editDate: getServerTime(),
    },
  });

  // An edit has the type of the message it replaces
  await sendRoomEvent(room, isCommentsChatId(chat.id) ? COMMENT_EVENT : EventType.RoomMessage, {
    ...newContent,
    body: `* ${newText.body}`,
    formatted_body: newText.formatted_body ? `* ${newText.formatted_body}` : undefined,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: RelationType.Replace, event_id: eventId },
  });
  return true;
}

export async function editTodo({
  chat, message, todo,
}: { chat: ApiChat; message: ApiMessage; todo: ApiNewMediaTodo }) {
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, message.id) : undefined;
  if (!room || !eventId) return undefined;

  const newContent = buildTodoContent(todo);
  onUpdate({
    '@type': 'updateMessage',
    chatId: chat.id,
    id: message.id,
    message: {
      content: { ...message.content, todo: { ...message.content.todo, mediaType: 'todo', todo: todo.todo } },
      isEdited: true,
      editDate: getServerTime(),
    },
  });

  await sendRoomEvent(room, EventType.RoomMessage, {
    ...newContent,
    body: `* ${newContent.body}`,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: RelationType.Replace, event_id: eventId },
  });
  return true;
}

async function sendTodoUpdate(chat: ApiChat, messageId: number, update: Parameters<typeof buildTodoUpdateContent>[1]) {
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, messageId) : undefined;
  if (!room || !eventId) return undefined;

  await sendRoomEvent(room, TODO_UPDATE_EVENT, buildTodoUpdateContent(eventId, update));
  return true;
}

export function toggleTodoCompleted({
  chat, messageId, completedIds, incompletedIds,
}: { chat: ApiChat; messageId: number; completedIds: number[]; incompletedIds: number[] }) {
  return sendTodoUpdate(chat, messageId, {
    completed: completedIds.length ? completedIds : undefined,
    incompleted: incompletedIds.length ? incompletedIds : undefined,
  });
}

export function appendTodoList({
  chat, message, items,
}: { chat: ApiChat; message: ApiMessage; items: ApiTodoItem[] }) {
  return sendTodoUpdate(chat, message.id, { append: items });
}

export async function deleteMessages({
  chat, messageIds,
}: { chat: ApiChat; messageIds: number[]; shouldDeleteForAll?: boolean }) {
  const room = requireRoom(chat);
  if (!room) return;
  const client = getClient();
  const eventIds = messageIds.map((id) => getEventIdForMessage(room, id)).filter(Boolean);
  onUpdate({ '@type': 'deleteMessages', chatId: chat.id, ids: messageIds });
  await Promise.all(eventIds.map((eventId) => client.redactEvent(room.roomId, eventId).catch(() => undefined)));
}

export async function forwardMessages({
  fromChat, toChat, messages,
}: ForwardMessagesParams) {
  const fromRoom = requireRoom(fromChat);
  const toRoom = await ensureRoomForChat(toChat);
  if (!fromRoom || !toRoom) return;

  for (const message of messages) {
    const eventId = getEventIdForMessage(fromRoom, message.id);
    if (!eventId) continue;
    const [event] = await fetchEventsByIds(fromRoom, [eventId]);
    if (!event) continue;
    const content = { ...event.getContent() } as Record<string, unknown>;
    delete content['m.relates_to'];
    delete content['m.new_content'];
    const existingForward = content[FORWARD_KEY] as Record<string, unknown> | undefined;
    content[FORWARD_KEY] = existingForward || {
      sender: event.getSender(),
      ts: event.getTs(),
      room_id: fromRoom.roomId,
      event_id: eventId,
    };
    await sendRoomEvent(toRoom, event.getType(), content);
  }
}

function getMyReactionEvents(room: Room, eventId: string) {
  const relations = room.relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction);
  const myUserId = getMyUserId();
  return (relations?.getRelations() || [])
    .filter((event) => event.getSender() === myUserId && !event.isRedacted());
}

export async function sendReaction({
  chat, messageId, reactions,
}: { chat: ApiChat; messageId: number; reactions?: ApiReaction[]; shouldAddToRecent?: boolean }) {
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, messageId) : undefined;
  if (!room || !eventId) return undefined;
  const client = getClient();

  const wantedKeys = new Set((reactions || [])
    .filter((reaction): reaction is Extract<ApiReaction, { type: 'emoji' }> => reaction.type === 'emoji')
    .map(({ emoticon }) => normalizeReactionKey(emoticon)));
  const existing = getMyReactionEvents(room, eventId);
  const getKey = (event: MatrixEvent) => normalizeReactionKey(event.getRelation()?.key || '');
  const existingKeys = new Set(existing.map(getKey));

  // Reuse the exact key other clients used so the reactions are counted together
  const allAnnotationKeys = (room.relations.getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction)
    ?.getSortedAnnotationsByKey() || []).map(([key]) => key);
  const toMatrixKey = (key: string) => allAnnotationKeys.find((existingKey) => normalizeReactionKey(existingKey) === key)
    || (key.length === 1 && key.charCodeAt(0) >= TEXT_DEFAULT_EMOJI_START && key.charCodeAt(0) <= TEXT_DEFAULT_EMOJI_END
      ? `${key}\uFE0F` : key);

  await Promise.all([
    ...existing
      .filter((event) => !wantedKeys.has(getKey(event)))
      .map((event) => client.redactEvent(room.roomId, event.getId()!)),
    ...[...wantedKeys]
      .filter((key) => !existingKeys.has(key))
      .map((key) => client.sendEvent(room.roomId, EventType.Reaction, {
        'm.relates_to': { rel_type: RelationType.Annotation, event_id: eventId, key: toMatrixKey(key) },
      } as never)),
  ]);
  recordReactionUsage([...wantedKeys].filter((key) => !existingKeys.has(key)));
  return true;
}

function getPinnedEventIds(room: Room): string[] {
  return room.currentState.getStateEvents(EventType.RoomPinnedEvents, '')?.getContent()?.pinned || [];
}

export async function pinMessage({
  chat, messageId, isUnpin,
}: { chat: ApiChat; messageId: number; isUnpin: boolean; isOneSide?: boolean; isSilent?: boolean }) {
  const room = requireRoom(chat);
  const eventId = room ? getEventIdForMessage(room, messageId) : undefined;
  if (!room || !eventId) return;
  const pinned = getPinnedEventIds(room).filter((id) => id !== eventId);
  const nextPinned = isUnpin ? pinned : [eventId, ...pinned];
  await getClient().sendStateEvent(room.roomId, EventType.RoomPinnedEvents, { pinned: nextPinned }, '');
  onUpdate({
    '@type': 'updatePinnedIds', chatId: chat.id, messageIds: [messageId], isPinned: !isUnpin,
  });
}

export async function unpinAllMessages({ chat }: { chat: ApiChat; threadId?: ThreadId }) {
  const room = requireRoom(chat);
  if (!room) return;
  await getClient().sendStateEvent(room.roomId, EventType.RoomPinnedEvents, { pinned: [] }, '');
}

export async function fetchPinnedMessages({ chat }: { chat: ApiChat; threadId: ThreadId }) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;
  const events = (await fetchEventsByIds(room, getPinnedEventIds(room))).filter(Boolean);
  const { messages, usedEvents } = await buildMessagesFromEvents(room, events);
  const { users } = buildUsers(collectUserIds(usedEvents), room);
  return {
    messages: messages.map((message) => ({ ...message, isPinned: true })),
    users,
    chats: [],
  };
}

export async function markMessageListRead({
  chat, maxId = 0,
}: { chat: ApiChat; threadId?: ThreadId; maxId?: number }) {
  const room = requireRoom(chat);
  if (!room) return;
  const client = getClient();

  let eventId = maxId ? getEventIdForMessage(room, maxId) : undefined;
  let event = eventId ? room.findEventById(eventId) : undefined;
  if (!event) {
    const events = room.getLiveTimeline().getEvents();
    event = events.slice().reverse().find((item) => !item.status && (!maxId || item.getTs() <= maxId + 1));
    eventId = event?.getId();
  }
  if (!event || !eventId) return;

  // Hidden events after the last shown message (reactions, edits, redactions) would otherwise stay unread
  // on the server and bring the unread badge back
  const liveEvents = room.getLiveTimeline().getEvents();
  const index = liveEvents.indexOf(event);
  if (index !== -1) {
    const context = getChatContext(room);
    const later = liveEvents.slice(index + 1).filter((item) => !item.status && item.getId());
    if (later.length && !later.some((item) => isDisplayableEvent(item, context, room))) {
      event = later[later.length - 1];
      eventId = event.getId()!;
    }
  }

  try {
    await client.setRoomReadMarkers(room.roomId, eventId, event);
  } catch {
    // Read markers are best effort
  }
}

// Matrix receipts mark everything up to an event as read, so a message counts as seen by every member
// whose receipt points at it or at a later event. The receipt time is when they caught up to that point
function getReadReceipt(room: Room, userId: string) {
  const eventId = room.getEventReadUpTo(userId);
  if (!eventId) return undefined;
  const receipt = room.getReadReceiptForUserId(userId, false)
    || room.getReadReceiptForUserId(userId, true);
  const event = room.findEventById(eventId);
  const readUpToId = findMessageId(eventId) ?? (event ? Math.floor(event.getTs()) : receipt?.data.ts);
  if (!readUpToId) return undefined;
  return { readUpToId, date: Math.floor((receipt?.data.ts || event?.getTs() || 0) / 1000) || undefined };
}

export async function fetchSeenBy({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;
  const myUserId = getMyUserId();
  const sender = room.findEventById(getEventIdForMessage(room, messageId) || '')?.getSender() || myUserId;

  const seenByDates: Record<string, number> = {};
  room.getJoinedMembers().forEach(({ userId }) => {
    if (userId === myUserId || userId === sender) return;
    const receipt = getReadReceipt(room, userId);
    if (receipt && receipt.readUpToId >= Math.floor(messageId) && receipt.date) {
      seenByDates[getPeerIdByUserId(userId)] = receipt.date;
    }
  });

  const { users } = buildUsers(room.getJoinedMembers().map(({ userId }) => userId)
    .filter((userId) => seenByDates[getPeerIdByUserId(userId)]), room);
  users.forEach((user) => onUpdate({ '@type': 'updateUser', id: user.id, user }));

  return seenByDates;
}

export async function fetchOutboxReadDate({ chat, messageId }: { chat: ApiChat; messageId: number }) {
  await waitForSync();
  const room = requireRoom(chat);
  const userId = getUserIdByPeerId(chat.id);
  if (!room || !userId) return undefined;
  const receipt = getReadReceipt(room, userId);
  if (!receipt?.date || receipt.readUpToId < Math.floor(messageId)) return undefined;
  return { date: receipt.date };
}

export async function fetchUnreadMentions({ chat }: { chat: ApiChat; threadId?: ThreadId; offsetId?: number }) {
  await waitForSync();
  const room = requireRoom(chat);
  if (!room) return undefined;
  const myUserId = getMyUserId();
  const readUpTo = getReadReceipt(room, myUserId)?.readUpToId || 0;
  const events = room.getLiveTimeline().getEvents().filter((event) => (
    event.getTs() > readUpTo && event.getSender() !== myUserId && isMentioningUser(event, myUserId)
  ));
  const { messages } = await buildMessagesFromEvents(room, events);
  const unread = messages.filter((message) => message.id > readUpTo)
    .map((message) => ({ ...message, hasUnreadMention: true }));
  return {
    messages: unread,
    topics: [],
    totalCount: Math.max(unread.length, room.getUnreadNotificationCount(NotificationCountType.Highlight) || 0),
  };
}

// Matrix clears mention counts together with the read receipt, which is sent while reading the chat
export function readAllMentions(params: { chat: ApiChat; threadId?: ThreadId }) {
  void params;
  return Promise.resolve();
}

export async function markMessagesRead({ chat }: { chat: ApiChat; messageIds: number[] }) {
  await markMessageListRead({ chat });
}

export async function sendMessageAction({
  peer, action,
}: { peer: ApiPeer; threadId?: ThreadId; action: ApiSendMessageAction }) {
  const room = getRoomByChatId(peer.id);
  if (!room) return false;
  const isTyping = action.type !== 'cancel';
  await getClient().sendTyping(room.roomId, isTyping, isTyping ? TYPING_TIMEOUT_MS : 0).catch(() => undefined);
  return true;
}

export function saveDraft() {
  return Promise.resolve(true);
}

/* Users */

export async function fetchFullUser({ id }: { id: string; accessHash?: string }) {
  await waitForSync();
  const userId = getUserIdByPeerId(id);
  if (!userId) return undefined;
  const client = getClient();
  let user: ApiUser;
  try {
    const profile = await client.getProfileInfo(userId);
    user = buildApiUser(userId, profile.displayname, profile.avatar_url, getMyUserId(), userId !== getMyUserId());
  } catch {
    user = buildUser(userId);
  }
  const commonChatsCount = getVisibleRooms()
    .filter((room) => !getDmUserId(room) && room.getMember(userId)?.membership === 'join').length;

  return {
    user,
    fullInfo: { commonChatsCount },
    users: [user],
    chats: [],
  };
}

export async function fetchUsers({ users }: { users: ApiUser[] }) {
  await waitForSync();
  const userIds = users.map(getUserIdForPeer).filter(Boolean);
  const result = buildUsers(userIds);
  return { users: result.users, userStatusesById: result.userStatusesById };
}

export async function fetchCommonChats({ user }: { user: ApiUser; maxId?: string }) {
  await waitForSync();
  const userId = getUserIdForPeer(user);
  const chatIds = getVisibleRooms()
    .filter((room) => !getDmUserId(room) && userId && room.getMember(userId)?.membership === 'join')
    .map(getChatIdForRoom);
  return { chatIds, count: chatIds.length };
}

export async function updateProfile({ firstName, lastName }: { firstName?: string; lastName?: string; about?: string }) {
  const displayName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (displayName) await getClient().setDisplayName(displayName);
  const currentUser = await fetchCurrentApiUser();
  if (currentUser) {
    onUpdate({ '@type': 'updateUser', id: currentUser.id, user: currentUser });
  }
  return true;
}

export async function uploadProfilePhoto(file: File) {
  const client = getClient();
  const url = await uploadContent(file, file.name || 'avatar.jpg', file.type || 'image/jpeg');
  await client.setAvatarUrl(url);
  const currentUser = await fetchCurrentApiUser();
  if (currentUser) {
    onUpdate({ '@type': 'updateUser', id: currentUser.id, user: currentUser });
  }
  return undefined;
}

export async function fetchProfilePhotos({ peer }: { peer: ApiPeer; offset?: number; limit?: number }) {
  const avatarPhotoId = peer.avatarPhotoId;
  if (!avatarPhotoId) return { photos: [], count: 0, nextOffsetId: undefined };
  return {
    photos: [{
      mediaType: 'photo' as const,
      id: avatarPhotoId,
      date: 0,
      sizes: [{ type: 'x' as const, width: 640, height: 640 }],
    }],
    count: 1,
    nextOffsetId: undefined,
  };
}

export async function fetchAuthorizations() {
  const client = getClient();
  const { devices } = await client.getDevices();
  const currentDeviceId = client.getDeviceId();
  const authorizations: Record<string, ApiSession> = {};
  devices.forEach((device) => {
    const lastSeen = Math.floor((device.last_seen_ts || 0) / 1000);
    authorizations[device.device_id] = {
      hash: device.device_id,
      isCurrent: device.device_id === currentDeviceId,
      isOfficialApp: true,
      isPasswordPending: false,
      deviceModel: device.display_name || device.device_id,
      platform: '',
      systemVersion: '',
      appName: device.display_name || 'Matrix',
      appVersion: '',
      dateCreated: lastSeen,
      dateActive: lastSeen,
      ip: device.last_seen_ip || '',
      country: '',
      region: '',
      areCallsEnabled: false,
      areSecretChatsEnabled: false,
    };
  });
  return { authorizations, ttlDays: 365 };
}

type PushSubscriptionToken = { endpoint: string; keys: { p256dh: string; auth: string } };

function parsePushToken(token: string): PushSubscriptionToken | undefined {
  try {
    const parsed = JSON.parse(token) as PushSubscriptionToken;
    return parsed.endpoint && parsed.keys?.p256dh ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The browser push subscription becomes a Matrix pusher delivered through the Sygnal web push gateway
export async function registerDevice(token: string) {
  const subscription = parsePushToken(token);
  if (!subscription) return undefined;
  await waitForSync();
  await getClient().setPusher({
    kind: 'http',
    app_id: PUSH_APP_ID,
    pushkey: subscription.keys.p256dh,
    app_display_name: 'Peyvand',
    device_display_name: DEVICE_DISPLAY_NAME,
    lang: 'en',
    data: {
      url: PUSH_GATEWAY_URL,
      endpoint: subscription.endpoint,
      auth: subscription.keys.auth,
    } as never,
    append: false,
  });
  return true;
}

export async function unregisterDevice(token: string) {
  const subscription = parsePushToken(token);
  if (!subscription || !hasClient()) return undefined;
  await getClient().setPusher({
    kind: null,
    app_id: PUSH_APP_ID,
    pushkey: subscription.keys.p256dh,
  } as never).catch(() => undefined);
  return true;
}

const NOTIFY_DEFAULTS_EVENT_TYPE = 'im.peyvand.notify_defaults';
const DEFAULT_NOTIFY_SETTINGS: ApiPeerNotifySettings = { mutedUntil: 0, hasSound: true, shouldShowPreviews: true };
// Matrix default push rules that correspond to Telegram's per-type notification switches
const NOTIFY_PUSH_RULES: Partial<Record<ApiNotifyPeerType, string[]>> = {
  users: ['.m.rule.room_one_to_one', '.m.rule.encrypted_room_one_to_one'],
  groups: ['.m.rule.message', '.m.rule.encrypted'],
};

function getStoredNotifyDefaults() {
  return (getClient().getAccountData(NOTIFY_DEFAULTS_EVENT_TYPE as never)?.getContent() || {});
}

export async function fetchNotifyDefaultSettings() {
  await waitForSync();
  const stored = getStoredNotifyDefaults();
  return {
    users: { ...DEFAULT_NOTIFY_SETTINGS, ...stored.users },
    groups: { ...DEFAULT_NOTIFY_SETTINGS, ...stored.groups },
    channels: { ...DEFAULT_NOTIFY_SETTINGS, ...stored.channels },
  };
}

export async function updateNotificationSettings(peerType: ApiNotifyPeerType, {
  isMuted, shouldShowPreviews,
}: { isMuted?: boolean; shouldShowPreviews?: boolean }) {
  const client = getClient();
  const stored = getStoredNotifyDefaults();
  const current = { ...DEFAULT_NOTIFY_SETTINGS, ...stored[peerType] };
  const next: ApiPeerNotifySettings = {
    ...current,
    mutedUntil: isMuted === undefined ? current.mutedUntil : (isMuted ? MUTE_INDEFINITE_TIMESTAMP : 0),
    shouldShowPreviews: shouldShowPreviews ?? current.shouldShowPreviews,
  };
  await client.setAccountData(NOTIFY_DEFAULTS_EVENT_TYPE as never, { ...stored, [peerType]: next } as never);

  if (isMuted !== undefined) {
    await Promise.all((NOTIFY_PUSH_RULES[peerType] || []).map((ruleId) => (
      client.setPushRuleEnabled('global', PushRuleKind.Underride, ruleId, !isMuted).catch(() => undefined)
    )));
  }
  return true;
}

export function checkUsername() {
  return Promise.resolve({ result: false, error: 'USERNAME_NOT_MODIFIED' });
}

export { announceUser, buildApiUserStatus, decodeMxc, encodeMxc };
export { getRoomPowerLevels, getReplyTargetEventId };
