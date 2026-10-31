import { getActions, getGlobal } from '../global';

import { DEBUG, DEBUG_MORE, IS_TEST } from '../config';
// eslint-disable-next-line import-x/default
import serviceWorkerUrl from '../serviceWorker/service.worker.ts?worker&url';
import {
  IS_ANDROID, IS_ANDROID_APP, IS_IOS, IS_SERVICE_WORKER_SUPPORTED,
} from './browser/windowEnvironment';
import { formatShareText } from './deeplink';
import { validateFiles } from './files';
import { notifyClientReady, playNotifySoundDebounced } from './notifications';

type WorkerAction = {
  type: string;
  payload: Record<string, any>;
};

const IGNORE_WORKER_PATH = '/k/';
const SERVICE_WORKER_OPTIONS: RegistrationOptions = import.meta.env.DEV
  ? { scope: './', type: 'module' }
  : { type: 'module' };

function handleWorkerMessage(e: MessageEvent) {
  const action: WorkerAction = e.data;
  if (DEBUG_MORE) {
    // eslint-disable-next-line no-console
    console.log('[SW] Message from worker', action);
  }
  if (!action.type) return;
  const dispatch = getActions();
  const payload = action.payload;
  switch (action.type) {
    case 'focusMessage': {
      const { fallbackChatId, ...focusPayload } = payload as { chatId: string; fallbackChatId?: string; messageId?: number };
      const chats = getGlobal().chats.byId;
      // Matrix push notifications only know the room and sender, so the chat ID is resolved here
      const chatId = !chats[focusPayload.chatId] && fallbackChatId && chats[fallbackChatId]
        ? fallbackChatId : focusPayload.chatId;
      if (focusPayload.messageId) {
        dispatch.focusMessage?.({ ...focusPayload, chatId } as any);
      } else {
        dispatch.openChat({ id: chatId, shouldReplaceHistory: true });
      }
      break;
    }
    case 'playNotificationSound':
      playNotifySoundDebounced(action.payload.id);
      break;
    case 'share':
      dispatch.openChatWithDraft({
        text: formatShareText(payload.url, payload.text, payload.title),
        files: validateFiles(payload.files),
      });
      break;
  }
}

function subscribeToWorker() {
  navigator.serviceWorker.removeEventListener('message', handleWorkerMessage);
  navigator.serviceWorker.addEventListener('message', handleWorkerMessage);
  // Notify web worker that client is ready to receive messages
  notifyClientReady();
}

if (IS_SERVICE_WORKER_SUPPORTED && IS_ANDROID_APP) {
  // The Android app carries these files itself; a worker only adds cache lookups and network races to startup
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
    .catch(() => undefined);
} else if (IS_SERVICE_WORKER_SUPPORTED) {
  window.addEventListener('load', async () => {
    try {
      const controller = navigator.serviceWorker.controller;
      if (!controller || controller.scriptURL.includes(IGNORE_WORKER_PATH)) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        const ourRegistrations = registrations.filter((r) => !r.scope.includes(IGNORE_WORKER_PATH));
        if (ourRegistrations.length) {
          if (DEBUG) {
            // eslint-disable-next-line no-console
            console.log('[SW] Hard reload detected, re-enabling Service Worker');
          }
          await Promise.all(ourRegistrations.map((r) => r.unregister()));
        }
      }

      await navigator.serviceWorker.register(serviceWorkerUrl, SERVICE_WORKER_OPTIONS);

      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[SW] ServiceWorker registered');
      }

      await navigator.serviceWorker.ready;

      // Wait for registration to be available
      await navigator.serviceWorker.getRegistration();

      if (navigator.serviceWorker.controller) {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[SW] ServiceWorker ready');
        }
        subscribeToWorker();
      } else {
        if (DEBUG) {
          // eslint-disable-next-line no-console
          console.error('[SW] ServiceWorker not available');
        }

        if (!IS_IOS && !IS_ANDROID && !IS_TEST) {
          getActions().showDialog?.({ data: { type: 'error', message: 'SERVICE_WORKER_DISABLED', hasErrorKey: true } });
        }
      }
    } catch (err) {
      if (DEBUG) {
        // eslint-disable-next-line no-console
        console.error('[SW] ServiceWorker registration failed: ', err);
      }
    }
  });
  window.addEventListener('focus', async () => {
    await navigator.serviceWorker.ready;
    subscribeToWorker();
  });
}
