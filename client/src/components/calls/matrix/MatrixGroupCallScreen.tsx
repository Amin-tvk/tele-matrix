import {
  memo, useEffect, useMemo, useRef,
} from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiChat, ApiUser } from '../../../api/types';
import type { GlobalState } from '../../../global/types';

import { selectChat } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import {
  getMatrixGroupCallLevels, getMatrixGroupCallMyKey, leaveMatrixGroupCall, setMatrixGroupCallScreenOpen,
  toggleMatrixGroupCallMute, toggleMatrixGroupCallSound,
} from '../../../util/calls/matrixGroupCall';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';

import styles from './MatrixGroupCallScreen.module.scss';

// The voice chat in full, as in Telegram's mobile app: everyone in it with what they are doing, and a big button to
// talk. Minimized it becomes the bar over the chat (MatrixGroupCallPill)

type ActiveCall = NonNullable<NonNullable<GlobalState['matrixGroupCalls']>['active']>;

type StateProps = {
  active?: ActiveCall;
  chat?: ApiChat;
  participants: NonNullable<GlobalState['matrixGroupCalls']>['byChatId'][string]['participants'];
  usersById: Record<string, ApiUser>;
};

type Status = 'speaking' | 'listening' | 'muted' | 'connecting';

const STATUS_TEXT: Record<Status, string> = {
  speaking: 'speaking',
  listening: 'listening',
  muted: 'muted',
  connecting: 'connecting…',
};

// A level this loud counts as full volume for the animations
const FULL_LEVEL = 0.12;
const SMOOTHING = 0.75;

const MatrixGroupCallScreen = ({
  active, chat, participants, usersById,
}: StateProps) => {
  const rootRef = useRef<HTMLDivElement>();
  const myKey = getMatrixGroupCallMyKey();
  const isOpen = Boolean(active?.isScreenOpen);

  // Voice levels drive the rings and the big button directly, every frame, outside of rendering
  useEffect(() => {
    if (!isOpen) return undefined;
    const smoothed: Record<string, number> = {};
    let frame = 0;
    const tick = () => {
      const levels = getMatrixGroupCallLevels();
      rootRef.current?.querySelectorAll<HTMLElement>('[data-level-key]').forEach((element) => {
        const key = element.dataset.levelKey!;
        const target = Math.min(1, (levels[key] || 0) / FULL_LEVEL);
        smoothed[key] = (smoothed[key] || 0) * SMOOTHING + target * (1 - SMOOTHING);
        element.style.setProperty('--level', smoothed[key].toFixed(3));
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMatrixGroupCallScreenOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const rows = useMemo(() => {
    if (!active) return [];
    const keyOf = (userId: string, deviceId: string) => `${userId}|${deviceId}`;
    const list = participants.map((participant) => {
      const key = keyOf(participant.userId, participant.deviceId);
      const isMe = key === myKey;
      let status: Status;
      if (isMe) {
        status = active.isMuted ? 'muted' : active.speakingKeys.includes(key) ? 'speaking' : 'listening';
      } else if (!active.connectedKeys.includes(key)) {
        status = 'connecting';
      } else if (active.mutedKeys.includes(key)) {
        status = 'muted';
      } else {
        status = active.speakingKeys.includes(key) ? 'speaking' : 'listening';
      }
      return {
        key, isMe, status, user: usersById[participant.peerId], peerId: participant.peerId,
      };
    });
    // This device first, then whoever is talking
    return list.sort((a, b) => Number(b.isMe) - Number(a.isMe)
      || Number(b.status === 'speaking') - Number(a.status === 'speaking'));
  }, [active, participants, usersById, myKey]);

  if (!active || !isOpen) return undefined;

  const isAnyoneSpeaking = active.speakingKeys.length > 0;
  const count = new Set(participants.map(({ peerId }) => peerId)).size;

  return (
    <div className={styles.overlay} onClick={() => setMatrixGroupCallScreenOpen(false)}>
      <div
        ref={rootRef}
        className={buildClassName(
          styles.root, !active.isMuted && styles.live, isAnyoneSpeaking && styles.speaking,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <button
            type="button"
            className={styles.headerButton}
            aria-label="Minimize"
            onClick={() => setMatrixGroupCallScreenOpen(false)}
          >
            <Icon name="down" />
          </button>
          <div className={styles.titles}>
            <div className={styles.title}>{chat?.title || 'Voice chat'}</div>
            <div className={styles.subtitle}>
              {`Voice chat · ${count} ${count === 1 ? 'participant' : 'participants'}`}
            </div>
          </div>
          <div className={styles.headerButton} style="visibility: hidden" />
        </div>

        <div className={styles.list}>
          {rows.map(({
            key, isMe, status, user, peerId,
          }) => (
            <div key={key} className={buildClassName(styles.row, status === 'speaking' && styles.rowSpeaking)}>
              <div className={styles.avatarWrap} data-level-key={key}>
                <div className={styles.ring} />
                <Avatar peer={user} size="medium" />
              </div>
              <div className={styles.person}>
                <div className={styles.name}>
                  {(user && [user.firstName, user.lastName].filter(Boolean).join(' ')) || peerId}
                  {isMe && <span className={styles.you}>(you)</span>}
                </div>
                <div className={buildClassName(
                  styles.status,
                  status === 'speaking' && styles.statusSpeaking,
                  status === 'muted' && styles.statusMuted,
                  status === 'connecting' && styles.statusConnecting,
                )}
                >
                  {STATUS_TEXT[status]}
                </div>
              </div>
              <Icon
                name={status === 'muted' ? 'muted' : 'microphone'}
                className={buildClassName(styles.rowIcon, status === 'speaking' && styles.rowIconSpeaking)}
              />
            </div>
          ))}
        </div>

        <div className={styles.controls}>
          <button type="button" className={styles.control} onClick={toggleMatrixGroupCallSound}>
            <span className={buildClassName(styles.controlButton, active.isSoundOff && styles.controlActive)}>
              <Icon name={active.isSoundOff ? 'speaker-muted-story' : 'speaker'} />
            </span>
            {active.isSoundOff ? 'Sound off' : 'Sound'}
          </button>

          <button
            type="button"
            className={buildClassName(styles.micArea, active.isMuted && styles.micMuted)}
            aria-label={active.isMuted ? 'Unmute' : 'Mute'}
            onClick={toggleMatrixGroupCallMute}
          >
            <div className={styles.mic} data-level-key={myKey}>
              <div className={styles.blobSpin}><div className={styles.blob} /></div>
              <div className={buildClassName(styles.blobSpin, styles.blobSpinReverse)}>
                <div className={buildClassName(styles.blob, styles.blobInner)} />
              </div>
              <div className={styles.micButton}>
                <Icon name={active.isMuted ? 'muted' : 'microphone'} />
              </div>
            </div>
            <div className={styles.micLabel}>{active.isMuted ? 'Unmute' : 'You\'re Live'}</div>
            <div className={styles.micHint}>{active.isMuted ? 'You are muted' : 'Tap to mute'}</div>
          </button>

          <button type="button" className={styles.control} onClick={leaveMatrixGroupCall}>
            <span className={buildClassName(styles.controlButton, styles.leaveButton)}>
              <Icon name="phone-discard" />
            </span>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
};

export default memo(withGlobal((global): StateProps => {
  const active = global.matrixGroupCalls?.active;
  const info = active ? global.matrixGroupCalls?.byChatId[active.chatId] : undefined;
  return {
    active,
    chat: active ? selectChat(global, active.chatId) : undefined,
    participants: info?.callId === active?.callId ? info?.participants || [] : [],
    usersById: global.users.byId,
  };
})(MatrixGroupCallScreen));
