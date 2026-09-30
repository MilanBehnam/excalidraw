// Data: users, collections, files, sharing, scenes and version history.
//
// DynamoDB table (pk, sk):
//   user#<sub>      profile              { email, name, fileCount }
//   user#<sub>      access#col#<id>      { role }         what a user can open
//   user#<sub>      access#file#<fid>    { role, col }
//   email#<email>   user                 { sub }          find users to share with
//   email#<email>   invite#<kind>#<id>   {}               shared before they signed up
//   col#<id>        meta                 { name, owner, ownerName }
//   col#<id>        file#<fid>           { name, createdAt }
//   <kind>#<id>     member#<sub>         { email, name, role }   kind = col | file
//   <kind>#<id>     invite#<email>       { email }
//   scene#<fid>     meta                 { rev, obj, col?, key?, lastVersionAt, versionRev, editors }
//   scene#<fid>     v#<time>             { obj, at, by, expiresAt }  version history
//
// S3: scenes/<fid>/<uuid> (current scene), versions/<fid>/<time>,
// images/<fid>/<imageId>.
//
// Collection files are stored encrypted with a per-file key kept here and
// handed to users who have access (the client's collab code encrypts
// everything). Quick "Live collaboration" rooms have no `col`: their key is
// only in their link, as before.

import { randomBytes, randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import type { User } from "./auth.ts";

export const TABLE = process.env.TABLE_NAME || "excalidraw";
export const BUCKET = process.env.BUCKET_NAME || "excalidraw";
export const MAX_FILES_PER_USER = 200;
const VERSION_INTERVAL_MS = 5 * 60 * 1000;
const VERSION_TTL_S = 90 * 24 * 60 * 60;

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// path-style addressing for S3-compatible servers (S3Mock in local dev)
export const s3 = new S3Client({
  forcePathStyle: !!process.env.AWS_ENDPOINT_URL_S3,
});

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Kind = "col" | "file";

// low level
// -----------------------------------------------------------------------------

const newId = () => randomBytes(10).toString("hex");
/** AES-128 key in the format the client's encryption code expects */
const newKey = () => randomBytes(16).toString("base64url");

const get = async (pk: string, sk = "meta") =>
  (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;

const put = (item: Record<string, unknown>) =>
  db.send(new PutCommand({ TableName: TABLE, Item: item }));

const del = (pk: string, sk: string) =>
  db.send(new DeleteCommand({ TableName: TABLE, Key: { pk, sk } }));

const query = async (pk: string, skPrefix = "") => {
  const items: Record<string, any>[] = [];
  let start: Record<string, any> | undefined;
  do {
    const page = await db.send(
      new QueryCommand({
        TableName: TABLE,
        // DynamoDB rejects an empty begins_with prefix
        KeyConditionExpression: skPrefix
          ? "pk = :pk AND begins_with(sk, :sk)"
          : "pk = :pk",
        ExpressionAttributeValues: skPrefix
          ? { ":pk": pk, ":sk": skPrefix }
          : { ":pk": pk },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(page.Items || []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
};

const batchGet = async (keys: { pk: string; sk: string }[]) => {
  const items: Record<string, any>[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let pending: any = { [TABLE]: { Keys: keys.slice(i, i + 100) } };
    while (pending && Object.keys(pending).length) {
      const res = await db.send(new BatchGetCommand({ RequestItems: pending }));
      items.push(...(res.Responses?.[TABLE] || []));
      pending = res.UnprocessedKeys;
    }
  }
  return items;
};

export const getObject = async (key: string) => {
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return Buffer.from(await obj.Body!.transformToByteArray());
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }
    throw error;
  }
};

export const putObject = (key: string, body: Buffer) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));

const deleteObject = (key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

const deletePrefix = async (prefix: string) => {
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    await Promise.all((list.Contents || []).map((o) => deleteObject(o.Key!)));
    token = list.NextContinuationToken;
  } while (token);
};

// users
// -----------------------------------------------------------------------------

const knownUsers = new Map<string, string>();

/** keeps the profile/email index current and turns pending invites into access */
export const ensureUser = async (user: User) => {
  const signature = `${user.email}|${user.name}`;
  if (knownUsers.get(user.sub) === signature) {
    return;
  }
  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `user#${user.sub}`, sk: "profile" },
      UpdateExpression:
        "SET email = :email, #name = :name, fileCount = if_not_exists(fileCount, :zero)",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: {
        ":email": user.email,
        ":name": user.name,
        ":zero": 0,
      },
    }),
  );
  await put({ pk: `email#${user.email}`, sk: "user", sub: user.sub });

  for (const invite of await query(`email#${user.email}`, "invite#")) {
    const [, kind, id] = invite.sk.split("#") as [string, Kind, string];
    await addMember(kind, id, user);
    await del(`${kind}#${id}`, `invite#${user.email}`);
    await del(invite.pk, invite.sk);
  }
  knownUsers.set(user.sub, signature);
};

const addMember = async (
  kind: Kind,
  id: string,
  user: User,
  role: "owner" | "member" = "member",
) => {
  let col: string | undefined;
  if (kind === "file") {
    col = (await get(`scene#${id}`))?.col;
    if (!col) {
      return; // file was deleted meanwhile
    }
  }
  await put({
    pk: `${kind}#${id}`,
    sk: `member#${user.sub}`,
    email: user.email,
    name: user.name,
    role,
  });
  await put({ pk: `user#${user.sub}`, sk: `access#${kind}#${id}`, role, col });
};

const removeMember = async (kind: Kind, id: string, sub: string) => {
  await del(`${kind}#${id}`, `member#${sub}`);
  await del(`user#${sub}`, `access#${kind}#${id}`);
};

/** the sidebar: collections and single files the user can open */
export const listAccess = async (user: User) => {
  const access = await query(`user#${user.sub}`, "access#");
  const cols = access.filter((a) => a.sk.startsWith("access#col#"));
  const files = access.filter((a) => a.sk.startsWith("access#file#"));

  const colMetas = await batchGet(
    cols.map((a) => ({ pk: `col#${a.sk.slice(11)}`, sk: "meta" })),
  );
  const fileItems = await batchGet(
    files.map((a) => ({ pk: `col#${a.col}`, sk: `file#${a.sk.slice(12)}` })),
  );

  const collections = colMetas.map((meta) => ({
    id: meta.pk.slice(4),
    name: meta.name,
    ownerName: meta.ownerName,
    isOwner: meta.owner === user.sub,
  }));
  return {
    name: user.name,
    email: user.email,
    owned: collections.filter((c) => c.isOwner),
    shared: collections.filter((c) => !c.isOwner),
    sharedFiles: fileItems.map((item) => ({
      id: item.sk.slice(5),
      name: item.name,
      collectionId: item.pk.slice(4),
    })),
  };
};

export const deleteUser = async (user: User) => {
  for (const a of await query(`user#${user.sub}`, "access#")) {
    const [, kind, id] = a.sk.split("#") as [string, Kind, string];
    if (kind === "col" && a.role === "owner") {
      await deleteCollection(user, id);
    } else {
      await removeMember(kind, id, user.sub);
    }
  }
  await del(`user#${user.sub}`, "profile");
  await del(`email#${user.email}`, "user");
  knownUsers.delete(user.sub);
};

// access checks
// -----------------------------------------------------------------------------

const collectionMeta = async (id: string) => {
  const meta = await get(`col#${id}`);
  if (!meta) {
    throw new HttpError(404, "collection not found");
  }
  return meta;
};

const requireCollectionMember = async (user: User, id: string) => {
  const meta = await collectionMeta(id);
  if (!(await get(`col#${id}`, `member#${user.sub}`))) {
    throw new HttpError(403, "no access to this collection");
  }
  return meta;
};

const requireCollectionOwner = async (user: User, id: string) => {
  const meta = await collectionMeta(id);
  if (meta.owner !== user.sub) {
    throw new HttpError(403, "only the owner can do this");
  }
  return meta;
};

/**
 * "open" = quick live room (anyone with its link), otherwise whether the
 * user may open this collection file
 */
export const roomAccess = async (
  user: User | null,
  roomId: string,
): Promise<"open" | "allowed" | "denied"> => {
  const scene = await get(`scene#${roomId}`);
  if (scene?.deleted) {
    return "denied";
  }
  if (!scene?.col) {
    return "open";
  }
  if (!user) {
    return "denied";
  }
  const [viaCollection, viaFile] = await Promise.all([
    get(`col#${scene.col}`, `member#${user.sub}`),
    get(`file#${roomId}`, `member#${user.sub}`),
  ]);
  return viaCollection || viaFile ? "allowed" : "denied";
};

export const requireRoomAccess = async (user: User | null, roomId: string) => {
  const access = await roomAccess(user, roomId);
  if (access === "denied") {
    throw new HttpError(user ? 403 : 401, "no access to this file");
  }
  return access;
};

/** the live rooms (files) behind a collection or file */
export const roomsOf = async (kind: Kind, id: string) =>
  kind === "file"
    ? [id]
    : (await query(`col#${id}`, "file#")).map((f) => f.sk.slice(5) as string);

/** every room a user can currently open */
export const roomsOfUser = async (user: User) => {
  const rooms: string[] = [];
  for (const a of await query(`user#${user.sub}`, "access#")) {
    const [, kind, id] = a.sk.split("#") as [string, Kind, string];
    rooms.push(...(await roomsOf(kind, id)));
  }
  return rooms;
};

// collections & files
// -----------------------------------------------------------------------------

export const createCollection = async (user: User, name: string) => {
  const id = newId();
  await put({
    pk: `col#${id}`,
    sk: "meta",
    name,
    owner: user.sub,
    ownerName: user.name,
    createdAt: Date.now(),
  });
  await addMember("col", id, user, "owner");
  return { id };
};

const members = async (kind: Kind, id: string) => {
  const items = await query(`${kind}#${id}`);
  return [
    ...items
      .filter((i) => i.sk.startsWith("member#"))
      .map((i) => ({
        target: i.sk,
        name: i.name,
        email: i.email,
        role: i.role,
      })),
    ...items
      .filter((i) => i.sk.startsWith("invite#"))
      .map((i) => ({
        target: i.sk,
        name: null,
        email: i.email,
        role: "invited",
      })),
  ];
};

export const getCollection = async (user: User, id: string) => {
  const meta = await requireCollectionMember(user, id);
  const isOwner = meta.owner === user.sub;
  const files = (await query(`col#${id}`, "file#"))
    .map((f) => ({ id: f.sk.slice(5), name: f.name, createdAt: f.createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    id,
    name: meta.name,
    ownerName: meta.ownerName,
    isOwner,
    files,
    members: isOwner ? await members("col", id) : undefined,
  };
};

export const renameCollection = async (
  user: User,
  id: string,
  name: string,
) => {
  await requireCollectionMember(user, id);
  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `col#${id}`, sk: "meta" },
      UpdateExpression: "SET #name = :name",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": name },
    }),
  );
};

export const deleteCollection = async (user: User, id: string) => {
  const meta = await requireCollectionOwner(user, id);
  for (const item of await query(`col#${id}`)) {
    if (item.sk.startsWith("file#")) {
      await deleteFileData(item.sk.slice(5), meta.owner);
    } else if (item.sk.startsWith("member#")) {
      await del(`user#${item.sk.slice(7)}`, `access#col#${id}`);
    } else if (item.sk.startsWith("invite#")) {
      await del(`email#${item.email}`, `invite#col#${id}`);
    }
    await del(item.pk, item.sk);
  }
};

export const createFile = async (user: User, colId: string, name: string) => {
  const meta = await requireCollectionMember(user, colId);
  // counts against the collection owner: it's their storage
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `user#${meta.owner}`, sk: "profile" },
        UpdateExpression: "ADD fileCount :one",
        ConditionExpression: "fileCount < :max",
        ExpressionAttributeValues: { ":one": 1, ":max": MAX_FILES_PER_USER },
      }),
    );
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      throw new HttpError(
        409,
        `the collection owner reached the limit of ${MAX_FILES_PER_USER} files`,
      );
    }
    throw error;
  }
  const id = newId();
  await put({
    pk: `scene#${id}`,
    sk: "meta",
    rev: 0,
    col: colId,
    key: newKey(),
  });
  await put({
    pk: `col#${colId}`,
    sk: `file#${id}`,
    name,
    createdAt: Date.now(),
  });
  return { id };
};

const fileOf = async (colId: string, fileId: string) => {
  const file = await get(`col#${colId}`, `file#${fileId}`);
  if (!file) {
    throw new HttpError(404, "file not found");
  }
  return file;
};

export const renameFile = async (
  user: User,
  colId: string,
  fileId: string,
  name: string,
) => {
  await requireRoomAccess(user, fileId);
  await fileOf(colId, fileId);
  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `col#${colId}`, sk: `file#${fileId}` },
      UpdateExpression: "SET #name = :name",
      ExpressionAttributeNames: { "#name": "name" },
      ExpressionAttributeValues: { ":name": name },
    }),
  );
};

export const deleteFile = async (user: User, colId: string, fileId: string) => {
  const meta = await requireCollectionOwner(user, colId);
  await fileOf(colId, fileId);
  await deleteFileData(fileId, meta.owner);
  await del(`col#${colId}`, `file#${fileId}`);
};

const deleteFileData = async (fileId: string, owner: string) => {
  const scene = await get(`scene#${fileId}`);
  if (scene?.obj) {
    await deleteObject(scene.obj);
  }
  await deletePrefix(`images/${fileId}/`);
  await deletePrefix(`versions/${fileId}/`);
  for (const item of await query(`scene#${fileId}`, "v#")) {
    await del(item.pk, item.sk);
  }
  // tombstone: keeps anyone who still has it open from recreating it (their
  // next save would otherwise start a new quick room under the same id)
  await put({
    pk: `scene#${fileId}`,
    sk: "meta",
    col: scene?.col,
    deleted: true,
  });
  for (const item of await query(`file#${fileId}`)) {
    if (item.sk.startsWith("member#")) {
      await del(`user#${item.sk.slice(7)}`, `access#file#${fileId}`);
    } else if (item.sk.startsWith("invite#")) {
      await del(`email#${item.email}`, `invite#file#${fileId}`);
    }
    await del(item.pk, item.sk);
  }
  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `user#${owner}`, sk: "profile" },
      UpdateExpression: "ADD fileCount :minusOne",
      ExpressionAttributeValues: { ":minusOne": -1 },
    }),
  );
};

/** what the app needs to open a file */
export const getFile = async (user: User, fileId: string) => {
  await requireRoomAccess(user, fileId);
  const scene = await get(`scene#${fileId}`);
  if (!scene?.col || scene.deleted) {
    throw new HttpError(404, "file not found");
  }
  const [file, meta] = await Promise.all([
    fileOf(scene.col, fileId),
    collectionMeta(scene.col),
  ]);
  const isOwner = meta.owner === user.sub;
  return {
    id: fileId,
    name: file.name,
    key: scene.key,
    collectionId: scene.col,
    isOwner,
    members: isOwner ? await members("file", fileId) : undefined,
  };
};

// sharing
// -----------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireOwnerOf = async (user: User, kind: Kind, id: string) => {
  const colId = kind === "col" ? id : (await get(`scene#${id}`))?.col;
  if (!colId) {
    throw new HttpError(404, "not found");
  }
  return requireCollectionOwner(user, colId);
};

export const share = async (
  user: User,
  kind: Kind,
  id: string,
  rawEmail: string,
) => {
  await requireOwnerOf(user, kind, id);
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    throw new HttpError(400, "invalid email");
  }
  if (email === user.email) {
    throw new HttpError(400, "you already own this");
  }
  const existing = await get(`email#${email}`, "user");
  if (existing) {
    const profile = await get(`user#${existing.sub}`, "profile");
    await addMember(kind, id, {
      sub: existing.sub,
      email,
      name: profile?.name || email,
    });
    return { status: "added" as const };
  }
  await put({ pk: `${kind}#${id}`, sk: `invite#${email}`, email });
  await put({ pk: `email#${email}`, sk: `invite#${kind}#${id}` });
  return { status: "invited" as const };
};

/** owner removes someone, or a member leaves (target = their own member#) */
export const unshare = async (
  user: User,
  kind: Kind,
  id: string,
  target: string,
) => {
  const isSelf = target === `member#${user.sub}`;
  if (!isSelf) {
    await requireOwnerOf(user, kind, id);
  }
  if (target.startsWith("member#")) {
    const item = await get(`${kind}#${id}`, target);
    if (item?.role === "owner") {
      throw new HttpError(400, "the owner can't leave; delete it instead");
    }
    await removeMember(kind, id, target.slice(7));
  } else if (target.startsWith("invite#")) {
    const email = target.slice(7);
    await del(`${kind}#${id}`, target);
    await del(`email#${email}`, `invite#${kind}#${id}`);
  } else {
    throw new HttpError(400, "invalid target");
  }
};

// scenes, images & versions
// -----------------------------------------------------------------------------

export const getScene = async (roomId: string) => {
  const scene = await get(`scene#${roomId}`);
  const body = scene?.obj && (await getObject(scene.obj));
  return body ? { body, rev: scene!.rev as number } : null;
};

/** saves only if the stored revision still matches `expectedRev` */
export const saveScene = async (
  roomId: string,
  expectedRev: number,
  body: Buffer,
  editor: User | null,
) => {
  const obj = `scenes/${roomId}/${randomUUID()}`;
  await putObject(obj, body);
  let prev: Record<string, any> | undefined;
  try {
    ({ Attributes: prev } = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `scene#${roomId}`, sk: "meta" },
        UpdateExpression: editor
          ? "SET rev = :next, obj = :obj ADD editors :editor"
          : "SET rev = :next, obj = :obj",
        ConditionExpression:
          expectedRev === 0
            ? "attribute_not_exists(pk) OR rev = :expected"
            : "rev = :expected",
        ExpressionAttributeValues: {
          ":next": expectedRev + 1,
          ":obj": obj,
          ":expected": expectedRev,
          ...(editor ? { ":editor": new Set([editor.name]) } : {}),
        },
        ReturnValues: "ALL_OLD",
      }),
    ));
  } catch (error: any) {
    await deleteObject(obj);
    if (error.name === "ConditionalCheckFailedException") {
      throw new HttpError(412, "scene was changed, reload and retry");
    }
    throw error;
  }
  if (prev?.obj) {
    await deleteObject(prev.obj);
  }
  const rev = expectedRev + 1;
  if (
    prev?.col &&
    Date.now() - (prev.lastVersionAt || 0) >= VERSION_INTERVAL_MS
  ) {
    await createVersion(roomId);
  }
  return rev;
};

/** snapshots the current scene into the history (if it changed since) */
export const createVersion = async (fileId: string) => {
  const scene = await get(`scene#${fileId}`);
  if (!scene?.col || !scene.obj || scene.rev === scene.versionRev) {
    return;
  }
  const at = Date.now();
  const obj = `versions/${fileId}/${at}`;
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${scene.obj}`,
        Key: obj,
      }),
    );
  } catch (error: any) {
    // replaced by a newer save in the meantime; the next one gets versioned
    if (error.name === "NoSuchKey") {
      return;
    }
    throw error;
  }
  await put({
    pk: `scene#${fileId}`,
    sk: `v#${at}`,
    obj,
    at,
    by: [...(scene.editors || [])],
    // removed automatically after 90 days (DynamoDB TTL, S3 lifecycle rule)
    expiresAt: Math.floor(at / 1000) + VERSION_TTL_S,
  });
  await db.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `scene#${fileId}`, sk: "meta" },
      UpdateExpression:
        "SET lastVersionAt = :at, versionRev = :rev REMOVE editors",
      ExpressionAttributeValues: { ":at": at, ":rev": scene.rev },
    }),
  );
};

export const listVersions = async (user: User, fileId: string) => {
  await requireRoomAccess(user, fileId);
  const now = Date.now() / 1000;
  return (
    (await query(`scene#${fileId}`, "v#"))
      // TTL deletion can lag behind a bit
      .filter((v) => v.expiresAt > now)
      .map((v) => ({ id: String(v.at), at: v.at, by: v.by }))
      .reverse()
  );
};

export const getVersion = async (
  user: User,
  fileId: string,
  versionId: string,
) => {
  await requireRoomAccess(user, fileId);
  const version = await get(`scene#${fileId}`, `v#${versionId}`);
  const body = version && (await getObject(version.obj));
  if (!body) {
    throw new HttpError(404, "version not found");
  }
  return body;
};

export const sceneExists = async (roomId: string) =>
  !!(await get(`scene#${roomId}`));
