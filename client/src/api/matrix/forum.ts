import type { MatrixEvent, Room } from 'matrix-js-sdk';

import type { ApiTopic } from '../types';

import { getMessageId, getPeerIdByUserId } from './ids';

// Topics in groups, like Telegram's forums. A topic is a Matrix thread: its first message carries the topic's
// title and icon, and everything said in it is a thread reply to that message, so other Matrix apps show topics
// as threads. Messages outside any thread are the "General" topic.
//
// - `im.peyvand.forum` (state, key ''): `{ enabled, pinned: [root event IDs] }`, set by admins
// - `im.peyvand.topic` (state, key = root event ID): title, icon, creator and whether it is closed or deleted.
//   Members may send it (the group's "create topics" permission), so the app accepts a change only from the
//   topic's creator or an admin
// - `im.peyvand.topic_read` (room account data): how far each topic has been read on any of the person's devices,
//   since a Matrix read receipt covers the whole room

export const FORUM_EVENT = 'im.peyvand.forum';
export const TOPIC_EVENT = 'im.peyvand.topic';
export const TOPIC_KEY = 'im.peyvand.topic';
export const TOPIC_READ_EVENT = 'im.peyvand.topic_read';
export const GENERAL_TOPIC_KEY = 'main';
const THREAD_RELATION = 'm.thread';

export type TopicContent = {
  title?: string;
  icon_color?: number;
  icon_emoji_id?: string;
  creator?: string;
  root_ts?: number;
  closed?: boolean;
  hidden?: boolean;
  deleted?: boolean;
};

export type RoomTopic = {
  rootId: string;
  id: number;
  title: string;
  iconColor: number;
  iconEmojiId?: string;
  creator: string;
  date: number;
  isClosed?: true;
  isHidden?: true;
};

export function isForumRoom(room: Room) {
  return Boolean(room.currentState.getStateEvents(FORUM_EVENT, '')?.getContent()?.enabled);
}

export function getPinnedTopicRootIds(room: Room): string[] {
  const pinned = room.currentState.getStateEvents(FORUM_EVENT, '')?.getContent()?.pinned;
  return Array.isArray(pinned) ? pinned.filter((id): id is string => typeof id === 'string') : [];
}

export function getThreadRootId(event: MatrixEvent) {
  const relatesTo = event.getWireContent()['m.relates_to'] || event.getContent()['m.relates_to'];
  return relatesTo?.rel_type === THREAD_RELATION && typeof relatesTo.event_id === 'string'
    ? relatesTo.event_id : undefined;
}

function readTopicState(event: MatrixEvent, isAdmin: (userId: string) => boolean): TopicContent | undefined {
  const content = event.getContent<TopicContent>();
  const previous = event.getPrevContent() as TopicContent;
  const sender = event.getSender()!;
  const creator = previous.creator || content.creator;
  const isValid = isAdmin(sender) || (sender === creator && content.creator === creator);
  if (isValid) return content;
  // A change by someone else is ignored; what was there before stays
  return previous.title ? previous : undefined;
}

function buildRoomTopic(room: Room, rootId: string, content: TopicContent): RoomTopic | undefined {
  if (!content.title || content.deleted) return undefined;
  const rootTs = content.root_ts || room.findEventById(rootId)?.getTs() || 0;
  if (!rootTs) return undefined;
  return {
    rootId,
    id: getMessageId(room.roomId, rootId, rootTs),
    title: content.title,
    iconColor: content.icon_color ?? 0,
    iconEmojiId: content.icon_emoji_id,
    creator: content.creator || '',
    date: Math.floor(rootTs / 1000),
    isClosed: content.closed ? true : undefined,
    isHidden: content.hidden ? true : undefined,
  };
}

export function getRoomTopics(room: Room, isAdmin: (userId: string) => boolean) {
  const topics: RoomTopic[] = [];
  room.currentState.getStateEvents(TOPIC_EVENT).forEach((event) => {
    const rootId = event.getStateKey();
    const content = rootId ? readTopicState(event, isAdmin) : undefined;
    const topic = rootId && content ? buildRoomTopic(room, rootId, content) : undefined;
    if (topic) topics.push(topic);
  });
  return topics;
}

// Every topic ever started here, deleted ones too: their messages are no one's business in General
export function getAllTopicRootIds(room: Room) {
  return new Set(room.currentState.getStateEvents(TOPIC_EVENT).map((event) => event.getStateKey()!).filter(Boolean));
}

export function getRoomTopic(room: Room, rootId: string, isAdmin: (userId: string) => boolean) {
  const event = room.currentState.getStateEvents(TOPIC_EVENT, rootId);
  const content = event ? readTopicState(event, isAdmin) : undefined;
  return content ? buildRoomTopic(room, rootId, content) : undefined;
}

export function buildApiTopic(topic: RoomTopic, room: Room, myUserId: string, isAdmin: boolean): ApiTopic {
  return {
    id: topic.id,
    title: topic.title,
    iconColor: topic.iconColor,
    iconEmojiId: topic.iconEmojiId,
    date: topic.date,
    fromId: topic.creator ? getPeerIdByUserId(topic.creator) : '',
    isClosed: topic.isClosed,
    isHidden: topic.isHidden,
    isPinned: getPinnedTopicRootIds(room).includes(topic.rootId) ? true : undefined,
    isOwner: topic.creator === myUserId || isAdmin ? true : undefined,
    notifySettings: {},
  };
}

/* Read state */

export function getTopicReadTimestamps(room: Room): Record<string, number> {
  const content = room.getAccountData(TOPIC_READ_EVENT)?.getContent();
  return content?.topics && typeof content.topics === 'object' ? content.topics : {};
}
