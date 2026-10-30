import type { MatrixEvent, Room, RoomMember } from 'matrix-js-sdk';
import {
  EventType, MatrixEvent as MatrixEventClass, MsgType, RelationType,
} from 'matrix-js-sdk';

import type {
  ApiAudio,
  ApiChat,
  ApiChatAdminRights,
  ApiChatBannedRights,
  ApiChatMember,
  ApiDocument,
  ApiFormattedText,
  ApiMessage,
  ApiMessageEntity,
  ApiMessageForwardInfo,
  ApiPeerReaction,
  ApiPhoto,
  ApiReactionCount,
  ApiReactions,
  ApiUser,
  ApiUserStatus,
  ApiVideo,
  ApiVoice,
  MediaContent,
} from '../types';
import type { ApiMessageAction } from '../types/messageActions';
import type { PackImage } from './stickersState';
import type { StoryRef } from './storiesState';
import { ApiMessageEntityTypes } from '../types';

import { getEmojiOnlyCountForMessage } from '../../global/helpers/getEmojiOnlyCountForMessage';
import { addTimestampEntities } from '../../util/dates/timestamp';
import { omitUndefined } from '../../util/iteratees';
import {
  COMMENT_EVENT, getCommentRootEventId, getCommentsChatId, isCommentEvent, rememberCommentEvent,
} from './comments';
import {
  FORWARD_KEY, MEMBER_TAG_EVENT, MEMBER_TAG_KEY_PREFIX, PERMISSIONS_EVENT, ROUND_VIDEO_KEY, THUMBNAIL_SEPARATOR, UNDECRYPTABLE_TEXT,
} from './constants';
import { parseHtmlToFormattedText, stripReplyFallback } from './html';
import {
  encodeMxc, findMessageId, getChatIdByRoomId, getMessageId, getPeerIdByUserId,
} from './ids';
import { getEncryptedFileMediaId, markGifMedia } from './media';
import { addMentionEntities } from './mentions';
import { getRoomTtlSeconds, isExpiredEvent, RETENTION_EVENT } from './retention';
import { buildApiSticker, PACK_KEY, STICKER_MARKER } from './stickersState';
import { FORWARDED_STORY_KEY, getStoriesSummary, STORY_REPLY_KEY } from './storiesState';
import { buildTodoMedia } from './todo';
import { getBadgeEmoji, isVerifiedId } from './verifiedState';

export const POWER_LEVEL_ADMIN = 50;
export const POWER_LEVEL_OWNER = 100;
const POWER_LEVEL_CREATOR = 1000;
const WAVEFORM_MAX_MATRIX = 1024;
const WAVEFORM_MAX_TELEGRAM = 31;

export type ChatContext = {
  chatId: string;
  isPrivate: boolean;
  isChannel: boolean;
  myUserId: string;
  resolvePeerId: (userId: string) => string;
  // Comments under channel posts are left out of the channel's own timeline
  withComments?: boolean;
};

export function getServerName(id: string) {
  return id.slice(id.indexOf(':') + 1);
}

export function getLocalpart(userId: string) {
  return userId.replace(/^@/, '').split(':')[0];
}

export function buildApiUser(
  userId: string,
  displayName: string | undefined,
  avatarUrl: string | undefined,
  myUserId: string,
  isContact?: boolean,
): ApiUser {
  const localpart = getLocalpart(userId);
  const homeServer = getServerName(userId);
  return omitUndefined<ApiUser>({
    id: getPeerIdByUserId(userId),
    isMin: false,
    type: 'userTypeRegular',
    firstName: displayName || localpart,
    usernames: [{ username: localpart, isActive: true }],
    hasUsername: true,
    phoneNumber: '',
    avatarPhotoId: avatarUrl ? encodeMxc(avatarUrl) : undefined,
    isSelf: userId === myUserId ? true : undefined,
    isContact: isContact ? true : undefined,
    // Sent as `false` too, so taking the tick away reaches the UI
    isVerified: isVerifiedId(userId),
    badgeEmoji: getBadgeEmoji(userId) || '',
    homeServer: homeServer && homeServer !== getServerName(myUserId) ? homeServer : undefined,
    // People with the blue tick can post stories; their avatars get the story ring
    ...getStoriesSummary(userId),
  });
}

export function buildApiUserFromMember(member: RoomMember, myUserId: string) {
  return buildApiUser(member.userId, member.rawDisplayName || member.name, member.getMxcAvatarUrl(), myUserId, true);
}

export function buildApiUserStatus(
  presence: string | undefined, lastActiveAgo: number | undefined, isCurrentlyActive: boolean | undefined,
): ApiUserStatus {
  if (presence === 'online' || isCurrentlyActive) {
    return { type: 'userStatusOnline', expires: Math.floor(Date.now() / 1000) + 300 };
  }
  if (lastActiveAgo !== undefined) {
    return { type: 'userStatusOffline', wasOnline: Math.floor((Date.now() - lastActiveAgo) / 1000) };
  }
  return { type: 'userStatusRecently' };
}

// Room versions 12+ (MSC4289) give room creators unlimited power without listing them in power levels
function getRoomCreators(room: Room) {
  const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, '');
  const creators = new Set<string>();
  if (!createEvent) return creators;
  const content = createEvent.getContent();
  const version = String(content.room_version || '1');
  const versionNumber = Number(version);
  const hasPrivilegedCreators = Number.isNaN(versionNumber) ? version.includes('hydra') : versionNumber >= 12;
  if (!hasPrivilegedCreators) return creators;
  creators.add(createEvent.getSender()!);
  (content.additional_creators || []).forEach((userId: string) => creators.add(userId));
  return creators;
}

export function getRoomPowerLevels(room: Room) {
  const content = room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() || {};
  const users: Record<string, number> = content.users || {};
  const events: Record<string, number> = content.events || {};
  const usersDefault: number = content.users_default ?? 0;
  const eventsDefault: number = content.events_default ?? 0;
  const stateDefault: number = content.state_default ?? 50;
  const creators = getRoomCreators(room);

  return {
    getUserLevel: (userId: string) => (creators.has(userId) ? POWER_LEVEL_CREATOR : users[userId] ?? usersDefault),
    messageLevel: events[EventType.RoomMessage] ?? eventsDefault,
    stickerLevel: events[EventType.Sticker] ?? eventsDefault,
    reactionLevel: events[EventType.Reaction] ?? eventsDefault,
    nameLevel: events[EventType.RoomName] ?? stateDefault,
    pinLevel: events[EventType.RoomPinnedEvents] ?? stateDefault,
    tagLevel: events[MEMBER_TAG_EVENT] ?? stateDefault,
    redactLevel: content.redact ?? 50,
    kickLevel: content.kick ?? 50,
    banLevel: content.ban ?? 50,
    inviteLevel: content.invite ?? 0,
    usersDefault,
  };
}

// Someone added to a group belongs to it right away, as in Telegram, though Matrix waits until their app accepts
export function getRoomMembers(room: Room) {
  return [...room.getJoinedMembers(), ...room.getMembersWithMembership('invite')];
}

export function getRoomMemberCount(room: Room) {
  return room.getJoinedMemberCount() + room.getInvitedMemberCount();
}

export function isRoomChannel(room: Room) {
  const { messageLevel, usersDefault } = getRoomPowerLevels(room);
  return messageLevel > usersDefault && messageLevel >= POWER_LEVEL_ADMIN;
}

function buildAdminRights(level: number, room: Room): ApiChatAdminRights | undefined {
  if (level < POWER_LEVEL_ADMIN) return undefined;
  const levels = getRoomPowerLevels(room);
  return omitUndefined<ApiChatAdminRights>({
    changeInfo: level >= levels.nameLevel ? true : undefined,
    postMessages: level >= levels.messageLevel ? true : undefined,
    editMessages: true,
    deleteMessages: level >= levels.redactLevel ? true : undefined,
    banUsers: level >= levels.kickLevel ? true : undefined,
    inviteUsers: level >= levels.inviteLevel ? true : undefined,
    pinMessages: level >= levels.pinLevel ? true : undefined,
    addAdmins: level >= POWER_LEVEL_OWNER ? true : undefined,
    manageRanks: level >= levels.tagLevel ? true : undefined,
  });
}

// Rights that only the app enforces, saved by the group's permissions screen
const STORED_RIGHTS = [
  'sendPhotos', 'sendVideos', 'sendRoundvideos', 'sendAudios', 'sendVoices', 'sendDocs', 'sendPolls', 'embedLinks',
] as const;

function getStoredBannedRights(room: Room) {
  const content = room.currentState.getStateEvents(PERMISSIONS_EVENT, '')?.getContent() || {};
  const banned: Record<string, unknown> = content.banned || {};
  return omitUndefined<ApiChatBannedRights>(Object.fromEntries(
    STORED_RIGHTS.map((key) => [key, banned[key] ? true : undefined]),
  ));
}

function buildBannedRights(level: number, room: Room): ApiChatBannedRights | undefined {
  const levels = getRoomPowerLevels(room);
  const isRestricted = level < POWER_LEVEL_ADMIN;
  const rights = omitUndefined<ApiChatBannedRights>({
    ...(isRestricted && !isRoomChannel(room) ? getStoredBannedRights(room) : undefined),
    sendMessages: level < levels.messageLevel ? true : undefined,
    sendMedia: level < levels.messageLevel ? true : undefined,
    sendPlain: level < levels.messageLevel ? true : undefined,
    sendStickers: level < levels.stickerLevel ? true : undefined,
    sendGifs: level < levels.stickerLevel ? true : undefined,
    sendReactions: level < levels.reactionLevel ? true : undefined,
    changeInfo: level < levels.nameLevel ? true : undefined,
    inviteUsers: level < levels.inviteLevel ? true : undefined,
    pinMessages: level < levels.pinLevel ? true : undefined,
    editRank: level < levels.tagLevel ? true : undefined,
  });
  if (rights.sendPhotos && rights.sendVideos && rights.sendRoundvideos && rights.sendAudios && rights.sendVoices
    && rights.sendDocs) {
    rights.sendMedia = true;
  }
  return Object.keys(rights).length ? rights : undefined;
}

// What an ordinary member may do: the group's permissions screen
export function buildDefaultBannedRights(room: Room) {
  if (isRoomChannel(room)) return undefined;
  return buildBannedRights(getRoomPowerLevels(room).usersDefault, room) || {};
}

export function buildApiChatFromRoom(
  room: Room,
  myUserId: string,
  dmUserId: string | undefined,
  dmUser?: ApiUser,
): ApiChat {
  const membership = room.getMyMembership();
  const createEvent = room.currentState.getStateEvents(EventType.RoomCreate, '');
  const isArchived = Boolean(room.tags['m.lowpriority']);

  if (dmUserId) {
    return omitUndefined<ApiChat>({
      id: getPeerIdByUserId(dmUserId),
      type: 'chatTypePrivate',
      title: dmUser ? [dmUser.firstName, dmUser.lastName].filter(Boolean).join(' ') : getLocalpart(dmUserId),
      avatarPhotoId: dmUser?.avatarPhotoId,
      isNotJoined: membership !== 'join' ? true : undefined,
      creationDate: createEvent ? Math.floor(createEvent.getTs() / 1000) : undefined,
      folderId: isArchived ? 1 : undefined,
      isListed: true,
      isVerified: isVerifiedId(dmUserId),
      ttlPeriod: getRoomTtlSeconds(room),
    });
  }

  const levels = getRoomPowerLevels(room);
  const myLevel = levels.getUserLevel(myUserId);
  const isChannel = isRoomChannel(room);
  const alias = room.getCanonicalAlias();

  return omitUndefined<ApiChat>({
    id: getChatIdByRoomId(room.roomId),
    type: isChannel ? 'chatTypeChannel' : 'chatTypeSuperGroup',
    title: room.name || getLocalpart(room.roomId),
    avatarPhotoId: room.getMxcAvatarUrl() ? encodeMxc(room.getMxcAvatarUrl()!) : undefined,
    membersCount: getRoomMemberCount(room) || undefined,
    creationDate: createEvent ? Math.floor(createEvent.getTs() / 1000) : undefined,
    isOwner: myLevel >= POWER_LEVEL_OWNER ? true : undefined,
    adminRights: buildAdminRights(myLevel, room),
    currentUserBannedRights: buildBannedRights(myLevel, room),
    defaultBannedRights: buildDefaultBannedRights(room),
    isNotJoined: membership !== 'join' ? true : undefined,
    isForbidden: membership === 'leave' || membership === 'ban' ? true : undefined,
    // Room addresses on this server can be changed in the group type settings
    usernames: alias
      ? [{ username: alias, isActive: true, isEditable: alias.endsWith(`:${getServerName(myUserId)}`) || undefined }]
      : undefined,
    hasUsername: alias ? true : undefined,
    areSignaturesShown: isChannel ? true : undefined,
    folderId: isArchived ? 1 : undefined,
    ttlPeriod: getRoomTtlSeconds(room),
    isListed: true,
    isVerified: isVerifiedId(room.roomId),
  });
}

export function buildApiChatMember(member: RoomMember, room: Room): ApiChatMember {
  const level = getRoomPowerLevels(room).getUserLevel(member.userId);
  const memberEvent = member.events.member;
  return omitUndefined<ApiChatMember>({
    userId: getPeerIdByUserId(member.userId),
    joinedDate: memberEvent ? Math.floor(memberEvent.getTs() / 1000) : undefined,
    inviterId: memberEvent && memberEvent.getSender() !== member.userId
      ? getPeerIdByUserId(memberEvent.getSender()!) : undefined,
    isOwner: level >= POWER_LEVEL_OWNER ? true : undefined,
    isAdmin: level >= POWER_LEVEL_ADMIN && level < POWER_LEVEL_OWNER ? true : undefined,
    adminRights: level >= POWER_LEVEL_ADMIN ? buildAdminRights(level, room) : undefined,
    rank: getMemberTag(room, member.userId),
  });
}

export function isMentioningUser(event: MatrixEvent, userId: string) {
  const content = event.getContent();
  const mentions = content['m.mentions'];
  if (mentions) return Boolean(mentions.room || mentions.user_ids?.includes(userId));
  // Older clients only put mentions in the message itself
  const html = typeof content.formatted_body === 'string' ? content.formatted_body : '';
  return html.includes(`matrix.to/#/${userId}`) || html.includes(`matrix.to/#/${encodeURIComponent(userId)}`);
}

export function getMemberTag(room: Room, userId: string): string | undefined {
  const tag = room.currentState.getStateEvents(MEMBER_TAG_EVENT, `${MEMBER_TAG_KEY_PREFIX}${userId}`)?.getContent()?.tag;
  return typeof tag === 'string' && tag.trim() ? tag.trim() : undefined;
}

// Telegram stores 5-bit waveform samples, Matrix uses 0..1024
function convertWaveform(waveform?: number[]) {
  if (!waveform?.length) return undefined;
  return waveform.map((value) => Math.round((Math.min(value, WAVEFORM_MAX_MATRIX) / WAVEFORM_MAX_MATRIX)
    * WAVEFORM_MAX_TELEGRAM));
}

function getMediaId(content: Record<string, any>) {
  if (content.file?.url) return getEncryptedFileMediaId(content.file);
  if (typeof content.url === 'string' && content.url.startsWith('mxc://')) return encodeMxc(content.url);
  return undefined;
}

function getThumbnailId(info: Record<string, any> | undefined) {
  if (!info) return undefined;
  if (info.thumbnail_file?.url) return getEncryptedFileMediaId(info.thumbnail_file);
  if (typeof info.thumbnail_url === 'string') return encodeMxc(info.thumbnail_url);
  return undefined;
}

function buildCaption(content: Record<string, any>, resolvePeerId: ChatContext['resolvePeerId']) {
  const fileName: string | undefined = content.filename;
  const body: string | undefined = content.body;
  if (!fileName || !body || body === fileName) return undefined;
  if (content.format === 'org.matrix.custom.html' && content.formatted_body) {
    return parseHtmlToFormattedText(content.formatted_body, resolvePeerId);
  }
  return { text: body };
}

// Web addresses typed as plain text, which Telegram's server would have marked as links
const PLAIN_URL_REGEX = /\b(?:https?:\/\/|www\.|t\.me\/)[^\s<>"]+/gi;
const URL_TRAILING_PUNCTUATION = /[.,!?;:'")\]}»…]+$/;

function addUrlEntities(formatted: ApiFormattedText): ApiFormattedText {
  const entities = formatted.entities || [];
  const added: ApiMessageEntity[] = [];
  for (const match of formatted.text.matchAll(PLAIN_URL_REGEX)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION, '');
    const offset = match.index;
    const end = offset + url.length;
    const isCovered = entities.some((entity) => entity.offset < end && offset < entity.offset + entity.length
      && entity.type !== ApiMessageEntityTypes.Bold && entity.type !== ApiMessageEntityTypes.Italic
      && entity.type !== ApiMessageEntityTypes.Underline && entity.type !== ApiMessageEntityTypes.Strike);
    if (url.length > 4 && !isCovered) {
      added.push({ type: ApiMessageEntityTypes.Url, offset, length: url.length });
    }
  }
  if (!added.length) return formatted;
  return { ...formatted, entities: [...entities, ...added].sort((a, b) => a.offset - b.offset) };
}

function buildText(content: Record<string, any>, resolvePeerId: ChatContext['resolvePeerId']): ApiFormattedText {
  if (content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string') {
    return addUrlEntities(parseHtmlToFormattedText(content.formatted_body, resolvePeerId));
  }
  const body = typeof content.body === 'string' ? content.body : '';
  return addUrlEntities({ text: stripReplyFallback(body) });
}

function buildPhoto(mediaId: string, content: Record<string, any>, date: number): ApiPhoto {
  const info = content.info || {};
  const width = info.w || 600;
  const height = info.h || 400;
  return {
    mediaType: 'photo',
    id: mediaId,
    date,
    sizes: [
      { type: 'm', width: Math.min(width, 320), height: Math.round(height * (Math.min(width, 320) / width)) },
      { type: 'x', width, height },
    ],
  };
}

function readStoryRef(value: unknown) {
  const ref = value as StoryRef | undefined;
  return ref && typeof ref.user_id === 'string' && typeof ref.story_id === 'number'
    ? { peerId: getPeerIdByUserId(ref.user_id), storyId: ref.story_id } : undefined;
}

function buildStoryReplyInfo(event: MatrixEvent) {
  const ref = readStoryRef(event.getContent()[STORY_REPLY_KEY]);
  return ref ? { type: 'story' as const, ...ref } : undefined;
}

function buildMessageContent(
  event: MatrixEvent, context: ChatContext,
): MediaContent | undefined {
  const type = event.getType();
  const content = event.getContent();
  const date = Math.floor(event.getTs() / 1000);
  const { resolvePeerId } = context;

  if (event.isDecryptionFailure() || type === EventType.RoomMessageEncrypted) {
    return {
      text: {
        text: UNDECRYPTABLE_TEXT,
        entities: [{ type: ApiMessageEntityTypes.Italic, offset: 0, length: UNDECRYPTABLE_TEXT.length }],
      },
    };
  }

  // A forwarded story opens the story itself while it lasts; other apps see its picture or video
  const forwardedStory = readStoryRef(content[FORWARDED_STORY_KEY]);
  if (forwardedStory) {
    return {
      storyData: { mediaType: 'storyData', id: forwardedStory.storyId, peerId: forwardedStory.peerId },
      text: buildCaption(content, resolvePeerId),
    };
  }

  if ((type === EventType.Sticker || content[STICKER_MARKER]) && typeof content.url === 'string') {
    const pack = content[PACK_KEY];
    return { sticker: buildApiSticker(content as PackImage, typeof pack === 'string' ? pack : undefined) };
  }

  if (type === EventType.Sticker) {
    const mediaId = getMediaId(content);
    return mediaId ? { photo: buildPhoto(mediaId, content, date) } : { text: { text: content.body || '' } };
  }

  if (type !== EventType.RoomMessage && type !== COMMENT_EVENT) return undefined;

  const info = content.info || {};
  const mediaId = getMediaId(content);
  const fileName: string = content.filename || content.body || 'file';

  switch (content.msgtype) {
    case MsgType.Text:
    case MsgType.Notice:
      return { text: buildText(content, resolvePeerId) };
    case MsgType.Emote: {
      const text = buildText(content, resolvePeerId);
      const italic = { type: ApiMessageEntityTypes.Italic, offset: 0, length: text.text.length } as const;
      return { text: { ...text, entities: [...(text.entities || []), italic] } };
    }
    case MsgType.Image: {
      if (!mediaId) break;
      // A GIF file can't play in the video player, so it is shown as a picture of the original file, which the
      // browser animates; the server's thumbnails of it are still frames
      if (info.mimetype === 'image/gif') markGifMedia(mediaId);
      return { photo: buildPhoto(mediaId, content, date), text: buildCaption(content, resolvePeerId) };
    }
    case MsgType.Video: {
      if (!mediaId) break;
      const thumbnailId = getThumbnailId(info);
      const video: ApiVideo = omitUndefined<ApiVideo>({
        mediaType: 'video',
        id: thumbnailId ? `${mediaId}${THUMBNAIL_SEPARATOR}${thumbnailId}` : mediaId,
        mimeType: info.mimetype || 'video/mp4',
        duration: info.duration ? Math.round(info.duration / 1000) : 0,
        fileName,
        width: info.w,
        height: info.h,
        size: info.size || 0,
        supportsStreaming: true,
        isRound: content[ROUND_VIDEO_KEY] ? true : undefined,
        previewPhotoSizes: thumbnailId && info.thumbnail_info?.w
          ? [{ type: 's', width: info.thumbnail_info.w, height: info.thumbnail_info.h }] : undefined,
      });
      return { video, text: buildCaption(content, resolvePeerId) };
    }
    case MsgType.Audio: {
      if (!mediaId) break;
      const isVoice = Boolean(content['org.matrix.msc3245.voice'] || content['org.matrix.msc3245.voice.v2']);
      const audioInfo = content['org.matrix.msc1767.audio'] || {};
      const durationMs = info.duration || audioInfo.duration || 0;
      if (isVoice) {
        const voice: ApiVoice = {
          mediaType: 'voice',
          id: mediaId,
          duration: Math.max(1, Math.round(durationMs / 1000)),
          waveform: convertWaveform(audioInfo.waveform),
          size: info.size || 0,
        };
        return { voice };
      }
      const audio: ApiAudio = {
        mediaType: 'audio',
        id: mediaId,
        size: info.size || 0,
        mimeType: info.mimetype || 'audio/mpeg',
        fileName,
        duration: Math.round(durationMs / 1000),
      };
      return { audio, text: buildCaption(content, resolvePeerId) };
    }
    case MsgType.File: {
      if (!mediaId) break;
      const thumbnailId = getThumbnailId(info);
      const document: ApiDocument = omitUndefined<ApiDocument>({
        mediaType: 'document',
        id: thumbnailId ? `${mediaId}${THUMBNAIL_SEPARATOR}${thumbnailId}` : mediaId,
        fileName,
        size: info.size || 0,
        mimeType: info.mimetype || 'application/octet-stream',
        previewPhotoSizes: thumbnailId && info.thumbnail_info?.w
          ? [{ type: 's', width: info.thumbnail_info.w, height: info.thumbnail_info.h }] : undefined,
      });
      return { document, text: buildCaption(content, resolvePeerId) };
    }
    case MsgType.Location: {
      const match = typeof content.geo_uri === 'string' && content.geo_uri.match(/^geo:(-?[\d.]+),(-?[\d.]+)/);
      if (match) {
        return {
          location: {
            mediaType: 'geo',
            geo: { lat: Number(match[1]), long: Number(match[2]), accessHash: '0' },
          },
        };
      }
      break;
    }
  }

  return typeof content.body === 'string' ? { text: { text: content.body } } : undefined;
}

// Stories keep their media in the shape of a Matrix message, and are built like one
export function buildStoryContent(
  content: Record<string, unknown>, ts: number, resolvePeerId: ChatContext['resolvePeerId'],
): MediaContent | undefined {
  const event = new MatrixEventClass({
    type: EventType.RoomMessage, content, origin_server_ts: ts, event_id: `$story${ts}`,
  });
  return buildMessageContent(event, {
    chatId: '', isPrivate: false, isChannel: false, myUserId: '', resolvePeerId,
  });
}

function buildMembershipAction(event: MatrixEvent, context: ChatContext): ApiMessageAction | undefined {
  if (context.isPrivate) return undefined;

  const content = event.getContent();
  const prevContent = event.getPrevContent();
  const membership = content.membership;
  const prevMembership = prevContent.membership;
  const target = event.getStateKey()!;
  const sender = event.getSender()!;

  if (membership === prevMembership) return undefined;

  if (membership === 'invite') {
    return { mediaType: 'action', type: 'chatAddUser', userIds: [context.resolvePeerId(target)] };
  }
  if (membership === 'join') {
    // Joins that follow an invite were already shown as "added"
    if (prevMembership === 'invite') return undefined;
    return { mediaType: 'action', type: 'chatAddUser', userIds: [context.resolvePeerId(target)] };
  }
  if (membership === 'leave' || membership === 'ban') {
    if (prevMembership === 'invite' && sender === target) return undefined;
    return { mediaType: 'action', type: 'chatDeleteUser', userId: context.resolvePeerId(target) };
  }

  void sender;
  return undefined;
}

function buildStateAction(event: MatrixEvent, room: Room, context: ChatContext): ApiMessageAction | undefined {
  const content = event.getContent();
  switch (event.getType()) {
    case EventType.RoomCreate:
      if (context.isPrivate) return undefined;
      return context.isChannel
        ? { mediaType: 'action', type: 'channelCreate', title: getRoomTitle(room) }
        : { mediaType: 'action', type: 'chatCreate', title: getRoomTitle(room), userIds: [] };
    case EventType.RoomMember:
      return buildMembershipAction(event, context);
    case EventType.RoomName:
      if (context.isPrivate || !content.name) return undefined;
      return { mediaType: 'action', type: 'chatEditTitle', title: content.name };
    case EventType.RoomAvatar:
      if (context.isPrivate) return undefined;
      if (!content.url) return { mediaType: 'action', type: 'chatDeletePhoto' };
      return {
        mediaType: 'action',
        type: 'chatEditPhoto',
        photo: buildPhoto(encodeMxc(content.url), { info: { w: 640, h: 640 } }, Math.floor(event.getTs() / 1000)),
      };
    case RETENTION_EVENT: {
      const lifetime = content.max_lifetime;
      return {
        mediaType: 'action',
        type: 'setMessagesTtl',
        period: typeof lifetime === 'number' && lifetime > 0 ? Math.round(lifetime / 1000) : 0,
      };
    }
    default:
      return undefined;
  }
}

const CREATION_SETUP_WINDOW_MS = 15000;

function getRoomTitle(room: Room) {
  return room.currentState.getStateEvents(EventType.RoomName, '')?.getContent().name || room.name;
}

// Matrix rooms are set up with several state events right after creation; Telegram shows a single "created" line
function isCreationSetupEvent(event: MatrixEvent, room?: Room) {
  const createEvent = room?.currentState.getStateEvents(EventType.RoomCreate, '');
  if (!createEvent || event.getSender() !== createEvent.getSender()) return false;
  if (event.getTs() - createEvent.getTs() > CREATION_SETUP_WINDOW_MS) return false;
  const type = event.getType();
  if (type === EventType.RoomName || type === EventType.RoomAvatar) return true;
  return type === EventType.RoomMember && event.getStateKey() === event.getSender()
    && event.getContent().membership === 'join';
}

// A channel post's views: the author and every member whose read receipt is at this post or a later one.
// Only real receipts count: the SDK's own checks also treat joining after a post as having read it
export function countPostViews(room: Room, event: MatrixEvent) {
  const eventId = event.getId();
  if (!eventId) return 1;
  const timelineSet = room.getUnfilteredTimelineSet();
  const views = room.getJoinedMembers().filter(({ userId }) => {
    if (userId === event.getSender()) return true;
    const readUpTo = room.getEventReadUpTo(userId, true);
    if (!readUpTo) return false;
    if (readUpTo === eventId) return true;
    const order = timelineSet.compareEventOrdering(readUpTo, eventId);
    return order !== null && order > 0;
  }).length;
  return Math.max(views, 1);
}

export function isDisplayableEvent(
  event: MatrixEvent, context: Pick<ChatContext, 'isPrivate' | 'withComments'>, room?: Room,
) {
  if (event.isRedacted() || event.status) return false;
  if (event.isState() && isCreationSetupEvent(event, room)) return false;
  if (room && isExpiredEvent(event, room)) return false;
  const type = event.getType();
  const relation = event.getRelation();
  if (relation?.rel_type === RelationType.Replace) return false;

  switch (type) {
    case EventType.RoomMessage:
    case EventType.RoomMessageEncrypted:
    case EventType.Sticker:
      return true;
    case COMMENT_EVENT:
      return Boolean(context.withComments);
    case EventType.RoomCreate:
    case EventType.RoomName:
    case EventType.RoomAvatar:
      return !context.isPrivate;
    case RETENTION_EVENT:
      return true;
    case EventType.RoomMember: {
      if (context.isPrivate) return false;
      const membership = event.getContent().membership;
      const prevMembership = event.getPrevContent().membership;
      if (membership === prevMembership) return false;
      if (membership === 'join' && prevMembership === 'invite') return false;
      // Unblocking a removed member is not announced in the chat, like in Telegram
      if (membership === 'leave' && prevMembership === 'ban') return false;
      if ((membership === 'leave' || membership === 'ban') && prevMembership === 'invite'
        && event.getSender() === event.getStateKey()) return false;
      return true;
    }
    default:
      return false;
  }
}

export function getReplyTargetEventId(event: MatrixEvent) {
  const relatesTo = event.getWireContent()['m.relates_to'] || event.getContent()['m.relates_to'];
  if (!relatesTo) return undefined;
  if (relatesTo['m.in_reply_to']?.event_id) return relatesTo['m.in_reply_to'].event_id;
  if (relatesTo.rel_type === 'm.thread' && relatesTo.event_id) return relatesTo.event_id;
  return undefined;
}

export function normalizeReactionKey(key: string) {
  return key.replace(/\uFE0F/g, '');
}

export function buildReactions(room: Room, event: MatrixEvent, context: ChatContext): ApiReactions | undefined {
  const relations = room.relations.getChildEventsForEvent(
    event.getId()!, RelationType.Annotation, EventType.Reaction,
  );
  const sorted = relations?.getSortedAnnotationsByKey();
  if (!sorted?.length) return undefined;

  const results: ApiReactionCount[] = [];
  const recentReactions: ApiPeerReaction[] = [];
  let chosenOrder = 0;

  // Element and other clients may add variation selectors that Telegram reactions do not use
  const eventsByKey = new Map<string, MatrixEvent[]>();
  sorted.forEach(([rawKey, eventsSet]) => {
    const key = normalizeReactionKey(rawKey);
    eventsByKey.set(key, [...(eventsByKey.get(key) || []), ...eventsSet]);
  });

  eventsByKey.forEach((allEvents, key) => {
    const events = allEvents.filter((reactionEvent) => !reactionEvent.isRedacted());
    if (!events.length) return;
    const isMine = events.some((reactionEvent) => reactionEvent.getSender() === context.myUserId);
    results.push({
      reaction: { type: 'emoji', emoticon: key },
      count: events.length,
      chosenOrder: isMine ? chosenOrder++ : undefined,
    });
    events.forEach((reactionEvent) => {
      recentReactions.push({
        peerId: context.resolvePeerId(reactionEvent.getSender()!),
        reaction: { type: 'emoji', emoticon: key },
        isOwn: reactionEvent.getSender() === context.myUserId ? true : undefined,
        addedDate: Math.floor(reactionEvent.getTs() / 1000),
      });
    });
  });

  if (!results.length) return undefined;

  return {
    canSeeList: true,
    results,
    recentReactions: recentReactions.sort((a, b) => b.addedDate - a.addedDate),
  };
}

function buildForwardInfo(content: Record<string, any>, context: ChatContext): ApiMessageForwardInfo | undefined {
  const forward = content[FORWARD_KEY];
  if (!forward || typeof forward !== 'object') return undefined;
  return omitUndefined<ApiMessageForwardInfo>({
    date: Math.floor((forward.ts || Date.now()) / 1000),
    isChannelPost: false,
    fromId: forward.sender ? context.resolvePeerId(forward.sender) : undefined,
    hiddenUserName: !forward.sender ? forward.sender_name : undefined,
  });
}

export function buildApiMessage(
  event: MatrixEvent, room: Room, context: ChatContext,
): ApiMessage | undefined {
  if (!isDisplayableEvent(event, context, room)) return undefined;

  const eventId = event.getId();
  if (!eventId) return undefined;

  const sender = event.getSender()!;
  const isState = event.isState();
  const action = isState ? buildStateAction(event, room, context) : undefined;
  const content = isState ? (action ? { action } : undefined) : buildMessageContent(event, context);
  if (!content) return undefined;

  const todo = !isState && !event.isDecryptionFailure()
    ? buildTodoMedia(room, event, context.resolvePeerId) : undefined;
  if (todo) {
    delete content.text;
    content.todo = todo;
  }

  if (content.text) {
    content.text = addMentionEntities(
      addTimestampEntities({ ...content.text, emojiOnlyCount: undefined }), room.roomId, eventId,
    );
  }

  const id = getMessageId(room.roomId, eventId, event.getTs());
  const replyTargetId = !isState ? getReplyTargetEventId(event) : undefined;
  const replyToMsgId = replyTargetId ? findMessageId(replyTargetId) : undefined;
  const replacingEvent = event.replacingEvent();
  // Comments belong to the channel's virtual discussion chat, in the thread of their post
  const commentRootId = isCommentEvent(event) ? getCommentRootEventId(event) : undefined;
  if (commentRootId) rememberCommentEvent(eventId, commentRootId);
  const replyToTopId = commentRootId ? findMessageId(commentRootId) : undefined;
  const isOutgoing = sender === context.myUserId && (!context.isChannel || Boolean(commentRootId));
  const forwardInfo = !isState ? buildForwardInfo(event.getContent(), context) : undefined;

  const message: ApiMessage = omitUndefined<ApiMessage>({
    id,
    chatId: commentRootId ? getCommentsChatId(room.roomId) : context.chatId,
    content: omitUndefined(content),
    date: Math.floor(event.getTs() / 1000),
    isOutgoing,
    senderId: context.resolvePeerId(sender),
    replyInfo: replyToMsgId ? { type: 'message', replyToMsgId, replyToTopId } : buildStoryReplyInfo(event),
    forwardInfo,
    isEdited: replacingEvent ? true : undefined,
    editDate: replacingEvent ? Math.floor(replacingEvent.getTs() / 1000) : undefined,
    isForwardingAllowed: true,
    reactions: !isState ? buildReactions(room, event, context) : undefined,
    viewsCount: context.isChannel && !isState && !commentRootId ? countPostViews(room, event) : undefined,
    isMentioned: !isState && sender !== context.myUserId && isMentioningUser(event, context.myUserId)
      ? true : undefined,
  });

  const emojiOnlyCount = getEmojiOnlyCountForMessage(message.content, message.groupedId);
  if (emojiOnlyCount && message.content.text) message.content.text.emojiOnlyCount = emojiOnlyCount;

  return message;
}
