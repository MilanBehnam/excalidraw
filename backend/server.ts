// Collaboration backend for excalidraw-app:
// - socket.io relay for live rooms (protocol ported from
//   https://github.com/excalidraw/excalidraw-room, MIT)
// - storage for collections (DynamoDB) and scenes/images (S3)
//
// Everything stored is end-to-end encrypted by the client. The server only
// sees ids and opaque blobs; the keys live in the URL hash and never reach it.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";

import {
  CreateTableCommand,
  DynamoDBClient,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { Server as SocketIO } from "socket.io";

import type { IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PORT || 3002);
const TABLE = process.env.TABLE_NAME || "excalidraw";
const BUCKET = process.env.BUCKET_NAME || "excalidraw";
/** required to create collections and standalone rooms. Empty = disabled */
const PASSCODE = process.env.PASSCODE || "";
/** only needed when the app is served from another origin (local dev) */
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 2000;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// path-style addressing for S3-compatible servers (S3Mock in local dev)
const s3 = new S3Client({ forcePathStyle: !!process.env.AWS_ENDPOINT_URL_S3 });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// storage
// -----------------------------------------------------------------------------
// Table layout (pk, sk):
//   col#<id>, meta          { name }                collection
//   col#<id>, file#<fid>    { name, createdAt }     file in collection
//   scene#<roomId>, meta    { rev, obj? }           pointer to scenes/<roomId>/<uuid>
// Images: files/<roomId>/<fileId>

const newId = () => randomBytes(10).toString("hex");

const getItem = async (pk: string, sk = "meta") =>
  (await db.send(new GetCommand({ TableName: TABLE, Key: { pk, sk } }))).Item;

const getObject = async (key: string) => {
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

const putObject = (key: string, body: Buffer) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));

const deleteObject = (key: string) =>
  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

const deleteRoom = async (roomId: string) => {
  const scene = await getItem(`scene#${roomId}`);
  if (scene?.obj) {
    await deleteObject(scene.obj);
  }
  let token: string | undefined;
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `files/${roomId}/`,
        ContinuationToken: token,
      }),
    );
    await Promise.all((list.Contents || []).map((o) => deleteObject(o.Key!)));
    token = list.NextContinuationToken;
  } while (token);
  await db.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { pk: `scene#${roomId}`, sk: "meta" },
    }),
  );
};

/** saves only if the stored revision still matches `expectedRev` */
const saveScene = async (roomId: string, expectedRev: number, body: Buffer) => {
  const obj = `scenes/${roomId}/${randomUUID()}`;
  await putObject(obj, body);
  try {
    const { Attributes: prev } = await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `scene#${roomId}`, sk: "meta" },
        UpdateExpression: "SET rev = :next, obj = :obj",
        ConditionExpression:
          expectedRev === 0
            ? "attribute_not_exists(pk) OR rev = :expected"
            : "rev = :expected",
        ExpressionAttributeValues: {
          ":next": expectedRev + 1,
          ":obj": obj,
          ":expected": expectedRev,
        },
        ReturnValues: "UPDATED_OLD",
      }),
    );
    if (prev?.obj) {
      await deleteObject(prev.obj);
    }
    return expectedRev + 1;
  } catch (error: any) {
    await deleteObject(obj);
    if (error.name === "ConditionalCheckFailedException") {
      throw new HttpError(412, "scene was changed, reload and retry");
    }
    throw error;
  }
};

// http
// -----------------------------------------------------------------------------

const send = (
  res: ServerResponse,
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const isBinary = body instanceof Uint8Array;
  if (body !== undefined) {
    headers["content-type"] = isBinary
      ? "application/octet-stream"
      : "application/json";
  }
  res.writeHead(status, headers);
  res.end(body === undefined || isBinary ? body : JSON.stringify(body));
};

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      throw new HttpError(413, `body is longer than ${MAX_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** reads `{ name }`, where name is the client-encrypted name */
const readName = async (req: IncomingMessage): Promise<string> => {
  let name: unknown;
  try {
    name = JSON.parse((await readBody(req)).toString()).name;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (typeof name !== "string" || !name || name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, "invalid name");
  }
  return name;
};

const checkPasscode = (req: IncomingMessage) => {
  if (!PASSCODE) {
    return;
  }
  const given = Buffer.from(String(req.headers["x-passcode"] || ""));
  const expected = Buffer.from(PASSCODE);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(401, "passcode required");
  }
};

const parseRev = (header: string | undefined) => {
  const rev = Number(header?.replace(/"/g, ""));
  if (!header || !Number.isInteger(rev) || rev < 0) {
    throw new HttpError(428, 'If-Match: "<rev>" header required');
  }
  return rev;
};

const handleScenes = async (
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
) => {
  if (req.method === "GET") {
    const scene = await getItem(`scene#${roomId}`);
    const body = scene?.obj && (await getObject(scene.obj));
    if (!body) {
      return send(res, 404, { error: "not found" });
    }
    return send(res, 200, body, {
      etag: `"${scene.rev}"`,
      "cache-control": "no-store",
    });
  }
  if (req.method === "PUT") {
    const expectedRev = parseRev(req.headers["if-match"]);
    // brand new rooms (outside of collections) need the passcode
    if (expectedRev === 0 && !(await getItem(`scene#${roomId}`))) {
      checkPasscode(req);
    }
    const rev = await saveScene(roomId, expectedRev, await readBody(req));
    return send(res, 200, { rev }, { etag: `"${rev}"` });
  }
  throw new HttpError(405, "method not allowed");
};

const handleFiles = async (
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  fileId: string,
) => {
  const key = `files/${roomId}/${fileId}`;
  if (req.method === "GET") {
    const body = await getObject(key);
    return body
      ? send(res, 200, body, {
          // file ids are content hashes, so they never change
          "cache-control": "public, max-age=31536000, immutable",
        })
      : send(res, 404, { error: "not found" });
  }
  if (req.method === "PUT") {
    if (!(await getItem(`scene#${roomId}`))) {
      checkPasscode(req);
    }
    await putObject(key, await readBody(req));
    return send(res, 200, {});
  }
  throw new HttpError(405, "method not allowed");
};

const handleCollections = async (
  req: IncomingMessage,
  res: ServerResponse,
  id?: string,
  sub?: string,
  fileId?: string,
) => {
  const pk = `col#${id}`;

  if (!id) {
    if (req.method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }
    checkPasscode(req);
    const name = await readName(req);
    const newCollectionId = newId();
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: `col#${newCollectionId}`, sk: "meta", name },
      }),
    );
    return send(res, 201, { id: newCollectionId });
  }

  if (!sub) {
    if (req.method === "GET") {
      // ponytail: single Query page (1 MB), paginate if a collection ever
      // holds thousands of files
      const { Items = [] } = await db.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
        }),
      );
      const meta = Items.find((item) => item.sk === "meta");
      if (!meta) {
        return send(res, 404, { error: "not found" });
      }
      const files = Items.filter((item) => item.sk.startsWith("file#"))
        .map((item) => ({
          id: item.sk.slice("file#".length),
          name: item.name,
          createdAt: item.createdAt,
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      return send(res, 200, { name: meta.name, files });
    }
    if (req.method === "PATCH") {
      await renameItem(pk, "meta", await readName(req));
      return send(res, 200, {});
    }
    if (req.method === "DELETE") {
      const { Items = [] } = await db.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
        }),
      );
      for (const item of Items) {
        if (item.sk.startsWith("file#")) {
          await deleteRoom(item.sk.slice("file#".length));
        }
        await db.send(
          new DeleteCommand({ TableName: TABLE, Key: { pk, sk: item.sk } }),
        );
      }
      return send(res, 204);
    }
    throw new HttpError(405, "method not allowed");
  }

  if (sub !== "files") {
    throw new HttpError(404, "not found");
  }

  if (!fileId) {
    if (req.method !== "POST") {
      throw new HttpError(405, "method not allowed");
    }
    const name = await readName(req);
    if (!(await getItem(pk))) {
      throw new HttpError(404, "collection not found");
    }
    const newFileId = newId();
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk, sk: `file#${newFileId}`, name, createdAt: Date.now() },
      }),
    );
    // empty scene, so friends can save into it without the passcode
    await db.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: `scene#${newFileId}`, sk: "meta", rev: 0, col: id },
      }),
    );
    return send(res, 201, { id: newFileId });
  }

  if (req.method === "PATCH") {
    await renameItem(pk, `file#${fileId}`, await readName(req));
    return send(res, 200, {});
  }
  if (req.method === "DELETE") {
    if (!(await getItem(pk, `file#${fileId}`))) {
      throw new HttpError(404, "file not found");
    }
    await deleteRoom(fileId);
    await db.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { pk, sk: `file#${fileId}` },
      }),
    );
    return send(res, 204);
  }
  throw new HttpError(405, "method not allowed");
};

const renameItem = async (pk: string, sk: string, name: string) => {
  try {
    await db.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { pk, sk },
        UpdateExpression: "SET #name = :name",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#name": "name" },
        ExpressionAttributeValues: { ":name": name },
      }),
    );
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      throw new HttpError(404, "not found");
    }
    throw error;
  }
};

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  if (CORS_ORIGIN) {
    res.setHeader("access-control-allow-origin", CORS_ORIGIN);
    res.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE",
    );
    res.setHeader(
      "access-control-allow-headers",
      "content-type, if-match, x-passcode",
    );
    res.setHeader("access-control-expose-headers", "etag");
    if (req.method === "OPTIONS") {
      return send(res, 204);
    }
  }

  const [api, kind, ...params] = new URL(req.url!, "http://localhost").pathname
    .split("/")
    .filter(Boolean);

  if (!api) {
    return send(res, 200, { ok: true });
  }
  if (api !== "api" || params.some((param) => !ID_RE.test(param))) {
    throw new HttpError(404, "not found");
  }
  if (kind === "scenes" && params.length === 1) {
    return handleScenes(req, res, params[0]);
  }
  if (kind === "files" && params.length === 2) {
    return handleFiles(req, res, params[0], params[1]);
  }
  if (kind === "collections" && params.length <= 3) {
    return handleCollections(req, res, ...params);
  }
  throw new HttpError(404, "not found");
};

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof HttpError) {
      return send(res, error.status, { error: error.message });
    }
    console.error(error);
    send(res, 500, { error: "internal error" });
  });
});

// live rooms (same protocol as excalidraw-room)
// -----------------------------------------------------------------------------

type OnUserFollowedPayload = {
  userToFollow: { socketId: string; username: string };
  action: "FOLLOW" | "UNFOLLOW";
};

const io = new SocketIO(server, {
  transports: ["websocket", "polling"],
  cors: CORS_ORIGIN ? { origin: CORS_ORIGIN } : undefined,
  maxHttpBufferSize: MAX_BYTES,
});

io.on("connection", (socket) => {
  io.to(socket.id).emit("init-room");

  socket.on("join-room", async (roomID: string) => {
    await socket.join(roomID);
    const sockets = await io.in(roomID).fetchSockets();
    if (sockets.length <= 1) {
      io.to(socket.id).emit("first-in-room");
    } else {
      socket.broadcast.to(roomID).emit("new-user", socket.id);
    }
    io.in(roomID).emit(
      "room-user-change",
      sockets.map((s) => s.id),
    );
  });

  socket.on(
    "server-broadcast",
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
    },
  );

  socket.on(
    "server-volatile-broadcast",
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      socket.volatile.broadcast
        .to(roomID)
        .emit("client-broadcast", encryptedData, iv);
    },
  );

  socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
    const roomID = `follow@${payload.userToFollow.socketId}`;
    if (payload.action === "FOLLOW") {
      await socket.join(roomID);
    } else {
      await socket.leave(roomID);
    }
    const followedBy = (await io.in(roomID).fetchSockets()).map((s) => s.id);
    io.to(payload.userToFollow.socketId).emit(
      "user-follow-room-change",
      followedBy,
    );
  });

  socket.on("disconnecting", async () => {
    for (const roomID of socket.rooms) {
      const otherClients = (await io.in(roomID).fetchSockets()).filter(
        (s) => s.id !== socket.id,
      );
      const isFollowRoom = roomID.startsWith("follow@");
      if (!isFollowRoom && otherClients.length > 0) {
        socket.broadcast.to(roomID).emit(
          "room-user-change",
          otherClients.map((s) => s.id),
        );
      }
      if (isFollowRoom && otherClients.length === 0) {
        io.to(roomID.replace("follow@", "")).emit("broadcast-unfollow");
      }
    }
  });
});

// startup
// -----------------------------------------------------------------------------

/** local dev only: in AWS the CloudFormation stack creates these */
const createResources = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await db
        .send(
          new CreateTableCommand({
            TableName: TABLE,
            BillingMode: "PAY_PER_REQUEST",
            AttributeDefinitions: [
              { AttributeName: "pk", AttributeType: "S" },
              { AttributeName: "sk", AttributeType: "S" },
            ],
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "sk", KeyType: "RANGE" },
            ],
          }),
        )
        .catch((error) => {
          if (!(error instanceof ResourceInUseException)) {
            throw error;
          }
        });
      await s3
        .send(new CreateBucketCommand({ Bucket: BUCKET }))
        .catch((error) => {
          if (error.name !== "BucketAlreadyOwnedByYou") {
            throw error;
          }
        });
      return;
    } catch (error) {
      // dynamodb/minio containers may still be starting
      if (attempt >= 20) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};

if (process.env.CREATE_RESOURCES === "true") {
  await createResources();
}

server.listen(PORT, () => {
  console.log(`excalidraw backend listening on :${PORT}`);
});
