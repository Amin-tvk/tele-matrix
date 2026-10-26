import type { ApiFormattedText, ApiMessageEntity } from '../types';
import { ApiMessageEntityTypes } from '../types';

// Converts between Telegram-style text entities and Matrix `org.matrix.custom.html` bodies.
// Runs inside a worker, where `DOMParser` is unavailable, so HTML is tokenized manually

const MATRIX_TO_USER_RE = /^https:\/\/matrix\.to\/#\/(@[^/?#]+)/;
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre']);
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
};

type PeerResolver = (userId: string) => string | undefined;

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    }
    if (code.startsWith('#')) {
      return String.fromCodePoint(parseInt(code.slice(1), 10));
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function parseAttributes(source: string) {
  const attributes: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

type OpenTag = {
  tag: string;
  start: number;
  entity?: Omit<ApiMessageEntity, 'offset' | 'length'>;
  listCounter?: number;
};

export function parseHtmlToFormattedText(html: string, resolvePeerId?: PeerResolver): ApiFormattedText {
  // Reply fallbacks are not part of the message
  const source = html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/gi, '');
  const tokenRe = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)|</g;

  let text = '';
  const entities: ApiMessageEntity[] = [];
  const stack: OpenTag[] = [];
  let preDepth = 0;

  function ensureLineBreak() {
    if (text.length && !text.endsWith('\n')) {
      text += '\n';
    }
  }

  function closeTag(tag: string) {
    const index = stack.map((item) => item.tag).lastIndexOf(tag);
    if (index === -1) return;

    const closed = stack.splice(index);
    closed.reverse().forEach((item) => {
      if (item.tag === 'pre') preDepth--;
      if (item.entity) {
        let end = text.length;
        // Block-level entities should not include the trailing newline
        while (end > item.start && text[end - 1] === '\n' && BLOCK_TAGS.has(item.tag)) end--;
        if (end > item.start) {
          entities.push({ ...item.entity, offset: item.start, length: end - item.start } as ApiMessageEntity);
        }
      }
    });

    if (BLOCK_TAGS.has(tag)) ensureLineBreak();
  }

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(source))) {
    const [token, rawTag, rawAttributes, rawText] = match;

    if (rawText !== undefined || token === '<') {
      let chunk = decodeEntities(rawText ?? token);
      if (!preDepth) chunk = chunk.replace(/\n/g, '');
      text += chunk;
      continue;
    }
    if (!rawTag) continue;

    const tag = rawTag.toLowerCase();
    const isClosing = token.startsWith('</');

    if (isClosing) {
      closeTag(tag);
      continue;
    }

    const attributes = parseAttributes(rawAttributes || '');

    if (tag === 'br') {
      text += '\n';
      continue;
    }
    if (tag === 'hr') {
      ensureLineBreak();
      text += '———\n';
      continue;
    }
    if (tag === 'img') {
      text += attributes.alt || attributes.title || '';
      continue;
    }

    if (BLOCK_TAGS.has(tag)) ensureLineBreak();

    let entity: OpenTag['entity'];
    switch (tag) {
      case 'b':
      case 'strong':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        entity = { type: ApiMessageEntityTypes.Bold };
        break;
      case 'i':
      case 'em':
        entity = { type: ApiMessageEntityTypes.Italic };
        break;
      case 'u':
        entity = { type: ApiMessageEntityTypes.Underline };
        break;
      case 's':
      case 'del':
      case 'strike':
        entity = { type: ApiMessageEntityTypes.Strike };
        break;
      case 'code':
        if (!stack.some((item) => item.tag === 'pre')) {
          entity = { type: ApiMessageEntityTypes.Code };
        } else {
          const language = attributes.class?.match(/language-([\w+#-]+)/)?.[1];
          const pre = stack.findLast((item) => item.tag === 'pre');
          if (pre?.entity && language) {
            (pre.entity as { language?: string }).language = language;
          }
        }
        break;
      case 'pre':
        preDepth++;
        entity = { type: ApiMessageEntityTypes.Pre };
        break;
      case 'blockquote':
        entity = { type: ApiMessageEntityTypes.Blockquote };
        break;
      case 'a': {
        const href = attributes.href || '';
        const userMatch = href.match(MATRIX_TO_USER_RE);
        const peerId = userMatch && resolvePeerId?.(decodeURIComponent(userMatch[1]));
        if (peerId) {
          entity = { type: ApiMessageEntityTypes.MentionName, userId: peerId } as OpenTag['entity'];
        } else if (/^(https?|mailto|tel):/i.test(href)) {
          entity = { type: ApiMessageEntityTypes.TextUrl, url: href } as OpenTag['entity'];
        }
        break;
      }
      case 'span':
      case 'font':
        if ('data-mx-spoiler' in attributes) {
          entity = { type: ApiMessageEntityTypes.Spoiler };
        }
        break;
      case 'li': {
        const list = stack.findLast((item) => item.tag === 'ol' || item.tag === 'ul');
        if (list?.tag === 'ol') {
          list.listCounter = (list.listCounter || 0) + 1;
          text += `${list.listCounter}. `;
        } else {
          text += '• ';
        }
        break;
      }
      case 'ol':
        stack.push({ tag, start: text.length, listCounter: Number(attributes.start || 1) - 1 });
        continue;
    }

    if (VOID_TAGS.has(tag) || token.endsWith('/>')) continue;
    stack.push({ tag, start: text.length, entity });
  }

  while (stack.length) {
    closeTag(stack[stack.length - 1].tag);
  }

  // Trim trailing whitespace produced by block elements
  const trimmedText = text.replace(/\s+$/, '');
  const resultEntities = entities
    .map((entity) => ({
      ...entity,
      length: Math.min(entity.length, trimmedText.length - entity.offset),
    }))
    .filter((entity) => entity.length > 0)
    .sort((a, b) => a.offset - b.offset);

  return {
    text: trimmedText,
    entities: resultEntities.length ? resultEntities : undefined,
  };
}

type TagPair = { open: string; close: string };

function getEntityTags(entity: ApiMessageEntity, resolveUserId?: (peerId: string) => string | undefined): TagPair | undefined {
  switch (entity.type) {
    case ApiMessageEntityTypes.Bold:
      return { open: '<strong>', close: '</strong>' };
    case ApiMessageEntityTypes.Italic:
      return { open: '<em>', close: '</em>' };
    case ApiMessageEntityTypes.Underline:
      return { open: '<u>', close: '</u>' };
    case ApiMessageEntityTypes.Strike:
      return { open: '<del>', close: '</del>' };
    case ApiMessageEntityTypes.Code:
      return { open: '<code>', close: '</code>' };
    case ApiMessageEntityTypes.Pre:
      return {
        open: `<pre><code${entity.language ? ` class="language-${escapeHtml(entity.language)}"` : ''}>`,
        close: '</code></pre>',
      };
    case ApiMessageEntityTypes.Blockquote:
      return { open: '<blockquote>', close: '</blockquote>' };
    case ApiMessageEntityTypes.Spoiler:
      return { open: '<span data-mx-spoiler>', close: '</span>' };
    case ApiMessageEntityTypes.TextUrl:
      return { open: `<a href="${escapeHtml(entity.url)}">`, close: '</a>' };
    case ApiMessageEntityTypes.MentionName: {
      const userId = resolveUserId?.(entity.userId);
      return userId
        ? { open: `<a href="https://matrix.to/#/${escapeHtml(userId)}">`, close: '</a>' }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function buildHtmlFromFormattedText(
  { text, entities }: ApiFormattedText,
  resolveUserId?: (peerId: string) => string | undefined,
) {
  const tagged = (entities || [])
    .map((entity) => ({ entity, tags: getEntityTags(entity, resolveUserId) }))
    .filter((item): item is { entity: ApiMessageEntity; tags: TagPair } => Boolean(item.tags));

  if (!tagged.length) return undefined;

  const boundaries = new Set<number>([0, text.length]);
  tagged.forEach(({ entity }) => {
    boundaries.add(entity.offset);
    boundaries.add(Math.min(entity.offset + entity.length, text.length));
  });
  const points = [...boundaries].sort((a, b) => a - b);

  let html = '';
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const active = tagged
      .filter(({ entity }) => entity.offset <= start && entity.offset + entity.length >= end)
      // Outer (longer) entities first
      .sort((a, b) => b.entity.length - a.entity.length || a.entity.offset - b.entity.offset);

    const segment = escapeHtml(text.slice(start, end));
    const isInsidePre = active.some(({ entity }) => entity.type === ApiMessageEntityTypes.Pre);
    const content = isInsidePre ? segment : segment.replace(/\n/g, '<br>');
    html += active.map(({ tags }) => tags.open).join('')
      + content
      + active.slice().reverse().map(({ tags }) => tags.close).join('');
  }

  // Adjacent identical tags produced by segmentation are merged for cleaner output
  let previous: string;
  do {
    previous = html;
    html = html.replace(/<\/(strong|em|u|del|code)><\1>/g, '');
  } while (html !== previous);

  return html;
}

export function stripReplyFallback(body: string) {
  const lines = body.split('\n');
  let index = 0;
  while (index < lines.length && lines[index].startsWith('> ')) index++;
  if (index > 0 && lines[index] === '') {
    return lines.slice(index + 1).join('\n');
  }
  return body;
}
