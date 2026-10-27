import { memo, useState } from '../../../lib/teact/teact';
import { getActions, getGlobal, withGlobal } from '../../../global';

import { selectChat, selectChatFullInfo } from '../../../global/selectors';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island, { IslandDescription } from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';
import Switcher from '../../ui/Switcher';

type OwnProps = {
  chatId: string;
  onClose: NoneToVoidFunction;
  isActive: boolean;
};

type StateProps = {
  hasComments: boolean;
  canChange: boolean;
};

// Channel admins let subscribers comment under posts. Comments live in the channel itself, so unlike Telegram
// no separate discussion group is needed
const ManageComments = ({
  chatId, hasComments, canChange, isActive, onClose,
}: OwnProps & StateProps) => {
  const { showNotification, loadFullChat } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);

  useHistoryBack({ isActive, onBack: onClose });

  const handleToggle = useLastCallback(async () => {
    const chat = selectChat(getGlobal(), chatId);
    if (!chat || isSaving) return;
    setIsSaving(true);
    const result = await callApi('setChannelComments', { chat, isEnabled: !hasComments });
    setIsSaving(false);
    if (result === 'encrypted') {
      showNotification({ message: { key: 'PeyvandCommentsEncrypted' } });
      return;
    }
    if (!result) {
      showNotification({ message: { key: 'SomethingWentWrong' } });
      return;
    }
    loadFullChat({ chatId });
  });

  return (
    <div className="Management">
      <div className="panel-content custom-scroll">
        <Island>
          <ListItem icon="comments" onClick={handleToggle} disabled={!canChange || isSaving}>
            <span>{lang('PeyvandCommentsToggle')}</span>
            <Switcher
              label={lang('PeyvandCommentsToggle')}
              checked={hasComments}
              disabled={!canChange || isSaving}
              inactive
            />
          </ListItem>
        </Island>
        <IslandDescription dir="auto">{lang('PeyvandCommentsDescription')}</IslandDescription>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global, { chatId }): Complete<StateProps> => {
    const chat = selectChat(global, chatId);
    return {
      hasComments: Boolean(selectChatFullInfo(global, chatId)?.linkedChatId),
      canChange: Boolean(chat?.isOwner || chat?.adminRights?.changeInfo),
    };
  },
)(ManageComments));
