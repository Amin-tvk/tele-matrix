import type { MatrixEvent, Room } from 'matrix-js-sdk';
import { RelationType } from 'matrix-js-sdk';

import type {
  ApiFormattedText, ApiMediaTodo, ApiNewMediaTodo, ApiTodoCompletion, ApiTodoItem,
} from '../types';

// Checklists travel as regular text messages, so other Matrix apps show them as a plain list. The list itself
// is kept under a custom key, and ticking or adding items is sent as events that reference the message

export const TODO_KEY = 'im.peyvand.todo';
export const TODO_UPDATE_EVENT = 'im.peyvand.todo.update';

type StoredTodo = {
  title: ApiFormattedText;
  items: ApiTodoItem[];
  others_can_append?: boolean;
  others_can_complete?: boolean;
};

type TodoUpdateContent = {
  completed?: number[];
  incompleted?: number[];
  append?: ApiTodoItem[];
};

function isFormattedText(value: unknown): value is ApiFormattedText {
  return Boolean(value) && typeof (value as ApiFormattedText).text === 'string';
}

function isTodoItem(value: unknown): value is ApiTodoItem {
  const item = value as ApiTodoItem | undefined;
  return Boolean(item) && typeof item.id === 'number' && isFormattedText(item.title);
}

export function buildTodoContent({ todo }: ApiNewMediaTodo) {
  const stored: StoredTodo = {
    title: todo.title,
    items: todo.items,
    others_can_append: todo.othersCanAppend || undefined,
    others_can_complete: todo.othersCanComplete || undefined,
  };
  const body = [`☑️ ${todo.title.text}`, ...todo.items.map((item) => `☐ ${item.title.text}`)].join('\n');

  return {
    msgtype: 'm.text',
    body,
    [TODO_KEY]: stored,
  };
}

export function buildTodoUpdateContent(eventId: string, update: TodoUpdateContent) {
  return {
    ...update,
    'm.relates_to': { rel_type: RelationType.Reference, event_id: eventId },
  };
}

export function buildTodoMedia(
  room: Room, event: MatrixEvent, resolvePeerId: (userId: string) => string,
): ApiMediaTodo | undefined {
  const stored = event.getContent()[TODO_KEY] as StoredTodo | undefined;
  if (!stored || !isFormattedText(stored.title) || !Array.isArray(stored.items)) return undefined;

  const author = event.getSender();
  const othersCanAppend = Boolean(stored.others_can_append);
  const othersCanComplete = Boolean(stored.others_can_complete);
  const items = stored.items.filter(isTodoItem);
  const completions = new Map<number, ApiTodoCompletion>();

  const updates = room.relations.getChildEventsForEvent(event.getId()!, RelationType.Reference, TODO_UPDATE_EVENT)
    ?.getRelations()
    .filter((update) => !update.isRedacted())
    .sort((a, b) => a.getTs() - b.getTs()) || [];

  updates.forEach((update) => {
    const sender = update.getSender()!;
    const isAuthor = sender === author;
    const { completed, incompleted, append } = update.getContent<TodoUpdateContent>();

    if (Array.isArray(append) && (isAuthor || othersCanAppend)) {
      append.filter(isTodoItem).forEach((item) => {
        if (!items.some(({ id }) => id === item.id)) items.push(item);
      });
    }

    if (!isAuthor && !othersCanComplete) return;
    if (Array.isArray(completed)) {
      completed.forEach((itemId) => {
        completions.set(itemId, {
          itemId,
          completedBy: resolvePeerId(sender),
          completedAt: Math.floor(update.getTs() / 1000),
        });
      });
    }
    if (Array.isArray(incompleted)) {
      incompleted.forEach((itemId) => completions.delete(itemId));
    }
  });

  return {
    mediaType: 'todo',
    todo: {
      title: stored.title,
      items,
      othersCanAppend: othersCanAppend || undefined,
      othersCanComplete: othersCanComplete || undefined,
    },
    completions: [...completions.values()].filter(({ itemId }) => items.some(({ id }) => id === itemId)),
  };
}
