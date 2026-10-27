import type { ChangeEvent, FormEvent } from 'react';
import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { TabState } from '../../../global/types';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import InputText from '../../ui/InputText';
import Loading from '../../ui/Loading';
import Modal from '../../ui/Modal';

import styles from './EncryptionRecoveryModal.module.scss';

export type OwnProps = {
  modal: TabState['encryptionRecoveryModal'];
};

const RECOVERY_KEY_FILE_NAME = 'peyvand-recovery-key.txt';

const EncryptionRecoveryModal = ({ modal }: OwnProps) => {
  const {
    restoreEncryptionKeys, closeEncryptionRecoveryModal, setupEncryptionRecovery, setEncryptionRecoveryMode,
    showNotification, signOut, requestDeviceVerification,
  } = getActions();
  const lang = useLang();

  const isOpen = Boolean(modal);
  const renderingModal = useCurrentOrPrev(modal);
  const {
    mode, isLoading, errorKey, restoredCount, recoveryKey,
    isPasswordBased,
  } = renderingModal || {};
  const isRestoreDone = restoredCount !== undefined;
  const isPasswordShown = mode === 'reset'
    || errorKey === 'MatrixSetupPasswordNeeded' || errorKey === 'MatrixSetupWrongPassword';

  const [key, setKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [password, setPassword] = useState('');

  const handleKeyChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setKey(e.target.value);
  });

  const handlePassphraseChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassphrase(e.target.value);
  });

  const handlePasswordChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  });

  const handleClose = useLastCallback(() => {
    closeEncryptionRecoveryModal();
    setKey('');
    setPassphrase('');
    setPassword('');
  });

  const handleRestoreSubmit = useLastCallback((e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!key.trim() || isLoading) return;
    restoreEncryptionKeys({ key });
  });

  const handleSetupSubmit = useLastCallback((e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (isLoading || (isPasswordShown && !password)) return;
    setupEncryptionRecovery({
      passphrase: passphrase.trim() || undefined,
      password: password || undefined,
      isReset: mode === 'reset',
    });
  });

  const handleCopy = useLastCallback(() => {
    if (!recoveryKey) return;
    copyTextToClipboard(recoveryKey);
    showNotification({ message: { key: 'TextCopied' } });
  });

  const handleSignOut = useLastCallback(() => {
    handleClose();
    signOut({ forceInitApi: true });
  });

  const handleVerify = useLastCallback(() => {
    setKey('');
    requestDeviceVerification();
  });

  const handleDownload = useLastCallback(() => {
    if (!recoveryKey) return;
    const blob = new Blob([`${lang('MatrixSetupKeyFileHeader')}\n\n${recoveryKey}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = RECOVERY_KEY_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  });

  const openMode = (newMode: 'setup' | 'reset' | 'restore') => {
    setPassword('');
    setPassphrase('');
    setEncryptionRecoveryMode({ mode: newMode });
  };

  function renderRecoveryKey() {
    return (
      <>
        <p className={styles.description}>{lang('MatrixSetupKeyDescription')}</p>
        <div className={styles.recoveryKey} dir="ltr">{recoveryKey}</div>
        <div className={styles.keyActions}>
          <Button isText inline size="smaller" onClick={handleCopy}>{lang('Copy')}</Button>
          <Button isText inline size="smaller" onClick={handleDownload}>{lang('MediaDownload')}</Button>
        </div>
        <p className={buildClassName(styles.description, styles.warning)}>{lang('MatrixSetupKeyWarning')}</p>
        <div className="dialog-buttons">
          <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('MatrixSetupKeySaved')}</Button>
        </div>
      </>
    );
  }

  function renderSetup() {
    const isReset = mode === 'reset';
    return (
      <form onSubmit={handleSetupSubmit}>
        <p className={styles.description}>
          {lang(isReset ? 'MatrixResetDescription' : mode === 'ready' ? 'MatrixReadyNewKey' : 'MatrixSetupDescription')}
        </p>
        <InputText
          id="matrix-recovery-passphrase"
          type="password"
          label={lang('MatrixSetupPassphrase')}
          value={passphrase}
          onChange={handlePassphraseChange}
          autoComplete="new-password"
        />
        <p className={styles.hint}>{lang('MatrixSetupPassphraseHint')}</p>
        {isPasswordShown && (
          <InputText
            id="matrix-account-password"
            type="password"
            label={lang('MatrixSetupPassword')}
            value={password}
            error={errorKey === 'MatrixSetupWrongPassword' ? lang(errorKey) : undefined}
            onChange={handlePasswordChange}
            autoComplete="current-password"
          />
        )}
        {errorKey && errorKey !== 'MatrixSetupWrongPassword' && (
          <p className={styles.error}>{lang(errorKey)}</p>
        )}
        <div className="dialog-buttons">
          <Button
            className="confirm-dialog-button"
            isText
            type="submit"
            color={isReset ? 'danger' : undefined}
            isLoading={isLoading}
            disabled={isPasswordShown && !password}
          >
            {lang(isReset ? 'MatrixResetAction' : 'MatrixSetupCreate')}
          </Button>
          <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
        </div>
      </form>
    );
  }

  function renderReady() {
    return (
      <>
        <p className={styles.description}>{lang('MatrixReadyDescription')}</p>
        <div className="dialog-buttons">
          <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Done')}</Button>
          <Button className="confirm-dialog-button" isText onClick={() => openMode('setup')}>
            {lang('MatrixReadyChangeKey')}
          </Button>
        </div>
      </>
    );
  }

  function renderBroken() {
    return (
      <>
        <p className={styles.description}>{lang('MatrixDeviceBrokenDescription')}</p>
        <p className={buildClassName(styles.description, styles.warning)}>{lang('MatrixDeviceBrokenWarning')}</p>
        <div className="dialog-buttons">
          <Button className="confirm-dialog-button" isText color="danger" onClick={handleSignOut}>
            {lang('MatrixDeviceBrokenAction')}
          </Button>
          <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
        </div>
      </>
    );
  }

  function renderRestore() {
    if (isRestoreDone) {
      return (
        <>
          <p className={styles.description}>
            {lang('MatrixRecoveryDone', { count: restoredCount }, { pluralValue: restoredCount })}
          </p>
          <div className="dialog-buttons">
            <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Done')}</Button>
          </div>
        </>
      );
    }

    return (
      <form onSubmit={handleRestoreSubmit}>
        <p className={styles.description}>
          {lang(isPasswordBased ? 'PeyvandRecoveryPasswordDescription' : 'MatrixRecoveryDescription')}
        </p>
        <InputText
          id="matrix-recovery-key"
          type="password"
          label={lang(isPasswordBased ? 'PeyvandRecoveryPreviousPassword' : 'MatrixRecoveryKey')}
          value={key}
          error={errorKey ? lang(errorKey) : undefined}
          onChange={handleKeyChange}
          autoComplete="off"
        />
        <button type="button" className={styles.link} onClick={() => openMode('reset')}>
          {lang('MatrixRecoveryForgot')}
        </button>
        <button type="button" className={buildClassName(styles.link, styles.verifyLink)} onClick={handleVerify}>
          {lang('MatrixVerifyWithDevice')}
        </button>
        <div className="dialog-buttons">
          <Button
            className="confirm-dialog-button"
            isText
            type="submit"
            isLoading={isLoading}
            disabled={!key.trim()}
          >
            {lang('MatrixRecoveryRestore')}
          </Button>
          <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
        </div>
      </form>
    );
  }

  function renderContent() {
    if (recoveryKey) return renderRecoveryKey();
    if (!mode) return <Loading className={styles.loading} />;
    if (mode === 'restore') return renderRestore();
    if (mode === 'broken') return renderBroken();
    if (mode === 'ready' && !isLoading && !errorKey) return renderReady();
    return renderSetup();
  }

  const title = recoveryKey ? 'MatrixSetupKeyTitle'
    : mode === 'broken' ? 'MatrixDeviceBrokenTitle'
      : mode === 'setup' ? 'MatrixSetupTitle'
        : mode === 'reset' ? 'MatrixResetTitle'
          : mode === 'ready' ? 'MatrixEncryptionSettings'
            : 'MatrixRecoveryTitle';

  return (
    <Modal
      isOpen={isOpen}
      title={lang(title)}
      hasCloseButton
      className={styles.root}
      onClose={handleClose}
    >
      {renderContent()}
    </Modal>
  );
};

export default memo(EncryptionRecoveryModal);
