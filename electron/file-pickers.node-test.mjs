import assert from "node:assert/strict";
import test from "node:test";

import { installFilePickers } from "./file-pickers.mjs";

function fixture({ token = "random-local-token", origin = "http://127.0.0.1:4100" } = {}) {
  const handlers = new Map();
  const requests = [];
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const localOnly = (channel, handler) => (event, ...args) => {
    assert.equal(event.local, true, `${channel} stays bound to the local Electron page`);
    return handler(event, ...args);
  };
  installFilePickers({
    ipcMain,
    localOnly,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ["C:\\Videos\\final.mp4"] }) },
    windowFor: () => undefined,
    t: key => key,
    browserUpload: {
      origin: () => origin,
      request: async (path, init) => {
        requests.push({ path, init });
        return new Response(null, { status: 204 });
      },
      token,
    },
  });
  const run = (event, address, multiple, accept) => handlers.get("browser:pick-files")(event, address, multiple, accept);
  return { handlers, requests, run };
}

test("passes chosen Windows file paths to the trusted local server without reading file bytes in the renderer", async () => {
  const state = fixture();
  const address = "http://127.0.0.1:4100/api/bots/release-bot/browser/upload?chooser=picker_1&threadId=team-chat";
  const frame = {}, event = { local: true, senderFrame: frame, sender: { mainFrame: frame } };
  assert.equal(await state.run(event, address, false, "video/*"), true);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].path, "/api/bots/release-bot/browser/upload?chooser=picker_1&threadId=team-chat");
  assert.equal(state.requests[0].init.method, "PUT");
  assert.deepEqual(JSON.parse(state.requests[0].init.body), { files: ["C:\\Videos\\final.mp4"] });
});

test("requires a local main-frame caller and limits destinations to the active picker route", async () => {
  const state = fixture();
  const frame = {}, event = { local: true, senderFrame: frame, sender: { mainFrame: frame } };
  for (const [address, multiple, accept] of [
    ["https://127.0.0.1:4100/api/bots/release-bot/browser/upload?chooser=picker_1", false, "video/*"],
    ["http://127.0.0.1:4100/api/internal/browser/mcp?chooser=picker_1", false, "video/*"],
    ["http://127.0.0.1:4100/api/bots/release-bot/browser/upload?chooser=../other", false, "video/*"],
    ["http://remote.example/api/bots/release-bot/browser/upload?chooser=picker_1", false, "video/*"],
  ]) await assert.rejects(state.run(event, address, multiple, accept));

  assert.throws(() => state.run({ ...event, local: false }, "http://127.0.0.1:4100/api/bots/release-bot/browser/upload?chooser=picker_1", false, "video/*"));
  assert.equal(state.requests.length, 0);
});
