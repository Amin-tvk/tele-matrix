// Speeds offered for voice and video messages. A tap on the speed button steps through them, like in Telegram
export const PLAYBACK_RATE_STEPS = [1, 1.5, 2];
export const REGULAR_PLAYBACK_RATE = 1;

export function getActivePlaybackRate(playbackRate: number, isPlaybackRateActive?: boolean) {
  return isPlaybackRateActive ? playbackRate : REGULAR_PLAYBACK_RATE;
}

export function getNextPlaybackRate(currentRate: number) {
  // Rates saved by older versions (1.4, 1.8) continue from the closest step
  const index = PLAYBACK_RATE_STEPS.findIndex((rate) => rate >= currentRate - 0.11);
  const nextIndex = index === -1 ? 0 : (index + 1) % PLAYBACK_RATE_STEPS.length;
  return PLAYBACK_RATE_STEPS[nextIndex];
}

export function formatPlaybackRate(rate: number) {
  return `${rate}X`;
}
