import { Method } from 'matrix-js-sdk';

import {
  buildUser, getClient, getMyUserId, hasClient, onUpdate, rememberProfile,
} from './client';
import { getPeerIdByUserId } from './ids';

// Server administration through the Synapse admin API. Every request is authorized by the server,
// so these methods only work for accounts marked as server admins

const ADMIN_PREFIX = '/_synapse/admin';
const USERS_PAGE_SIZE = 100;

export type AdminUser = {
  userId: string;
  peerId: string;
  displayName?: string;
  isAdmin: boolean;
  isDeactivated: boolean;
  createdAt?: number;
};

export type AdminInvite = {
  token: string;
  usesAllowed?: number;
  completed: number;
  pending: number;
  expiresAt?: number;
};

type SynapseUser = {
  name: string;
  displayname?: string | null;
  avatar_url?: string | null;
  admin: boolean | number;
  deactivated: boolean | number;
  creation_ts?: number;
};

type SynapseToken = {
  token: string;
  uses_allowed: number | null;
  pending: number;
  completed: number;
  expiry_time: number | null;
};

function adminRequest<T>(method: Method, path: string, query?: Record<string, string>, body?: object) {
  return getClient().http.authedRequest<T>(method, path, query, body, { prefix: ADMIN_PREFIX });
}

function getFullUserId(username: string) {
  const cleaned = username.trim().replace(/^@/, '');
  return cleaned.includes(':') ? `@${cleaned}` : `@${cleaned}:${getClient().getDomain()}`;
}

function buildAdminUser(user: SynapseUser): AdminUser {
  // Makes the user known to the UI so a chat with them can be opened from the list
  rememberProfile(user.name, user.displayname, user.avatar_url);
  const peerId = getPeerIdByUserId(user.name);
  const apiUser = buildUser(user.name);
  onUpdate({ '@type': 'updateUser', id: apiUser.id, user: apiUser });

  return {
    userId: user.name,
    peerId,
    displayName: user.displayname || undefined,
    isAdmin: Boolean(user.admin),
    isDeactivated: Boolean(user.deactivated),
    createdAt: user.creation_ts,
  };
}

export async function fetchIsServerAdmin() {
  if (!hasClient()) return false;
  try {
    const { admin } = await adminRequest<{ admin: boolean }>(
      Method.Get, `/v1/users/${encodeURIComponent(getMyUserId())}/admin`,
    );
    return Boolean(admin);
  } catch {
    return false;
  }
}

export async function fetchAdminUsers({ query, offset = 0 }: { query?: string; offset?: number }) {
  const params: Record<string, string> = {
    from: String(offset),
    limit: String(USERS_PAGE_SIZE),
    guests: 'false',
    deactivated: 'true',
    order_by: 'creation_ts',
    dir: 'b',
  };
  if (query?.trim()) params.name = query.trim().replace(/^@/, '');

  const [{ users, total, next_token: nextToken }, rooms] = await Promise.all([
    adminRequest<{ users: SynapseUser[]; total: number; next_token?: string }>(Method.Get, '/v2/users', params),
    adminRequest<{ total_rooms: number }>(Method.Get, '/v1/rooms', { limit: '1' }).catch(() => undefined),
  ]);

  return {
    users: users.map(buildAdminUser),
    total,
    roomsCount: rooms?.total_rooms,
    nextOffset: nextToken ? Number(nextToken) : undefined,
  };
}

export async function createAdminUser({ username, password, displayName }: {
  username: string; password: string; displayName?: string;
}) {
  const userId = getFullUserId(username);
  const user = await adminRequest<SynapseUser>(Method.Put, `/v2/users/${encodeURIComponent(userId)}`, undefined, {
    password,
    displayname: displayName || undefined,
    admin: false,
  });
  return buildAdminUser({ ...user, name: user.name || userId });
}

export async function setUserServerAdmin({ userId, isAdmin }: { userId: string; isAdmin: boolean }) {
  await adminRequest(Method.Put, `/v1/users/${encodeURIComponent(userId)}/admin`, undefined, { admin: isAdmin });
  return true;
}

export async function resetUserPassword({ userId, password }: { userId: string; password: string }) {
  await adminRequest(Method.Post, `/v1/reset_password/${encodeURIComponent(userId)}`, undefined, {
    new_password: password,
    logout_devices: true,
  });
  return true;
}

export async function logoutUserDevices({ userId }: { userId: string }) {
  const { devices } = await adminRequest<{ devices: { device_id: string }[] }>(
    Method.Get, `/v2/users/${encodeURIComponent(userId)}/devices`,
  );
  if (devices.length) {
    await adminRequest(Method.Post, `/v2/users/${encodeURIComponent(userId)}/delete_devices`, undefined, {
      devices: devices.map(({ device_id: deviceId }) => deviceId),
    });
  }
  return devices.length;
}

export async function setUserDeactivated({ userId, isDeactivated, password }: {
  userId: string; isDeactivated: boolean; password?: string;
}) {
  if (isDeactivated) {
    await adminRequest(Method.Post, `/v1/deactivate/${encodeURIComponent(userId)}`, undefined, { erase: false });
  } else {
    // A reactivated account needs a new password to sign in with
    await adminRequest(Method.Put, `/v2/users/${encodeURIComponent(userId)}`, undefined, {
      deactivated: false,
      password,
    });
  }
  return true;
}

function buildInvite(token: SynapseToken): AdminInvite {
  return {
    token: token.token,
    usesAllowed: token.uses_allowed ?? undefined,
    completed: token.completed,
    pending: token.pending,
    expiresAt: token.expiry_time ?? undefined,
  };
}

export async function fetchAdminInvites() {
  const { registration_tokens: tokens } = await adminRequest<{ registration_tokens: SynapseToken[] }>(
    Method.Get, '/v1/registration_tokens', { valid: 'true' },
  );
  return tokens.map(buildInvite).sort((a, b) => (b.expiresAt || Infinity) - (a.expiresAt || Infinity));
}

export async function createAdminInvite({ usesAllowed, validDays }: { usesAllowed?: number; validDays?: number }) {
  const token = await adminRequest<SynapseToken>(Method.Post, '/v1/registration_tokens/new', undefined, {
    uses_allowed: usesAllowed || null,
    expiry_time: validDays ? Date.now() + validDays * 24 * 60 * 60 * 1000 : null,
  });
  return buildInvite(token);
}

export async function deleteAdminInvite({ token }: { token: string }) {
  await adminRequest(Method.Delete, `/v1/registration_tokens/${encodeURIComponent(token)}`);
  return true;
}
