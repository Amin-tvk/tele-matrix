import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { EventType } from 'matrix-js-sdk';

import { buildRoomChatId } from './peerIds';
import { getValue, setValue } from './store';

// Comments under channel posts, like Telegram's discussion. They are Matrix thread replies to the post, sent in the
// channel room itself with their own event type: a channel's power levels let subscribers send that type while
// posting stays with the admins. The UI expects comments in a separate discussion group, so each channel with
// comments gets a virtual group chat backed by the same room

export const COMMENT_EVENT = 'im.peyvand.comment';
const COMMENTS_CHAT_SUFFIX = '#comments';
const THREAD_RELATION = 'm.thread';
const RECENT_REPLIERS_COUNT = 3;

export function getCommentsChatId(roomId: string) {
  const chatId = buildRoomChatId(`${roomId}${COMMENTS_CHAT_SUFFIX}`);
  if (getValue(`r:${chatId}`) !== roomId) {
    setValue(`r:${chatId}`, roomId);
    setValue(`c:${chatId}`, '1');
  }
  return chatId;
}

export function isCommentsChatId(chatId: string) {
  return Boolean(getValue(`c:${chatId}`));
}

export function isCommentEvent(event: MatrixEvent) {
  return event.getType() === COMMENT_EVENT;
}

export function getCommentRootEventId(event: MatrixEvent) {
  const relatesTo = event.getWireContent()['m.relates_to'] || event.getContent()['m.relates_to'];
  return relatesTo?.rel_type === THREAD_RELATION ? relatesTo.event_id as string | undefined : undefined;
}

function getPowerLevelsContent(room: Room) {
  return room.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent() || {};
}

// Comments are on when subscribers may send the comment event type
export function areCommentsEnabled(room: Room) {
  const content = getPowerLevelsContent(room);
  const level = content.events?.[COMMENT_EVENT];
  return level !== undefined && level <= (content.users_default ?? 0);
}

/* Comment counts under posts */

// `isExact` is false when the post came without the server's count (posts from /sync), which is then fetched
type ThreadSummary = { count: number; recentSenders: string[]; commentIds: Set<string>; isExact: boolean };
const summaries = new Map<string, ThreadSummary>();
// Comments known on this device and the post each is under, so deletions and reactions find their chat
const commentRootIds = new Map<string, string>();

export function rememberCommentEvent(eventId: string, rootEventId: string) {
  commentRootIds.set(eventId, rootEventId);
}

export function getKnownCommentRootId(eventId: string) {
  return commentRootIds.get(eventId);
}

// The server bundles the number of thread replies with the post
export function getThreadSummary(postEvent: MatrixEvent) {
  const postId = postEvent.getId()!;
  let summary = summaries.get(postId);
  if (!summary) {
    const bundled = postEvent.getServerAggregatedRelation<{ count?: number; latest_event?: { sender?: string } }>(
      THREAD_RELATION,
    );
    summary = {
      count: bundled?.count || 0,
      recentSenders: bundled?.latest_event?.sender ? [bundled.latest_event.sender] : [],
      commentIds: new Set(),
      isExact: Boolean(bundled),
    };
    summaries.set(postId, summary);
  }
  return summary;
}

export function setThreadSummary(postId: string, comments: MatrixEvent[]) {
  const recentSenders: string[] = [];
  comments.slice().sort((a, b) => b.getTs() - a.getTs()).forEach((event) => {
    const sender = event.getSender();
    if (sender && !recentSenders.includes(sender) && recentSenders.length < RECENT_REPLIERS_COUNT) {
      recentSenders.push(sender);
    }
  });
  summaries.set(postId, {
    count: comments.length,
    recentSenders,
    commentIds: new Set(comments.map((event) => event.getId()!)),
    isExact: true,
  });
}

export function setThreadSummaryCount(postId: string, count: number, latestSender?: string) {
  const summary = summaries.get(postId);
  const recentSenders = summary?.recentSenders || [];
  summaries.set(postId, {
    count,
    recentSenders: latestSender && !recentSenders.includes(latestSender)
      ? [latestSender, ...recentSenders].slice(0, RECENT_REPLIERS_COUNT) : recentSenders,
    commentIds: summary?.commentIds || new Set(),
    isExact: true,
  });
}

export function addCommentToSummary(postEvent: MatrixEvent, comment: MatrixEvent) {
  const summary = getThreadSummary(postEvent);
  const commentId = comment.getId()!;
  if (summary.commentIds.has(commentId)) return false;
  summary.commentIds.add(commentId);
  summary.count++;
  const sender = comment.getSender();
  if (sender) {
    summary.recentSenders = [sender, ...summary.recentSenders.filter((id) => id !== sender)]
      .slice(0, RECENT_REPLIERS_COUNT);
  }
  return true;
}

export function removeCommentFromSummary(postId: string, commentId: string) {
  const summary = summaries.get(postId);
  if (!summary) return;
  summary.commentIds.delete(commentId);
  summary.count = Math.max(0, summary.count - 1);
}
