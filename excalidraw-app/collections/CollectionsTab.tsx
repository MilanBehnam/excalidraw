import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import {
  pencilIcon,
  PlusIcon,
  shareIOS,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";
import { useCallback, useEffect, useState } from "react";

import { useAtomValue } from "../app-jotai";
import { authUserAtom, openAuthDialog } from "../auth/auth";
import { activeRoomLinkAtom, collabAPIAtom } from "../collab/Collab";
import { getCollaborationLinkData } from "../data";
import { loadVersion } from "../data/backend";

import {
  createCollection,
  createFile,
  deleteCollection,
  deleteFile,
  fetchCollection,
  fetchFile,
  fetchMe,
  fetchVersions,
  getShareLink,
  leave,
  openFile,
  removeAccess,
  renameCollection,
  renameFile,
  saveDrawingToFile,
  shareWith,
} from "./collections";

import "./CollectionsTab.scss";

import type { CollabAPI } from "../collab/Collab";
import type {
  Collection,
  FileInfo,
  Kind,
  Member,
  SharedFile,
  Version,
} from "./collections";

/** how often to pick up changes by others while the tab is open */
const REFRESH_INTERVAL_MS = 10000;

const formatTime = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export const CollectionsTab = () => {
  const user = useAtomValue(authUserAtom);

  if (!user) {
    return (
      <div className="collections">
        <h3>Collections</h3>
        <p className="collections__empty">
          Sign in to keep collections of drawings and share them with friends by
          email. Everyone with access edits the same file, live.
        </p>
        <FilledButton
          size="large"
          fullWidth
          label="Sign in or create account"
          onClick={() => openAuthDialog()}
        />
      </div>
    );
  }
  return <SignedIn />;
};

const SignedIn = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const user = useAtomValue(authUserAtom)!;
  const collabAPI = useAtomValue(collabAPIAtom);
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  const activeRoom = activeRoomLink
    ? getCollaborationLinkData(activeRoomLink)
    : null;

  const [owned, setOwned] = useState<Collection[]>([]);
  const [shared, setShared] = useState<Collection[]>([]);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [activeFile, setActiveFile] = useState<FileInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  // kept apart so a background refresh doesn't hide an action's error
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      const load = (list: { id: string }[]) =>
        Promise.all(list.map((c) => fetchCollection(c.id)));
      const [ownedFull, sharedFull] = await Promise.all([
        load(me.owned),
        load(me.shared),
      ]);
      setOwned(ownedFull);
      setShared(sharedFull);
      setSharedFiles(me.sharedFiles);
      setLoaded(true);
      setLoadError(null);
    } catch (error: any) {
      setLoadError(`Can't load your collections (${error.message})`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh, user.sub]);

  // the collection file you're in right now (not quick live rooms)
  const activeRoomId = activeRoom?.roomId;
  const isCollectionFile =
    !!activeRoomId &&
    ([...owned, ...shared].some((c) =>
      c.files.some((f) => f.id === activeRoomId),
    ) ||
      sharedFiles.some((f) => f.id === activeRoomId));
  useEffect(() => {
    if (!isCollectionFile) {
      setActiveFile(null);
      return;
    }
    fetchFile(activeRoomId!).then(setActiveFile, () => setActiveFile(null));
  }, [activeRoomId, isCollectionFile]);

  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (error: any) {
      setActionError(error.message);
    }
  };

  const toast = (message: string) => excalidrawAPI?.setToast({ message });

  const onOpen = (fileId: string) => run(() => openFile(fileId));

  const onNewCollection = () => {
    const name = window.prompt("Collection name:")?.trim();
    if (name) {
      run(() => createCollection(name));
    }
  };

  const onNewFile = (collectionId: string, saveCurrent: boolean) => {
    const name = window.prompt("File name:", "Untitled")?.trim();
    if (!name || !excalidrawAPI) {
      return;
    }
    run(async () => {
      const fileId = await createFile(collectionId, name);
      if (saveCurrent) {
        await saveDrawingToFile(excalidrawAPI, fileId);
      }
      await openFile(fileId);
    });
  };

  const onShare = (kind: Kind, id: string, name: string) => {
    const email = window.prompt(`Share “${name}” with (email):`)?.trim();
    if (!email) {
      return;
    }
    run(async () => {
      const { status } = await shareWith(kind, id, email);
      await navigator.clipboard
        .writeText(getShareLink(kind, id))
        .catch(() => {});
      toast(
        status === "added"
          ? `Shared with ${email}. It's in their “Shared with me”. Link copied, if you want to send it too.`
          : `${email} has no account yet: they get access when they sign up with that email. Link copied, send it to them.`,
      );
    });
  };

  const onRemove = (kind: Kind, id: string, member: Member) => {
    if (window.confirm(`Remove ${member.name || member.email}'s access?`)) {
      run(() => removeAccess(kind, id, member.target));
    }
  };

  const onLeave = (kind: Kind, id: string, name: string) => {
    if (window.confirm(`Leave “${name}”? It disappears from your list.`)) {
      if (id === activeRoomId || activeFile?.collectionId === id) {
        window.location.hash = "";
      }
      run(() => leave(kind, id));
    }
  };

  const onRename = (
    current: string,
    save: (name: string) => Promise<unknown>,
  ) => {
    const name = window.prompt("New name:", current)?.trim();
    if (name && name !== current) {
      run(() => save(name));
    }
  };

  const renderMembers = (kind: Kind, id: string, members?: Member[]) => {
    const others = members?.filter((m) => m.role !== "owner");
    if (!others?.length) {
      return null;
    }
    return (
      <div className="collections__members">
        Shared with:
        {others.map((member) => (
          <span key={member.target} className="collections__member">
            {member.name || member.email}
            {member.role === "invited" && " (invited)"}
            <button
              title="Remove access"
              onClick={() => onRemove(kind, id, member)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    );
  };

  const renderFile = (
    collection: Collection,
    file: { id: string; name: string },
  ) => (
    <li
      key={file.id}
      className={`collections__file ${
        file.id === activeRoomId ? "collections__file--active" : ""
      }`}
    >
      <button
        className="collections__file-name"
        onClick={() => onOpen(file.id)}
        title="Open and edit together"
      >
        {file.name}
      </button>
      <button
        className="collections__icon"
        title="Rename"
        onClick={() =>
          onRename(file.name, (name) =>
            renameFile(collection.id, file.id, name),
          )
        }
      >
        {pencilIcon}
      </button>
      {collection.isOwner && (
        <>
          <button
            className="collections__icon"
            title="Share this file"
            onClick={() => onShare("file", file.id, file.name)}
          >
            {shareIOS}
          </button>
          <button
            className="collections__icon"
            title="Delete for everyone"
            onClick={() => {
              if (window.confirm(`Delete “${file.name}” for everyone?`)) {
                if (file.id === activeRoomId) {
                  window.location.hash = "";
                }
                run(() => deleteFile(collection.id, file.id));
              }
            }}
          >
            {TrashIcon}
          </button>
        </>
      )}
    </li>
  );

  const renderCollection = (collection: Collection) => (
    <details key={collection.id} className="collections__item" open>
      <summary>
        <span className="collections__name">
          {collection.name}
          {!collection.isOwner && (
            <span className="collections__owner">
              {" "}
              · {collection.ownerName}
            </span>
          )}
        </span>
        <button
          className="collections__icon"
          title="Rename"
          onClick={(event) => {
            // don't toggle <details>
            event.preventDefault();
            onRename(collection.name, (name) =>
              renameCollection(collection.id, name),
            );
          }}
        >
          {pencilIcon}
        </button>
        {collection.isOwner && (
          <button
            className="collections__icon"
            title="Share collection"
            onClick={(event) => {
              event.preventDefault();
              onShare("col", collection.id, collection.name);
            }}
          >
            {shareIOS}
          </button>
        )}
      </summary>

      <ul className="collections__files">
        {collection.files.map((file) => renderFile(collection, file))}
      </ul>
      {renderMembers("col", collection.id, collection.members)}

      <div className="collections__actions">
        <button onClick={() => onNewFile(collection.id, false)}>
          + New file
        </button>
        <button onClick={() => onNewFile(collection.id, true)}>
          Save current drawing here
        </button>
        {collection.isOwner ? (
          <button
            className="collections__danger"
            onClick={() => {
              if (
                window.confirm(
                  `Delete “${collection.name}” and all its files for everyone? This can't be undone.`,
                )
              ) {
                if (collection.files.some((f) => f.id === activeRoomId)) {
                  window.location.hash = "";
                }
                run(() => deleteCollection(collection.id));
              }
            }}
          >
            Delete
          </button>
        ) : (
          <button
            onClick={() => onLeave("col", collection.id, collection.name)}
          >
            Leave
          </button>
        )}
      </div>
    </details>
  );

  return (
    <div className="collections">
      <div className="collections__header">
        <h3>Collections</h3>
        <FilledButton
          size="medium"
          icon={PlusIcon}
          label="New collection"
          onClick={onNewCollection}
        />
      </div>
      <button
        className="collections__account"
        onClick={() => openAuthDialog()}
        title="Account settings"
      >
        Signed in as <strong>{user.name}</strong>
      </button>

      {activeFile && collabAPI && (
        <ActiveFile
          file={activeFile}
          roomKey={activeRoom!.roomKey}
          collabAPI={collabAPI}
          onError={setActionError}
          renderMembers={renderMembers}
          onRestored={() => toast("Restored. Everyone sees this version now.")}
        />
      )}

      {[loadError, actionError].map(
        (error) =>
          error && (
            <div key={error} className="collections__error">
              {error}
            </div>
          ),
      )}

      <h4>My collections</h4>
      {loaded && !owned.length && (
        <p className="collections__empty">
          Create a collection, add files and share it with friends by email.
        </p>
      )}
      {owned.map(renderCollection)}

      {(shared.length > 0 || sharedFiles.length > 0) && (
        <>
          <h4>Shared with me</h4>
          {shared.map(renderCollection)}
          {sharedFiles.length > 0 && (
            <ul className="collections__files">
              {sharedFiles.map((file) => (
                <li
                  key={file.id}
                  className={`collections__file ${
                    file.id === activeRoomId ? "collections__file--active" : ""
                  }`}
                >
                  <button
                    className="collections__file-name"
                    onClick={() => onOpen(file.id)}
                  >
                    {file.name}
                  </button>
                  <button
                    className="collections__icon"
                    title="Leave"
                    onClick={() => onLeave("file", file.id, file.name)}
                  >
                    {TrashIcon}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
};

/** the file you're in: who's got access, history, back to your drawing */
const ActiveFile = ({
  file,
  roomKey,
  collabAPI,
  onError,
  renderMembers,
  onRestored,
}: {
  file: FileInfo;
  roomKey: string;
  collabAPI: CollabAPI;
  onError: (error: string | null) => void;
  renderMembers: (
    kind: Kind,
    id: string,
    members?: Member[],
  ) => React.ReactNode;
  onRestored: () => void;
}) => {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [previewing, setPreviewing] = useState<Version | null>(null);

  // leaving the file (or switching) ends any preview
  useEffect(
    () => () => {
      setPreviewing(null);
    },
    [file.id],
  );

  const toggleHistory = async () => {
    if (versions) {
      return setVersions(null);
    }
    try {
      setVersions(await fetchVersions(file.id));
    } catch (error: any) {
      onError(error.message);
    }
  };

  const preview = async (version: Version) => {
    try {
      collabAPI.startVersionPreview(
        await loadVersion(file.id, version.id, roomKey),
      );
      setPreviewing(version);
    } catch (error: any) {
      onError(error.message);
    }
  };

  const endPreview = (restore: boolean) => {
    collabAPI.endVersionPreview(restore);
    setPreviewing(null);
    if (restore) {
      onRestored();
    }
  };

  if (previewing) {
    return (
      <div className="collections__active collections__active--preview">
        <div>
          Viewing version from <strong>{formatTime(previewing.at)}</strong>
          {previewing.by.length > 0 && ` by ${previewing.by.join(", ")}`}
        </div>
        <div className="collections__active-actions">
          <button onClick={() => endPreview(true)}>Restore this version</button>
          <button onClick={() => endPreview(false)}>Back to live</button>
        </div>
      </div>
    );
  }

  return (
    <div className="collections__active">
      <div>
        Editing <strong>{file.name}</strong>
      </div>
      <div className="collections__active-actions">
        <button onClick={toggleHistory}>
          {versions ? "Hide history" : "History"}
        </button>
        <button onClick={() => (window.location.hash = "")}>
          Back to my drawing
        </button>
      </div>
      {file.isOwner && renderMembers("file", file.id, file.members)}
      {versions && (
        <ul className="collections__versions">
          {!versions.length && (
            <li className="collections__empty">
              No versions yet. One is saved every 5 minutes of editing and when
              everyone leaves.
            </li>
          )}
          {versions.map((version) => (
            <li key={version.id}>
              <button onClick={() => preview(version)}>
                {formatTime(version.at)}
                {version.by.length > 0 && (
                  <span className="collections__owner">
                    {" "}
                    · {version.by.join(", ")}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
