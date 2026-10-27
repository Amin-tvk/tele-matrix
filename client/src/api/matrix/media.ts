import type { ApiOnProgress, ApiParsedMedia } from '../types';
import { ApiMediaFormat } from '../types';

import {
  MEDIA_CACHE_DISABLED,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_NAME,
  MEDIA_CACHE_NAME_AVATARS,
} from '../../config';
import * as cacheApi from '../../util/cacheApi';
import { THUMBNAIL_SEPARATOR } from './constants';
import { decodeMxc } from './ids';
import { retryOnNetworkError } from './retry';
import { getAuthHeaders, getHomeserverUrl } from './session';
import { getValue, setValue } from './store';

export type EncryptedFile = {
  url: string;
  key: JsonWebKey & { k: string };
  iv: string;
  hashes: { sha256: string };
  v: string;
  mimetype?: string;
};

type MediaSource = { mxc: string; encryptedFile?: EncryptedFile };

const THUMBNAIL_SIZES = {
  avatar: [128, 128, 'crop'],
  profile: [640, 640, 'scale'],
  small: [320, 240, 'scale'],
  large: [800, 600, 'scale'],
} as const;
const MAX_PROGRESSIVE_BUFFERS = 3;
const progressiveBuffers = new Map<string, { buffer: ArrayBuffer; mimeType?: string }>();

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16) + value.length.toString(16);
}

export function getEncryptedFileMediaId(file: EncryptedFile) {
  const id = `e${hashString(file.url)}`;
  setValue(`f:${id}`, JSON.stringify(file));
  return id;
}

function resolveMediaSource(mediaId: string): MediaSource | undefined {
  if (mediaId.includes('/')) return { mxc: decodeMxc(mediaId) };
  const raw = getValue(`f:${mediaId}`);
  if (!raw) return undefined;
  const encryptedFile = JSON.parse(raw) as EncryptedFile;
  return { mxc: encryptedFile.url, encryptedFile };
}

function splitMxc(mxc: string) {
  const [serverName, mediaId] = mxc.replace(/^mxc:\/\//, '').split('/');
  return { serverName, mediaId };
}

export function getMediaDownloadUrl(mxc: string) {
  const { serverName, mediaId } = splitMxc(mxc);
  return `${getHomeserverUrl()}/_matrix/client/v1/media/download/${encodeURIComponent(serverName)}/${encodeURIComponent(mediaId)}`;
}

function getMediaThumbnailUrl(mxc: string, [width, height, method]: readonly [number, number, string]) {
  const { serverName, mediaId } = splitMxc(mxc);
  return `${getHomeserverUrl()}/_matrix/client/v1/media/thumbnail/${encodeURIComponent(serverName)}/`
    + `${encodeURIComponent(mediaId)}?width=${width}&height=${height}&method=${method}`;
}

type ParsedMediaHash = {
  kind: 'avatar' | 'profile' | 'photo' | 'document';
  mediaId: string;
  thumbnailId?: string;
  size?: string;
  isDownload?: boolean;
};

const PROGRESSIVE_PREFIX = '/progressive/';

function parseMediaHash(rawUrl: string): ParsedMediaHash | undefined {
  // Streaming requests come from the service worker as full URLs
  const progressiveIndex = rawUrl.indexOf(PROGRESSIVE_PREFIX);
  const url = progressiveIndex === -1
    ? rawUrl : decodeURIComponent(rawUrl.slice(progressiveIndex + PROGRESSIVE_PREFIX.length));
  const match = url.match(/^(avatar|profile|photo|document)([^?]*)(?:\?(.*))?$/);
  if (!match) return undefined;
  const kind = match[1] as ParsedMediaHash['kind'];
  const query = match[3] || '';

  if (kind === 'avatar' || kind === 'profile') {
    return query ? { kind, mediaId: query } : undefined;
  }

  const [mediaId, thumbnailId] = match[2].split(THUMBNAIL_SEPARATOR);
  const params = new URLSearchParams(query);
  return {
    kind,
    mediaId,
    thumbnailId,
    size: params.get('size') || undefined,
    isDownload: params.has('download'),
  };
}

async function fetchMedia(url: string, onProgress?: ApiOnProgress, range?: [number, number]) {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (range) headers.Range = `bytes=${range[0]}-${range[1]}`;
  const response = await fetch(url, { headers });
  if (!response.ok) return undefined;

  const mimeType = response.headers.get('Content-Type') || undefined;
  const contentRange = response.headers.get('Content-Range');
  // The server doesn't expose Content-Range to other origins, so a partial response can't tell the file size
  const isPartial = response.status === 206;
  const fullSize = contentRange ? Number(contentRange.split('/')[1])
    : isPartial ? undefined : Number(response.headers.get('Content-Length'));

  if (!onProgress || !response.body || !fullSize) {
    return {
      data: await response.arrayBuffer(), mimeType, fullSize: fullSize || undefined, isPartial,
    };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (onProgress.isCanceled) {
      void reader.cancel();
      return undefined;
    }
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / fullSize, 1));
  }
  const data = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    data.set(chunk, offset);
    offset += chunk.length;
  });

  return {
    data: data.buffer, mimeType, fullSize, isPartial,
  };
}

function base64ToBytes(base64: string) {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array, isUrlSafe?: boolean) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  const base64 = btoa(binary).replace(/=+$/, '');
  return isUrlSafe ? base64.replace(/\+/g, '-').replace(/\//g, '_') : base64;
}

async function decryptAttachment(data: ArrayBuffer, file: EncryptedFile) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  if (bytesToBase64(digest) !== file.hashes.sha256.replace(/=+$/, '')) {
    throw new Error('Attachment hash mismatch');
  }
  const key = await crypto.subtle.importKey('jwk', file.key, { name: 'AES-CTR' }, false, ['decrypt']);
  return crypto.subtle.decrypt({ name: 'AES-CTR', counter: base64ToBytes(file.iv), length: 64 }, key, data);
}

export async function encryptAttachment(data: ArrayBuffer) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, true, ['encrypt', 'decrypt']);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CTR', counter: iv, length: 64 }, key, data);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext));
  const jwk = await crypto.subtle.exportKey('jwk', key);

  return {
    data: ciphertext,
    info: {
      key: {
        alg: 'A256CTR', ext: true, k: jwk.k!, key_ops: ['encrypt', 'decrypt'], kty: 'oct',
      },
      iv: bytesToBase64(iv),
      hashes: { sha256: bytesToBase64(digest) },
      v: 'v2',
    },
  };
}

function pickThumbnailSize(parsed: ParsedMediaHash) {
  if (parsed.kind === 'avatar') return THUMBNAIL_SIZES.avatar;
  if (parsed.kind === 'profile') return THUMBNAIL_SIZES.profile;
  if (parsed.isDownload || !parsed.size) return undefined;
  return parsed.size === 'x' || parsed.size === 'y' || parsed.size === 'w'
    ? THUMBNAIL_SIZES.large : THUMBNAIL_SIZES.small;
}

async function downloadParsed(parsed: ParsedMediaHash, onProgress?: ApiOnProgress) {
  const wantsPreview = Boolean(parsed.size) && parsed.kind === 'document';
  const sourceId = wantsPreview && parsed.thumbnailId ? parsed.thumbnailId : parsed.mediaId;
  const source = resolveMediaSource(sourceId);
  if (!source) return undefined;

  if (source.encryptedFile) {
    const result = await fetchMedia(getMediaDownloadUrl(source.mxc), onProgress);
    if (!result) return undefined;
    const data = await decryptAttachment(result.data, source.encryptedFile);
    return { data, mimeType: source.encryptedFile.mimetype, fullSize: data.byteLength };
  }

  const thumbnailSize = wantsPreview && parsed.thumbnailId ? undefined : pickThumbnailSize(parsed);
  if (thumbnailSize) {
    const thumbnail = await fetchMedia(getMediaThumbnailUrl(source.mxc, thumbnailSize));
    if (thumbnail) return thumbnail;
    // Previews of non-image documents must not fall back to downloading the whole file
    if (wantsPreview) return undefined;
  }

  return fetchMedia(getMediaDownloadUrl(source.mxc), onProgress);
}

// Players need the real file size to seek and to know where the media ends
const progressiveSizes = new Map<string, number>();

async function fetchMediaSize(url: string) {
  try {
    const response = await fetch(url, { method: 'HEAD', headers: getAuthHeaders() });
    const size = response.ok ? Number(response.headers.get('Content-Length')) : undefined;
    return size || undefined;
  } catch {
    return undefined;
  }
}

async function downloadProgressive(parsed: ParsedMediaHash, url: string, start: number, end: number) {
  const source = resolveMediaSource(parsed.mediaId);
  if (!source) return undefined;

  const cached = progressiveBuffers.get(url);
  if (cached) {
    return { data: cached.buffer.slice(start, end + 1), mimeType: cached.mimeType, fullSize: cached.buffer.byteLength };
  }

  if (!source.encryptedFile) {
    const downloadUrl = getMediaDownloadUrl(source.mxc);
    const [partial, knownSize] = await Promise.all([
      fetchMedia(downloadUrl, undefined, [start, end]),
      progressiveSizes.get(url) ?? fetchMediaSize(downloadUrl),
    ]);
    if (!partial) return undefined;
    if (partial.isPartial) {
      const fullSize = partial.fullSize || knownSize;
      if (fullSize) progressiveSizes.set(url, fullSize);
      return { ...partial, fullSize };
    }
    rememberProgressiveBuffer(url, partial.data, partial.mimeType);
    return { data: partial.data.slice(start, end + 1), mimeType: partial.mimeType, fullSize: partial.data.byteLength };
  }

  const full = await downloadParsed({ ...parsed, isDownload: true });
  if (!full) return undefined;
  rememberProgressiveBuffer(url, full.data, full.mimeType);
  return { data: full.data.slice(start, end + 1), mimeType: full.mimeType, fullSize: full.data.byteLength };
}

function rememberProgressiveBuffer(url: string, buffer: ArrayBuffer, mimeType?: string) {
  progressiveBuffers.set(url, { buffer, mimeType });
  if (progressiveBuffers.size > MAX_PROGRESSIVE_BUFFERS) {
    progressiveBuffers.delete(progressiveBuffers.keys().next().value!);
  }
}

export async function downloadMedia(
  {
    url, mediaFormat, start, end, isHtmlAllowed,
  }: {
    url: string; mediaFormat: ApiMediaFormat; start?: number; end?: number; isHtmlAllowed?: boolean;
  },
  onProgress?: ApiOnProgress,
) {
  const parsed = parseMediaHash(url);
  if (!parsed) return undefined;

  const result = mediaFormat === ApiMediaFormat.Progressive && start !== undefined && end !== undefined
    ? await downloadProgressive(parsed, url, start, end)
    : await downloadParsed(parsed, onProgress);
  if (!result) return undefined;

  let mimeType = result.mimeType;
  // Prevent HTML-in-media attacks
  if (!isHtmlAllowed && mimeType) {
    mimeType = mimeType.replace(/html/gi, '');
  }

  let parsedMedia: ApiParsedMedia;
  switch (mediaFormat) {
    case ApiMediaFormat.Text:
      parsedMedia = new TextDecoder().decode(result.data);
      break;
    case ApiMediaFormat.Progressive:
    case ApiMediaFormat.DownloadUrl:
      parsedMedia = result.data;
      break;
    default:
      parsedMedia = new Blob([result.data], { type: mimeType });
  }

  const canCache = mediaFormat !== ApiMediaFormat.Progressive && (
    mediaFormat !== ApiMediaFormat.BlobUrl || (parsedMedia as Blob).size <= MEDIA_CACHE_MAX_BYTES
  );
  if (!MEDIA_CACHE_DISABLED && canCache) {
    const cacheName = url.startsWith('avatar') ? MEDIA_CACHE_NAME_AVATARS : MEDIA_CACHE_NAME;
    void cacheApi.save(cacheName, url, parsedMedia);
  }

  const isBuffer = mediaFormat === ApiMediaFormat.Progressive || mediaFormat === ApiMediaFormat.DownloadUrl;
  return {
    dataBlob: isBuffer ? '' : parsedMedia as string | Blob,
    arrayBuffer: isBuffer ? parsedMedia as ArrayBuffer : undefined,
    mimeType,
    fullSize: result.fullSize,
  };
}

export function uploadContent(
  data: Blob | ArrayBuffer, fileName: string, mimeType: string, onProgress?: ApiOnProgress,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getHomeserverUrl()}/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`);
    Object.entries(getAuthHeaders()).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.setRequestHeader('Content-Type', mimeType || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (onProgress?.isCanceled) {
        xhr.abort();
        return;
      }
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText).content_uri);
      } else {
        reject(Object.assign(new Error(`Upload failed: ${xhr.status}`), { httpStatus: xhr.status }));
      }
    };
    // Named like the SDK's network errors, so the upload is retried once the connection is back
    xhr.onerror = () => reject(Object.assign(new Error('Upload failed'), { name: 'ConnectionError' }));
    xhr.onabort = () => reject(new Error('Upload canceled'));
    xhr.send(data);
  });
}

export async function uploadFile(
  blob: Blob, fileName: string, mimeType: string, isEncrypted: boolean, onProgress?: ApiOnProgress,
): Promise<{ url?: string; file?: EncryptedFile }> {
  // The server can't resume an upload, so an interrupted one starts over once the connection is back
  const isCanceled = () => Boolean(onProgress?.isCanceled);
  if (!isEncrypted) {
    return { url: await retryOnNetworkError(() => uploadContent(blob, fileName, mimeType, onProgress), isCanceled) };
  }

  const { data, info } = await encryptAttachment(await blob.arrayBuffer());
  const url = await retryOnNetworkError(
    () => uploadContent(data, fileName, 'application/octet-stream', onProgress), isCanceled,
  );
  return { file: { ...info, url, mimetype: mimeType } };
}
