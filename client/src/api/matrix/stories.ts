import { Method, MsgType } from 'matrix-js-sdk';

import type {
  ApiPeer, ApiPeerStories, ApiStory, ApiTypeStory,
} from '../types';

import { DEBUG } from '../../config';
import { buildStoryContent } from './builders';
import {
  buildUser, getClient, getMyUserId, hasClient, onUpdate,
} from './client';
import { getPeerIdByUserId, getUserIdByPeerId } from './ids';
import { uploadFile } from './media';
import {
  getActiveStories, getUserStories, isStoryActive, parseStoredStories, setUserStories, STORIES_PROFILE_FIELD,
  STORY_LIFETIME_MS, STORY_VIEW_EVENT,
} from './storiesState';
import type { StoredStory } from './storiesState';
import { getValue, setValue } from './store';
import { getVerifiedIds, isVerifiedId } from './verifiedState';

// Stories, like Telegram's, for people with the blue tick. Each person keeps their stories as a list in a custom
// field of their own profile, which anyone signed in can read; the media are regular unencrypted uploads.
// Stories last a day; those kept on the profile stay in its Posts tab

// Profile fields are limited in size, so old stories that only lived for a day are dropped first
const MAX_STORED_STORIES = 100;
const READ_KEY_PREFIX = 'story-read:';

// Who viewed a story: each viewer's app sends the owner's devices a direct message, and the owner's app keeps the
// list in its account data, so every device of the owner shows the same viewers
const STORY_VIEWS_EVENT = 'im.peyvand.story_views';
const SENT_VIEW_KEY_PREFIX = 'story-view-sent:';
const VIEWS_SAVE_DELAY_MS = 3000;
const RECENT_VIEWERS_COUNT = 3;

type ViewsByStoryId = Record<string, Record<string, number>>;

let pendingViews: ViewsByStoryId | undefined;
let viewsSaveTimeout: ReturnType<typeof setTimeout> | undefined;

function getProfilePath(userId: string, field?: string) {
  return `/profile/${encodeURIComponent(userId)}${field ? `/${field}` : ''}`;
}

function getStoredViews(): ViewsByStoryId {
  if (pendingViews) return pendingViews;
  return getClient().getAccountData(STORY_VIEWS_EVENT as never)?.getContent<{ views?: ViewsByStoryId }>().views || {};
}

function getStoryViewers(storyId: number) {
  return Object.entries(getStoredViews()[storyId] || {}).sort(([, a], [, b]) => b - a);
}

function buildStoryViews(storyId: number) {
  const viewers = getStoryViewers(storyId);
  return {
    hasViewers: viewers.length ? true as const : undefined,
    viewsCount: viewers.length,
    recentViewerIds: viewers.slice(0, RECENT_VIEWERS_COUNT).map(([userId]) => getPeerIdByUserId(userId)),
  };
}

function buildApiStory(userId: string, story: StoredStory): ApiStory | undefined {
  const content = buildStoryContent(story.content, story.ts, getPeerIdByUserId);
  if (!content) return undefined;
  const isMine = userId === getMyUserId();
  return {
    views: isMine ? buildStoryViews(story.id) : undefined,
    '@type': 'story',
    id: story.id,
    peerId: getPeerIdByUserId(userId),
    date: Math.floor(story.ts / 1000),
    expireDate: Math.floor((story.ts + STORY_LIFETIME_MS) / 1000),
    content,
    isInProfile: story.inProfile || undefined,
    isPublic: true,
    isOut: isMine ? true : undefined,
  };
}

function buildStoriesById(userId: string, stories: StoredStory[]) {
  return stories.reduce<Record<number, ApiTypeStory>>((acc, story) => {
    const apiStory = buildApiStory(userId, story);
    if (apiStory) acc[story.id] = apiStory;
    return acc;
  }, {});
}

function getLastReadId(userId: string) {
  return Number(getValue(`${READ_KEY_PREFIX}${userId}`)) || undefined;
}

// Brings the stories read from a profile into the UI: new ones appear, deleted ones go away
export function applyProfileStories(userId: string, value: unknown) {
  const stories = isVerifiedId(userId) ? parseStoredStories(value) : [];
  const { changed, removedIds } = setUserStories(userId, stories);
  if (!changed.length && !removedIds.length) return;

  const peerId = getPeerIdByUserId(userId);
  const user = buildUser(userId);
  onUpdate({ '@type': 'updateUser', id: user.id, user });
  changed.forEach((story) => {
    const apiStory = buildApiStory(userId, story);
    if (apiStory) onUpdate({ '@type': 'updateStory', peerId, story: apiStory });
  });
  removedIds.forEach((storyId) => onUpdate({ '@type': 'deleteStory', peerId, storyId }));
}

async function refreshUserStories(userId: string) {
  try {
    const value = await getClient().http.authedRequest<unknown>(
      Method.Get, getProfilePath(userId, STORIES_PROFILE_FIELD),
    );
    applyProfileStories(userId, (value as Record<string, unknown>)?.[STORIES_PROFILE_FIELD]);
  } catch {
    // No stories field yet
    applyProfileStories(userId, []);
  }
}

async function saveMyStories(stories: StoredStory[]) {
  const userId = getMyUserId();
  const now = Date.now();
  const kept = stories
    .filter((story) => story.inProfile || isStoryActive(story, now))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_STORED_STORIES)
    .reverse();
  await getClient().http.authedRequest(
    Method.Put, getProfilePath(userId, STORIES_PROFILE_FIELD), undefined, { [STORIES_PROFILE_FIELD]: kept },
  );
  applyProfileStories(userId, kept);
}

function getUserIdForPeer(peer: Pick<ApiPeer, 'id'>) {
  return getUserIdByPeerId(peer.id);
}

/* Methods used by the UI */

export function fetchAllStories({ isHidden }: { isFirstRequest?: boolean; stateHash?: string; isHidden?: boolean }) {
  const peerStories: Record<string, ApiPeerStories> = {};
  if (!isHidden && hasClient()) {
    [...getVerifiedIds()].filter((id) => id.startsWith('@')).forEach((userId) => {
      const active = getActiveStories(userId);
      if (!active.length) return;
      peerStories[getPeerIdByUserId(userId)] = {
        byId: buildStoriesById(userId, getUserStories(userId)),
        orderedIds: active.map(({ id }) => id),
        profileIds: getUserStories(userId).filter(({ inProfile }) => inProfile).map(({ id }) => id),
        lastUpdatedAt: Math.max(...active.map(({ ts }) => Math.floor(ts / 1000))),
        lastReadId: getLastReadId(userId),
      };
    });
  }
  return Promise.resolve({ peerStories, state: String(Date.now()), stealthMode: {} });
}

export async function fetchPeerStories({ peer }: { peer: ApiPeer }) {
  const userId = getUserIdForPeer(peer);
  if (!userId) return undefined;
  await refreshUserStories(userId);
  return {
    stories: buildStoriesById(userId, getActiveStories(userId)),
    lastReadStoryId: getLastReadId(userId),
  };
}

export async function fetchPeerProfileStories({ peer }: { peer: ApiPeer; offsetId?: number }) {
  const userId = getUserIdForPeer(peer);
  if (!userId) return undefined;
  await refreshUserStories(userId);
  const posts = getUserStories(userId).filter(({ inProfile }) => inProfile).sort((a, b) => b.ts - a.ts);
  return { count: posts.length, stories: buildStoriesById(userId, posts), pinnedIds: [] as number[] };
}

export async function fetchStoriesArchive({ peer }: { peer: ApiPeer; offsetId?: number }) {
  const userId = getUserIdForPeer(peer);
  if (!userId || userId !== getMyUserId()) return undefined;
  await refreshUserStories(userId);
  const all = getUserStories(userId).slice().sort((a, b) => b.ts - a.ts);
  return { count: all.length, stories: buildStoriesById(userId, all), pinnedIds: [] as number[] };
}

export async function fetchPeerStoriesByIds({ peer, ids }: { peer: ApiPeer; ids: number[] }) {
  const userId = getUserIdForPeer(peer);
  if (!userId) return undefined;
  await refreshUserStories(userId);
  const byId = buildStoriesById(userId, getUserStories(userId));
  const stories = ids.reduce<Record<number, ApiTypeStory>>((acc, id) => {
    acc[id] = byId[id] || { id, peerId: peer.id, isDeleted: true };
    return acc;
  }, {});
  return { stories, pinnedIds: [] as number[] };
}

// Tells the story's owner it was seen, once per story
function reportStoryView(userId: string, storyId: number) {
  if (userId === getMyUserId()) return;
  const sentKey = `${SENT_VIEW_KEY_PREFIX}${userId}:${storyId}`;
  if (getValue(sentKey)) return;
  setValue(sentKey, '1');
  const contentMap = new Map([[userId, new Map([['*', { story_id: storyId }]])]]);
  getClient().sendToDevice(STORY_VIEW_EVENT, contentMap).catch(() => {
    setValue(sentKey, '');
  });
}

export function viewStory({ peer, storyId }: { peer: ApiPeer; storyId: number }) {
  const userId = getUserIdForPeer(peer);
  if (userId) reportStoryView(userId, storyId);
  return Promise.resolve(true);
}

export function markStoryRead({ peer, storyId }: { peer: ApiPeer; storyId: number }) {
  const userId = getUserIdForPeer(peer);
  if (!userId) return Promise.resolve(true);
  if (storyId > (getLastReadId(userId) || 0)) setValue(`${READ_KEY_PREFIX}${userId}`, String(storyId));
  reportStoryView(userId, storyId);
  return Promise.resolve(true);
}

function scheduleViewsSave() {
  if (viewsSaveTimeout) clearTimeout(viewsSaveTimeout);
  viewsSaveTimeout = setTimeout(() => {
    viewsSaveTimeout = undefined;
    const toSave = pendingViews;
    if (!toSave || !hasClient()) return;
    // Views of stories that no longer exist are dropped
    const storyIds = new Set(getUserStories(getMyUserId()).map(({ id }) => String(id)));
    const kept = Object.fromEntries(Object.entries(toSave).filter(([id]) => storyIds.has(id)));
    getClient().setAccountData(STORY_VIEWS_EVENT as never, { views: kept } as never)
      .then(() => {
        if (pendingViews === toSave) pendingViews = undefined;
      })
      .catch((err) => {
        if (DEBUG) console.warn('[matrix] Saving story views failed', err);
      });
  }, VIEWS_SAVE_DELAY_MS);
}

// A viewer's app reported a view of one of this person's stories
export function handleStoryViewEvent(sender: string, content: { story_id?: unknown }) {
  const storyId = Number(content.story_id);
  const myUserId = getMyUserId();
  const story = getUserStories(myUserId).find(({ id }) => id === storyId);
  if (!story || sender === myUserId) return;
  const views = getStoredViews();
  if (views[storyId]?.[sender]) return;
  pendingViews = { ...views, [storyId]: { ...views[storyId], [sender]: Math.floor(Date.now() / 1000) } };
  scheduleViewsSave();

  const viewer = buildUser(sender);
  onUpdate({ '@type': 'updateUser', id: viewer.id, user: viewer });
  const apiStory = buildApiStory(myUserId, story);
  if (apiStory) onUpdate({ '@type': 'updateStory', peerId: getPeerIdByUserId(myUserId), story: apiStory });
}

export function fetchStoryViewList({ storyId, query }: {
  peer: ApiPeer; storyId: number; query?: string; areJustContacts?: true; areReactionsFirst?: true;
  limit?: number; offset?: string;
}) {
  const lowerQuery = query?.trim().toLowerCase();
  const views = getStoryViewers(storyId)
    .map(([userId, date]) => {
      const user = buildUser(userId);
      onUpdate({ '@type': 'updateUser', id: user.id, user });
      return { user, date };
    })
    .filter(({ user }) => !lowerQuery || [user.firstName, user.lastName, user.usernames?.[0]?.username]
      .some((part) => part?.toLowerCase().includes(lowerQuery)))
    .map(({ user, date }) => ({ type: 'user' as const, peerId: user.id, date }));
  return Promise.resolve({
    views, nextOffset: undefined, reactionsCount: 0, viewsCount: views.length,
  });
}

export function fetchStoriesViews({ storyIds }: { peer: ApiPeer; storyIds: number[] }) {
  return Promise.resolve({ views: buildStoryViews(storyIds[0]) });
}

export async function deleteStory({ peer, storyId }: { peer: ApiPeer; storyId: number }) {
  if (getUserIdForPeer(peer) !== getMyUserId()) return undefined;
  await saveMyStories(getUserStories(getMyUserId()).filter(({ id }) => id !== storyId));
  return true;
}

export async function toggleStoryInProfile({ peer, storyId, isInProfile }: {
  peer: ApiPeer; storyId: number; isInProfile?: boolean;
}) {
  if (getUserIdForPeer(peer) !== getMyUserId()) return undefined;
  await saveMyStories(getUserStories(getMyUserId()).map((story) => (
    story.id === storyId ? { ...story, inProfile: isInProfile || undefined } : story
  )));
  // The UI expects the IDs of the changed stories
  return [storyId];
}

// Posting is for people with the blue tick; other apps only show stories of verified people
export async function sendStory({
  blob, fileName, mimeType, caption, isInProfile, width, height, duration,
}: {
  blob: Blob;
  fileName: string;
  mimeType: string;
  caption?: string;
  isInProfile?: boolean;
  width?: number;
  height?: number;
  duration?: number;
}) {
  const userId = getMyUserId();
  if (!isVerifiedId(userId)) return false;
  try {
    const { url } = await uploadFile(blob, fileName, mimeType, false);
    if (!url) return false;
    const isVideo = mimeType.startsWith('video/');
    const ts = Date.now();
    const content: Record<string, unknown> = {
      msgtype: isVideo ? MsgType.Video : MsgType.Image,
      body: caption || fileName,
      filename: fileName,
      url,
      info: {
        mimetype: mimeType,
        size: blob.size,
        w: width,
        h: height,
        duration: isVideo && duration ? Math.round(duration * 1000) : undefined,
      },
    };
    const story: StoredStory = {
      id: Math.floor(ts / 1000), ts, content, inProfile: isInProfile || undefined,
    };
    await refreshUserStories(userId);
    await saveMyStories([...getUserStories(userId), story]);
    return true;
  } catch (err) {
    if (DEBUG) console.warn('[matrix] Posting a story failed', err);
    return false;
  }
}
