import type { MatrixEvent } from 'matrix-js-sdk';

import type { ApiChatFolder } from '../types';

import { ALL_FOLDER_ID } from '../../config';
import { buildCollectionByKey } from '../../util/iteratees';
import { getClient, onUpdate, waitForSync } from './client';
import { FOLDERS_EVENT } from './constants';

// Chat folders live in the account data, so they follow the user to every device

type StoredFolders = {
  folders: ApiChatFolder[];
  orderedIds: number[];
  areTagsEnabled?: boolean;
};

let lastSyncedFolders: StoredFolders | undefined;

function readStoredFolders(): StoredFolders {
  const event = getClient().getAccountData(FOLDERS_EVENT as never);
  const content = event?.getContent<Partial<StoredFolders>>();
  const folders = Array.isArray(content?.folders) ? content.folders : [];
  const orderedIds = Array.isArray(content?.orderedIds) ? content.orderedIds : folders.map(({ id }) => id);
  return { folders, orderedIds, areTagsEnabled: Boolean(content?.areTagsEnabled) };
}

async function writeStoredFolders(stored: StoredFolders) {
  lastSyncedFolders = stored;
  await getClient().setAccountData(FOLDERS_EVENT as never, stored as never);
}

function buildResult({ folders, orderedIds, areTagsEnabled }: StoredFolders) {
  const ids = orderedIds.includes(ALL_FOLDER_ID) ? orderedIds : [ALL_FOLDER_ID, ...orderedIds];
  return {
    byId: buildCollectionByKey(folders, 'id') as Record<number, ApiChatFolder>,
    orderedIds: ids.filter((id) => id === ALL_FOLDER_ID || folders.some((folder) => folder.id === id)),
    areTagsEnabled,
  };
}

export async function fetchChatFolders() {
  await waitForSync();
  lastSyncedFolders = readStoredFolders();
  return buildResult(lastSyncedFolders);
}

export function fetchRecommendedChatFolders() {
  return Promise.resolve([] as ApiChatFolder[]);
}

export async function editChatFolder({ id, folderUpdate }: { id: number; folderUpdate: ApiChatFolder }) {
  const stored = readStoredFolders();
  const folder = {
    ...folderUpdate,
    id,
    excludedChatIds: folderUpdate.excludedChatIds.filter((chatId) => !folderUpdate.includedChatIds.includes(chatId)),
  };
  const isNew = !stored.folders.some((item) => item.id === id);
  await writeStoredFolders({
    ...stored,
    folders: isNew ? [...stored.folders, folder] : stored.folders.map((item) => (item.id === id ? folder : item)),
    orderedIds: isNew ? [...stored.orderedIds, id] : stored.orderedIds,
  });
  onUpdate({ '@type': 'updateChatFolder', id, folder });
  return true;
}

export async function deleteChatFolder(id: number) {
  const stored = readStoredFolders();
  await writeStoredFolders({
    ...stored,
    folders: stored.folders.filter((folder) => folder.id !== id),
    orderedIds: stored.orderedIds.filter((folderId) => folderId !== id),
  });
  onUpdate({ '@type': 'updateChatFolder', id, folder: undefined });
}

export async function sortChatFolders(ids: number[]) {
  await writeStoredFolders({ ...readStoredFolders(), orderedIds: ids });
  return true;
}

export async function toggleDialogFilterTags(isEnabled: boolean) {
  await writeStoredFolders({ ...readStoredFolders(), areTagsEnabled: isEnabled });
  return true;
}

// Applies folder changes made on another device
export function handleFoldersAccountData(event: MatrixEvent) {
  if (event.getType() !== FOLDERS_EVENT) return;
  const next = readStoredFolders();
  const previous = lastSyncedFolders;
  lastSyncedFolders = next;
  if (!previous || JSON.stringify(previous) === JSON.stringify(next)) return;

  next.folders.forEach((folder) => {
    const old = previous.folders.find(({ id }) => id === folder.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(folder)) {
      onUpdate({ '@type': 'updateChatFolder', id: folder.id, folder });
    }
  });
  previous.folders.forEach(({ id }) => {
    if (!next.folders.some((folder) => folder.id === id)) {
      onUpdate({ '@type': 'updateChatFolder', id, folder: undefined });
    }
  });
  onUpdate({ '@type': 'updateChatFoldersOrder', orderedIds: buildResult(next).orderedIds });
}
