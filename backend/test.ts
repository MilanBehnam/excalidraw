// Integration check against a running local backend (DEV_FAKE_AUTH=true):
//   docker compose -f backend/docker-compose.yml exec backend node --test test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = process.env.BACKEND_URL || "http://localhost:3002";
const run = Date.now();

/** made-up logins, see auth.ts */
const login = (name: string) => {
  const email = `${name}-${run}@example.com`;
  return {
    email,
    token: `dev:${encodeURIComponent(email)}:${encodeURIComponent(name)}`,
  };
};

const api = (
  as: { token: string } | null,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) =>
  fetch(`${BASE}/api/${path}`, {
    ...init,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
    headers: {
      ...(as ? { authorization: `Bearer ${as.token}` } : {}),
      ...init.headers,
    },
  });

const alice = login("alice");
const bob = login("bob");
const carol = login("carol");

test("collections, sharing, access checks and versions", async () => {
  assert.equal((await api(null, "me")).status, 401);
  assert.equal((await api({ token: "dev:" }, "me")).status, 401);

  // alice creates a collection with a file
  const col = await api(alice, "collections", {
    method: "POST",
    json: { name: "Trip" },
  });
  assert.equal(col.status, 201);
  const { id: colId } = await col.json();
  const file = await api(alice, `collections/${colId}/files`, {
    method: "POST",
    json: { name: "Map" },
  });
  const { id: fileId } = await file.json();
  const info = await (await api(alice, `files/${fileId}`)).json();
  assert.equal(info.name, "Map");
  assert.equal(info.key.length, 22);

  // bob has no access yet: not via API, scene or images
  await api(bob, "me");
  assert.equal((await api(bob, `collections/${colId}`)).status, 403);
  assert.equal((await api(bob, `files/${fileId}`)).status, 403);
  assert.equal((await api(bob, `scenes/${fileId}`)).status, 403);
  assert.equal((await api(null, `scenes/${fileId}`)).status, 401);
  assert.equal(
    (await api(bob, `images/${fileId}/img`, { method: "PUT", body: "x" }))
      .status,
    403,
  );

  // only the owner can share; bob exists -> added, carol doesn't -> invited
  const shareWith = (as: typeof alice, email: string) =>
    api(as, "shares", {
      method: "POST",
      json: { kind: "col", id: colId, email },
    });
  assert.equal((await shareWith(bob, carol.email)).status, 403);
  assert.deepEqual(await (await shareWith(alice, bob.email)).json(), {
    status: "added",
  });
  assert.deepEqual(await (await shareWith(alice, carol.email)).json(), {
    status: "invited",
  });

  const bobMe = await (await api(bob, "me")).json();
  assert.deepEqual(
    bobMe.shared.map((c: any) => [c.id, c.ownerName]),
    [[colId, "alice"]],
  );
  // carol signs up later and finds the collection shared with her
  const carolMe = await (await api(carol, "me")).json();
  assert.deepEqual(
    carolMe.shared.map((c: any) => c.id),
    [colId],
  );

  // bob edits the same file; first save of a file starts its history
  const put = await api(bob, `scenes/${fileId}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(put.status, 200);
  const stale = await api(alice, `scenes/${fileId}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: new Uint8Array([9]),
  });
  assert.equal(stale.status, 412);
  const versions = await (await api(alice, `files/${fileId}/versions`)).json();
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0].by, ["bob"]);
  const version = await api(
    alice,
    `files/${fileId}/versions/${versions[0].id}`,
  );
  assert.deepEqual(
    new Uint8Array(await version.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );

  // members can edit but not delete or see who has access
  assert.equal(
    (
      await api(bob, `collections/${colId}/files/${fileId}`, {
        method: "DELETE",
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await api(bob, `collections/${colId}`)).json()).members,
    undefined,
  );
  const aliceView = await (await api(alice, `collections/${colId}`)).json();
  assert.deepEqual(aliceView.members.map((m: any) => m.name).sort(), [
    "alice",
    "bob",
    "carol",
  ]);

  // owner removes bob: access is gone everywhere
  const bobTarget = aliceView.members.find((m: any) => m.name === "bob").target;
  assert.equal(
    (
      await api(alice, "shares", {
        method: "DELETE",
        json: { kind: "col", id: colId, target: bobTarget },
      })
    ).status,
    204,
  );
  assert.equal((await api(bob, `scenes/${fileId}`)).status, 403);
  assert.deepEqual((await (await api(bob, "me")).json()).shared, []);

  // single-file share, then bob leaves it himself
  await api(alice, "shares", {
    method: "POST",
    json: { kind: "file", id: fileId, email: bob.email },
  });
  assert.deepEqual(
    (await (await api(bob, "me")).json()).sharedFiles.map((f: any) => f.name),
    ["Map"],
  );
  assert.equal((await api(bob, `scenes/${fileId}`)).status, 200);
  await api(bob, "shares", {
    method: "DELETE",
    json: { kind: "file", id: fileId, target: `member#dev-${bob.email}` },
  });
  assert.equal((await api(bob, `scenes/${fileId}`)).status, 403);

  // deleting the collection removes everything
  assert.equal(
    (await api(alice, `collections/${colId}`, { method: "DELETE" })).status,
    204,
  );
  // deleted files stay closed (their id can't be reused as a quick room)
  assert.equal((await api(alice, `files/${fileId}`)).status, 403);
  assert.equal(
    (
      await api(alice, `scenes/${fileId}`, {
        method: "PUT",
        headers: { "if-match": '"1"' },
        body: "x",
      })
    ).status,
    403,
  );
  assert.deepEqual((await (await api(carol, "me")).json()).shared, []);
});

test("quick live rooms: starting needs an account, joining doesn't", async () => {
  const room = `quick${run}`;
  const anonymous = await api(null, `scenes/${room}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: "x",
  });
  assert.equal(anonymous.status, 401);
  const started = await api(alice, `scenes/${room}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: "x",
  });
  assert.equal(started.status, 200);
  // a guest with the link can load and save it
  assert.equal((await api(null, `scenes/${room}`)).status, 200);
  const guestSave = await api(null, `scenes/${room}`, {
    method: "PUT",
    headers: { "if-match": '"1"' },
    body: "y",
  });
  assert.equal(guestSave.status, 200);
});

test("deleting an account removes what it owns", async () => {
  const dave = login("dave");
  const { id } = await (
    await api(dave, "collections", { method: "POST", json: { name: "D" } })
  ).json();
  assert.equal((await api(dave, "me", { method: "DELETE" })).status, 204);
  // signing in again starts empty; the old collection is gone
  assert.deepEqual((await (await api(dave, "me")).json()).owned, []);
  assert.equal((await api(dave, `collections/${id}`)).status, 404);
});
