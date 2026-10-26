import { APP_NAME, DEBUG, DEBUG_MORE } from '../config';
import { buildRoomChatId, buildUserPeerId } from '../api/matrix/peerIds';

declare const self: ServiceWorkerGlobalScope;

enum Boolean {
  True = '1',
  False = '0',
}

type PushData = {
  custom: {
    msg_id?: string;
    silent?: string;
    channel_id?: string;
    chat_id?: string;
    from_id?: string;
  };
  mute: Boolean;
  badge: Boolean;
  loc_key: string;
  loc_args: string[];
  random_id: number;
  title: string;
  description: string;
};

// Payload sent by the Sygnal web push gateway for Matrix events
type MatrixPushData = {
  event_id?: string;
  room_id: string;
  room_name?: string;
  sender?: string;
  sender_display_name?: string;
  type?: string;
  content?: { body?: string; msgtype?: string };
  prio?: 'high' | 'low';
  unread?: number;
};

type NotificationData = {
  messageId?: number;
  chatId?: string;
  fallbackChatId?: string;
  title: string;
  body: string;
  isSilent?: boolean;
  icon?: string;
  reaction?: string;
  shouldReplaceHistory?: boolean;
};

type FocusMessageData = {
  chatId?: string;
  fallbackChatId?: string;
  messageId?: number;
  reaction?: string;
  shouldReplaceHistory?: boolean;
};

type CloseNotificationData = {
  lastReadInboxMessageId?: number;
  chatId: string;
};

let lastSyncAt = new Date().valueOf();
const shownNotifications = new Set();
const clickBuffer: Record<string, NotificationData> = {};

function getPushData(e: PushEvent | Notification): PushData | undefined {
  try {
    return e.data.json();
  } catch (error) {
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log('[SW] Unable to parse push notification data', e.data);
    }
    return undefined;
  }
}

function getChatId(data: PushData) {
  if (data.custom.from_id) {
    return data.custom.from_id;
  }

  // Chats and channels have “negative” IDs
  if (data.custom.chat_id || data.custom.channel_id) {
    return `-${data.custom.chat_id || data.custom.channel_id}`;
  }

  return undefined;
}

function getMessageId(data: PushData) {
  if (!data.custom.msg_id) return undefined;
  return parseInt(data.custom.msg_id, 10);
}

function getNotificationData(data: PushData): NotificationData {
  let title = data.title || APP_NAME;
  const isSilent = data.custom?.silent === Boolean.True;
  if (isSilent) {
    title += ' 🔕';
  }
  return {
    chatId: getChatId(data),
    messageId: getMessageId(data),
    body: data.description,
    isSilent,
    title,
  };
}

async function getClients() {
  const appUrl = new URL(self.registration.scope).origin;
  const clients = await self.clients.matchAll({ type: 'window' }) as WindowClient[];
  return clients.filter((client) => {
    return new URL(client.url).origin === appUrl;
  });
}

async function playNotificationSound(id: string) {
  const clients = await getClients();
  const client = clients[0];
  if (!client) return;
  client.postMessage({
    type: 'playNotificationSound',
    payload: { id },
  });
}

function showNotification({
  chatId,
  fallbackChatId,
  roomId,
  messageId,
  body,
  title,
  icon,
  reaction,
  isSilent,
  shouldReplaceHistory,
}: NotificationData & { roomId?: string }) {
  const isFirstBatch = new Date().valueOf() - lastSyncAt < 1000;
  const tag = String(isFirstBatch ? 0 : chatId || 0);
  const options: NotificationOptions = {
    body,
    data: {
      chatId,
      fallbackChatId,
      roomId,
      messageId,
      reaction,
      count: 1,
      shouldReplaceHistory,
    },
    icon: icon || 'icon-192x192.png',
    badge: 'icon-192x192.png',
    tag,
    // @ts-ignore
    vibrate: [200, 100, 200],
  };

  return Promise.all([
    // TODO Update condition when reaction badges are implemented
    (!reaction && !isSilent) ? playNotificationSound(String(messageId) || chatId || '') : undefined,
    self.registration.showNotification(title, options),
  ]);
}

async function closeNotifications({
  chatId,
  lastReadInboxMessageId,
}: CloseNotificationData) {
  const notifications = await self.registration.getNotifications();
  const lastMessageId = lastReadInboxMessageId || Number.MAX_VALUE;
  notifications.forEach((notification) => {
    if (
      notification.tag === '0'
      || (notification.data.chatId === chatId && notification.data.messageId <= lastMessageId)
    ) {
      notification.close();
    }
  });
}

const MATRIX_MEDIA_LABELS: Record<string, string> = {
  'm.image': '🖼 Photo',
  'm.video': '📹 Video',
  'm.audio': '🎤 Voice message',
  'm.file': '📎 File',
  'm.location': '📍 Location',
};

function isMatrixPush(data: unknown): data is MatrixPushData {
  // `Boolean` is shadowed by the push flag enum in this module
  return typeof data === 'object' && data !== null && 'room_id' in data;
}

function getMatrixNotificationData(data: MatrixPushData): NotificationData {
  const sender = data.sender_display_name || data.sender || '';
  const msgtype = data.content?.msgtype;
  const text = data.type === 'm.room.encrypted' || !data.content
    ? 'New message'
    : (msgtype && MATRIX_MEDIA_LABELS[msgtype]) || data.content.body || 'New message';
  const isDirect = !data.room_name || data.room_name === sender;

  return {
    // Direct chats use the sender's peer ID, other rooms their own ID; the client resolves which one exists
    chatId: isDirect && data.sender ? buildUserPeerId(data.sender) : buildRoomChatId(data.room_id),
    fallbackChatId: isDirect && data.sender ? buildRoomChatId(data.room_id) : data.sender && buildUserPeerId(data.sender),
    title: isDirect ? sender || APP_NAME : data.room_name!,
    body: isDirect ? text : `${sender}: ${text}`,
    isSilent: data.prio === 'low',
  };
}

async function handleMatrixPush(data: MatrixPushData) {
  const notification = getMatrixNotificationData(data);

  // A read receipt from another device clears the room's notifications
  if (!data.event_id) {
    const shown = await self.registration.getNotifications();
    shown.forEach((item) => {
      if (item.data?.roomId === data.room_id) item.close();
    });
    return;
  }

  // The visible app shows its own unread state, so no system notification is needed
  const clients = await getClients();
  if (clients.some((client) => client.focused && client.visibilityState === 'visible')) return;

  await showNotification({ ...notification, roomId: data.room_id } as NotificationData);
}

export function handlePush(e: PushEvent) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[SW] Push received event', e);
    if (e.data) {
      // eslint-disable-next-line no-console
      console.log('[SW] Push received with data', e.data.json());
    }
  }

  const data = getPushData(e);

  if (isMatrixPush(data)) {
    e.waitUntil(handleMatrixPush(data));
    return;
  }

  // Do not show muted notifications
  if (!data || data.mute === Boolean.True) return;

  const notification = getNotificationData(data);

  // Don't show already triggered notification
  if (shownNotifications.has(notification.messageId)) {
    shownNotifications.delete(notification.messageId);
    return;
  }

  e.waitUntil(showNotification(notification));
}

async function focusChatMessage(client: WindowClient, data: FocusMessageData) {
  if (!data.chatId) return;
  client.postMessage({
    type: 'focusMessage',
    payload: data,
  });
  if (!client.focused) {
    // Catch "focus not allowed" DOM Exceptions
    try {
      await client.focus();
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[SW] ', error);
      }
    }
  }
}

export function handleNotificationClick(e: NotificationEvent) {
  const appUrl = self.registration.scope;
  e.notification.close(); // Android needs explicit close.
  const { data } = e.notification;
  const notifyClients = async () => {
    const clients = await getClients();
    await Promise.all(clients.map((client) => {
      clickBuffer[client.id] = data;
      return focusChatMessage(client, data);
    }));
    if (!self.clients.openWindow || clients.length > 0) return undefined;
    // Store notification data for default client (fix for android)
    clickBuffer[0] = data;
    // If there is no opened client we need to open one and wait until it is fully loaded
    try {
      const newClient = await self.clients.openWindow(appUrl);
      if (newClient) {
        // Store notification data until client is fully loaded
        clickBuffer[newClient.id] = data;
      }
    } catch (error) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[SW] ', error);
      }
    }
    return undefined;
  };
  e.waitUntil(notifyClients());
}

export function handleClientMessage(e: ExtendableMessageEvent) {
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] New message from client', e);
  }
  if (!e.data) return;
  const source = e.source as WindowClient;
  if (e.data.type === 'clientReady') {
    // focus on chat message when client is fully ready
    const data = clickBuffer[source.id] || clickBuffer[0];
    if (data) {
      delete clickBuffer[source.id];
      delete clickBuffer[0];
      e.waitUntil(focusChatMessage(source, data));
    }
  }
  if (e.data.type === 'showMessageNotification') {
    // store messageId for already shown notification
    const notification: NotificationData = e.data.payload;
    e.waitUntil((async () => {
      // Close existing notification if it is already shown
      if (notification.chatId) {
        const notifications = await self.registration.getNotifications({ tag: notification.chatId });
        notifications.forEach((n) => n.close());
      }
      // Mark this notification as shown if it was handled locally
      shownNotifications.add(notification.messageId);
      return showNotification(notification);
    })());
  }

  if (e.data.type === 'closeMessageNotifications') {
    e.waitUntil(closeNotifications(e.data.payload));
  }
}

self.addEventListener('sync', () => {
  lastSyncAt = Date.now();
});
