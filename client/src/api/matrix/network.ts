import { getValue, setValue } from './store';

// Network resilience for the Matrix connection. Proxies and mobile networks often drop idle
// long-poll connections without closing them, which the SDK would only notice after its
// 80-second buffer. Requests are given tight deadlines instead, so a dead connection fails fast
// and the SDK's reconnection logic takes over

// Extra time a long poll may take beyond the timeout the server was asked to hold it for
const LONG_POLL_GRACE_MS = 10000;
// Deadline for regular requests that should answer quickly (sync without waiting, keep-alives)
const SHORT_REQUEST_TIMEOUT_MS = 10000;

function getRequestDeadline(url: URL) {
  const path = url.pathname;
  if (path.endsWith('/sync')) {
    const timeout = Number(url.searchParams.get('timeout')) || 0;
    return timeout + LONG_POLL_GRACE_MS;
  }

  if (path.endsWith('/_matrix/client/versions')) {
    return SHORT_REQUEST_TIMEOUT_MS;
  }

  // Uploads, downloads and other requests keep the SDK's own timeouts
  return undefined;
}

let keyUploadConflictHandler: NoneToVoidFunction | undefined;

export function setKeyUploadConflictHandler(handler: NoneToVoidFunction) {
  keyUploadConflictHandler = handler;
}

// The server refuses one-time keys of this device when it still holds different ones under the same IDs
function watchKeyUpload(response: Response) {
  if (response.status !== 400 || !keyUploadConflictHandler) return response;
  response.clone().text().then((text) => {
    if (/One time key .* already exists/.test(text)) keyUploadConflictHandler?.();
  }).catch(() => undefined);
  return response;
}

// The long poll in flight: after the app was in the background or the network changed it may be dead
// without having failed yet
let pendingSync: { startedAt: number; timeout: number; abort: NoneToVoidFunction } | undefined;
// Grace before an unanswered long poll counts as dead when the app asks (it is cut at LONG_POLL_GRACE_MS anyway)
const OVERDUE_SYNC_GRACE_MS = 2000;

// Fails a long poll that should have been answered by now, so the SDK reconnects right away
export function abortOverdueSync() {
  if (!pendingSync) return false;
  if (Date.now() - pendingSync.startedAt <= pendingSync.timeout + OVERDUE_SYNC_GRACE_MS) return false;
  pendingSync.abort();
  return true;
}

// The SDK asks for the server's versions before it shows the chats saved on the device, which costs a round trip
// (seconds on a slow mobile network) on every start. The first ask is answered from the last answer saved here;
// the server is still asked, to refresh it. Later asks (the SDK's connection checks) always go to the server
const VERSIONS_CACHE_KEY = 'cache:versions';
let isVersionsCacheUsed = false;

function rememberVersions(response: Response) {
  if (response.ok) {
    response.clone().text().then((text) => setValue(VERSIONS_CACHE_KEY, text)).catch(() => undefined);
  }
  return response;
}

function answerVersionsFromCache(input: RequestInfo | URL, init?: RequestInit) {
  if (isVersionsCacheUsed) return undefined;
  isVersionsCacheUsed = true;
  const cached = getValue(VERSIONS_CACHE_KEY);
  if (!cached) return undefined;
  void fetch(input, init).then(rememberVersions).catch(() => undefined);
  return Promise.resolve(new Response(cached, { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

export const fetchWithDeadline: typeof fetch = (input, init) => {
  let deadline: number | undefined;
  let url: URL | undefined;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
    deadline = getRequestDeadline(url);
  } catch {
    deadline = undefined;
  }

  const isVersionsRequest = Boolean(url?.pathname.endsWith('/_matrix/client/versions'));
  if (isVersionsRequest) {
    const cachedAnswer = answerVersionsFromCache(input, init);
    if (cachedAnswer) return cachedAnswer;
  }

  if (url?.pathname.endsWith('/keys/upload')) return fetch(input, init).then(watchKeyUpload);
  if (!deadline) return fetch(input, init);

  const controller = new AbortController();
  const outerSignal = init?.signal;
  const forwardAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) {
    forwardAbort();
  } else {
    outerSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  let isTimedOut = false;
  const timeOut = () => {
    isTimedOut = true;
    controller.abort();
  };
  const timer = setTimeout(timeOut, deadline);
  const isSync = url!.pathname.endsWith('/sync');
  const syncEntry = isSync
    ? { startedAt: Date.now(), timeout: Number(url!.searchParams.get('timeout')) || 0, abort: timeOut }
    : undefined;
  if (syncEntry) pendingSync = syncEntry;

  return fetch(input, { ...init, signal: controller.signal })
    .then((response) => (isVersionsRequest ? rememberVersions(response) : response))
    .catch((err) => {
      // Reported as a network failure so the SDK retries instead of treating it as a cancellation
      if (isTimedOut) throw new TypeError('Request timed out');
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      if (syncEntry && pendingSync === syncEntry) pendingSync = undefined;
      outerSignal?.removeEventListener('abort', forwardAbort);
    });
};
