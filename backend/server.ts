// Collaboration backend for excalidraw-app:
// - accounts (Cognito ID tokens, see auth.ts)
// - collections, files, sharing by email and version history (store.ts)
// - socket.io relay for live rooms (protocol ported from
//   https://github.com/excalidraw/excalidraw-room, MIT), with access checks

import http from "node:http";

import {
  CreateTableCommand,
  ResourceInUseException,
} from "@aws-sdk/client-dynamodb";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { Server as SocketIO } from "socket.io";

import { authConfig, verifyToken } from "./auth.ts";
import {
  BUCKET,
  HttpError,
  TABLE,
  createCollection,
  createFile,
  createVersion,
  db,
  deleteCollection,
  deleteFile,
  deleteUser,
  ensureUser,
  getCollection,
  getFile,
  getObject,
  getScene,
  getVersion,
  listAccess,
  listVersions,
  putObject,
  renameCollection,
  renameFile,
  requireRoomAccess,
  roomAccess,
  roomsOf,
  roomsOfUser,
  s3,
  saveScene,
  sceneExists,
  share,
  unshare,
} from "./store.ts";

import type { User } from "./auth.ts";
import type { Kind } from "./store.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const PORT = Number(process.env.PORT || 3002);
/** only needed when the app is served from another origin (local dev) */
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** wait for the last client's final save before snapshotting on leave */
const LEAVE_VERSION_DELAY_MS = 10000;

// http helpers
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

const readJson = async (req: IncomingMessage): Promise<Record<string, any>> => {
  try {
    const json = JSON.parse((await readBody(req)).toString());
    if (json && typeof json === "object") {
      return json;
    }
  } catch {}
  throw new HttpError(400, "invalid JSON");
};

const readName = async (req: IncomingMessage) => {
  const name = (await readJson(req)).name;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > MAX_NAME_LENGTH
  ) {
    throw new HttpError(400, "invalid name");
  }
  return name.trim();
};

const readShare = async (req: IncomingMessage) => {
  const { kind, id, ...rest } = await readJson(req);
  if ((kind !== "col" && kind !== "file") || !ID_RE.test(id)) {
    throw new HttpError(400, "invalid share");
  }
  return { kind: kind as Kind, id: id as string, ...rest } as {
    kind: Kind;
    id: string;
    email?: unknown;
    target?: unknown;
  };
};

const parseRev = (header: string | undefined) => {
  const rev = Number(header?.replace(/"/g, ""));
  if (!header || !Number.isInteger(rev) || rev < 0) {
    throw new HttpError(428, 'If-Match: "<rev>" header required');
  }
  return rev;
};

/**
 * The app sends `x-auth-token` because CloudFront drops `Authorization` on
 * GET requests unless it's part of the cache key; tests use `Authorization`.
 */
const bearer = (req: IncomingMessage) =>
  (req.headers["x-auth-token"] as string | undefined) ||
  req.headers.authorization?.replace(/^Bearer /, "");

const requireUser = (user: User | null) => {
  if (!user) {
    throw new HttpError(401, "sign in required");
  }
  return user;
};

// routes
// -----------------------------------------------------------------------------

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  if (CORS_ORIGIN) {
    res.setHeader("access-control-allow-origin", CORS_ORIGIN);
    res.setHeader(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE",
    );
    res.setHeader(
      "access-control-allow-headers",
      "content-type, if-match, authorization, x-auth-token",
    );
    res.setHeader("access-control-expose-headers", "etag");
    if (req.method === "OPTIONS") {
      return send(res, 204);
    }
  }

  const [api, kind, ...params] = new URL(req.url!, "http://localhost").pathname
    .split("/")
    .filter(Boolean);
  const [a, b, c] = params;
  const method = req.method;

  if (!api) {
    return send(res, 200, { ok: true });
  }
  if (api !== "api" || params.some((param) => !ID_RE.test(param))) {
    throw new HttpError(404, "not found");
  }
  if (kind === "config" && method === "GET") {
    return send(res, 200, authConfig);
  }

  const user = await verifyToken(bearer(req));
  if (user) {
    await ensureUser(user);
  }

  // quick rooms and collection files
  if (kind === "scenes" && params.length === 1) {
    if (method === "GET") {
      await requireRoomAccess(user, a);
      const scene = await getScene(a);
      return scene
        ? send(res, 200, scene.body, {
            etag: `"${scene.rev}"`,
            "cache-control": "no-store",
          })
        : send(res, 404, { error: "not found" });
    }
    if (method === "PUT") {
      const expectedRev = parseRev(req.headers["if-match"]);
      // starting a new quick room needs an account (it uses our storage)
      if (!(await sceneExists(a))) {
        requireUser(user);
      }
      await requireRoomAccess(user, a);
      const rev = await saveScene(a, expectedRev, await readBody(req), user);
      return send(res, 200, { rev }, { etag: `"${rev}"` });
    }
  }

  if (kind === "images" && params.length === 2) {
    await requireRoomAccess(user, a);
    const key = `images/${a}/${b}`;
    if (method === "GET") {
      const body = await getObject(key);
      return body
        ? send(res, 200, body, {
            // image ids are content hashes, so they never change
            "cache-control": "private, max-age=31536000, immutable",
          })
        : send(res, 404, { error: "not found" });
    }
    if (method === "PUT") {
      if (!(await sceneExists(a))) {
        requireUser(user);
      }
      await putObject(key, await readBody(req));
      return send(res, 200, {});
    }
  }

  // everything below needs an account
  const me = requireUser(user);

  if (kind === "me" && params.length === 0) {
    if (method === "GET") {
      return send(res, 200, await listAccess(me));
    }
    if (method === "DELETE") {
      const rooms = await roomsOfUser(me);
      await deleteUser(me);
      await revalidateRooms(rooms);
      return send(res, 204);
    }
  }

  if (kind === "collections") {
    if (params.length === 0 && method === "POST") {
      return send(res, 201, await createCollection(me, await readName(req)));
    }
    if (params.length === 1) {
      if (method === "GET") {
        return send(res, 200, await getCollection(me, a));
      }
      if (method === "PATCH") {
        await renameCollection(me, a, await readName(req));
        return send(res, 200, {});
      }
      if (method === "DELETE") {
        const rooms = await roomsOf("col", a);
        await deleteCollection(me, a);
        await revalidateRooms(rooms);
        return send(res, 204);
      }
    }
    if (b === "files") {
      if (params.length === 2 && method === "POST") {
        return send(res, 201, await createFile(me, a, await readName(req)));
      }
      if (params.length === 3 && method === "PATCH") {
        await renameFile(me, a, c, await readName(req));
        return send(res, 200, {});
      }
      if (params.length === 3 && method === "DELETE") {
        await deleteFile(me, a, c);
        await revalidateRooms([c]);
        return send(res, 204);
      }
    }
  }

  if (kind === "files" && method === "GET") {
    if (params.length === 1) {
      return send(res, 200, await getFile(me, a));
    }
    if (params.length === 2 && b === "versions") {
      return send(res, 200, await listVersions(me, a));
    }
    if (params.length === 3 && b === "versions") {
      return send(res, 200, await getVersion(me, a, c), {
        "cache-control": "private, max-age=31536000, immutable",
      });
    }
  }

  if (kind === "shares" && params.length === 0) {
    const body = await readShare(req);
    if (method === "POST" && typeof body.email === "string") {
      return send(res, 200, await share(me, body.kind, body.id, body.email));
    }
    if (method === "DELETE" && typeof body.target === "string") {
      await unshare(me, body.kind, body.id, body.target);
      await revalidateRooms(await roomsOf(body.kind, body.id));
      return send(res, 204);
    }
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

const isFollowRoom = (roomID: string) => roomID.startsWith("follow@");

/** after access changes: sends out whoever may no longer be in these rooms */
const revalidateRooms = async (roomIds: string[]) => {
  for (const roomID of roomIds) {
    for (const socket of await io.in(roomID).fetchSockets()) {
      if ((await roomAccess(socket.data.user, roomID)) === "denied") {
        socket.emit("access-denied");
        socket.leave(roomID);
      }
    }
  }
};

io.on("connection", async (socket) => {
  const user = await verifyToken(socket.handshake.auth?.token);
  socket.data.user = user;
  io.to(socket.id).emit("init-room");

  socket.on("join-room", async (roomID: string) => {
    if (typeof roomID !== "string" || !ID_RE.test(roomID)) {
      return;
    }
    if ((await roomAccess(user, roomID)) === "denied") {
      io.to(socket.id).emit("access-denied");
      return;
    }
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

  // only relay into rooms the socket actually joined (and was allowed into)
  socket.on(
    "server-broadcast",
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      if (socket.rooms.has(roomID)) {
        socket.broadcast.to(roomID).emit("client-broadcast", encryptedData, iv);
      }
    },
  );

  socket.on(
    "server-volatile-broadcast",
    (roomID: string, encryptedData: ArrayBuffer, iv: Uint8Array) => {
      if (socket.rooms.has(roomID)) {
        socket.volatile.broadcast
          .to(roomID)
          .emit("client-broadcast", encryptedData, iv);
      }
    },
  );

  socket.on("user-follow", async (payload: OnUserFollowedPayload) => {
    if (typeof payload?.userToFollow?.socketId !== "string") {
      return;
    }
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
      if (roomID === socket.id) {
        continue;
      }
      const otherClients = (await io.in(roomID).fetchSockets()).filter(
        (s) => s.id !== socket.id,
      );
      if (!isFollowRoom(roomID) && otherClients.length > 0) {
        socket.broadcast.to(roomID).emit(
          "room-user-change",
          otherClients.map((s) => s.id),
        );
      }
      if (isFollowRoom(roomID) && otherClients.length === 0) {
        io.to(roomID.replace("follow@", "")).emit("broadcast-unfollow");
      }
      // everyone left a file: snapshot it into the version history
      if (!isFollowRoom(roomID) && otherClients.length === 0) {
        setTimeout(async () => {
          if ((await io.in(roomID).fetchSockets()).length === 0) {
            await createVersion(roomID).catch(console.error);
          }
        }, LEAVE_VERSION_DELAY_MS);
      }
    }
  });
});

// startup
// -----------------------------------------------------------------------------

// a failed DB call inside a socket handler must not take the server down
process.on("unhandledRejection", (error) => console.error(error));

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
      // dynamodb/s3 containers may still be starting
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
