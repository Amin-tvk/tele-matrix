// Stories of people with the blue tick, as last read from their profiles; kept free of imports so builders can read it

export const STORIES_PROFILE_FIELD = 'im.peyvand.stories';
export const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
// Sent by a viewer's app to the story owner's devices
export const STORY_VIEW_EVENT = 'im.peyvand.story_view';
// On a message that answers a story, and on a forwarded story: `{ user_id, story_id }`
export const STORY_REPLY_KEY = 'im.peyvand.story_reply';
export const FORWARDED_STORY_KEY = 'im.peyvand.story';

export type StoryRef = { user_id?: string; story_id?: number };

// `content` has the shape of a Matrix image or video message, so it's built like one
export type StoredStory = {
  id: number;
  ts: number;
  content: Record<string, unknown>;
  // Kept on the profile's Posts tab after the day is over
  inProfile?: boolean;
};

const storiesByUserId = new Map<string, StoredStory[]>();

export function isStoryActive(story: StoredStory, now = Date.now()) {
  return now < story.ts + STORY_LIFETIME_MS;
}

export function parseStoredStories(value: unknown): StoredStory[] {
  if (!Array.isArray(value)) return [];
  return value.filter((story): story is StoredStory => (
    Boolean(story) && typeof story.id === 'number' && typeof story.ts === 'number'
    && Boolean(story.content) && typeof story.content === 'object'
  ));
}

export function getUserStories(userId: string) {
  return storiesByUserId.get(userId) || [];
}

export function getActiveStories(userId: string) {
  const now = Date.now();
  return getUserStories(userId).filter((story) => isStoryActive(story, now));
}

// Returns the stories that are new or changed and the IDs that are gone, to update the UI with
export function setUserStories(userId: string, stories: StoredStory[]) {
  const previous = new Map(getUserStories(userId).map((story) => [story.id, story]));
  storiesByUserId.set(userId, stories);
  const changed = stories.filter((story) => {
    const old = previous.get(story.id);
    return !old || old.inProfile !== story.inProfile;
  });
  const removedIds = [...previous.keys()].filter((id) => !stories.some((story) => story.id === id));
  return { changed, removedIds };
}

export function getStoriesSummary(userId: string) {
  const active = getActiveStories(userId);
  return {
    hasStories: active.length > 0,
    maxStoryId: active.length ? Math.max(...active.map(({ id }) => id)) : undefined,
  };
}
