// Client for our own collab backend (backend/server.ts): collab room scenes
// and images. They're encrypted with the room key (from the quick room's link,
// or handed out by the server for collection files, see backend/store.ts).

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

import { apiUrl, getIdToken } from "../auth/auth";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// http
// -----------------------------------------------------------------------------

/** fetch against the backend, as the signed-in user (if any) */
export const backendFetch = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  const token = await getIdToken();
  return fetch(apiUrl(path), {
    ...init,
    headers: {
      ...init.headers,
      // not `Authorization`: CloudFront drops that on GET requests
      ...(token ? { "x-auth-token": token } : {}),
    },
  });
};

export const MAX_BACKEND_BYTES = 5 * 1024 * 1024;

/** `status` 401/403 = no access (anymore) to the room */
const httpError = (message: string, status: number) =>
  Object.assign(new Error(`${message} (${status})`), { status });

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
      throw httpError("Loading scene failed", res.status);
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
      throw httpError("Saving scene failed", put.status);
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

/** a snapshot from a collection file's version history */
export const loadVersion = async (
  fileId: string,
  versionId: string,
  key: string,
) => {
  const res = await backendFetch(`files/${fileId}/versions/${versionId}`);
  if (!res.ok) {
    throw new Error(`Loading version failed (${res.status})`);
  }
  return restoreElements(
    await decryptElements(await res.arrayBuffer(), key),
    null,
  );
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
        const res = await backendFetch(`images/${roomId}/${id}`, {
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
        const res = await backendFetch(`images/${roomId}/${id}`);
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
