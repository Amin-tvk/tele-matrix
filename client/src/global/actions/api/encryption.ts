import type { ActionReturnType } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { pause } from '../../../util/schedulers';
import { callApi } from '../../../api/gramjs';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { updateTabState } from '../../reducers/tabs';
import { selectTabState } from '../../selectors';

const RECOVERY_PROMPT_DURATION = 15000;

let lastPromptAt = 0;
let isChecking = false;

const SETUP_PROMPT_INTERVAL = 3 * 24 * 60 * 60 * 1000;
const SETUP_PROMPT_STORAGE_KEY = 'peyvand-recovery-setup-prompt';
const RESTORE_MODAL_INTERVAL = 24 * 60 * 60 * 1000;
const RESTORE_MODAL_STORAGE_KEY = 'peyvand-recovery-restore-modal';

function shouldOpenRestoreModal() {
  try {
    const last = Number(localStorage.getItem(RESTORE_MODAL_STORAGE_KEY)) || 0;
    if (Date.now() - last < RESTORE_MODAL_INTERVAL) return false;
    localStorage.setItem(RESTORE_MODAL_STORAGE_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

// Accounts without a recovery key are reminded now and then, as their encrypted messages are lost on sign out
function shouldPromptSetup() {
  try {
    const last = Number(localStorage.getItem(SETUP_PROMPT_STORAGE_KEY)) || 0;
    if (Date.now() - last < SETUP_PROMPT_INTERVAL) return false;
    localStorage.setItem(SETUP_PROMPT_STORAGE_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function getRecoveryMode(status: {
  hasSecretStorage: boolean; isDeviceVerified: boolean; isBackupActive: boolean; isCrossSigningReady: boolean;
}) {
  if (!status.hasSecretStorage) return 'setup';
  if (status.isDeviceVerified && status.isBackupActive && status.isCrossSigningReady) return 'ready';
  return 'restore';
}

// Right after start or a reconnect the backup may still be switching on, and a dropped request reads as missing.
// The prompt waits and asks again, and appears only if the device still isn't set up
const RECHECK_DELAY = 20000;

async function fetchSettledStatus() {
  const first = await callApi('fetchEncryptionStatus');
  if (!first?.isAvailable || first.isUncertain || first.isDeviceBroken || getRecoveryMode(first) === 'ready') {
    return first;
  }
  await pause(RECHECK_DELAY);
  const second = await callApi('fetchEncryptionStatus');
  return second && !second.isUncertain ? second : undefined;
}

addActionHandler('checkEncryptionRecovery', async (global, actions): Promise<void> => {
  if (Date.now() - lastPromptAt < RECOVERY_PROMPT_DURATION || isChecking) return;
  isChecking = true;
  const status = await fetchSettledStatus().finally(() => {
    isChecking = false;
  });
  if (!status?.isAvailable || status.isUncertain) return;
  // A recovery key can't help a device whose keys were lost; it needs a new sign-in instead
  // Opened right away: until the next sign-in, new messages can't be read on this device
  if (status.isDeviceBroken) {
    lastPromptAt = Date.now();
    global = getGlobal();
    if (!selectTabState(global, getCurrentTabId()).encryptionRecoveryModal) {
      actions.openEncryptionRecoveryModal({ tabId: getCurrentTabId() });
    }
    return;
  }
  const mode = getRecoveryMode(status);
  if (mode === 'ready') return;
  // Accounts with only an old key backup can still restore from it
  if (mode === 'setup' && !status.hasKeyBackup && !shouldPromptSetup()) return;
  if (Date.now() - lastPromptAt < RECOVERY_PROMPT_DURATION) return;
  lastPromptAt = Date.now();

  // A device that can't open the account's backup doesn't save its keys there either, so the person's other
  // devices never get them. A passing notice is easy to miss, so the window itself opens once a day
  if (mode === 'restore' && status.hasKeyBackup && shouldOpenRestoreModal()) {
    global = getGlobal();
    if (!selectTabState(global, getCurrentTabId()).encryptionRecoveryModal) {
      actions.openEncryptionRecoveryModal({ isFromPrompt: true, tabId: getCurrentTabId() });
    }
    return;
  }

  const isSetup = mode === 'setup' && !status.hasKeyBackup;
  actions.showNotification({
    message: { key: isSetup ? 'MatrixSetupPrompt' : 'MatrixRecoveryPrompt' },
    actionText: { key: isSetup ? 'MatrixSetupAction' : 'MatrixRecoveryEnter' },
    action: { action: 'openEncryptionRecoveryModal', payload: { isFromPrompt: true, tabId: getCurrentTabId() } },
    duration: RECOVERY_PROMPT_DURATION,
    icon: 'lock',
    tabId: getCurrentTabId(),
  });
});

addActionHandler('openEncryptionRecoveryModal', async (global, actions, payload): Promise<void> => {
  const { isFromPrompt, tabId = getCurrentTabId() } = payload || {};
  global = updateTabState(global, { encryptionRecoveryModal: { isLoading: true } }, tabId);
  setGlobal(global);

  const status = await callApi('fetchEncryptionStatus');

  global = getGlobal();
  if (!selectTabState(global, tabId).encryptionRecoveryModal) return;
  // The reminder was out of date by the time it was tapped: nothing to enter, so no window either
  if (isFromPrompt && status?.isAvailable && !status.isDeviceBroken && getRecoveryMode(status) === 'ready') {
    global = updateTabState(global, { encryptionRecoveryModal: undefined }, tabId);
    setGlobal(global);
    actions.showNotification({ message: { key: 'MatrixRecoveryAlreadySet' }, icon: 'check', tabId });
    return;
  }
  // Accounts with an old key backup but no secret storage restore with the backup key
  const mode = !status?.isAvailable ? 'restore'
    : status.isDeviceBroken ? 'broken'
      : !status.hasSecretStorage && status.hasKeyBackup && !status.isBackupActive ? 'restore'
        : getRecoveryMode(status);
  global = updateTabState(global, {
    encryptionRecoveryModal: { mode, isPasswordBased: status?.isPasswordBased || undefined },
  }, tabId);
  setGlobal(global);
});

addActionHandler('setEncryptionRecoveryMode', (global, actions, payload): ActionReturnType => {
  const { mode, tabId = getCurrentTabId() } = payload;
  if (!selectTabState(global, tabId).encryptionRecoveryModal) return undefined;
  return updateTabState(global, { encryptionRecoveryModal: { mode } }, tabId);
});

addActionHandler('setupEncryptionRecovery', async (global, actions, payload): Promise<void> => {
  const {
    passphrase, password, isReset, tabId = getCurrentTabId(),
  } = payload;
  const mode = selectTabState(global, tabId).encryptionRecoveryModal?.mode;

  global = updateTabState(global, { encryptionRecoveryModal: { mode, isLoading: true } }, tabId);
  setGlobal(global);

  const result = await callApi('setupEncryptionRecovery', { passphrase, password, isReset });

  global = getGlobal();
  if (!selectTabState(global, tabId).encryptionRecoveryModal) return;
  global = updateTabState(global, {
    encryptionRecoveryModal: result?.recoveryKey
      ? { mode, recoveryKey: result.recoveryKey }
      : { mode, errorKey: result?.errorKey || 'MatrixRecoveryErrorUnknown' },
  }, tabId);
  setGlobal(global);
});

addActionHandler('openServerAdminModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { serverAdminModal: {} }, tabId);
});

addActionHandler('closeServerAdminModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { serverAdminModal: undefined }, tabId);
});

addActionHandler('openEmergencyAlertModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { emergencyAlertModal: {} }, tabId);
});

addActionHandler('closeEmergencyAlertModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { emergencyAlertModal: undefined }, tabId);
});

// People with the blue tick post stories from this window
addActionHandler('openStoryComposerModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { storyComposerModal: {} }, tabId);
});

addActionHandler('closeStoryComposerModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { storyComposerModal: undefined }, tabId);
});

addActionHandler('closeEncryptionRecoveryModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  return updateTabState(global, { encryptionRecoveryModal: undefined }, tabId);
});

addActionHandler('restoreEncryptionKeys', async (global, actions, payload): Promise<void> => {
  const { key, tabId = getCurrentTabId() } = payload;

  global = updateTabState(global, { encryptionRecoveryModal: { mode: 'restore', isLoading: true } }, tabId);
  setGlobal(global);

  const result = await callApi('restoreEncryptionKeys', { key });

  global = getGlobal();
  if (!selectTabState(global, tabId).encryptionRecoveryModal) return;

  global = updateTabState(global, {
    encryptionRecoveryModal: result && !result.errorKey
      ? { mode: 'restore', restoredCount: result.imported }
      : { mode: 'restore', errorKey: result?.errorKey || 'MatrixRecoveryErrorUnknown' },
  }, tabId);
  setGlobal(global);
});

// Confirming this sign-in from another device, by comparing emojis on both, instead of entering the recovery key
addActionHandler('requestDeviceVerification', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  global = updateTabState(global, {
    encryptionRecoveryModal: undefined,
    deviceVerificationModal: { state: 'waiting', isIncoming: false },
  }, tabId);
  setGlobal(global);

  const isRequested = await callApi('requestDeviceVerification');
  if (isRequested) return;
  global = getGlobal();
  global = updateTabState(global, { deviceVerificationModal: { state: 'cancelled', isIncoming: false } }, tabId);
  setGlobal(global);
});

addActionHandler('acceptDeviceVerification', (): ActionReturnType => {
  void callApi('acceptDeviceVerification');
});

addActionHandler('confirmDeviceVerification', (global, actions, payload): ActionReturnType => {
  void callApi('confirmDeviceVerification', { isMatch: payload.isMatch });
});

addActionHandler('closeDeviceVerificationModal', (global, actions, payload): ActionReturnType => {
  const { tabId = getCurrentTabId() } = payload || {};
  const state = selectTabState(global, tabId).deviceVerificationModal?.state;
  if (state !== 'done' && state !== 'cancelled') void callApi('cancelDeviceVerification');
  return updateTabState(global, { deviceVerificationModal: undefined }, tabId);
});
