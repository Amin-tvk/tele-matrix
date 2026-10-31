import { memo, useEffect, useMemo } from '../../../lib/teact/teact';
import { withGlobal } from '../../../global';

import type { ApiChat, ApiUser } from '../../../api/types';
import type { GlobalState } from '../../../global/types';

import { isChatChannel } from '../../../global/helpers';
import { selectChat } from '../../../global/selectors';
import { ARE_PHONE_CALLS_SUPPORTED } from '../../../util/browser/windowEnvironment';
import buildClassName from '../../../util/buildClassName';
import {
  getMatrixGroupCallMyKey, joinMatrixGroupCall, leaveMatrixGroupCall, MAX_GROUP_CALL_PARTICIPANTS,
  toggleMatrixGroupCallMute,
} from '../../../util/calls/matrixGroupCall';
import { isUserId } from '../../../util/entities/ids';
import { callApi } from '../../../api/gramjs';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';

import styles from './MatrixGroupCallPill.module.scss';

// A group's voice chat: who is in it, with Join, or Mute and Leave once in. While in a call it shows in other chats
// too, so the call can always be left

type OwnProps = {
  chatId: string;
};

type StateProps = {
  chat?: ApiChat;
  callChat?: ApiChat;
  callInfo?: NonNullable<GlobalState['matrixGroupCalls']>['byChatId'][string];
  active?: NonNullable<GlobalState['matrixGroupCalls']>['active'];
  usersById: Record<string, ApiUser>;
};

const MAX_AVATARS = 4;

const MatrixGroupCallPill = ({
  chatId, chat, callChat, callInfo, active, usersById,
}: OwnProps & StateProps) => {
  const isGroup = Boolean(chat) && !isUserId(chatId) && !isChatChannel(chat);

  useEffect(() => {
    if (isGroup && ARE_PHONE_CALLS_SUPPORTED) void callApi('fetchMatrixGroupCall', { chatId });
  }, [chatId, isGroup]);

  const isJoinedHere = active?.chatId === chatId;
  const isJoinedElsewhere = Boolean(active) && !isJoinedHere;
  const participants = useMemo(() => {
    const list = callInfo?.callId ? callInfo.participants : [];
    // One entry per person, even with several devices
    const byPeerId = new Map(list.map((participant) => [participant.peerId, participant]));
    return [...byPeerId.values()];
  }, [callInfo]);

  if (!ARE_PHONE_CALLS_SUPPORTED) return undefined;
  if (!isJoinedElsewhere && (!isGroup || (!participants.length && !isJoinedHere))) return undefined;

  const speakingKeys = new Set(active?.speakingKeys || []);
  const myKey = getMatrixGroupCallMyKey();
  const isSpeaking = (userId: string) => [...speakingKeys].some((key) => key.startsWith(`${userId}|`)
    || (key === myKey && myKey?.startsWith(`${userId}|`)));
  const count = participants.length;

  return (
    <div className={styles.root}>
      <Icon name="voice-chat" className={styles.icon} />
      <div className={styles.info}>
        <div className={styles.title}>
          {isJoinedElsewhere ? `Voice chat · ${callChat?.title || ''}` : 'Voice chat'}
        </div>
        <div className={styles.subtitle}>
          {isJoinedHere || isJoinedElsewhere
            ? `${active.isMuted ? 'Muted' : 'You are in'} · ${active.connectedKeys.length + 1} connected`
            : `${count} ${count === 1 ? 'participant' : 'participants'}`}
        </div>
      </div>
      {!isJoinedElsewhere && (
        <div className={styles.avatars}>
          {participants.slice(0, MAX_AVATARS).map((participant) => (
            <Avatar
              key={participant.peerId}
              className={buildClassName(styles.avatar, isSpeaking(participant.userId) && styles.speaking)}
              peer={usersById[participant.peerId]}
              size="tiny"
            />
          ))}
        </div>
      )}
      <div className={styles.buttons}>
        {active ? (
          <>
            <Button
              round
              size="smaller"
              color={active.isMuted ? 'translucent' : 'primary'}
              iconName={active.isMuted ? 'microphone-outline' : 'microphone'}
              ariaLabel={active.isMuted ? 'Unmute' : 'Mute'}
              onClick={toggleMatrixGroupCallMute}
            />
            <Button
              round
              size="smaller"
              color="danger"
              iconName="phone-discard"
              ariaLabel="Leave voice chat"
              onClick={leaveMatrixGroupCall}
            />
          </>
        ) : (
          <Button
            size="tiny"
            pill
            fluid
            disabled={count >= MAX_GROUP_CALL_PARTICIPANTS}
            onClick={() => void joinMatrixGroupCall(chatId)}
          >
            Join
          </Button>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global, { chatId }): StateProps => {
  const groupCalls = global.matrixGroupCalls;
  const active = groupCalls?.active;
  return {
    chat: selectChat(global, chatId),
    callChat: active ? selectChat(global, active.chatId) : undefined,
    callInfo: groupCalls?.byChatId[chatId],
    active,
    usersById: global.users.byId,
  };
})(MatrixGroupCallPill));
