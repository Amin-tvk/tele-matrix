import type { ActionReturnType } from '../../types';

import { getCurrentTabId } from '../../../util/establishMultitabRole';
import { callApi } from '../../../api/gramjs';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { updateTabState } from '../../reducers/tabs';
import { selectTabState } from '../../selectors';

const RECOVERY_PROMPT_DURATION = 15000;

let lastPromptAt = 0;

const SETUP_PROMPT_INTERVAL = 3 * 24 * 60 * 60 * 1000;
const SETUP_PROMPT_STORAGE_KEY = 'peyvand-recovery-setup-prompt';

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

addActionHandler('checkEncryptionRecovery', async (global, actions): Promise<void> => {
  if (Date.now() - lastPromptAt < RECOVERY_PROMPT_DURATION) return;
  const status = await callApi('fetchEncryptionStatus');
  if (!status?.isAvailable) return;
  const mode = getRecoveryMode(status);
  if (mode === 'ready') return;
  // Accounts with only an old key backup can still restore from it
  if (mode === 'setup' && !status.hasKeyBackup && !shouldPromptSetup()) return;
  if (Date.now() - lastPromptAt < RECOVERY_PROMPT_DURATION) return;
  lastPromptAt = Date.now();

  const isSetup = mode === 'setup' && !status.hasKeyBackup;
  actions.showNotification({
    message: { key: isSetup ? 'MatrixSetupPrompt' : 'MatrixRecoveryPrompt' },
    actionText: { key: isSetup ? 'MatrixSetupAction' : 'MatrixRecoveryEnter' },
    action: { action: 'openEncryptionRecoveryModal', payload: { tabId: getCurrentTabId() } },
    duration: RECOVERY_PROMPT_DURATION,
    icon: 'lock',
    tabId: getCurrentTabId(),
  });
});

addActionHandler('openEncryptionRecoveryModal', async (global, actions, payload): Promise<void> => {
  const { tabId = getCurrentTabId() } = payload || {};
  global = updateTabState(global, { encryptionRecoveryModal: { isLoading: true } }, tabId);
  setGlobal(global);

  const status = await callApi('fetchEncryptionStatus');

  global = getGlobal();
  if (!selectTabState(global, tabId).encryptionRecoveryModal) return;
  // Accounts with an old key backup but no secret storage restore with the backup key
  const mode = !status?.isAvailable ? 'restore'
    : !status.hasSecretStorage && status.hasKeyBackup && !status.isBackupActive ? 'restore'
      : getRecoveryMode(status);
  global = updateTabState(global, { encryptionRecoveryModal: { mode } }, tabId);
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
