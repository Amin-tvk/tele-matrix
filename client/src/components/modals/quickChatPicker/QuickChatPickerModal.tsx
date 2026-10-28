import { memo, useEffect, useMemo, useRef, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiUser } from '../../../api/types';
import type { IconName } from '../../../types/icons';
import { LeftColumnContent, SettingsScreens } from '../../../types';

import { ALL_FOLDER_ID, ARCHIVED_FOLDER_ID } from '../../../config';
import { getChatTitle, getUserFullName } from '../../../global/helpers';
import { selectCurrentMessageList, selectTheme } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import captureKeyboardListeners from '../../../util/captureKeyboardListeners';
import {
  COMMAND_PALETTE_VIEW_EVENT, openCommandPalette, SHORTCUT_GROUPS, takeCommandPaletteView,
  toggleCurrentChatMuted,
} from '../../../util/commandPalette';
import { getOrderedIds } from '../../../util/folderManager';
import { getSystemTheme } from '../../../util/systemTheme';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';

import styles from './CommandPalette.module.scss';

// The Ctrl+K command palette: open a chat or run an action by typing, or browse the keyboard shortcuts

export type OwnProps = {
  modal?: boolean;
};

type StateProps = {
  chatsById: Record<string, ApiChat>;
  usersById: Record<string, ApiUser>;
  currentUserId?: string;
  currentChatId?: string;
  theme: string;
  hasPasscode?: boolean;
};

type Command = {
  id: string;
  title: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  isAvailable?: boolean;
  run: () => void;
};

type ChatEntry = { kind: 'chat'; id: string; title: string; subtitle?: string; peer: ApiChat | ApiUser };
type Item = ChatEntry | { kind: 'command'; command: Command };

const RECENT_CHATS_LIMIT = 6;
const MATCHING_CHATS_LIMIT = 12;

// Every word must appear; matches at the start of the text or of a word rank higher
function scoreMatch(text: string, query: string) {
  const haystack = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const word of words) {
    const index = haystack.indexOf(word);
    if (index === -1) return 0;
    score += index === 0 ? 3 : /[\s@:_-]/.test(haystack[index - 1]) ? 2 : 1;
  }
  return score;
}

const QuickChatPickerModal = ({
  modal, chatsById, usersById, currentUserId, currentChatId, theme, hasPasscode,
}: OwnProps & StateProps) => {
  const {
    closeQuickChatPicker, openChat, openLeftColumnContent, openSettingsScreen, setSharedSettingOption,
    toggleChatInfo, lockScreen, openStoryComposerModal, openServerAdminModal,
  } = getActions();
  const lang = useLang();
  const isOpen = Boolean(modal);

  const inputRef = useRef<HTMLInputElement>();
  const listRef = useRef<HTMLDivElement>();
  const shortcutsRef = useRef<HTMLDivElement>();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [view, setView] = useState<'commands' | 'shortcuts'>('commands');

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    setView(takeCommandPaletteView());
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => (view === 'commands' ? inputRef.current : shortcutsRef.current)?.focus());
  }, [isOpen, view]);

  const close = useLastCallback(() => closeQuickChatPicker());

  const commands = useMemo((): Command[] => ([
    {
      id: 'saved',
      title: 'Saved Messages',
      icon: 'saved-messages',
      keywords: 'bookmarks notes',
      run: () => currentUserId && openChat({ id: currentUserId, shouldReplaceHistory: true }),
    },
    {
      id: 'search',
      title: 'Search everything',
      hint: 'Messages, chats and people',
      icon: 'search',
      run: () => openLeftColumnContent({ contentKey: LeftColumnContent.GlobalSearch }),
    },
    {
      id: 'new-group',
      title: 'New Group',
      icon: 'group',
      keywords: 'create',
      run: () => openLeftColumnContent({ contentKey: LeftColumnContent.NewGroupStep1 }),
    },
    {
      id: 'new-channel',
      title: 'New Channel',
      icon: 'channel',
      keywords: 'create',
      run: () => openLeftColumnContent({ contentKey: LeftColumnContent.NewChannelStep1 }),
    },
    {
      id: 'story', title: 'Post a Story', icon: 'camera', keywords: 'stories', run: () => openStoryComposerModal(),
    },
    {
      id: 'contacts',
      title: 'Contacts',
      icon: 'user',
      keywords: 'people',
      run: () => openLeftColumnContent({ contentKey: LeftColumnContent.Contacts }),
    },
    {
      id: 'archived',
      title: 'Archived Chats',
      icon: 'archive',
      run: () => openLeftColumnContent({ contentKey: LeftColumnContent.Archived }),
    },
    {
      id: 'side-panel',
      title: 'Show or hide the side panel',
      hint: 'Chat info, media and members',
      icon: 'sidebar',
      keywords: 'info profile right column',
      isAvailable: Boolean(currentChatId),
      run: () => toggleChatInfo(undefined),
    },
    {
      id: 'mute',
      title: 'Mute or unmute this chat',
      icon: 'mute',
      keywords: 'notifications silence',
      isAvailable: Boolean(currentChatId),
      run: toggleCurrentChatMuted,
    },
    {
      id: 'theme',
      title: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      icon: 'darkmode',
      keywords: 'night theme appearance',
      run: () => {
        const newTheme = theme === 'dark' ? 'light' : 'dark';
        setSharedSettingOption({ theme: newTheme });
        setSharedSettingOption({ shouldUseSystemTheme: newTheme === getSystemTheme() });
      },
    },
    {
      id: 'settings',
      title: 'Settings',
      icon: 'settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.Main }),
    },
    {
      id: 'profile',
      title: 'Edit profile',
      icon: 'edit',
      keywords: 'name photo bio settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.EditProfile }),
    },
    {
      id: 'privacy',
      title: 'Privacy and Security',
      icon: 'lock',
      keywords: 'last seen passcode lock encryption backup recovery key devices sessions settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.Security }),
    },
    {
      id: 'notifications',
      title: 'Notifications and Sounds',
      icon: 'unmute',
      keywords: 'settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.Notifications }),
    },
    {
      id: 'appearance',
      title: 'Chat Settings',
      hint: 'Theme, wallpaper and text size',
      icon: 'document',
      keywords: 'appearance background font settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.General }),
    },
    {
      id: 'folders',
      title: 'Chat Folders',
      icon: 'folder',
      keywords: 'settings',
      run: () => openSettingsScreen({ screen: SettingsScreens.Folders }),
    },
    {
      id: 'lock',
      title: 'Lock Tele',
      icon: 'lock',
      keywords: 'passcode',
      isAvailable: Boolean(hasPasscode),
      run: () => lockScreen(),
    },
    {
      id: 'server-admin',
      title: 'Server Admin',
      hint: 'For server admins',
      icon: 'admin',
      keywords: 'users invite',
      run: () => openServerAdminModal(),
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      icon: 'keyboard',
      keywords: 'hotkeys keys help',
      run: () => openCommandPalette('shortcuts'),
    },
  ] satisfies Command[]).filter(({ isAvailable }) => isAvailable !== false),
  [currentChatId, currentUserId, hasPasscode, theme]);

  const chatEntries = useMemo((): ChatEntry[] => {
    if (!isOpen) return [];
    const ids = [...(getOrderedIds(ALL_FOLDER_ID) || []), ...(getOrderedIds(ARCHIVED_FOLDER_ID) || [])];
    return ids.flatMap((id): ChatEntry[] => {
      const user = usersById[id];
      const chat = chatsById[id];
      const peer = user || chat;
      if (!peer) return [];
      const title = id === currentUserId ? lang('SavedMessages')
        : user ? getUserFullName(lang, user) || '' : getChatTitle(lang, chat);
      const username = user?.usernames?.[0]?.username;
      const subtitle = user ? (username ? `@${username}` : undefined)
        : chat?.membersCount ? `${chat.membersCount} members` : undefined;
      return [{
        kind: 'chat', id, title, subtitle, peer,
      }];
    });
  }, [isOpen, chatsById, usersById, currentUserId, lang]);

  const items = useMemo((): Item[] => {
    const trimmed = query.trim();
    const commandItems = (list: Command[]) => list.map((command) => ({ kind: 'command' as const, command }));
    if (!trimmed) return [...chatEntries.slice(0, RECENT_CHATS_LIMIT), ...commandItems(commands)];

    const chats = chatEntries
      .map((entry) => ({ entry, score: scoreMatch(`${entry.title} ${entry.subtitle || ''}`, trimmed) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MATCHING_CHATS_LIMIT)
      .map(({ entry }) => entry);
    const matchingCommands = commands
      .map((command) => ({
        command, score: scoreMatch(`${command.title} ${command.hint || ''} ${command.keywords || ''}`, trimmed),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ command }) => command);
    return [...chats, ...commandItems(matchingCommands)];
  }, [query, chatEntries, commands]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const runItem = useLastCallback((item: Item) => {
    if (item.kind === 'chat') {
      openChat({ id: item.id, shouldReplaceHistory: true });
      close();
    } else if (item.command.id === 'shortcuts') {
      setView('shortcuts');
    } else {
      close();
      item.command.run();
    }
  });

  const handleKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((index) => (items.length ? (index + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((index) => (items.length ? (index - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) runItem(item);
    }
  });

  const handleShortcutsKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      setView('commands');
    }
  });

  // Esc goes back from the shortcuts page, then closes; handled ahead of the chat behind, like other modals
  const handleEsc = useLastCallback(() => {
    if (view === 'shortcuts') setView('commands');
    else close();
  });

  useEffect(() => (isOpen ? captureKeyboardListeners({ onEsc: handleEsc }) : undefined), [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleView = (e: Event) => {
      takeCommandPaletteView();
      setView((e as CustomEvent<'commands' | 'shortcuts'>).detail);
    };
    window.addEventListener(COMMAND_PALETTE_VIEW_EVENT, handleView);
    return () => window.removeEventListener(COMMAND_PALETTE_VIEW_EVENT, handleView);
  }, [isOpen]);

  const handleBackdropMouseDown = useLastCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  });

  if (!isOpen) return undefined;

  const firstCommandIndex = items.findIndex((item) => item.kind === 'command');

  function renderItem(item: Item, index: number) {
    const isActive = index === activeIndex;
    const sectionTitle = index === 0 && item.kind === 'chat' ? (query.trim() ? 'Chats' : 'Recent chats')
      : index === firstCommandIndex ? 'Actions' : undefined;
    const title = item.kind === 'chat' ? item.title : item.command.title;
    const subtitle = item.kind === 'chat' ? item.subtitle : item.command.hint;
    return (
      <div key={item.kind === 'chat' ? `chat-${item.id}` : item.command.id}>
        {sectionTitle && <div className={styles.section}>{sectionTitle}</div>}
        <div
          data-index={index}
          className={buildClassName(styles.item, isActive && styles.active)}
          onMouseMove={() => !isActive && setActiveIndex(index)}
          onClick={() => runItem(item)}
        >
          {item.kind === 'chat' ? (
            <Avatar size="small" peer={item.peer} isSavedMessages={item.id === currentUserId} />
          ) : (
            <span className={styles.iconBox}><Icon name={item.command.icon} /></span>
          )}
          <span className={styles.texts}>
            <span className={styles.title} dir="auto">{title}</span>
            {subtitle && <span className={styles.subtitle} dir="auto">{subtitle}</span>}
          </span>
          {isActive && <span className={styles.enter}>↵</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.backdrop} onMouseDown={handleBackdropMouseDown}>
      <div className={styles.palette} role="dialog" aria-label="Command palette">
        {view === 'commands' ? (
          <>
            <div className={styles.searchRow}>
              <Icon name="search" className={styles.searchIcon} />
              <input
                ref={inputRef}
                className={styles.input}
                value={query}
                placeholder="Search chats and actions…"
                dir="auto"
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
              />
              <kbd className={styles.kbd}>Esc</kbd>
            </div>
            <div ref={listRef} className={buildClassName(styles.list, 'custom-scroll')}>
              {items.length ? items.map(renderItem) : <div className={styles.empty}>Nothing found</div>}
            </div>
            <div className={styles.footer}>
              <span>
                <kbd className={styles.kbd}>↑</kbd>
                <kbd className={styles.kbd}>↓</kbd>
                {' '}
                move
              </span>
              <span>
                <kbd className={styles.kbd}>↵</kbd>
                {' '}
                open
              </span>
              <span className={styles.footerLink} onClick={() => setView('shortcuts')}>All shortcuts</span>
            </div>
          </>
        ) : (
          <div ref={shortcutsRef} className={styles.shortcuts} tabIndex={0} onKeyDown={handleShortcutsKeyDown}>
            <div className={styles.shortcutsHeader}>
              <button type="button" className={styles.back} onClick={() => setView('commands')} aria-label="Back">
                <Icon name="arrow-left" />
              </button>
              <span>Keyboard shortcuts</span>
            </div>
            <div className={buildClassName(styles.shortcutGroups, 'custom-scroll')}>
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.title}>
                  <div className={styles.section}>{group.title}</div>
                  {group.items.map(([keys, description]) => (
                    <div key={description} className={styles.shortcut}>
                      <span>{description}</span>
                      <span className={styles.keys}>
                        {keys.map((key) => <kbd key={key} className={styles.kbd}>{key}</kbd>)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global): StateProps => {
  const { chatId } = selectCurrentMessageList(global) || {};
  return {
    chatsById: global.chats.byId,
    usersById: global.users.byId,
    currentUserId: global.currentUserId,
    currentChatId: chatId,
    theme: selectTheme(global),
    hasPasscode: global.passcode?.hasPasscode,
  };
})(QuickChatPickerModal));
