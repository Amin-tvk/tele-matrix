import { getActions, getGlobal } from '../global';

import { MUTE_INDEFINITE_TIMESTAMP, UNMUTE_TIMESTAMP } from '../config';
import { getIsChatMuted } from '../global/helpers/notifications';
import {
  selectChat, selectCurrentMessageList, selectIsChatUnread, selectNotifyDefaults, selectNotifyException,
} from '../global/selectors';
import { IS_MAC_OS } from './browser/windowEnvironment';

// The command palette (Ctrl+K) is the chat picker's modal; it can open straight on its shortcuts page

export type CommandPaletteView = 'commands' | 'shortcuts';

let nextView: CommandPaletteView = 'commands';

export const COMMAND_PALETTE_VIEW_EVENT = 'tt-command-palette-view';

export function openCommandPalette(view: CommandPaletteView = 'commands') {
  nextView = view;
  getActions().openQuickChatPicker();
  // An open palette switches pages
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_VIEW_EVENT, { detail: view }));
}

export function takeCommandPaletteView() {
  const view = nextView;
  nextView = 'commands';
  return view;
}

export const MOD_KEY = IS_MAC_OS ? '⌘' : 'Ctrl';
const ALT_KEY = IS_MAC_OS ? '⌥' : 'Alt';

export const SHORTCUT_GROUPS: { title: string; items: [keys: string[], description: string][] }[] = [
  {
    title: 'General',
    items: [
      [[MOD_KEY, 'K'], 'Command palette: chats and actions'],
      [[MOD_KEY, '/'], 'Keyboard shortcuts'],
      [[MOD_KEY, ','], 'Settings'],
      [[MOD_KEY, 'Shift', 'F'], 'Search everything'],
      [[MOD_KEY, 'Shift', 'S'], 'Saved Messages'],
      [['Esc'], 'Close or go back'],
    ],
  },
  {
    title: 'Chats',
    items: [
      [[ALT_KEY, '↑'], 'Previous chat'],
      [[ALT_KEY, '↓'], 'Next chat'],
      [[ALT_KEY, 'Shift', '↑'], 'Previous unread chat'],
      [[ALT_KEY, 'Shift', '↓'], 'Next unread chat'],
      [[MOD_KEY, 'F'], 'Search in this chat'],
      [[ALT_KEY, 'I'], 'Show or hide the side panel'],
      [[MOD_KEY, 'Shift', 'M'], 'Mute or unmute this chat'],
    ],
  },
  {
    title: 'Writing',
    items: [
      [['Enter'], 'Send'],
      [['Shift', 'Enter'], 'New line'],
      [['↑'], 'Edit your last message (empty message box)'],
      [[MOD_KEY, 'B'], 'Bold'],
      [[MOD_KEY, 'I'], 'Italic'],
      [[MOD_KEY, 'Shift', 'X'], 'Strikethrough'],
    ],
  },
];

export function toggleCurrentChatMuted() {
  const global = getGlobal();
  const { chatId } = selectCurrentMessageList(global) || {};
  const chat = chatId ? selectChat(global, chatId) : undefined;
  if (!chat) return;
  const isMuted = getIsChatMuted(chat, selectNotifyDefaults(global), selectNotifyException(global, chat.id));
  getActions().updateChatMutedState({
    chatId: chat.id, mutedUntil: isMuted ? UNMUTE_TIMESTAMP : MUTE_INDEFINITE_TIMESTAMP,
  });
  getActions().showNotification({ message: isMuted ? 'Chat unmuted' : 'Chat muted' });
}

// Alt+Shift+Up/Down: the nearest chat above or below the open one that has unread messages
export function openNearestUnreadChat(orderedIds: string[], direction: 1 | -1) {
  const global = getGlobal();
  const { chatId } = selectCurrentMessageList(global) || {};
  const start = chatId ? orderedIds.indexOf(chatId) : -1;
  for (let i = start + direction; i >= 0 && i < orderedIds.length; i += direction) {
    if (selectIsChatUnread(global, orderedIds[i])) {
      getActions().openChat({ id: orderedIds[i], shouldReplaceHistory: true });
      return;
    }
  }
}
