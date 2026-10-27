import { ClientEvent, SyncState } from 'matrix-js-sdk';

import { pause } from '../../util/schedulers';
import { getClient, hasClient } from './client';

// Messages and media wait out dropped connections instead of failing. Mobile networks often go away for
// longer than the SDK's own retries (about half a minute), and like in Telegram a message keeps sending
// until the connection is back

const RETRY_DELAYS_MS = [1000, 3000, 5000, 10000];
// The server answering with an error is retried only a few times; it's unlikely to fix itself quickly
const MAX_SERVER_ERROR_ATTEMPTS = 5;

type RequestError = { name?: string; httpStatus?: number };

function getErrorKind(err: unknown) {
  const { name, httpStatus } = (err || {}) as RequestError;
  if (httpStatus) return httpStatus >= 500 || httpStatus === 429 ? 'server' : undefined;
  return name === 'ConnectionError' || name === 'TypeError' ? 'connection' : undefined;
}

function isConnected() {
  const state = getClient().getSyncState();
  return state === SyncState.Syncing || state === SyncState.Prepared;
}

function waitForConnection() {
  if (isConnected()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const client = getClient();
    const handleSync = () => {
      if (!isConnected()) return;
      client.off(ClientEvent.Sync, handleSync);
      resolve();
    };
    client.on(ClientEvent.Sync, handleSync);
  });
}

export async function retryOnNetworkError<T>(task: () => Promise<T>, isCanceled?: () => boolean): Promise<T> {
  let serverErrors = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      const kind = getErrorKind(err);
      if (kind === 'server') serverErrors++;
      if (!kind || serverErrors >= MAX_SERVER_ERROR_ATTEMPTS || isCanceled?.() || !hasClient()) throw err;

      if (kind === 'connection') await waitForConnection();
      await pause(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
      if (isCanceled?.() || !hasClient()) throw err;
    }
  }
}
