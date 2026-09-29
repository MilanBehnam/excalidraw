// Collections: named, shareable groups of drawings. Each file is a collab room
// (room id = file id) encrypted with the collection key, so opening a file is
// just joining that room. Names are encrypted too; the key lives in the
// `#collection=<id>,<key>` link and in this browser's storage.

import {
  decryptData,
  encryptData,
  generateEncryptionKey,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { isInitializedImageElement, newElementWith } from "@excalidraw/element";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";
import { FILE_UPLOAD_MAX_BYTES, STORAGE_KEYS } from "../app_constants";
import { getSyncableElements } from "../data";
import {
  backendFetch,
  saveFilesToBackend,
  saveSceneElements,
} from "../data/backend";
import { encodeFilesForUpload } from "../data/FileManager";

import type { CollabAPI } from "../collab/Collab";

export const COLLECTIONS_SIDEBAR_TAB = "collections";

/** a collection this browser knows about; `name` is a cache for display */
export type SavedCollection = { id: string; key: string; name: string };
export type CollectionFile = { id: string; name: string };

// links
// -----------------------------------------------------------------------------

const RE_COLLECTION_LINK = /^#collection=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]{22})$/;

export const getCollectionLink = (collection: { id: string; key: string }) =>
  `${window.location.origin}${window.location.pathname}#collection=${collection.id},${collection.key}`;

// my collections (browser storage)
// -----------------------------------------------------------------------------

const loadSavedCollections = (): SavedCollection[] => {
  try {
    return (
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_COLLECTIONS) || "[]",
      ) || []
    );
  } catch {
    return [];
  }
};

export const savedCollectionsAtom = atom(loadSavedCollections());

export const setSavedCollections = (collections: SavedCollection[]) => {
  appJotaiStore.set(savedCollectionsAtom, collections);
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_COLLECTIONS,
      JSON.stringify(collections),
    );
  } catch (error: any) {
    console.error(error);
  }
};

const addSavedCollection = (collection: SavedCollection) => {
  const collections = appJotaiStore.get(savedCollectionsAtom);
  if (!collections.some((c) => c.id === collection.id)) {
    setSavedCollections([collection, ...collections]);
  }
};

export const forgetCollection = (id: string) =>
  setSavedCollections(
    appJotaiStore.get(savedCollectionsAtom).filter((c) => c.id !== id),
  );

/**
 * Adds the collection from a `#collection=` link to "my collections".
 * Returns whether the current URL was such a link.
 */
export const importCollectionFromLink = () => {
  const match = window.location.hash.match(RE_COLLECTION_LINK);
  if (match) {
    addSavedCollection({ id: match[1], key: match[2], name: "" });
  }
  return !!match;
};

/** friends see this name next to your cursor */
export const ensureUsername = (collabAPI: CollabAPI | null) => {
  if (collabAPI && !collabAPI.getUsername()) {
    const username = window
      .prompt("Your name (friends will see it next to your cursor):")
      ?.trim();
    if (username) {
      collabAPI.setUsername(username);
    }
  }
};

// encrypted names
// -----------------------------------------------------------------------------

const encryptName = async (key: string, name: string) => {
  const { encryptedBuffer, iv } = await encryptData(
    key,
    new TextEncoder().encode(name),
  );
  const bytes = new Uint8Array([...iv, ...new Uint8Array(encryptedBuffer)]);
  return btoa(String.fromCharCode(...bytes));
};

const decryptName = async (key: string, encrypted: string) => {
  try {
    const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const decrypted = await decryptData(
      bytes.slice(0, IV_LENGTH_BYTES),
      bytes.slice(IV_LENGTH_BYTES),
      key,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "(unreadable)";
  }
};

// api
// -----------------------------------------------------------------------------

const request = async (path: string, method: string, name?: string) => {
  const res = await backendFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: name === undefined ? undefined : JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return res;
};

export const createCollection = async (name: string) => {
  const key = await generateEncryptionKey();
  const res = await request(
    "collections",
    "POST",
    await encryptName(key, name),
  );
  const { id } = await res.json();
  addSavedCollection({ id, key, name });
};

/** null if the collection was deleted */
export const fetchCollection = async ({ id, key }: SavedCollection) => {
  const res = await backendFetch(`collections/${id}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  const data: { name: string; files: CollectionFile[] } = await res.json();
  return {
    name: await decryptName(key, data.name),
    files: await Promise.all(
      data.files.map(async (file) => ({
        id: file.id,
        name: await decryptName(key, file.name),
      })),
    ),
  };
};

export const renameCollection = async (
  collection: SavedCollection,
  name: string,
) =>
  request(
    `collections/${collection.id}`,
    "PATCH",
    await encryptName(collection.key, name),
  );

export const deleteCollection = async (collection: SavedCollection) => {
  await request(`collections/${collection.id}`, "DELETE");
  forgetCollection(collection.id);
};

export const createFile = async (
  collection: SavedCollection,
  name: string,
): Promise<string> => {
  const res = await request(
    `collections/${collection.id}/files`,
    "POST",
    await encryptName(collection.key, name),
  );
  return (await res.json()).id;
};

export const renameFile = async (
  collection: SavedCollection,
  fileId: string,
  name: string,
) =>
  request(
    `collections/${collection.id}/files/${fileId}`,
    "PATCH",
    await encryptName(collection.key, name),
  );

export const deleteFile = (collection: SavedCollection, fileId: string) =>
  request(`collections/${collection.id}/files/${fileId}`, "DELETE");

/** copies what's on the canvas (incl. images) into a collection file */
export const saveDrawingToFile = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  collection: SavedCollection,
  fileId: string,
) => {
  const files = excalidrawAPI.getFiles();
  const elements = getSyncableElements(excalidrawAPI.getSceneElements());

  const usedFiles = new Map<FileId, BinaryFileData>();
  for (const element of elements) {
    if (isInitializedImageElement(element) && files[element.fileId]) {
      usedFiles.set(element.fileId, files[element.fileId]);
    }
  }
  const { savedFiles } = await saveFilesToBackend(
    fileId,
    await encodeFilesForUpload({
      files: usedFiles,
      encryptionKey: collection.key,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    }),
  );

  await saveSceneElements(
    fileId,
    collection.key,
    getSyncableElements(
      elements.map((element) =>
        isInitializedImageElement(element) &&
        savedFiles.includes(element.fileId)
          ? // tells collaborators to fetch the image from the backend
            newElementWith(element, { status: "saved" })
          : element,
      ),
    ),
    excalidrawAPI.getAppState(),
  );
};
