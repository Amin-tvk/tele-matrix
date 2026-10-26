import type { MediaContent } from '../../api/types';
import { ApiMessageEntityTypes } from '../../api/types';

import parseEmojiOnlyString from '../../util/emoji/parseEmojiOnlyString';

// Like the Telegram mobile apps, only short emoji messages are enlarged; longer ones stay in a regular bubble
export const MAX_ENLARGED_EMOJI_COUNT = 3;

export function getEmojiOnlyCountForMessage(content: MediaContent, groupedId?: string): number | undefined {
  if (!content.text) return undefined;
  const count = (
    !groupedId
    && Object.keys(content).length === 1 // Only text is present
    && !content.text.entities?.some((entity) => entity.type !== ApiMessageEntityTypes.CustomEmoji)
    && parseEmojiOnlyString(content.text.text)
  ) || undefined;
  return count && count <= MAX_ENLARGED_EMOJI_COUNT ? count : undefined;
}
