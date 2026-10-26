import type {
  ApiAppConfig, ApiConfig, ApiLanguage, ApiPeerColors, ApiReaction, LangPack,
} from '../types';

import { DEFAULT_APP_CONFIG } from '../../limits';
import { getClient, hasClient } from './client';
import { QUICK_REACTION_EVENT } from './constants';

// Methods that have no Matrix counterpart but whose callers expect a defined result

const CONFIG_TTL_SECONDS = 3600;
const MAX_GROUP_SIZE = 10000;
const MAX_MESSAGE_LENGTH = 32768;
const EDIT_TIME_LIMIT_SECONDS = 365 * 24 * 3600;
const MAX_FORWARDED_COUNT = 100;

// Telegram's default name colors, paired with brighter variants for the dark theme
const PEER_COLORS: [string, string][] = [
  ['#D45246', '#FF7C6F'],
  ['#F68136', '#FFA35A'],
  ['#6C61DF', '#A496FF'],
  ['#46BA43', '#6DD66A'],
  ['#5CAFFA', '#7CC4FF'],
  ['#408ACF', '#5FA9EE'],
  ['#D95574', '#FF7B98'],
];

export function fetchPeerColors() {
  const colors: ApiPeerColors['general'] = {};
  PEER_COLORS.forEach(([light, dark], index) => {
    colors[index] = { colors: [light], darkColors: [dark] };
  });
  return Promise.resolve({ colors, hash: 1 });
}

export function fetchPeerProfileColors() {
  return Promise.resolve({ colors: {}, hash: 1 });
}

const DEFAULT_QUICK_REACTION = '❤';

// The quick (double tap) reaction is kept in the account data, so it follows the user to every device
function getQuickReaction(): ApiReaction {
  const emoticon = hasClient()
    ? getClient().getAccountData(QUICK_REACTION_EVENT as never)?.getContent<{ emoticon?: string }>().emoticon
    : undefined;
  return { type: 'emoji', emoticon: emoticon || DEFAULT_QUICK_REACTION };
}

export async function setDefaultReaction({ reaction }: { reaction: ApiReaction }) {
  if (reaction.type !== 'emoji') return false;
  await getClient().setAccountData(QUICK_REACTION_EVENT as never, { emoticon: reaction.emoticon } as never);
  return true;
}

export function fetchConfig(): Promise<ApiConfig> {
  return Promise.resolve({
    expiresAt: Math.floor(Date.now() / 1000) + CONFIG_TTL_SECONDS,
    defaultReaction: getQuickReaction(),
    maxGroupSize: MAX_GROUP_SIZE,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    editTimeLimit: EDIT_TIME_LIMIT_SECONDS,
    maxForwardedCount: MAX_FORWARDED_COUNT,
    ratingEDecay: 0,
  });
}

export function fetchNearestCountry() {
  return Promise.resolve('IR');
}

export function getPasswordInfo() {
  return Promise.resolve({ hint: undefined, hasPassword: false });
}

export function setShouldDebugExportedSenders() {
  return undefined;
}

export function setOpenedChannelIds() {
  return undefined;
}

export function fetchChatlistInvites() {
  return Promise.resolve({ invites: [], chats: [], users: [] });
}

// Telegram's standard reaction set; rendered from bundled emoji images since there are no server animations
const REACTION_EMOJIS = [
  '👍', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '😢', '🎉', '🤩', '🙏', '👌', '😍', '❤‍🔥', '💯', '🤣',
  '⚡', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '😈', '😴', '😭', '🤓', '👻', '👀', '🙈', '😇', '😨', '🤝',
  '✍', '🤗', '🫡', '💅', '🤪', '🗿', '🆒', '💘', '🦄', '😘', '😎', '👾', '🤷', '😡', '👎', '🤬', '🥱', '🌚',
];
const TOP_REACTION_COUNT = 8;

export function fetchAvailableReactions() {
  return Promise.resolve(REACTION_EMOJIS.map((emoticon) => ({
    reaction: { type: 'emoji' as const, emoticon },
    title: emoticon,
  })));
}

function buildReactionList(count = REACTION_EMOJIS.length) {
  return {
    hash: '1',
    reactions: REACTION_EMOJIS.slice(0, count).map((emoticon) => ({ type: 'emoji' as const, emoticon })),
  };
}

export function fetchTopReactions() {
  return Promise.resolve(buildReactionList(TOP_REACTION_COUNT));
}

export function fetchRecentReactions() {
  return Promise.resolve(buildReactionList(TOP_REACTION_COUNT));
}

export function fetchDefaultTagReactions() {
  return Promise.resolve(buildReactionList(TOP_REACTION_COUNT));
}

export function fetchAppConfig(): Promise<ApiAppConfig> {
  return Promise.resolve({
    ...DEFAULT_APP_CONFIG,
    hash: 1,
    isPremiumPurchaseBlocked: true,
    isStarsGiftEnabled: false,
    isGiveawayGiftsPurchaseAvailable: false,
    arePasskeysAvailable: false,
    autologinDomains: [],
    urlAuthDomains: [],
    whitelistedDomains: [],
    premiumPromoOrder: [],
  });
}

// Languages are bundled with the app: English is the built-in fallback, Persian ships as a separate pack
const PERSIAN_PACK_VERSION = 2;
const LANG_TRANSLATIONS_URL = self.location.origin;
const LANGUAGES: ApiLanguage[] = [
  {
    langCode: 'fa',
    name: 'Persian',
    nativeName: 'فارسی',
    pluralCode: 'fa',
    isRtl: true,
    isOfficial: true,
    stringsCount: 1,
    translatedCount: 1,
    translationsUrl: LANG_TRANSLATIONS_URL,
  },
  {
    langCode: 'en',
    name: 'English',
    nativeName: 'English',
    pluralCode: 'en',
    isOfficial: true,
    stringsCount: 1,
    translatedCount: 1,
    translationsUrl: LANG_TRANSLATIONS_URL,
  },
];

async function loadPersianStrings() {
  const { default: strings } = await import('../../assets/localization/fa.json');
  return strings as LangPack['strings'];
}

export function fetchLanguages() {
  return Promise.resolve(LANGUAGES);
}

export function fetchLanguage({ langCode }: { langPack: string; langCode: string }) {
  return Promise.resolve(LANGUAGES.find((language) => language.langCode === langCode));
}

export async function fetchLangPack({ langCode }: { langPack: string; langCode: string }) {
  if (langCode !== 'fa') return undefined;
  return {
    langCode,
    fromVersion: 0,
    version: PERSIAN_PACK_VERSION,
    strings: await loadPersianStrings(),
    keysToRemove: [] as string[],
  };
}

export async function fetchLangDifference({
  langCode, fromVersion,
}: { langPack: string; langCode: string; fromVersion: number }) {
  if (langCode !== 'fa' || fromVersion >= PERSIAN_PACK_VERSION) return undefined;
  return {
    langCode,
    fromVersion,
    version: PERSIAN_PACK_VERSION,
    strings: await loadPersianStrings(),
    keysToRemove: [] as string[],
  };
}
