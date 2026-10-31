import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { TabState } from '../../../global/types';

import { callApi } from '../../../api/gramjs';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Modal from '../../ui/Modal';

import styles from './EmergencyAlertModal.module.scss';

export type OwnProps = {
  modal: TabState['emergencyAlertModal'];
};

// Pressing the menu item starts a short countdown that can still be cancelled, so a slip of the finger sends nothing
const COUNTDOWN_SECONDS = 5;
const SECOND_MS = 1000;

type Stage = 'loading' | 'noRecipients' | 'countdown' | 'sending' | 'sent' | 'failed';

const EmergencyAlertModal = ({ modal }: OwnProps) => {
  const { closeEmergencyAlertModal } = getActions();
  const isOpen = Boolean(modal);
  useCurrentOrPrev(modal);

  const [stage, setStage] = useState<Stage>('loading');
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [recipientsCount, setRecipientsCount] = useState(0);
  const [result, setResult] = useState<{ sent: number; failed: number } | undefined>();
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const stopTimer = useLastCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = undefined;
  });

  const send = useLastCallback(async () => {
    stopTimer();
    setStage('sending');
    const response = await callApi('sendEmergencyAlert');
    if (!response || !response.hasRecipients) {
      setStage(response ? 'noRecipients' : 'failed');
      return;
    }
    setResult({ sent: response.sent, failed: response.failed });
    setStage(response.sent ? 'sent' : 'failed');
  });

  useEffect(() => {
    if (!isOpen) {
      stopTimer();
      return;
    }
    setStage('loading');
    setResult(undefined);
    setSecondsLeft(COUNTDOWN_SECONDS);
    void callApi('fetchEmergencyRecipients').then((recipients) => {
      const count = recipients?.userIds.length || 0;
      setRecipientsCount(count);
      if (!count) {
        setStage('noRecipients');
        return;
      }
      setStage('countdown');
      timerRef.current = setInterval(() => {
        setSecondsLeft((seconds) => seconds - 1);
      }, SECOND_MS);
    }).catch(() => setStage('failed'));
  }, [isOpen, stopTimer]);

  useEffect(() => {
    if (stage === 'countdown' && secondsLeft <= 0) void send();
  }, [stage, secondsLeft, send]);

  const handleClose = useLastCallback(() => {
    stopTimer();
    closeEmergencyAlertModal();
  });

  function renderBody() {
    switch (stage) {
      case 'loading':
        return <p className={styles.hint}>Checking who receives emergency alerts…</p>;
      case 'noRecipients':
        return (
          <p className={styles.text}>
            No emergency contacts are set on this server yet. Ask a server admin to add them in the server admin panel.
          </p>
        );
      case 'countdown':
        return (
          <>
            <div className={styles.countdown}>{secondsLeft}</div>
            <p className={styles.text}>
              {`An emergency alert will be sent to ${recipientsCount} ${recipientsCount === 1 ? 'person' : 'people'}.`}
            </p>
            <p className={styles.hint}>Cancel now if you pressed this by mistake.</p>
          </>
        );
      case 'sending':
        return <p className={styles.text}>Sending the emergency alert…</p>;
      case 'sent':
        return (
          <p className={styles.text}>
            {`Emergency alert sent to ${result?.sent} ${result?.sent === 1 ? 'person' : 'people'}.`}
            {result?.failed ? ` ${result.failed} could not be reached.` : ''}
          </p>
        );
      default:
        return <p className={styles.text}>The alert could not be sent. Check your connection and try again.</p>;
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Emergency alert" isSlim>
      <div className={styles.content}>
        <div className={styles.icon}><Icon name="warning" /></div>
        {renderBody()}
        <div className={styles.buttons}>
          {stage === 'countdown' && (
            <Button color="danger" onClick={() => void send()}>Send now</Button>
          )}
          {stage === 'failed' && (
            <Button color="danger" onClick={() => void send()}>Try again</Button>
          )}
          <Button color="translucent" onClick={handleClose}>
            {stage === 'countdown' ? 'Cancel' : 'Close'}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default memo(EmergencyAlertModal);
