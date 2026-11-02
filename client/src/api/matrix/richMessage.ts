import type {
  ApiInputRichMessage, ApiPageBlock, ApiPageCaption, ApiRichMessage, ApiRichText,
} from '../types';

import { omitUndefined } from '../../util/iteratees';
import { setValue } from './store';

// Articles (Telegram's rich messages) travel as regular text messages, so other Matrix apps show the text and a
// simple formatted version. The blocks themselves are kept under a custom key, along with the Matrix content of
// every picture, video or file in them, so the receiving app can load and decrypt that media

export const RICH_MESSAGE_KEY = 'im.peyvand.rich_message';

type StoredRichMessage = {
  blocks: ApiPageBlock[];
  is_rtl?: boolean;
  media?: Record<string, Record<string, unknown>>;
};

// A Matrix event can't be larger than 64 KB; the formatted copy for other apps goes first when it gets close
const MAX_CONTENT_BYTES = 60000;
const MEDIA_TYPES = new Set(['photo', 'video', 'audio', 'document']);

// Media put into an article on this device: its ID in the article -> the Matrix content it was uploaded as
const uploadedMedia = new Map<string, Record<string, unknown>>();

export function rememberRichMedia(mediaId: string, content: Record<string, unknown>) {
  uploadedMedia.set(mediaId, content);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

// Telegram's article editor refers to media by a 64-bit number, while Matrix media IDs are text. Each one gets a
// number made from its ID, the same on every device, and loading media looks the number up (see media.ts)
export function getRichMediaAlias(mediaId: string) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < mediaId.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(mediaId.charCodeAt(i))) * FNV_PRIME);
  }
  const alias = (BigInt.asUintN(63, hash) || 1n).toString();
  setValue(`a:${alias}`, mediaId);
  return alias;
}

function collectMedia(value: unknown, found: Record<string, Record<string, unknown>>) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMedia(item, found));
    return;
  }
  const { mediaType, id } = value as { mediaType?: string; id?: string };
  if (mediaType && id && MEDIA_TYPES.has(mediaType) && uploadedMedia.has(id)) {
    found[id] = uploadedMedia.get(id)!;
  }
  Object.values(value).forEach((child) => collectMedia(child, found));
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toPlain(text: ApiRichText | undefined): string {
  if (!text) return '';
  switch (text.type) {
    case 'empty':
    case 'image':
      return '';
    case 'plain':
      return text.text;
    case 'concat':
      return text.texts.map(toPlain).join('');
    case 'math':
      return text.source;
    case 'customEmoji':
      return text.alt;
    default:
      return 'text' in text ? toPlain(text.text as ApiRichText) : '';
  }
}

function toHtml(text: ApiRichText | undefined): string {
  if (!text) return '';
  switch (text.type) {
    case 'plain':
      return escapeHtml(text.text).replace(/\n/g, '<br>');
    case 'concat':
      return text.texts.map(toHtml).join('');
    case 'bold':
      return `<b>${toHtml(text.text)}</b>`;
    case 'italic':
      return `<i>${toHtml(text.text)}</i>`;
    case 'underline':
      return `<u>${toHtml(text.text)}</u>`;
    case 'strike':
      return `<s>${toHtml(text.text)}</s>`;
    case 'fixed':
      return `<code>${toHtml(text.text)}</code>`;
    case 'url':
      return `<a href="${escapeHtml(text.url)}">${toHtml(text.text)}</a>`;
    case 'spoiler':
      return `<span data-mx-spoiler>${toHtml(text.text)}</span>`;
    default:
      return escapeHtml(toPlain(text));
  }
}

function captionText(caption: ApiPageCaption | ApiRichText | undefined) {
  if (!caption) return undefined;
  return 'type' in caption ? caption : caption.text;
}

const MEDIA_LABELS: Record<string, string> = {
  photo: 'Photo', video: 'Video', audio: 'Audio', document: 'File',
};
const HEADING_TAGS: Record<string, string> = {
  title: 'h2', heading1: 'h2', header: 'h3', heading2: 'h3', subtitle: 'h4', subheader: 'h4', heading3: 'h4',
  heading4: 'h5', heading5: 'h6', heading6: 'h6',
};

// One line of text and one piece of HTML per block, for apps that don't know articles
function renderBlock(block: ApiPageBlock, lines: string[], html: string[]) {
  switch (block.type) {
    case 'list':
    case 'orderedList': {
      const tag = block.type === 'list' ? 'ul' : 'ol';
      html.push(`<${tag}>`);
      block.items.forEach((item, index) => {
        const marker = block.type === 'list' ? '•' : `${index + 1}.`;
        if (item.type === 'text') {
          lines.push(`${marker} ${toPlain(item.text)}`);
          html.push(`<li>${toHtml(item.text)}</li>`);
        } else {
          const itemLines: string[] = [];
          const itemHtml: string[] = [];
          item.blocks.forEach((child) => renderBlock(child, itemLines, itemHtml));
          lines.push(`${marker} ${itemLines.join(' ')}`);
          html.push(`<li>${itemHtml.join('')}</li>`);
        }
      });
      html.push(`</${tag}>`);
      return;
    }
    case 'blockquote':
    case 'pullquote':
      lines.push(`> ${toPlain(block.text)}`);
      html.push(`<blockquote>${toHtml(block.text)}</blockquote>`);
      return;
    case 'blockquoteBlocks': {
      const quoteLines: string[] = [];
      const quoteHtml: string[] = [];
      block.blocks.forEach((child) => renderBlock(child, quoteLines, quoteHtml));
      lines.push(...quoteLines.map((line) => `> ${line}`));
      html.push(`<blockquote>${quoteHtml.join('')}</blockquote>`);
      return;
    }
    case 'preformatted':
      lines.push(toPlain(block.text));
      html.push(`<pre><code>${escapeHtml(toPlain(block.text))}</code></pre>`);
      return;
    case 'divider':
      lines.push('———');
      html.push('<hr>');
      return;
    case 'photo':
    case 'video':
    case 'audio':
    case 'document': {
      const caption = toPlain(captionText(block.caption));
      const label = `[${MEDIA_LABELS[block.type]}]${caption ? ` ${caption}` : ''}`;
      lines.push(label);
      html.push(`<p>${escapeHtml(label)}</p>`);
      return;
    }
    case 'cover':
      renderBlock(block.cover, lines, html);
      return;
    case 'collage':
    case 'slideshow':
      block.items.forEach((child) => renderBlock(child, lines, html));
      return;
    case 'details':
      lines.push(toPlain(block.title));
      html.push(`<details><summary>${toHtml(block.title)}</summary>`);
      block.blocks.forEach((child) => renderBlock(child, lines, html));
      html.push('</details>');
      return;
    case 'table':
      html.push('<table>');
      block.rows.forEach((row) => {
        lines.push(row.cells.map((cell) => toPlain(cell.text)).join(' | '));
        html.push(`<tr>${row.cells.map((cell) => `<td>${toHtml(cell.text)}</td>`).join('')}</tr>`);
      });
      html.push('</table>');
      return;
    case 'math':
      lines.push(block.source);
      html.push(`<p><code>${escapeHtml(block.source)}</code></p>`);
      return;
    default: {
      const text = 'text' in block ? block.text as ApiRichText : undefined;
      if (!text) return;
      const tag = HEADING_TAGS[block.type] || 'p';
      lines.push(toPlain(text));
      html.push(`<${tag}>${toHtml(text)}</${tag}>`);
    }
  }
}

export function buildRichMessageContent(richMessage: ApiInputRichMessage) {
  const lines: string[] = [];
  const html: string[] = [];
  richMessage.blocks.forEach((block) => renderBlock(block, lines, html));

  const media: Record<string, Record<string, unknown>> = {};
  collectMedia(richMessage.blocks, media);
  // Previews made on this device (blob addresses) mean nothing elsewhere
  const blocks = JSON.parse(JSON.stringify(richMessage.blocks, (key, value) => (
    key === 'blobUrl' || key === 'previewBlobUrl' || key === 'thumbnail' ? undefined : value
  ))) as ApiPageBlock[];
  const stored: StoredRichMessage = omitUndefined({
    blocks,
    is_rtl: richMessage.isRtl || undefined,
    media: Object.keys(media).length ? media : undefined,
  });

  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body: lines.join('\n').trim() || 'Article',
    format: 'org.matrix.custom.html',
    formatted_body: html.join(''),
    [RICH_MESSAGE_KEY]: stored,
  };
  const size = () => new TextEncoder().encode(JSON.stringify(content)).length;
  if (size() > MAX_CONTENT_BYTES) {
    delete content.format;
    delete content.formatted_body;
  }
  if (size() > MAX_CONTENT_BYTES) throw new Error('The article is too long');
  return content;
}

export function readRichMessage(
  content: Record<string, unknown>, registerMedia: (mediaContent: Record<string, unknown>) => string | undefined,
): ApiRichMessage | undefined {
  const stored = content[RICH_MESSAGE_KEY] as StoredRichMessage | undefined;
  if (!stored || !Array.isArray(stored.blocks)) return undefined;
  // The media is looked up by these IDs when it loads, and an encrypted file needs its keys known first
  Object.values(stored.media || {}).forEach((mediaContent) => {
    if (!mediaContent || typeof mediaContent !== 'object') return;
    const mediaId = registerMedia(mediaContent);
    if (mediaId) getRichMediaAlias(mediaId);
  });
  return omitUndefined<ApiRichMessage>({ blocks: stored.blocks, isRtl: stored.is_rtl ? true : undefined });
}
