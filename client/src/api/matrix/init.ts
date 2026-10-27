import type { ApiInitialArgs, ApiOnProgress, OnApiUpdate } from '../types';

import { DEBUG } from '../../config';
import { init as initUpdateEmitter } from '../gramjs/updates/apiUpdateEmitter';
import * as admin from './admin';
import * as auth from './auth';
import * as calls from './calls';
import {
  getClient, hasClient, onUpdate, retryConnectionNow, startClient, stopClient,
} from './client';
import * as directory from './directory';
import * as encryption from './encryption';
import * as folders from './folders';
import * as lastSeen from './lastSeen';
import { downloadMedia } from './media';
import * as methods from './methods';
import { parseSessionData } from './session';
import * as stubs from './stubs';
import * as verification from './verification';
import { setMyBadgeEmoji, setPeerVerified } from './verifiedBadges';

const LOGOUT_TIMEOUT_MS = 2500;

async function destroy(noLogOut = false, noClearLocalDb = false) {
  if (hasClient() && !noLogOut) {
    await Promise.race([
      getClient().logout(true).catch(() => undefined),
      new Promise((resolve) => {
        setTimeout(resolve, LOGOUT_TIMEOUT_MS);
      }),
    ]);
  }
  await stopClient(!noClearLocalDb);
}

function disconnect() {
  if (hasClient()) getClient().stopClient();
}

function restartAuth() {
  onUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  ...stubs,
  ...methods,
  ...admin,
  ...auth,
  ...calls,
  ...encryption,
  ...directory,
  ...folders,
  ...lastSeen,
  ...verification,
  setPeerVerified,
  setMyBadgeEmoji,
  destroy,
  disconnect,
  restartAuth,
  restartAuthWithQr: restartAuth,
  downloadMedia,
  retryConnectionNow,
};

// The encryption engine is a large WASM module; fetching and compiling it right away overlaps that work with
// the login form or with opening the local stores. The SDK reuses the already loaded module
function preloadCryptoModule() {
  void import('@matrix-org/matrix-sdk-crypto-wasm')
    .then(({ initAsync }) => initAsync())
    .catch((err) => {
      if (DEBUG) console.warn('[matrix] Crypto module preload failed', err);
    });
}

export function initApi(onApiUpdate: OnApiUpdate, initialArgs: ApiInitialArgs, _initialLocalDb?: unknown) {
  initUpdateEmitter(onApiUpdate);
  preloadCryptoModule();

  const session = parseSessionData(initialArgs.sessionData);
  if (session) {
    void startClient(session).catch((err) => {
      if (DEBUG) console.error('[matrix] Failed to start client', err);
      onUpdate({ '@type': 'updateConnectionState', connectionState: 'connectionStateConnecting' });
    });
  } else {
    onUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
  }

  return Promise.resolve();
}

export function callApi(fnName: string, ...args: any[]) {
  const handler = handlers[fnName];
  if (!handler) {
    if (DEBUG) console.debug('[matrix] Unsupported method', fnName);
    return undefined;
  }
  if (!DEBUG) return handler(...args);

  const startedAt = performance.now();
  console.debug(`[matrix] ${fnName} start`);
  const result = handler(...args);
  if (result instanceof Promise) {
    result.then(
      () => console.debug(`[matrix] ${fnName} done in ${Math.round(performance.now() - startedAt)} ms`),
      (err) => console.error(`[matrix] ${fnName} failed`, err),
    );
  }
  return result;
}

export function cancelApiProgress(progressCallback: ApiOnProgress) {
  progressCallback.isCanceled = true;
}
