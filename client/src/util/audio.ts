import { fetchBlob } from './files';

type AudioMetadata = {
  title?: string;
  performer?: string;
  duration?: number;
  coverUrl?: string;
};

export async function parseAudioMetadata(url: string): Promise<AudioMetadata> {
  const { parseBlob, selectCover } = await import('music-metadata');
  const blob = await fetchBlob(url);
  const metadata = await parseBlob(blob);
  const { common: { title, artist, picture }, format: { duration } } = metadata;

  const cover = selectCover(picture);
  const coverBlob = cover ? new Blob([cover.data as Uint8Array<ArrayBuffer>], { type: cover.format }) : undefined;
  const coverUrl = coverBlob ? URL.createObjectURL(coverBlob) : undefined;

  return {
    title,
    performer: artist,
    duration,
    coverUrl,
  };
}

const DURATION_TIMEOUT_MS = 5000;

// When the tags can't be parsed, the browser's own player still tells the length
export function getAudioDuration(url: string) {
  return new Promise<number>((resolve, reject) => {
    const audio = new Audio();
    const timeout = window.setTimeout(() => reject(new Error('Timed out')), DURATION_TIMEOUT_MS);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Unsupported audio'));
    };
    audio.src = url;
  });
}
