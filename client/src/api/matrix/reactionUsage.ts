import type { MatrixEvent } from 'matrix-js-sdk';
import { EventType } from 'matrix-js-sdk';

import type { ApiReaction } from '../types';

import { DEBUG } from '../../config';
import { normalizeReactionKey } from './builders';
import { getClient, hasClient, onUpdate } from './client';
import { REACTION_USAGE_EVENT } from './constants';

// Like in Telegram, the reactions a person uses most are offered first. Usage is counted per emoji with older use
// fading out, so a new favourite climbs up within days. It's kept in the account data to follow the user to
// every device

type Usage = { score: number; lastUsed: number };
type UsageMap = Record<string, Usage>;

// A use two weeks ago weighs half as much as one today
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
const SAVE_DELAY_MS = 3000;
// Keeps the account data small
const MAX_STORED = 60;

let pending: UsageMap | undefined;
let saveTimeout: ReturnType<typeof setTimeout> | undefined;
let isSeeded = false;

function decayedScore({ score, lastUsed }: Usage, now: number) {
  return score * 0.5 ** (Math.max(0, now - lastUsed) / HALF_LIFE_MS);
}

function getStoredUsage(): UsageMap | undefined {
  if (!hasClient()) return undefined;
  return getClient().getAccountData(REACTION_USAGE_EVENT as never)?.getContent<{ usage?: UsageMap }>().usage;
}

function getUsage(): UsageMap {
  return pending || getStoredUsage() || seedFromHistory();
}

// Before anything is stored, the reactions this person already left in loaded chats give a starting order
function seedFromHistory(): UsageMap {
  if (isSeeded || !hasClient()) return {};
  isSeeded = true;
  const client = getClient();
  const userId = client.getUserId();
  const usage: UsageMap = {};
  client.getRooms().forEach((room) => {
    room.getLiveTimeline().getEvents().forEach((event) => {
      if (event.getType() !== EventType.Reaction || event.getSender() !== userId || event.isRedacted()) return;
      const key = event.getRelation()?.key;
      if (key) addUse(usage, normalizeReactionKey(key), event.getTs());
    });
  });
  if (Object.keys(usage).length) scheduleSave(usage);
  return usage;
}

function addUse(usage: UsageMap, emoticon: string, at: number) {
  const current = usage[emoticon];
  usage[emoticon] = {
    score: (current ? decayedScore(current, at) : 0) + 1,
    lastUsed: Math.max(at, current?.lastUsed || 0),
  };
}

function scheduleSave(usage: UsageMap) {
  pending = usage;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = undefined;
    const toSave = pending;
    if (!toSave || !hasClient()) return;
    const now = Date.now();
    const trimmed = Object.fromEntries(Object.entries(toSave)
      .sort(([, a], [, b]) => decayedScore(b, now) - decayedScore(a, now))
      .slice(0, MAX_STORED));
    getClient().setAccountData(REACTION_USAGE_EVENT as never, { usage: trimmed } as never)
      .then(() => {
        if (pending === toSave) pending = undefined;
      })
      .catch((err) => {
        if (DEBUG) console.warn('[matrix] Saving reaction usage failed', err);
      });
  }, SAVE_DELAY_MS);
}

export function recordReactionUsage(emoticons: string[]) {
  if (!emoticons.length) return;
  const usage = { ...getUsage() };
  const now = Date.now();
  emoticons.forEach((emoticon) => addUse(usage, normalizeReactionKey(emoticon), now));
  scheduleSave(usage);
  onUpdate({ '@type': 'updateRecentReactions' });
}

// Another device changed the counts
export function handleReactionUsageAccountData(event: MatrixEvent) {
  if (event.getType() !== REACTION_USAGE_EVENT || pending) return;
  onUpdate({ '@type': 'updateRecentReactions' });
}

function toReactions(emoticons: string[]): ApiReaction[] {
  return emoticons.map((emoticon) => ({ type: 'emoji' as const, emoticon }));
}

function orderWithDefaults(used: string[], defaults: string[]) {
  const usedSet = new Set(used);
  return [...used, ...defaults.filter((emoticon) => !usedSet.has(emoticon))];
}

// Most used first, then the standard order
export function getTopReactions(defaults: string[]) {
  const now = Date.now();
  const used = Object.entries(getUsage())
    .sort(([, a], [, b]) => decayedScore(b, now) - decayedScore(a, now))
    .map(([emoticon]) => emoticon);
  return toReactions(orderWithDefaults(used, defaults));
}

// Most recently used first
export function getRecentReactions(defaults: string[], count: number) {
  const used = Object.entries(getUsage())
    .sort(([, a], [, b]) => b.lastUsed - a.lastUsed)
    .map(([emoticon]) => emoticon);
  return toReactions(orderWithDefaults(used, defaults).slice(0, count));
}
