import type { ApiSticker, ApiStickerSet } from '../types';

import { THUMBNAIL_SEPARATOR } from './constants';
import { encodeMxc } from './ids';

// Sticker packs in the Matrix image pack format (MSC2545, also read by Cinny and FluffyChat). The packs everyone
// can use live in one registry room, one `im.ponies.room_emotes` state event per pack keyed by its short name;
// the sticker bot fills it. Packs the server admins add are on for everyone until a person removes them

export const STICKER_REGISTRY_LOCALPART = 'peyvand-stickers';
export const PACK_EVENT = 'im.ponies.room_emotes';
// Sent with a sticker, so a tap on it opens its pack
export const PACK_KEY = 'im.peyvand.pack';
// Comments only take the comment event type, so a sticker there is an image marked with this
export const STICKER_MARKER = 'im.peyvand.sticker';
export const LOTTIE_MIME = 'application/x-tgsticker';
export const VIDEO_STICKER_MIME = 'video/webm';

export type PackImage = {
  url: string;
  body?: string;
  info?: {
    w?: number;
    h?: number;
    mimetype?: string;
    size?: number;
    thumbnail_url?: string;
    thumbnail_info?: { w?: number; h?: number; mimetype?: string };
  };
  usage?: string[];
};

export type PackContent = {
  pack?: {
    display_name?: string;
    avatar_url?: string;
    usage?: string[];
    'im.peyvand.default'?: boolean;
    'im.peyvand.added_ts'?: number;
  };
  images?: Record<string, PackImage>;
};

export type StoredPack = { shortName: string; content: PackContent };

const packsByShortName = new Map<string, StoredPack>();
const shortNameBySetId = new Map<string, string>();

// Telegram set IDs are numbers; a stable one is derived from the short name
export function getStickerSetId(shortName: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < shortName.length; i++) {
    hash ^= shortName.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const id = String(1_000_000_000 + hash);
  shortNameBySetId.set(id, shortName);
  return id;
}

export function getShortNameBySetId(id: string) {
  return shortNameBySetId.get(id);
}

export function setPacks(packs: StoredPack[]) {
  packsByShortName.clear();
  packs.forEach((pack) => {
    getStickerSetId(pack.shortName);
    packsByShortName.set(pack.shortName.toLowerCase(), pack);
  });
}

export function getPacks() {
  return [...packsByShortName.values()];
}

export function getPack(shortName: string) {
  return packsByShortName.get(shortName.toLowerCase());
}

function isStickerImage(image: PackImage, pack?: PackContent) {
  const usage = image.usage || pack?.pack?.usage;
  return !usage || usage.includes('sticker');
}

export function getPackImages(pack: StoredPack) {
  return Object.entries(pack.content.images || {})
    .filter(([, image]) => typeof image?.url === 'string' && isStickerImage(image, pack.content))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
}

export function buildStickerId(url: string, thumbnailUrl?: string) {
  const id = encodeMxc(url);
  return thumbnailUrl ? `${id}${THUMBNAIL_SEPARATOR}${encodeMxc(thumbnailUrl)}` : id;
}

// From a pack image or the content of a sticker message
export function buildApiSticker(image: PackImage, shortName?: string): ApiSticker {
  const info = image.info || {};
  const mimeType = info.mimetype;
  const isLottie = mimeType === LOTTIE_MIME;
  const isVideo = mimeType === VIDEO_STICKER_MIME;
  return {
    mediaType: 'sticker',
    id: buildStickerId(image.url, info.thumbnail_url),
    stickerSetInfo: shortName ? { id: getStickerSetId(shortName), accessHash: '' } : { isMissing: true },
    emoji: image.body && image.body.length <= 16 ? image.body : undefined,
    isLottie,
    isVideo,
    // Every pack here is free for everyone; without this the UI marks stickers as premium
    isFree: true,
    width: info.w || 512,
    height: info.h || 512,
    previewPhotoSizes: info.thumbnail_url
      ? [{ type: 'm', width: info.thumbnail_info?.w || 128, height: info.thumbnail_info?.h || 128 }]
      : undefined,
  };
}

// Pack images keyed by the sticker ID the UI uses, to send a sticker with its full details
export function findPackImage(stickerId: string) {
  for (const pack of packsByShortName.values()) {
    for (const [, image] of getPackImages(pack)) {
      if (buildStickerId(image.url, image.info?.thumbnail_url) === stickerId) {
        return { image, shortName: pack.shortName };
      }
    }
  }
  return undefined;
}

export function buildApiStickerSet(pack: StoredPack, installedDate?: number): ApiStickerSet {
  const images = getPackImages(pack);
  const stickers = images.map(([, image]) => buildApiSticker(image, pack.shortName));
  return {
    id: getStickerSetId(pack.shortName),
    accessHash: '',
    title: pack.content.pack?.display_name || pack.shortName,
    shortName: pack.shortName,
    count: stickers.length,
    installedDate,
    hasThumbnail: false,
    covers: stickers.slice(0, 1),
  };
}
