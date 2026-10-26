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

export const fetchWithDeadline: typeof fetch = (input, init) => {
  let deadline: number | undefined;
  try {
    deadline = getRequestDeadline(new URL(input instanceof Request ? input.url : String(input)));
  } catch {
    deadline = undefined;
  }

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
  const timer = setTimeout(() => {
    isTimedOut = true;
    controller.abort();
  }, deadline);

  return fetch(input, { ...init, signal: controller.signal })
    .catch((err) => {
      // Reported as a network failure so the SDK retries instead of treating it as a cancellation
      if (isTimedOut) throw new TypeError('Request timed out');
      throw err;
    })
    .finally(() => {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', forwardAbort);
    });
};
