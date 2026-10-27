import { Method } from 'matrix-js-sdk';

import type { ApiSticker, ApiStickerSetInfo } from '../types';
import type { PackImage, StoredPack } from './stickersState';

import { DEBUG } from '../../config';
import { getClient, hasClient, onUpdate } from './client';
import {
  buildApiSticker, buildApiStickerSet, findPackImage, getPack, getPackImages, getPacks, getShortNameBySetId,
  getStickerSetId, PACK_EVENT, setPacks, STICKER_REGISTRY_LOCALPART,
} from './stickersState';

// Which packs a person has on, plus their recent and favorite stickers, in their account data
const STICKERS_ACCOUNT_DATA = 'im.peyvand.stickers';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 20;
const FAVORITE_LIMIT = 5 * RECENT_LIMIT;

type StickerRef = { image: PackImage; pack?: string };
type StickerSettings = {
  added?: string[];
  removed?: string[];
  recent?: StickerRef[];
  favorite?: StickerRef[];
};
type StateEvent = { type: string; state_key: string; content: Record<string, unknown> };

let registryRoomId: string | undefined;
let refreshPromise: Promise<void> | undefined;
let lastRefreshAt = 0;
let refreshInterval: ReturnType<typeof setInterval> | undefined;
let installedShortNames = new Set<string>();

function readSettings(): StickerSettings {
  return getClient().getAccountData(STICKERS_ACCOUNT_DATA as never)?.getContent<StickerSettings>() || {};
}

async function writeSettings(update: Partial<StickerSettings>) {
  await getClient().setAccountData(STICKERS_ACCOUNT_DATA as never, { ...readSettings(), ...update } as never);
}

function isInstalled(pack: StoredPack, settings: StickerSettings) {
  const name = pack.shortName.toLowerCase();
  if (settings.removed?.some((removed) => removed.toLowerCase() === name)) return false;
  return Boolean(pack.content.pack?.['im.peyvand.default'])
    || Boolean(settings.added?.some((added) => added.toLowerCase() === name));
}

function getInstalledDate(pack: StoredPack) {
  return Math.floor((pack.content.pack?.['im.peyvand.added_ts'] || Date.now()) / 1000);
}

async function resolveRegistryRoomId() {
  if (registryRoomId) return registryRoomId;
  const client = getClient();
  try {
    const { room_id: roomId } = await client.getRoomIdForAlias(`#${STICKER_REGISTRY_LOCALPART}:${client.getDomain()}`);
    registryRoomId = roomId;
    return roomId;
  } catch {
    // The sticker bot hasn't added a pack yet
    return undefined;
  }
}

async function loadRegistry() {
  const roomId = await resolveRegistryRoomId();
  if (!roomId) {
    setPacks([]);
    return;
  }
  const events = await getClient().http.authedRequest<StateEvent[]>(
    Method.Get, `/rooms/${encodeURIComponent(roomId)}/state`,
  );
  setPacks(events
    .filter(({ type, state_key: key, content }) => type === PACK_EVENT && key && content?.images)
    .map(({ state_key: shortName, content }) => ({ shortName, content })));
}

// Packs that became available or went away since the last look reach the UI as set updates
function announceInstalledChanges() {
  const settings = readSettings();
  const installed = new Set(getPacks().filter((pack) => isInstalled(pack, settings)).map((pack) => pack.shortName));
  installed.forEach((shortName) => {
    if (installedShortNames.has(shortName)) return;
    const pack = getPack(shortName)!;
    onUpdate({
      '@type': 'updateStickerSet',
      id: getStickerSetId(shortName),
      stickerSet: buildApiStickerSet(pack, getInstalledDate(pack)),
    });
  });
  installedShortNames.forEach((shortName) => {
    if (installed.has(shortName)) return;
    onUpdate({ '@type': 'updateStickerSet', id: getStickerSetId(shortName), stickerSet: { installedDate: undefined } });
  });
  installedShortNames = installed;
}

function refreshRegistry(force?: boolean) {
  if (!hasClient()) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS / 2) return Promise.resolve();
  refreshPromise = loadRegistry()
    .then(() => {
      lastRefreshAt = Date.now();
    })
    .catch((err) => {
      if (DEBUG) console.warn('[matrix] Reading the sticker registry failed', err);
    })
    .finally(() => {
      refreshPromise = undefined;
    });
  return refreshPromise;
}

function startRefreshing() {
  if (refreshInterval) return;
  refreshInterval = setInterval(() => {
    if (!hasClient()) {
      clearInterval(refreshInterval);
      refreshInterval = undefined;
      return;
    }
    void refreshRegistry(true).then(announceInstalledChanges);
  }, REFRESH_INTERVAL_MS);
}

function buildHash(values: unknown) {
  const text = JSON.stringify(values);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  return String(hash >>> 0);
}

export async function fetchStickerSets({ hash }: { hash?: string }) {
  await refreshRegistry(true);
  startRefreshing();
  const settings = readSettings();
  const installed = getPacks().filter((pack) => isInstalled(pack, settings))
    .sort((a, b) => getInstalledDate(b) - getInstalledDate(a));
  installedShortNames = new Set(installed.map((pack) => pack.shortName));
  const sets = installed.map((pack) => buildApiStickerSet(pack, getInstalledDate(pack)));
  const newHash = buildHash(sets.map(({ id, count }) => [id, count]));
  // The UI appends the sets it gets to the ones it has, so an unchanged list isn't sent again
  if (hash && hash === newHash) return undefined;
  return { hash: newHash, sets };
}

export function fetchCustomEmojiSets() {
  return Promise.resolve({ hash: '0', sets: [] });
}

function findPack(stickerSetInfo: ApiStickerSetInfo) {
  if ('isMissing' in stickerSetInfo) return undefined;
  const shortName = 'shortName' in stickerSetInfo ? stickerSetInfo.shortName : getShortNameBySetId(stickerSetInfo.id);
  return shortName ? getPack(shortName) : undefined;
}

export async function fetchStickers({ stickerSetInfo }: { stickerSetInfo: ApiStickerSetInfo }) {
  if (!getPacks().length) await refreshRegistry(true);
  let pack = findPack(stickerSetInfo);
  if (!pack) {
    // A pack the bot added a moment ago
    await refreshRegistry(true);
    pack = findPack(stickerSetInfo);
  }
  if (!pack) return undefined;

  const settings = readSettings();
  const set = buildApiStickerSet(pack, isInstalled(pack, settings) ? getInstalledDate(pack) : undefined);
  const stickers = getPackImages(pack).map(([, image]) => buildApiSticker(image, pack.shortName));
  const packs: Record<string, ApiSticker[]> = {};
  stickers.forEach((sticker) => {
    if (!sticker.emoji) return;
    (packs[sticker.emoji] ||= []).push(sticker);
  });
  return { set, stickers, packs };
}

async function setInstalled(stickerSetId: string, isOn: boolean) {
  const shortName = getShortNameBySetId(stickerSetId);
  const pack = shortName ? getPack(shortName) : undefined;
  if (!pack) return;
  const settings = readSettings();
  const name = pack.shortName.toLowerCase();
  const added = (settings.added || []).filter((item) => item.toLowerCase() !== name);
  const removed = (settings.removed || []).filter((item) => item.toLowerCase() !== name);
  await writeSettings(isOn
    ? { added: [...added, pack.shortName], removed }
    : { added, removed: [...removed, pack.shortName] });
  if (isOn) installedShortNames.add(pack.shortName);
  else installedShortNames.delete(pack.shortName);
  onUpdate({
    '@type': 'updateStickerSet',
    id: stickerSetId,
    stickerSet: { installedDate: isOn ? Math.floor(Date.now() / 1000) : undefined },
  });
}

export function installStickerSet({ stickerSetId }: { stickerSetId: string; accessHash: string }) {
  return setInstalled(stickerSetId, true);
}

export function uninstallStickerSet({ stickerSetId }: { stickerSetId: string; accessHash: string }) {
  return setInstalled(stickerSetId, false);
}

/* Recent and favorite stickers */

function buildRef(sticker: ApiSticker): StickerRef | undefined {
  const found = findPackImage(sticker.id);
  return found ? { image: found.image, pack: found.shortName } : undefined;
}

function buildStickersFromRefs(refs: StickerRef[] = []) {
  return refs.filter((ref) => ref?.image?.url).map((ref) => buildApiSticker(ref.image, ref.pack));
}

export function addRecentSticker(image: PackImage, pack?: string) {
  const recent = (readSettings().recent || []).filter((ref) => ref.image?.url !== image.url);
  return writeSettings({ recent: [{ image, pack }, ...recent].slice(0, RECENT_LIMIT) }).catch(() => undefined);
}

export function fetchRecentStickers({ hash }: { hash?: string }) {
  const stickers = buildStickersFromRefs(readSettings().recent);
  const newHash = buildHash(stickers.map(({ id }) => id));
  return Promise.resolve(hash === newHash ? undefined : { hash: newHash, stickers });
}

export async function removeRecentSticker({ sticker }: { sticker: ApiSticker }) {
  const recent = (readSettings().recent || []).filter((ref) => buildApiSticker(ref.image, ref.pack).id !== sticker.id);
  await writeSettings({ recent });
  return true;
}

export async function clearRecentStickers() {
  await writeSettings({ recent: [] });
  return true;
}

export function fetchFavoriteStickers({ hash }: { hash?: string }) {
  const stickers = buildStickersFromRefs(readSettings().favorite);
  const newHash = buildHash(stickers.map(({ id }) => id));
  return Promise.resolve(hash === newHash ? undefined : { hash: newHash, stickers });
}

export async function faveSticker({ sticker, unfave }: { sticker: ApiSticker; unfave?: boolean }) {
  const favorite = (readSettings().favorite || [])
    .filter((ref) => buildApiSticker(ref.image, ref.pack).id !== sticker.id);
  const ref = unfave ? undefined : buildRef(sticker);
  await writeSettings({ favorite: ref ? [ref, ...favorite].slice(0, FAVORITE_LIMIT) : favorite });
  onUpdate({ '@type': 'updateFavoriteStickers' });
}

// Suggestions while typing an emoji come from the packs a person has on
export function fetchStickersForEmoji({ emoji }: { emoji: string; hash?: string }) {
  const settings = readSettings();
  const normalized = emoji.replace(/️/g, '');
  const stickers = getPacks()
    .filter((pack) => isInstalled(pack, settings))
    .flatMap((pack) => getPackImages(pack)
      .filter(([, image]) => image.body && image.body.replace(/️/g, '').includes(normalized))
      .map(([, image]) => buildApiSticker(image, pack.shortName)));
  return Promise.resolve({ stickers, hash: buildHash(stickers.map(({ id }) => id)) });
}
