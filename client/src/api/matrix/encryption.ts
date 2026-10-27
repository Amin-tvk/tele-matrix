import type { UIAuthCallback } from 'matrix-js-sdk';
import { MatrixError, Method } from 'matrix-js-sdk';
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/key-passphrase';
import { decodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api/recovery-key';
import type { SecretStorageKeyDescription } from 'matrix-js-sdk/lib/secret-storage';

import { DEBUG } from '../../config';
import {
  getClient, getMyUserId, hasClient, onUpdate, waitForSync,
} from './client';
import { getValue, setValue } from './store';

// Recovery of end-to-end encryption keys from the account's server-side backup.
// The recovery key (or passphrase) unlocks secret storage, which holds the cross-signing
// keys used to verify this device and the key that decrypts the message key backup

export type EncryptionStatus = {
  isAvailable: boolean;
  hasSecretStorage: boolean;
  hasKeyBackup: boolean;
  isDeviceVerified: boolean;
  isBackupActive: boolean;
  isCrossSigningReady: boolean;
  // This device's identity differs from the one the server publishes for it, so no one can send it keys
  isDeviceBroken: boolean;
};

export type RecoverySetupResult = {
  recoveryKey?: string;
  errorKey?: 'MatrixSetupPasswordNeeded' | 'MatrixSetupWrongPassword' | 'MatrixRecoveryErrorUnknown';
};

export type RecoveryResult = {
  imported: number;
  total: number;
  errorKey?: 'MatrixRecoveryErrorWrongKey' | 'MatrixRecoveryErrorNoBackup' | 'MatrixRecoveryErrorUnknown';
};

let pendingSecretStorageKey: { keyId: string; key: Uint8Array<ArrayBuffer> } | undefined;

export function getSecretStorageKeyCallback(
  { keys }: { keys: Record<string, SecretStorageKeyDescription> },
): Promise<[string, Uint8Array<ArrayBuffer>] | null> {
  if (pendingSecretStorageKey && keys[pendingSecretStorageKey.keyId]) {
    return Promise.resolve([pendingSecretStorageKey.keyId, pendingSecretStorageKey.key]);
  }
  return Promise.resolve(null);
}

// Called by the SDK when it creates a new secret storage key, so secrets can be stored with it right away
export function cacheSecretStorageKeyCallback(keyId: string, keyInfo: unknown, key: Uint8Array<ArrayBuffer>) {
  pendingSecretStorageKey = { keyId, key };
}

const RECOVERY_KEY_RE = /^E[s-zS-Z1-9]{2}[1-9A-HJ-NP-Za-km-z\s]+$/;

function looksLikeRecoveryKey(input: string) {
  return RECOVERY_KEY_RE.test(input.trim()) && input.replace(/\s/g, '').length >= 48;
}

export async function fetchEncryptionStatus(): Promise<EncryptionStatus | undefined> {
  if (!hasClient()) return undefined;
  await waitForSync();
  const client = getClient();
  const crypto = client.getCrypto();
  if (!crypto) {
    return {
      isAvailable: false,
      hasSecretStorage: false,
      hasKeyBackup: false,
      isDeviceVerified: false,
      isBackupActive: false,
      isCrossSigningReady: false,
      isDeviceBroken: false,
    };
  }

  const [
    defaultKeyId, backupInfo, verification, activeBackup, isCrossSigningReady, isDeviceBroken,
  ] = await Promise.all([
    client.secretStorage.getDefaultKeyId().catch(() => null),
    crypto.getKeyBackupInfo().catch(() => null),
    crypto.getDeviceVerificationStatus(getMyUserId(), client.getDeviceId()!).catch(() => null),
    crypto.getActiveSessionBackupVersion().catch(() => null),
    crypto.isCrossSigningReady().catch(() => false),
    checkIsDeviceBroken(),
  ]);

  return {
    isAvailable: true,
    hasSecretStorage: Boolean(defaultKeyId),
    hasKeyBackup: Boolean(backupInfo),
    isDeviceVerified: Boolean(verification?.crossSigningVerified),
    isBackupActive: Boolean(activeBackup),
    isCrossSigningReady,
    isDeviceBroken,
  };
}

type KeysQueryResponse = {
  device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>>;
};

let deviceCheck: { deviceId: string; isBroken: boolean } | undefined;
// Remembered, as the signs of a lost store go away once its old one-time keys are cleared
const BROKEN_DEVICE_KEY = 'broken-device';

// A device whose local crypto store was lost and recreated keeps its device ID but gets new keys.
// The server refuses to replace the published ones, so other people keep encrypting for the lost keys
// and new messages never become readable here. Only signing in again (a new device) fixes it
async function checkIsDeviceBroken() {
  const client = getClient();
  const deviceId = client.getDeviceId();
  const crypto = client.getCrypto();
  if (!deviceId || !crypto) return false;
  if (getValue(BROKEN_DEVICE_KEY) === deviceId) return true;
  if (deviceCheck?.deviceId === deviceId) return deviceCheck.isBroken;

  try {
    const [ownKeys, response] = await Promise.all([
      crypto.getOwnDeviceKeys(),
      client.http.authedRequest<KeysQueryResponse>(Method.Post, '/keys/query', undefined, {
        device_keys: { [getMyUserId()]: [deviceId] },
      }),
    ]);
    const publishedKey = response.device_keys?.[getMyUserId()]?.[deviceId]?.keys?.[`curve25519:${deviceId}`];
    // Keys not published yet are uploaded by the SDK shortly
    if (!publishedKey) return false;
    deviceCheck = { deviceId, isBroken: publishedKey !== ownKeys.curve25519 };
    return deviceCheck.isBroken;
  } catch {
    return false;
  }
}

type KeysClaimResponse = {
  one_time_keys?: Record<string, Record<string, Record<string, { fallback?: boolean }>>>;
};

// Each claim takes one key off the server; Synapse holds at most 100 per device
const MAX_STALE_KEY_CLAIMS = 150;
// The SDK retries a refused upload every few seconds; one cleanup covers many of them
const STALE_KEYS_RETRY_MS = 60000;

let isClearingStaleKeys = false;
let lastStaleKeysClearAt = 0;

// A device whose crypto store was recreated under the same device ID gets new identity keys, which
// the server accepts, but its one-time keys from before stay there under the same IDs, so its uploads
// of new ones are refused. People who already knew the device keep its old keys (their apps refuse a
// changed identity under the same device ID), so their messages can never be read here again.
// Only signing in again, as a new device, fixes that
export function handleKeyUploadConflict() {
  const deviceId = getClient().getDeviceId();
  if (!deviceId) return;
  if (getValue(BROKEN_DEVICE_KEY) !== deviceId) {
    setValue(BROKEN_DEVICE_KEY, deviceId);
    deviceCheck = { deviceId, isBroken: true };
    onUpdate({ '@type': 'updateEncryptionKeysMissing' });
  }
  void clearStaleOneTimeKeys();
}

// Claiming the old keys away stops the refused uploads, which the SDK would otherwise repeat forever
async function clearStaleOneTimeKeys() {
  if (isClearingStaleKeys || Date.now() - lastStaleKeysClearAt < STALE_KEYS_RETRY_MS) return;
  isClearingStaleKeys = true;
  lastStaleKeysClearAt = Date.now();

  const client = getClient();
  const userId = getMyUserId();
  const deviceId = client.getDeviceId();
  try {
    if (!deviceId) return;
    for (let i = 0; i < MAX_STALE_KEY_CLAIMS; i++) {
      const response = await client.http.authedRequest<KeysClaimResponse>(Method.Post, '/keys/claim', undefined, {
        one_time_keys: { [userId]: { [deviceId]: 'signed_curve25519' } },
      });
      const key = Object.values(response.one_time_keys?.[userId]?.[deviceId] || {})[0];
      // Only the fallback key is left once the one-time keys are gone; the SDK replaces it with its next upload
      if (!key || key.fallback) break;
    }
  } catch (err) {
    if (DEBUG) console.warn('[matrix] Clearing stale one-time keys failed', err);
  } finally {
    isClearingStaleKeys = false;
  }
}

async function unlockSecretStorage(input: string) {
  const client = getClient();
  const keyTuple = await client.secretStorage.getKey();
  if (!keyTuple) return undefined;
  const [keyId, keyInfo] = keyTuple;

  const candidates: Uint8Array<ArrayBuffer>[] = [];
  if (looksLikeRecoveryKey(input)) {
    try {
      candidates.push(decodeRecoveryKey(input));
    } catch {
      // Not a valid recovery key, may still be a passphrase
    }
  }
  const { passphrase } = keyInfo as { passphrase?: { salt: string; iterations: number; bits?: number } };
  if (passphrase?.salt) {
    candidates.push(await deriveRecoveryKeyFromPassphrase(input, passphrase.salt, passphrase.iterations, passphrase.bits));
  }

  for (const key of candidates) {
    if (await client.secretStorage.checkKey(key, keyInfo)) {
      return { keyId, key };
    }
  }
  return false;
}

export async function restoreEncryptionKeys({ key: input }: { key: string }): Promise<RecoveryResult> {
  await waitForSync();
  const client = getClient();
  const crypto = client.getCrypto();
  if (!crypto) return { imported: 0, total: 0, errorKey: 'MatrixRecoveryErrorUnknown' };

  try {
    const unlocked = await unlockSecretStorage(input.trim());

    if (unlocked === false) {
      return { imported: 0, total: 0, errorKey: 'MatrixRecoveryErrorWrongKey' };
    }

    if (unlocked) {
      pendingSecretStorageKey = unlocked;
      try {
        // Imports the cross-signing keys from secret storage and signs this device with them
        await crypto.bootstrapCrossSigning({});
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      } finally {
        pendingSecretStorageKey = undefined;
      }
    } else {
      // Older accounts may have a key backup without secret storage; the input is then the backup key itself
      const backupInfo = await crypto.getKeyBackupInfo();
      if (!backupInfo?.version) return { imported: 0, total: 0, errorKey: 'MatrixRecoveryErrorNoBackup' };
      if (!looksLikeRecoveryKey(input)) return { imported: 0, total: 0, errorKey: 'MatrixRecoveryErrorWrongKey' };
      await crypto.storeSessionBackupPrivateKey(decodeRecoveryKey(input), backupInfo.version);
    }

    const check = await crypto.checkKeyBackupAndEnable();
    if (!check?.backupInfo) {
      return { imported: 0, total: 0, errorKey: 'MatrixRecoveryErrorNoBackup' };
    }
    const result = await crypto.restoreKeyBackup();
    return { imported: result.imported, total: result.total };
  } catch (err) {
    if (DEBUG) console.warn('[matrix] Key recovery failed', err);
    const message = err instanceof Error ? err.message : String(err);
    const isKeyMismatch = /mac|decrypt|key/i.test(message) && !/network|fetch|timeout/i.test(message);
    return { imported: 0, total: 0, errorKey: isKeyMismatch ? 'MatrixRecoveryErrorWrongKey' : 'MatrixRecoveryErrorUnknown' };
  }
}

class PasswordRequiredError extends Error {}

function buildPasswordAuth(password?: string): UIAuthCallback<void> {
  return async (makeRequest) => {
    try {
      // Servers let accounts upload their first cross-signing keys without re-authenticating
      await makeRequest(null);
    } catch (err) {
      if (!(err instanceof MatrixError) || err.httpStatus !== 401 || !err.data?.flows) throw err;
      if (!password) throw new PasswordRequiredError();
      await makeRequest({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: getMyUserId() },
        password,
        session: err.data.session,
      });
    }
  };
}

// Creates a recovery key for the account: cross-signing keys (verifying this device), secret storage
// protected by the new key, and a server-side backup of message keys. With `isReset`, existing
// encryption identity and backups are replaced, which needs the account password
export async function setupEncryptionRecovery({ passphrase, password, isReset }: {
  passphrase?: string; password?: string; isReset?: boolean;
}): Promise<RecoverySetupResult> {
  await waitForSync();
  const client = getClient();
  const crypto = client.getCrypto();
  if (!crypto) return { errorKey: 'MatrixRecoveryErrorUnknown' };

  const authUploadDeviceSigningKeys = buildPasswordAuth(password);

  try {
    const generatedKey = await crypto.createRecoveryKeyFromPassphrase(passphrase?.trim() || undefined);

    if (isReset) {
      await crypto.resetEncryption(authUploadDeviceSigningKeys);
    } else if (!await crypto.isCrossSigningReady()) {
      await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true, authUploadDeviceSigningKeys });
    }

    // Keeps the current backup when this device can already use it, otherwise starts a new one
    const hasUsableBackup = Boolean(await crypto.getActiveSessionBackupVersion());
    await crypto.bootstrapSecretStorage({
      createSecretStorageKey: () => Promise.resolve(generatedKey),
      setupNewSecretStorage: true,
      setupNewKeyBackup: !hasUsableBackup,
    });
    await crypto.checkKeyBackupAndEnable();

    return { recoveryKey: generatedKey.encodedPrivateKey };
  } catch (err) {
    if (err instanceof PasswordRequiredError) return { errorKey: 'MatrixSetupPasswordNeeded' };
    if (err instanceof MatrixError && (err.httpStatus === 401 || err.errcode === 'M_FORBIDDEN')) {
      return { errorKey: password ? 'MatrixSetupWrongPassword' : 'MatrixSetupPasswordNeeded' };
    }
    if (DEBUG) console.warn('[matrix] Recovery setup failed', err);
    return { errorKey: 'MatrixRecoveryErrorUnknown' };
  } finally {
    pendingSecretStorageKey = undefined;
  }
}
