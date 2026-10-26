import type { RegularLangFnParameters } from '../../util/localization/types';
import type { MatrixSession } from './session';

import { onUpdate, startClient } from './client';
import { DEVICE_DISPLAY_NAME, MATRIX_HOMESERVER_URL } from './constants';

type MatrixErrorResponse = {
  errcode?: string;
  error?: string;
  session?: string;
  flows?: { stages: string[] }[];
  completed?: string[];
};

const USERNAME_RE = /^[a-z0-9._=\-/]+$/;

function sendAuthError(errorKey: RegularLangFnParameters) {
  onUpdate({ '@type': 'updateAuthorizationError', errorKey });
  onUpdate({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(`${MATRIX_HOMESERVER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function normalizeUsername(username: string) {
  return username.trim().replace(/^@/, '').split(':')[0].toLowerCase();
}

function buildSession(data: { user_id: string; access_token: string; device_id: string }): MatrixSession {
  return {
    homeserver: MATRIX_HOMESERVER_URL,
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
  };
}

export async function provideMatrixLogin({ username, password }: { username: string; password: string }) {
  const user = normalizeUsername(username);
  if (!user || !password) {
    sendAuthError({ key: 'MatrixErrorFillFields' });
    return;
  }

  try {
    const { status, data } = await postJson('/_matrix/client/v3/login', {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    });

    if (status !== 200) {
      const errcode = (data as MatrixErrorResponse).errcode;
      sendAuthError({
        key: errcode === 'M_FORBIDDEN' ? 'MatrixErrorInvalidCredentials'
          : errcode === 'M_LIMIT_EXCEEDED' ? 'MatrixErrorTooManyAttempts' : 'MatrixErrorUnknown',
      });
      return;
    }

    await startClient(buildSession(data), true);
  } catch {
    sendAuthError({ key: 'MatrixErrorNetwork' });
  }
}

export async function provideMatrixRegistration({
  username, password, token, displayName,
}: { username: string; password: string; token: string; displayName?: string }) {
  const user = normalizeUsername(username);
  if (!user || !password || !token) {
    sendAuthError({ key: 'MatrixErrorFillFields' });
    return;
  }
  if (!USERNAME_RE.test(user)) {
    sendAuthError({ key: 'MatrixErrorInvalidUsername' });
    return;
  }

  try {
    const baseRequest = {
      username: user,
      password,
      initial_device_display_name: DEVICE_DISPLAY_NAME,
    };

    let { status, data } = await postJson('/_matrix/client/v3/register', baseRequest);
    let attempts = 0;

    // User-interactive authentication: registration token, then the dummy stage
    while (status === 401 && attempts < 3) {
      attempts++;
      const uia = data as MatrixErrorResponse;
      const completed = uia.completed || [];
      const flow = uia.flows?.find(({ stages }) => stages.includes('m.login.registration_token')) || uia.flows?.[0];
      const nextStage = flow?.stages.find((stage) => !completed.includes(stage));
      if (!nextStage || !uia.session) break;

      const auth = nextStage === 'm.login.registration_token'
        ? { type: nextStage, token: token.trim(), session: uia.session }
        : { type: nextStage, session: uia.session };
      ({ status, data } = await postJson('/_matrix/client/v3/register', { ...baseRequest, auth }));

      if (status === 401 && (data as MatrixErrorResponse).errcode) break;
    }

    if (status !== 200) {
      const errcode = (data as MatrixErrorResponse).errcode;
      sendAuthError({
        key: errcode === 'M_USER_IN_USE' ? 'MatrixErrorUsernameTaken'
          : errcode === 'M_INVALID_USERNAME' ? 'MatrixErrorInvalidUsername'
            : errcode === 'M_WEAK_PASSWORD' ? 'MatrixErrorWeakPassword'
              : status === 401 ? 'MatrixErrorInvalidToken' : 'MatrixErrorUnknown',
      });
      return;
    }

    const session = buildSession(data);
    if (displayName?.trim()) {
      await fetch(`${MATRIX_HOMESERVER_URL}/_matrix/client/v3/profile/${encodeURIComponent(session.userId)}/displayname`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ displayname: displayName.trim() }),
      }).catch(() => undefined);
    }

    await startClient(session, true);
  } catch {
    sendAuthError({ key: 'MatrixErrorNetwork' });
  }
}
