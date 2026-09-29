// Client for our own collab backend (backend/server.ts): collab room scenes
// and images, stored end-to-end encrypted.

import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// http
// -----------------------------------------------------------------------------

// the socket server and the HTTP API are the same backend
const BACKEND_URL = new URL(
  import.meta.env.VITE_APP_WS_SERVER_URL,
  window.location.href,
);

const getPasscode = () => {
  try {
    return localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_BACKEND_PASSCODE);
  } catch {
    return null;
  }
};

/**
 * fetch against the backend. The server asks for a passcode (401) only when
 * creating new collections/rooms, in which case we prompt once and remember it.
 */
export const backendFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const send = (passcode: string | null) =>
    fetch(new URL(`api/${path}`, BACKEND_URL), {
      ...init,
      headers: {
        ...init.headers,
        ...(passcode ? { "x-passcode": passcode } : {}),
      },
    });

  const res = await send(getPasscode());
  if (res.status !== 401) {
    return res;
  }
  const input = window
    .prompt("This server needs a passcode to create new collections and rooms:")
    ?.trim();
  if (!input) {
    throw new Error("A server passcode is required for this");
  }
  const retry = await send(input);
  if (retry.status === 401) {
    throw new Error("Wrong server passcode");
  }
  // remember it only once the server accepted it
  try {
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_BACKEND_PASSCODE, input);
  } catch {}
  return retry;
};

export const MAX_BACKEND_BYTES = 5 * 1024 * 1024;

// scenes
// -----------------------------------------------------------------------------

/** iv + ciphertext */
const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
) => {
  const { encryptedBuffer, iv } = await encryptData(
    key,
    new TextEncoder().encode(JSON.stringify(elements)),
  );
  const blob = new Uint8Array(IV_LENGTH_BYTES + encryptedBuffer.byteLength);
  blob.set(iv);
  blob.set(new Uint8Array(encryptedBuffer), IV_LENGTH_BYTES);
  return blob;
};

const decryptElements = async (
  blob: ArrayBuffer,
  key: string,
): Promise<readonly ExcalidrawElement[]> => {
  const decrypted = await decryptData(
    new Uint8Array(blob, 0, IV_LENGTH_BYTES),
    new Uint8Array(blob, IV_LENGTH_BYTES),
    key,
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
};

class SceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => SceneVersionCache.cache.get(socket);
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    SceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToBackend = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    return SceneVersionCache.get(portal.socket) === getSceneVersion(elements);
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

/**
 * Merges `elements` into the stored scene and saves the result. Retries when
 * someone else saved in between (the server rejects stale revisions).
 */
export const saveSceneElements = async (
  roomId: string,
  roomKey: string,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
): Promise<readonly SyncableExcalidrawElement[]> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await backendFetch(`scenes/${roomId}`);
    let rev = '"0"';
    let toStore = elements;
    if (res.ok) {
      rev = res.headers.get("etag") || rev;
      const storedElements = getSyncableElements(
        restoreElements(
          await decryptElements(await res.arrayBuffer(), roomKey),
          null,
        ),
      );
      toStore = getSyncableElements(
        reconcileElements(
          elements,
          storedElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    } else if (res.status !== 404) {
      throw new Error(`Loading scene failed (${res.status})`);
    }

    const put = await backendFetch(`scenes/${roomId}`, {
      method: "PUT",
      headers: { "if-match": rev },
      body: await encryptElements(roomKey, toStore),
    });
    if (put.ok) {
      return toStore;
    }
    if (put.status === 413) {
      // matched by Collab to show the "scene too big" message
      throw new Error(`Scene is longer than ${MAX_BACKEND_BYTES} bytes`);
    }
    if (put.status !== 412) {
      throw new Error(`Saving scene failed (${put.status})`);
    }
  }
  throw new Error("Saving scene failed: too many concurrent changes");
};

export const saveScene = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToBackend(portal, elements)
  ) {
    return null;
  }

  const storedElements = await saveSceneElements(
    roomId,
    roomKey,
    elements,
    appState,
  );
  SceneVersionCache.set(socket, storedElements);
  return toBrandedType<RemoteExcalidrawElement[]>([...storedElements]);
};

export const loadScene = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const res = await backendFetch(`scenes/${roomId}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`Loading scene failed (${res.status})`);
  }
  const elements = getSyncableElements(
    restoreElements(
      await decryptElements(await res.arrayBuffer(), roomKey),
      null,
      { deleteInvisibleElements: true },
    ),
  );
  if (socket) {
    SceneVersionCache.set(socket, elements);
  }
  return elements;
};

// images
// -----------------------------------------------------------------------------

export const saveFilesToBackend = async (
  roomId: string,
  files: { id: FileId; buffer: Uint8Array }[],
) => {
  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const res = await backendFetch(`files/${roomId}/${id}`, {
          method: "PUT",
          body: buffer as Uint8Array<ArrayBuffer>,
        });
        (res.ok ? savedFiles : erroredFiles).push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const loadFilesFromBackend = async (
  roomId: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const res = await backendFetch(`files/${roomId}/${id}`);
        if (!res.ok) {
          erroredFiles.set(id, true);
          return;
        }
        const { data, metadata } = await decompressData<BinaryFileMetadata>(
          new Uint8Array(await res.arrayBuffer()),
          { decryptionKey },
        );
        loadedFiles.push({
          mimeType: metadata.mimeType || MIME_TYPES.binary,
          id,
          dataURL: new TextDecoder().decode(data) as DataURL,
          created: metadata?.created || Date.now(),
          lastRetrieved: metadata?.created || Date.now(),
        });
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
