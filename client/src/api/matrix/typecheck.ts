// Compile-time check that Matrix implementations match the method signatures the UI calls.
// Not imported at runtime

import type { Methods } from '../gramjs/methods/types';
import type * as auth from './auth';
import type * as directory from './directory';
import type * as folders from './folders';
import type * as lastSeen from './lastSeen';
import type * as methods from './methods';
import type * as scheduled from './scheduled';
import type * as stickers from './stickers';
import type * as stories from './stories';

type Implementations = typeof methods & typeof auth & typeof directory & typeof folders & typeof lastSeen
  & typeof stories & typeof stickers
  & typeof scheduled;
// Results differ in optional fields or are raw request results; callers only check that the call succeeded
type TruthyResultMethods = 'deleteChatMember' | 'leaveChannel' | 'deleteChatUser' | 'deleteChat' | 'deleteChannel'
  | 'editChatPhoto' | 'toggleChatArchived' | 'updateChatAdmin' | 'updateProfile' | 'sendReaction' | 'addChatMembers'
  | 'fetchChat' | 'uploadProfilePhoto' | 'fetchChatFolders' | 'fetchMessages' | 'sendMessageLocal' | 'sendMessage'
  | 'editMessage' | 'fetchFullUser' | 'registerDevice' | 'unregisterDevice'
  | 'updateNotificationSettings' | 'sortChatFolders' | 'toggleDialogFilterTags' | 'deleteChatFolder'
  | 'editChatFolder' | 'editTodo' | 'toggleTodoCompleted' | 'appendTodoList' | 'deleteStory' | 'markStoryRead'
  | 'toggleStoryInProfile' | 'fetchMessageViews';
type Overlap = Exclude<Extract<keyof Implementations, keyof Methods>, TruthyResultMethods>;

type CheckedMethods = {
  [K in Overlap]: (...args: Parameters<Methods[K]>) => Promise<Awaited<ReturnType<Methods[K]>>>
    | ReturnType<Methods[K]>;
};

// Names of implementations that do not accept the UI arguments or return an incompatible result
export type MismatchedMethods = {
  [K in Overlap]: Implementations[K] extends CheckedMethods[K] ? never : K;
}[Overlap];

// Fails to compile listing every mismatched method name
export const METHODS_CHECK: Record<MismatchedMethods, true> = {};
