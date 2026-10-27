import { memo } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { TabState } from '../../../global/types';

import buildClassName from '../../../util/buildClassName';
import renderText from '../../common/helpers/renderText';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Loading from '../../ui/Loading';
import Modal from '../../ui/Modal';

import styles from './EncryptionRecoveryModal.module.scss';

export type OwnProps = {
  modal: TabState['deviceVerificationModal'];
};

// Both devices of the account show the same seven emojis; the person confirms on each that they match
const DeviceVerificationModal = ({ modal }: OwnProps) => {
  const {
    acceptDeviceVerification, confirmDeviceVerification, closeDeviceVerificationModal, requestDeviceVerification,
    openEncryptionRecoveryModal,
  } = getActions();
  const lang = useLang();

  const isOpen = Boolean(modal);
  const renderingModal = useCurrentOrPrev(modal);
  const { state, isIncoming, emojis, restoredCount } = renderingModal || {};

  const handleClose = useLastCallback(() => closeDeviceVerificationModal());
  const handleAccept = useLastCallback(() => acceptDeviceVerification());
  const handleMatch = useLastCallback(() => confirmDeviceVerification({ isMatch: true }));
  const handleNoMatch = useLastCallback(() => confirmDeviceVerification({ isMatch: false }));
  const handleRetry = useLastCallback(() => requestDeviceVerification());
  const handleUseKey = useLastCallback(() => {
    closeDeviceVerificationModal();
    openEncryptionRecoveryModal();
  });

  function renderEmojis() {
    return (
      <div className={styles.emojis} dir="ltr">
        {emojis?.map(({ emoji, name }) => (
          <div key={name} className={styles.emojiItem}>
            <span className={styles.emoji}>{renderText(emoji, ['emoji'])}</span>
            <span className={styles.emojiName}>{name}</span>
          </div>
        ))}
      </div>
    );
  }

  function renderContent() {
    switch (state) {
      case 'incoming':
        return (
          <>
            <p className={styles.description}>{lang('MatrixVerifyIncoming')}</p>
            <div className="dialog-buttons">
              <Button className="confirm-dialog-button" isText onClick={handleAccept}>
                {lang('MatrixVerifyAccept')}
              </Button>
              <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
            </div>
          </>
        );
      case 'emoji':
      case 'confirmed':
        return (
          <>
            <p className={styles.description}>
              {lang(state === 'confirmed' ? 'MatrixVerifyConfirmedWaiting' : 'MatrixVerifyEmoji')}
            </p>
            {renderEmojis()}
            {state === 'emoji' && (
              <div className="dialog-buttons">
                <Button className="confirm-dialog-button" isText onClick={handleMatch}>
                  {lang('MatrixVerifyMatch')}
                </Button>
                <Button className="confirm-dialog-button" isText color="danger" onClick={handleNoMatch}>
                  {lang('MatrixVerifyNoMatch')}
                </Button>
              </div>
            )}
          </>
        );
      case 'done':
        return (
          <>
            <p className={styles.description}>{lang(isIncoming ? 'MatrixVerifyDoneOther' : 'MatrixVerifyDone')}</p>
            {Boolean(restoredCount) && (
              <p className={styles.description}>
                {lang('MatrixRecoveryDone', { count: restoredCount }, { pluralValue: restoredCount })}
              </p>
            )}
            <div className="dialog-buttons">
              <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Done')}</Button>
            </div>
          </>
        );
      case 'cancelled':
        return (
          <>
            <p className={styles.description}>{lang('MatrixVerifyCancelled')}</p>
            <div className="dialog-buttons">
              {!isIncoming && (
                <Button className="confirm-dialog-button" isText onClick={handleRetry}>{lang('Retry')}</Button>
              )}
              {!isIncoming && (
                <Button className="confirm-dialog-button" isText onClick={handleUseKey}>
                  {lang('MatrixRecoveryKey')}
                </Button>
              )}
              <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Close')}</Button>
            </div>
          </>
        );
      default:
        return (
          <>
            <p className={styles.description}>{lang('MatrixVerifyWaiting')}</p>
            <Loading className={buildClassName(styles.loading, styles.verifyLoading)} />
            <div className="dialog-buttons">
              <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
            </div>
          </>
        );
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      title={lang(isIncoming ? 'MatrixVerifyIncomingTitle' : 'MatrixVerifyTitle')}
      hasCloseButton
      className={styles.root}
      onClose={handleClose}
    >
      {renderContent()}
    </Modal>
  );
};

export default memo(DeviceVerificationModal);
