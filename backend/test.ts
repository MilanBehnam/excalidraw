// Integration check against a running backend (see README):
//   docker compose -f backend/docker-compose.yml exec backend node --test test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

const URL_ = process.env.BACKEND_URL || "http://localhost:3002";
const PASSCODE = process.env.PASSCODE || "";

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}/api/${path}`, {
    ...init,
    headers: { "x-passcode": PASSCODE, ...init.headers },
  });

test("collection → file → scene → image → delete", async () => {
  const col = await api("collections", {
    method: "POST",
    body: JSON.stringify({ name: "enc-name" }),
  });
  assert.equal(col.status, 201);
  const { id } = await col.json();

  const file = await api(`collections/${id}/files`, {
    method: "POST",
    body: JSON.stringify({ name: "enc-file" }),
  });
  assert.equal(file.status, 201);
  const { id: fileId } = await file.json();

  // fresh file has no scene yet; friends (no passcode) can create it
  assert.equal((await fetch(`${URL_}/api/scenes/${fileId}`)).status, 404);
  const put = await fetch(`${URL_}/api/scenes/${fileId}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: new Uint8Array([1, 2, 3]),
  });
  assert.equal(put.status, 200);
  assert.equal(put.headers.get("etag"), '"1"');

  // stale revision is rejected
  const stale = await api(`scenes/${fileId}`, {
    method: "PUT",
    headers: { "if-match": '"0"' },
    body: new Uint8Array([9]),
  });
  assert.equal(stale.status, 412);

  const get = await api(`scenes/${fileId}`);
  assert.deepEqual(
    new Uint8Array(await get.arrayBuffer()),
    new Uint8Array([1, 2, 3]),
  );

  assert.equal(
    (
      await fetch(`${URL_}/api/files/${fileId}/img1`, {
        method: "PUT",
        body: "png",
      })
    ).status,
    200,
  );
  assert.equal(await (await api(`files/${fileId}/img1`)).text(), "png");

  const listed = await (await api(`collections/${id}`)).json();
  assert.deepEqual(
    [listed.name, listed.files.map((f: any) => f.name)],
    ["enc-name", ["enc-file"]],
  );

  assert.equal(
    (await api(`collections/${id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal((await api(`collections/${id}`)).status, 404);
  assert.equal((await api(`scenes/${fileId}`)).status, 404);
  assert.equal((await api(`files/${fileId}/img1`)).status, 404);
});

test(
  "passcode guards new collections and standalone rooms",
  { skip: !PASSCODE },
  async () => {
    const col = await fetch(`${URL_}/api/collections`, {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    assert.equal(col.status, 401);
    const room = await fetch(`${URL_}/api/scenes/standalone${Date.now()}`, {
      method: "PUT",
      headers: { "if-match": '"0"' },
      body: "x",
    });
    assert.equal(room.status, 401);
  },
);
