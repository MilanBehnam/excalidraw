// Collections of drawings owned by accounts and shared by email. Each file is
// a collab room (room id = file id); opening one joins that room with the key
// the server hands to people who have access.

import { isInitializedImageElement, newElementWith } from "@excalidraw/element";
import { APP_NAME, DEFAULT_SIDEBAR } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { FILE_UPLOAD_MAX_BYTES } from "../app_constants";
import { authUserAtom, openAuthDialog } from "../auth/auth";
import { getCollaborationLink, getSyncableElements } from "../data";
import {
  backendFetch,
  saveFilesToBackend,
  saveSceneElements,
} from "../data/backend";
import { encodeFilesForUpload } from "../data/FileManager";

export const COLLECTIONS_SIDEBAR_TAB = "collections";

export type Kind = "col" | "file";
export type CollectionSummary = {
  id: string;
  name: string;
  ownerName: string;
  isOwner: boolean;
};
export type SharedFile = { id: string; name: string; collectionId: string };
export type Member = {
  /** `member#<id>` or `invite#<email>`, used to remove access */
  target: string;
  name: string | null;
  email: string;
  role: "owner" | "member" | "invited";
};
export type Collection = CollectionSummary & {
  files: { id: string; name: string }[];
  /** only for the owner */
  members?: Member[];
};
export type FileInfo = {
  id: string;
  name: string;
  key: string;
  collectionId: string;
  isOwner: boolean;
  members?: Member[];
};
export type Version = { id: string; at: number; by: string[] };

// api
// -----------------------------------------------------------------------------

const request = async <T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> => {
  const res = await backendFetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    openAuthDialog();
  }
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: null }));
    throw new Error(
      error
        ? `${error[0].toUpperCase()}${error.slice(1)}`
        : `Request failed (${res.status})`,
    );
  }
  return res.status === 204 ? (undefined as T) : res.json();
};

export const fetchMe = () =>
  request<{
    owned: CollectionSummary[];
    shared: CollectionSummary[];
    sharedFiles: SharedFile[];
  }>("me");

export const deleteMyData = () => request("me", "DELETE");

export const fetchCollection = (id: string) =>
  request<Collection>(`collections/${id}`);

export const createCollection = (name: string) =>
  request<{ id: string }>("collections", "POST", { name });

export const renameCollection = (id: string, name: string) =>
  request(`collections/${id}`, "PATCH", { name });

export const deleteCollection = (id: string) =>
  request(`collections/${id}`, "DELETE");

export const createFile = async (collectionId: string, name: string) =>
  (
    await request<{ id: string }>(`collections/${collectionId}/files`, "POST", {
      name,
    })
  ).id;

export const renameFile = (
  collectionId: string,
  fileId: string,
  name: string,
) => request(`collections/${collectionId}/files/${fileId}`, "PATCH", { name });

export const deleteFile = (collectionId: string, fileId: string) =>
  request(`collections/${collectionId}/files/${fileId}`, "DELETE");

export const fetchFile = (fileId: string) =>
  request<FileInfo>(`files/${fileId}`);

export const fetchVersions = (fileId: string) =>
  request<Version[]>(`files/${fileId}/versions`);

/** "added" = they have an account, "invited" = gets it when they sign up */
export const shareWith = (kind: Kind, id: string, email: string) =>
  request<{ status: "added" | "invited" }>("shares", "POST", {
    kind,
    id,
    email,
  });

export const removeAccess = (kind: Kind, id: string, target: string) =>
  request("shares", "DELETE", { kind, id, target });

export const leave = (kind: Kind, id: string) =>
  removeAccess(kind, id, `member#${appJotaiStore.get(authUserAtom)!.sub}`);

// links
// -----------------------------------------------------------------------------

const RE_SHARE_LINK = /^#(collection|file)=([a-zA-Z0-9_-]+)$/;

export const getShareLink = (kind: Kind, id: string) =>
  `${window.location.origin}${window.location.pathname}#${
    kind === "col" ? "collection" : "file"
  }=${id}`;

/** joins the file's live room (App's hashchange listener does the rest) */
export const openFile = async (fileId: string) => {
  const { key } = await fetchFile(fileId);
  window.location.href = getCollaborationLink({ roomId: fileId, roomKey: key });
};

/**
 * Handles `#collection=<id>` / `#file=<id>` links someone sent you. Returns
 * whether the URL was such a link. Signed out: asks to sign in first and
 * leaves the link in place for afterwards.
 */
export const openShareLinkFromUrl = (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fallbackUrl: string,
) => {
  const match = window.location.hash.match(RE_SHARE_LINK);
  if (!match) {
    return false;
  }
  if (!appJotaiStore.get(authUserAtom)) {
    openAuthDialog("Sign in to open what was shared with you");
    return true;
  }
  const [, kind, id] = match;
  if (kind === "file") {
    openFile(id).catch((error) =>
      excalidrawAPI.setToast({ message: error.message }),
    );
  } else {
    window.history.replaceState({}, APP_NAME, fallbackUrl);
    excalidrawAPI.toggleSidebar({
      name: DEFAULT_SIDEBAR.name,
      tab: COLLECTIONS_SIDEBAR_TAB,
      force: true,
    });
  }
  return true;
};

/** copies what's on the canvas (incl. images) into a collection file */
export const saveDrawingToFile = async (
  excalidrawAPI: ExcalidrawImperativeAPI,
  fileId: string,
) => {
  const { key } = await fetchFile(fileId);
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
      encryptionKey: key,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    }),
  );

  await saveSceneElements(
    fileId,
    key,
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
