import type { MatrixClient } from 'matrix-js-sdk';
import type { ShowSasCallbacks, VerificationRequest, Verifier } from 'matrix-js-sdk/lib/crypto-api';
import {
  CryptoEvent, VerificationPhase, VerificationRequestEvent, VerifierEvent,
} from 'matrix-js-sdk/lib/crypto-api';

import type { ApiDeviceVerification } from '../types';

import { DEBUG } from '../../config';
import { getClient, onUpdate } from './client';

// Signing in on a new device can be confirmed from a device that's already signed in, instead of entering the
// recovery key: both show the same emojis, and once the person confirms they match, the old device trusts the new
// one and hands it the key backup key, so the new device can read earlier messages too

const SAS_METHOD = 'm.sas.v1';
// After verification the backup key arrives from the other device in a separate message
const BACKUP_KEY_WAIT_MS = 15000;
const BACKUP_KEY_POLL_MS = 500;

let request: VerificationRequest | undefined;
let attachedVerifier: Verifier | undefined;
let sas: ShowSasCallbacks | undefined;
let isConfirmed = false;
let restoredCount: number | undefined;

function sendState() {
  if (!request) {
    onUpdate({ '@type': 'updateDeviceVerification', verification: undefined });
    return;
  }

  const { phase, initiatedByMe } = request;
  let state: ApiDeviceVerification['state'];
  if (phase === VerificationPhase.Cancelled) {
    state = 'cancelled';
  } else if (phase === VerificationPhase.Done) {
    state = 'done';
  } else if (sas) {
    state = isConfirmed ? 'confirmed' : 'emoji';
  } else if (phase === VerificationPhase.Requested && !initiatedByMe) {
    state = 'incoming';
  } else {
    state = 'waiting';
  }

  onUpdate({
    '@type': 'updateDeviceVerification',
    verification: {
      state,
      isIncoming: !initiatedByMe,
      otherDeviceId: request.otherDeviceId,
      emojis: sas?.sas.emoji?.map(([emoji, name]) => ({ emoji, name })),
      restoredCount,
    },
  });
}

async function restoreFromBackupAfterVerification() {
  const crypto = getClient().getCrypto();
  if (!crypto) return;
  const deadline = Date.now() + BACKUP_KEY_WAIT_MS;
  while (!await crypto.getSessionBackupPrivateKey() && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, BACKUP_KEY_POLL_MS);
    });
  }
  try {
    await crypto.checkKeyBackupAndEnable();
    if (!await crypto.getSessionBackupPrivateKey()) return;
    const result = await crypto.restoreKeyBackup();
    restoredCount = result.imported;
    sendState();
  } catch (err) {
    if (DEBUG) console.warn('[matrix] Restoring keys after verification failed', err);
  }
}

function handleRequestChange() {
  const current = request;
  if (!current) return;

  // The device that asked starts the emoji comparison once the other one accepts
  if (current.phase === VerificationPhase.Ready && current.initiatedByMe && !current.verifier) {
    void current.startVerification(SAS_METHOD).catch(() => undefined);
  }

  const { verifier } = current;
  if (verifier && verifier !== attachedVerifier) {
    attachedVerifier = verifier;
    verifier.on(VerifierEvent.ShowSas, (callbacks) => {
      if (request !== current) return;
      sas = callbacks;
      sendState();
    });
    void verifier.verify().catch(() => undefined);
  }

  if (current.phase === VerificationPhase.Done && current.initiatedByMe) {
    void restoreFromBackupAfterVerification();
  }

  sendState();
}

function setRequest(newRequest: VerificationRequest) {
  request?.off(VerificationRequestEvent.Change, handleRequestChange);
  request = newRequest;
  attachedVerifier = undefined;
  sas = undefined;
  isConfirmed = false;
  restoredCount = undefined;
  newRequest.on(VerificationRequestEvent.Change, handleRequestChange);
  handleRequestChange();
}

export function watchDeviceVerificationRequests(client: MatrixClient) {
  client.on(CryptoEvent.VerificationRequestReceived, (newRequest) => {
    // Only requests from this account's own devices; one at a time
    const isBusy = request && request.phase !== VerificationPhase.Cancelled && request.phase !== VerificationPhase.Done;
    if (!newRequest.isSelfVerification || isBusy) return;
    setRequest(newRequest);
  });
}

export async function requestDeviceVerification() {
  const crypto = getClient().getCrypto();
  if (!crypto) return false;
  setRequest(await crypto.requestOwnUserVerification());
  return true;
}

export async function acceptDeviceVerification() {
  await request?.accept();
  return true;
}

export async function confirmDeviceVerification({ isMatch }: { isMatch: boolean }) {
  if (!sas) return false;
  if (!isMatch) {
    sas.mismatch();
    return true;
  }
  isConfirmed = true;
  sendState();
  await sas.confirm();
  return true;
}

export async function cancelDeviceVerification() {
  const current = request;
  request = undefined;
  sas = undefined;
  sendState();
  const isActive = current && current.phase !== VerificationPhase.Cancelled && current.phase !== VerificationPhase.Done;
  if (isActive) await current.cancel().catch(() => undefined);
  return true;
}
