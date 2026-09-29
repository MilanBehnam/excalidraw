import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import {
  copyIcon,
  pencilIcon,
  PlusIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../app-jotai";
import { activeRoomLinkAtom, collabAPIAtom } from "../collab/Collab";
import { getCollaborationLink, getCollaborationLinkData } from "../data";

import {
  createCollection,
  createFile,
  deleteCollection,
  deleteFile,
  ensureUsername,
  fetchCollection,
  forgetCollection,
  getCollectionLink,
  renameCollection,
  renameFile,
  saveDrawingToFile,
  savedCollectionsAtom,
  setSavedCollections,
} from "./collections";

import "./CollectionsTab.scss";

import type { CollectionFile, SavedCollection } from "./collections";

/** how often to pick up files friends added/renamed while the tab is open */
const REFRESH_INTERVAL_MS = 10000;

export const CollectionsTab = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const collabAPI = useAtomValue(collabAPIAtom);
  const collections = useAtomValue(savedCollectionsAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const activeFileId = activeRoomLink
    ? getCollaborationLinkData(activeRoomLink)?.roomId
    : null;

  // null = deleted by someone
  const [filesById, setFilesById] = useState<
    Record<string, CollectionFile[] | null>
  >({});
  // kept apart so a background refresh doesn't hide an action's error
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const results = await Promise.all(collections.map(fetchCollection));
      setFilesById(
        Object.fromEntries(
          collections.map((c, i) => [c.id, results[i]?.files ?? null]),
        ),
      );
      // keep cached names in sync with renames done by friends
      if (
        collections.some((c, i) => results[i] && results[i]!.name !== c.name)
      ) {
        setSavedCollections(
          collections.map((c, i) => ({
            ...c,
            name: results[i]?.name ?? c.name,
          })),
        );
      }
      setLoadError(null);
    } catch (error: any) {
      setLoadError(`Can't reach the collections server (${error.message})`);
    }
  }, [collections]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (error: any) {
      setActionError(error.message);
    }
  };

  const openFile = (collection: SavedCollection, fileId: string) => {
    ensureUsername(collabAPI);
    // handled by App's hashchange listener, which joins the file's room
    window.location.href = getCollaborationLink({
      roomId: fileId,
      roomKey: collection.key,
    });
  };

  const onNewCollection = () => {
    const name = window.prompt("Collection name:")?.trim();
    if (name) {
      run(() => createCollection(name));
    }
  };

  const onNewFile = (collection: SavedCollection, saveCurrent: boolean) => {
    const name = window.prompt("File name:", "Untitled")?.trim();
    if (!name || !excalidrawAPI) {
      return;
    }
    run(async () => {
      const fileId = await createFile(collection, name);
      if (saveCurrent) {
        await saveDrawingToFile(excalidrawAPI, collection, fileId);
      }
      openFile(collection, fileId);
    });
  };

  const onCopyLink = async (collection: SavedCollection) => {
    await navigator.clipboard.writeText(getCollectionLink(collection));
    excalidrawAPI?.setToast({
      message: "Link copied. Anyone with it can view and edit this collection.",
    });
  };

  const renderFile = (collection: SavedCollection, file: CollectionFile) => (
    <li
      key={file.id}
      className={`collections__file ${
        file.id === activeFileId ? "collections__file--active" : ""
      }`}
    >
      <button
        className="collections__file-name"
        onClick={() => openFile(collection, file.id)}
        title="Open and edit together"
      >
        {file.name}
      </button>
      <button
        className="collections__icon"
        title="Rename"
        onClick={() => {
          const name = window.prompt("File name:", file.name)?.trim();
          if (name) {
            run(() => renameFile(collection, file.id, name));
          }
        }}
      >
        {pencilIcon}
      </button>
      <button
        className="collections__icon"
        title="Delete for everyone"
        onClick={() => {
          if (window.confirm(`Delete "${file.name}" for everyone?`)) {
            if (file.id === activeFileId) {
              window.location.hash = "";
            }
            run(() => deleteFile(collection, file.id));
          }
        }}
      >
        {TrashIcon}
      </button>
    </li>
  );

  return (
    <div className="collections">
      <div className="collections__header">
        <h3>My collections</h3>
        <FilledButton
          size="medium"
          icon={PlusIcon}
          label="New collection"
          onClick={onNewCollection}
        />
      </div>

      {activeFileId && (
        <div className="collections__active">
          Editing together
          <button onClick={() => (window.location.hash = "")}>
            Back to my drawing
          </button>
        </div>
      )}

      {[loadError, actionError].map(
        (error) =>
          error && (
            <div key={error} className="collections__error">
              {error}
            </div>
          ),
      )}

      {!collections.length && (
        <p className="collections__empty">
          Create a collection and share its link with friends. Everyone with the
          link can open and edit its files together, live.
        </p>
      )}

      {collections.map((collection) => {
        const files = filesById[collection.id];
        return (
          <details key={collection.id} className="collections__item" open>
            <summary>
              <span className="collections__name">
                {collection.name || "Loading…"}
              </span>
              <button
                className="collections__icon"
                title="Copy share link"
                onClick={(event) => {
                  // don't toggle <details>
                  event.preventDefault();
                  onCopyLink(collection);
                }}
              >
                {copyIcon}
              </button>
              <button
                className="collections__icon"
                title="Rename"
                onClick={(event) => {
                  event.preventDefault();
                  const name = window
                    .prompt("Collection name:", collection.name)
                    ?.trim();
                  if (name) {
                    run(() => renameCollection(collection, name));
                  }
                }}
              >
                {pencilIcon}
              </button>
            </summary>

            {files === null ? (
              <p className="collections__empty">This collection was deleted.</p>
            ) : (
              <ul className="collections__files">
                {files?.map((file) => renderFile(collection, file))}
              </ul>
            )}

            <div className="collections__actions">
              {files !== null && (
                <>
                  <button onClick={() => onNewFile(collection, false)}>
                    + New file
                  </button>
                  <button onClick={() => onNewFile(collection, true)}>
                    Save current drawing here
                  </button>
                </>
              )}
              <button onClick={() => forgetCollection(collection.id)}>
                Remove from my list
              </button>
              {files !== null && (
                <button
                  className="collections__danger"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete "${collection.name}" and all its files for everyone? This can't be undone.`,
                      )
                    ) {
                      if (files?.some((file) => file.id === activeFileId)) {
                        window.location.hash = "";
                      }
                      run(() => deleteCollection(collection));
                    }
                  }}
                >
                  Delete for everyone
                </button>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
};
