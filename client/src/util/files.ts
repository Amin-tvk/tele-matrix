import { CONTENT_TYPES_WITH_PREVIEW } from '../config';
import { pause } from './schedulers';

// Polyfill for Safari: `File` is not available in web worker
if (typeof File === 'undefined') {
  self.File = class extends Blob {
    name: string;

    constructor(fileBits: BlobPart[], fileName: string, options?: FilePropertyBag) {
      if (options) {
        const { type, ...rest } = options;
        super(fileBits, { type });
        Object.assign(this, rest);
      } else {
        super(fileBits);
      }

      this.name = fileName;
    }
  } as typeof File;
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e: ProgressEvent<FileReader>) => {
      const { result } = e.target || {};
      if (typeof result === 'string') {
        resolve(result);
      }

      reject(new Error('Failed to read blob'));
    };

    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function blobToFile(blob: Blob, fileName: string) {
  return new File([blob], fileName, {
    lastModified: Date.now(),
    type: blob.type,
  });
}

export function preloadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export function preloadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.volume = 0;
    // Phone browsers only decode frames of muted inline videos without a tap
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => resolve(video);
    video.onerror = reject;
    video.src = url;
  });
}

// The thumbnail sent with a video. Phones take a while to decode a large video, so they get more time,
// and the frame is a small JPEG rather than a full-size PNG
const POSTER_TIMEOUT_MS = 8000;
const POSTER_MAX_SIDE = 640;
const POSTER_QUALITY = 0.8;
const POSTER_SEEK_S = 0.5;

export async function createPosterForVideo(url: string): Promise<string | undefined> {
  try {
    const video = await preloadVideo(url);

    return await Promise.race([
      pause(POSTER_TIMEOUT_MS) as Promise<undefined>,
      new Promise<string | undefined>((resolve, reject) => {
        video.onseeked = () => {
          if (!video.videoWidth || !video.videoHeight) {
            resolve(undefined);
            return;
          }

          const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          canvas.toBlob((blob) => {
            resolve(blob ? URL.createObjectURL(blob) : undefined);
          }, 'image/jpeg', POSTER_QUALITY);
        };
        video.onerror = reject;
        const { duration } = video;
        video.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(duration / 2, POSTER_SEEK_S) : 0;
      }),
    ]);
  } catch (e) {
    return undefined;
  }
}

export async function fetchBlob(blobUrl: string) {
  const response = await fetch(blobUrl);
  return response.blob();
}

export async function fetchFile(blobUrl: string, fileName: string) {
  const blob = await fetchBlob(blobUrl);
  return blobToFile(blob, fileName);
}

export function imgToCanvas(img: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;

  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);

  return canvas;
}

export function hasPreview(file: File) {
  return CONTENT_TYPES_WITH_PREVIEW.has(file.type);
}

export function validateFiles(files: File[] | FileList | null): File[] | undefined {
  if (!files?.length) {
    return undefined;
  }
  return Array.from(files).map(fixMimeType).filter((file) => file.size);
}

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  mov: 'video/quicktime',
  flac: 'audio/flac',
};

// Browsers may omit the type or take a non-standard one from the OS (e.g. Firefox reports `audio/x-flac` on Windows)
// https://developer.mozilla.org/en-US/docs/Web/API/File/type#sect1
function fixMimeType(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const expectedType = ext && MIME_TYPE_BY_EXTENSION[ext];
  if (!expectedType || file.type === expectedType) {
    return file;
  }
  return new File([file], file.name, { type: expectedType });
}
