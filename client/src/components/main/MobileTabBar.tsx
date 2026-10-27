import { memo, useEffect } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { ApiUser } from '../../api/types';
import type { IconName } from '../../types/icons';
import { LeftColumnContent, SettingsScreens } from '../../types';

import { ALL_FOLDER_ID } from '../../config';
import { selectTabState, selectUser } from '../../global/selectors';
import buildClassName from '../../util/buildClassName';
import { formatIntegerCompact } from '../../util/textFormat';

import { useFolderManagerForUnreadCounters } from '../../hooks/useFolderManager';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Avatar from '../common/Avatar';
import Icon from '../common/icons/Icon';

import styles from './MobileTabBar.module.scss';

type OwnProps = {
  // The chat page is see-through over the wallpaper, so the bar is hidden while a chat is open
  isChatOpen?: boolean;
};

type StateProps = {
  currentUser?: ApiUser;
  contentKey: LeftColumnContent;
  settingsScreen?: SettingsScreens;
};

type Tab = 'chats' | 'contacts' | 'settings';

const AVATAR_SIZE = 26;

// Bottom navigation of the phone layout, like in Telegram's current apps: the chat list, contacts, settings and
// your profile are one tap away
const MobileTabBar = ({
  isChatOpen, currentUser, contentKey, settingsScreen,
}: OwnProps & StateProps) => {
  const { openLeftColumnContent, openSettingsScreen, openChatWithInfo } = getActions();
  const lang = useLang();
  const unreadChatsCount = useFolderManagerForUnreadCounters()[ALL_FOLDER_ID]?.chatsCount || 0;

  const activeTab: Tab | undefined = contentKey === LeftColumnContent.ChatList ? 'chats'
    : contentKey === LeftColumnContent.Contacts ? 'contacts'
      : contentKey === LeftColumnContent.Settings && settingsScreen === SettingsScreens.Main ? 'settings'
        : undefined;
  const isShown = Boolean(activeTab) && !isChatOpen;

  // Lists scrolled under the bar keep their last items reachable
  useEffect(() => {
    document.body.classList.toggle('has-mobile-tab-bar', isShown);
    return () => document.body.classList.remove('has-mobile-tab-bar');
  }, [isShown]);

  const handleChats = useLastCallback(() => openLeftColumnContent({ contentKey: LeftColumnContent.ChatList }));
  const handleContacts = useLastCallback(() => openLeftColumnContent({ contentKey: LeftColumnContent.Contacts }));
  const handleSettings = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.Main });
  });
  const handleProfile = useLastCallback(() => {
    if (currentUser) openChatWithInfo({ id: currentUser.id, isOwnProfile: true });
  });

  function renderTab(tab: Tab, icon: IconName, activeIcon: IconName, label: string, onClick: NoneToVoidFunction) {
    const isActive = activeTab === tab;
    return (
      <button type="button" className={buildClassName(styles.tab, isActive && styles.active)} onClick={onClick}>
        <span className={styles.iconWrapper}>
          <Icon name={isActive ? activeIcon : icon} className={styles.icon} />
          {tab === 'chats' && unreadChatsCount > 0 && (
            <span className={styles.badge}>{formatIntegerCompact(lang, unreadChatsCount)}</span>
          )}
        </span>
        <span className={styles.label}>{label}</span>
      </button>
    );
  }

  return (
    <nav className={buildClassName(styles.root, isShown && styles.shown)} aria-hidden={!isShown}>
      {renderTab('chats', 'message', 'message', lang('FilterChats'), handleChats)}
      {renderTab('contacts', 'user', 'user-filled', lang('Contacts'), handleContacts)}
      {renderTab('settings', 'settings', 'settings-filled', lang('Settings'), handleSettings)}
      <button type="button" className={styles.tab} onClick={handleProfile}>
        <span className={styles.iconWrapper}>
          {currentUser && <Avatar peer={currentUser} size={AVATAR_SIZE} className={styles.avatar} />}
        </span>
        <span className={styles.label}>{lang('Profile')}</span>
      </button>
    </nav>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { leftColumn } = selectTabState(global);
    return {
      currentUser: global.currentUserId ? selectUser(global, global.currentUserId) : undefined,
      contentKey: leftColumn.contentKey,
      settingsScreen: leftColumn.settingsScreen,
    };
  },
)(MobileTabBar));
