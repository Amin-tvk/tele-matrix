import type { MatrixEvent, Room } from 'matrix-js-sdk';
import {
  EventType, MatrixEvent as MatrixEventClass, Method, UpdateDelayedEventAction,
} from 'matrix-js-sdk';

import type { ApiChat, ApiMessage } from '../types';

import {
  buildMessageForEvent, getClient, getMyUserId, getRoomByChatId, onUpdate,
} from './client';
import { getChatIdByRoomId } from './ids';
import { deleteValue, getValue, setValue } from './store';

// Scheduled messages are Matrix delayed events (MSC4140): the server keeps the event and sends it at the chosen
// time, so it goes out even when no device is online. The server only has what will be sent, which in an
// encrypted chat is ciphertext, so this device also keeps the readable message to show in the scheduled list

const SCHEDULED_PLACEHOLDER = 'Scheduled message';
// Once the server has sent it, the message leaves the scheduled list a moment later
const SENT_GRACE_MS = 3000;

type ScheduledRecord = {
  delayId: string;
  roomId: string;
  type: string;
  content: Record<string, unknown>;
  scheduledAt: number;
};
type DelayedEvent = {
  delay_id: string;
  room_id: string;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  delay: number;
  running_since: number;
};

const sentTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Telegram message IDs are numbers; a scheduled message's comes from its delay ID
function getScheduledMessageId(delayId: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < delayId.length; i++) {
    hash ^= delayId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const id = (hash % 2_000_000_000) + 1;
  setValue(`sid:${id}`, delayId);
  return id;
}

function readRecord(delayId: string): ScheduledRecord | undefined {
  const raw = getValue(`sd:${delayId}`);
  return raw ? JSON.parse(raw) as ScheduledRecord : undefined;
}

function forgetScheduled(delayId: string, messageId: number) {
  deleteValue(`sd:${delayId}`);
  deleteValue(`sid:${messageId}`);
  const timer = sentTimers.get(delayId);
  if (timer) clearTimeout(timer);
  sentTimers.delete(delayId);
}

function watchUntilSent(record: ScheduledRecord) {
  if (sentTimers.has(record.delayId)) return;
  const messageId = getScheduledMessageId(record.delayId);
  const timer = setTimeout(() => {
    sentTimers.delete(record.delayId);
    forgetScheduled(record.delayId, messageId);
    onUpdate({ '@type': 'deleteScheduledMessages', chatId: getChatIdByRoomId(record.roomId), ids: [messageId] });
  }, Math.max(record.scheduledAt - Date.now(), 0) + SENT_GRACE_MS);
  sentTimers.set(record.delayId, timer);
}

function buildScheduledMessage(room: Room, record: ScheduledRecord): ApiMessage | undefined {
  const isReadable = record.type !== EventType.RoomMessageEncrypted;
  const event: MatrixEvent = new MatrixEventClass({
    event_id: `$scheduled-${record.delayId}`,
    type: isReadable ? record.type : EventType.RoomMessage,
    content: isReadable ? record.content : { msgtype: 'm.text', body: SCHEDULED_PLACEHOLDER },
    sender: getMyUserId(),
    room_id: room.roomId,
    origin_server_ts: record.scheduledAt,
  });
  const message = buildMessageForEvent(room, event);
  if (!message) return undefined;
  return {
    ...message,
    id: getScheduledMessageId(record.delayId),
    date: Math.floor(record.scheduledAt / 1000),
    isScheduled: true,
    isOutgoing: true,
    sendingState: undefined,
  };
}

async function sendDelayed(room: Room, type: string, content: Record<string, unknown>, delay: number) {
  const client = getClient();
  // The SDK sends delayed events as they are, so an encrypted chat's message is encrypted here first
  let wireType = type;
  let wireContent = content;
  if (client.isRoomEncrypted(room.roomId)) {
    const event = new MatrixEventClass({
      type, content, room_id: room.roomId, sender: getMyUserId(), event_id: `~${client.makeTxnId()}`,
    });
    await (client as unknown as { encryptEventIfNeeded: (e: MatrixEvent, r: Room) => Promise<void> })
      .encryptEventIfNeeded(event, room);
    wireType = event.getWireType();
    wireContent = event.getWireContent();
  }
  const path = `/rooms/${encodeURIComponent(room.roomId)}/send/${encodeURIComponent(wireType)}/`
    + encodeURIComponent(client.makeTxnId());
  const { delay_id: delayId } = await client.http.authedRequest<{ delay_id: string }>(
    Method.Put, path, { 'org.matrix.msc4140.delay': String(delay) }, wireContent,
  );
  return delayId;
}

// Called by sendMessage for a message with a send time
export async function scheduleRoomEvent(
  room: Room, type: string, content: Record<string, unknown>, scheduledAtSeconds: number,
) {
  const scheduledAt = scheduledAtSeconds * 1000;
  const delayId = await sendDelayed(room, type, content, Math.max(scheduledAt - Date.now(), 1000));
  const record: ScheduledRecord = {
    delayId, roomId: room.roomId, type, content, scheduledAt,
  };
  setValue(`sd:${delayId}`, JSON.stringify(record));
  watchUntilSent(record);
  return buildScheduledMessage(room, record);
}

async function fetchDelayedEvents() {
  const client = getClient();
  const result = await client.http.authedRequest<{ scheduled?: DelayedEvent[]; delayed_events?: DelayedEvent[] }>(
    Method.Get, '/delayed_events', undefined, undefined,
    { prefix: '/_matrix/client/unstable/org.matrix.msc4140' },
  );
  return (result.scheduled || result.delayed_events || []).filter((event) => event.state_key === undefined);
}

export async function fetchScheduledHistory({ chat }: { chat: ApiChat }) {
  const room = getRoomByChatId(chat.id);
  if (!room) return { messages: [] };
  let delayed: DelayedEvent[];
  try {
    delayed = await fetchDelayedEvents();
  } catch {
    // The server doesn't support scheduled messages
    return { messages: [] };
  }
  const messages = delayed
    .filter((event) => event.room_id === room.roomId)
    .map((event) => {
      const record = readRecord(event.delay_id) || {
        delayId: event.delay_id,
        roomId: event.room_id,
        type: event.type,
        content: event.content,
        scheduledAt: event.running_since + event.delay,
      };
      watchUntilSent(record);
      return buildScheduledMessage(room, record);
    })
    .filter((message): message is ApiMessage => Boolean(message));
  return { messages };
}

async function updateDelayed(delayId: string, action: UpdateDelayedEventAction) {
  await getClient()._unstable_updateDelayedEvent(delayId, action);
}

export async function deleteScheduledMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
  await Promise.all(messageIds.map(async (messageId) => {
    const delayId = getValue(`sid:${messageId}`);
    if (!delayId) return;
    await updateDelayed(delayId, UpdateDelayedEventAction.Cancel).catch(() => undefined);
    forgetScheduled(delayId, messageId);
  }));
  onUpdate({ '@type': 'deleteScheduledMessages', chatId: chat.id, ids: messageIds });
}

// "Send now"
export async function sendScheduledMessages({ chat, ids }: { chat: ApiChat; ids: number[] }) {
  await Promise.all(ids.map(async (messageId) => {
    const delayId = getValue(`sid:${messageId}`);
    if (!delayId) return;
    await updateDelayed(delayId, UpdateDelayedEventAction.Send);
    forgetScheduled(delayId, messageId);
  }));
  onUpdate({ '@type': 'deleteScheduledMessages', chatId: chat.id, ids });
}

// A delayed event's time can't be changed, so it is cancelled and scheduled again for the new time
export async function rescheduleMessage({
  chat, message, scheduledAt,
}: { chat: ApiChat; message: ApiMessage; scheduledAt: number; scheduleRepeatPeriod?: number }) {
  const room = getRoomByChatId(chat.id);
  const delayId = getValue(`sid:${message.id}`);
  if (!room || !delayId) return;
  const delayed = (await fetchDelayedEvents()).find((event) => event.delay_id === delayId);
  const record = readRecord(delayId);
  if (!delayed && !record) return;

  await updateDelayed(delayId, UpdateDelayedEventAction.Cancel);
  forgetScheduled(delayId, message.id);
  const scheduled = record
    ? await scheduleRoomEvent(room, record.type, record.content, scheduledAt)
    : undefined;
  if (!scheduled && delayed) {
    // Scheduled on another device: the stored event, encrypted or not, is sent again as it is
    const client = getClient();
    const path = `/rooms/${encodeURIComponent(room.roomId)}/send/${encodeURIComponent(delayed.type)}/`
      + encodeURIComponent(client.makeTxnId());
    await client.http.authedRequest(
      Method.Put, path, { 'org.matrix.msc4140.delay': String(Math.max(scheduledAt * 1000 - Date.now(), 1000)) },
      delayed.content,
    );
  }
  onUpdate({ '@type': 'deleteScheduledMessages', chatId: chat.id, ids: [message.id] });
  if (scheduled) {
    onUpdate({ '@type': 'newScheduledMessage', chatId: chat.id, id: scheduled.id, message: scheduled });
  }
}
