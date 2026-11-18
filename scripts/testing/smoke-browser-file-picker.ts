import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { installFilePickers } from "../../electron/file-pickers.mjs";
import { BrowserLive } from "../../server/browser-live.ts";
import { relay } from "../../server/browser-relay.ts";
import { BrowserRuntime, type BrowserSpawnSpec } from "../../server/browser-runtime.ts";
import { json, readBody } from "../../server/harness/http.ts";
import type { RequestAuth } from "../../server/request-auth.ts";
import { createBrowserViewerRoutes } from "../../server/routes/browser-viewers.ts";
import { dispatchRoutes } from "../../server/routes/table.ts";
import { createUpgrades } from "../../server/routes/upgrades.ts";

const LOCAL = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;

export async function verifyBrowserFilePicker(options: {
  spec: BrowserSpawnSpec;
  dataDir: string;
  localFile: string;
  button: { x: number; y: number };
  readFiles: () => Promise<unknown>;
}): Promise<void> {
  const { spec, dataDir, localFile, button, readFiles } = options;
  const desktopToken = randomBytes(32).toString("base64url");
  const session = spec.env.AGENT_BROWSER_SESSION!;
  const runtime = new BrowserRuntime();
  const live = new BrowserLive({ runtime, devTools: {
    filePickers: true,
    url: (port) => relay(port, { action: "cdp_url" }, { timeoutMs: 5_000, maxBytes: 65_536 }).then((answer) => answer.data?.cdpUrl),
  } });
  const route = createBrowserViewerRoutes({
    upgrades: createUpgrades(),
    dataDir,
    desktopUploadToken: () => desktopToken,
    person: () => "local-owner",
    audience: () => "team",
    browser: async (botId) => ({ botId, session, spec: { ...spec, env: { ...spec.env } } }),
    authorize: async () => null,
    current: () => true,
    restartRefusal: () => null,
    viewers: {
      open: (view) => live.open(view),
      action: (input) => live.action(input),
      stream: () => false,
      fileChooserOffered: (_browser, owner, chooser) => live.fileChooserOffered(session, owner, chooser),
      answerFileChooser: (_browser, owner, chooser, paths) => live.answerFileChooser(session, owner, chooser, paths),
      download: () => undefined,
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: LOCAL, json, readBody })
      .then((matched) => { if (!matched) json(res, 404, { error: "no route" }); })
      .catch((error: Error & { status?: number }) => {
        if (!res.headersSent) json(res, error.status ?? 500, { error: error.message });
        else res.destroy(error);
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const base = origin + "/api/bots/pepper/browser";
  const abort = new AbortController();
  try {
    const response = await fetch(base + "/live?filePicker=1", {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    async function event<T>(name: string): Promise<T> {
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) {
          const { value, done } = await reader.read();
          assert(!done, "The viewer disconnected while waiting for " + name);
          buffer += value;
          continue;
        }
        const packet = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = packet.split("\n");
        assert.notEqual(lines[0], "event: error", packet);
        if (lines[0] === "event: " + name) return JSON.parse(lines[1]!.slice("data: ".length)) as T;
      }
    }
    const { viewerId } = await event<{ viewerId: string }>("ready");
    const action = async (body: Record<string, unknown>) => {
      const result = await fetch(base + "/action", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, viewerId }), signal: AbortSignal.timeout(8_000) });
      assert.equal(result.status, 200, await result.text());
    };
    const click = () => action({ type: "input_batch", events: ["mousePressed", "mouseReleased"].map((eventType) => ({
      type: "input_mouse", eventType, ...button, button: "left", clickCount: 1,
    })) });
    const choose = async () => {
      await click();
      const offer = await event<{ id: string; accept: string; multiple: boolean }>("fileChooser");
      assert.equal(offer.accept, "video/mp4");
      assert.equal(offer.multiple, false);
      return offer;
    };
    const upload = (id: string, body: FormData) => fetch(base + "/upload?" + new URLSearchParams({ chooser: id }), {
      method: "POST", body, signal: AbortSignal.timeout(8_000),
    });

    await action({ type: "take" });
    const cancelled = await choose();
    assert.equal((await upload(cancelled.id, new FormData())).status, 204);
    assert.deepEqual(await event("fileChooserClosed"), { id: cancelled.id });
    assert.deepEqual(await readFiles(), { draft: "Bundled browser works", files: [] });

    const picked = await choose();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const body = new FormData();
    body.append("file", new Blob([bytes], { type: "video/mp4" }), "fixture-video.mp4");
    assert.equal((await upload(cancelled.id, body)).status, 409);
    const answer = await upload(picked.id, body);
    assert.equal(answer.status, 204, await answer.text());
    assert.deepEqual(await event("fileChooserClosed"), { id: picked.id });
    assert.deepEqual(await readFiles(), { draft: "Bundled browser works", files: [{ name: "fixture-video.mp4", size: bytes.length }] });

    const handlers = new Map<string, (event: unknown, address: string, multiple: boolean, accept: string) => Promise<boolean>>();
    let pickerOptions: Record<string, unknown> | undefined;
    installFilePickers({
      ipcMain: { handle: (channel: string, handler: (event: unknown, address: string, multiple: boolean, accept: string) => Promise<boolean>) => handlers.set(channel, handler) },
      localOnly: (_channel: string, handler: unknown) => handler,
      dialog: { showOpenDialog: async (_window: unknown, options: Record<string, unknown>) => {
        pickerOptions = options;
        return { canceled: false, filePaths: [localFile] };
      } },
      windowFor: () => undefined,
      t: (key: string) => key,
      browserUpload: {
        origin: () => origin,
        request: (path: string, init: RequestInit) => fetch(origin + path, { ...init, headers: { ...init.headers, "x-openmausbot-desktop-owner": desktopToken } }),
      },
    });
    const disk = await choose();
    const root = {};
    const main = { sender: { mainFrame: root }, senderFrame: root };
    const pickFiles = handlers.get("browser:pick-files")!;
    const address = base + "/upload?" + new URLSearchParams({ chooser: disk.id });
    await assert.rejects(pickFiles({ ...main, senderFrame: {} }, address, false, "video/mp4"), /Invalid browser file picker/);
    await assert.rejects(pickFiles(main, "/api/config?chooser=" + disk.id, false, "video/mp4"), /Invalid browser file picker/);
    assert.equal(await pickFiles(main, address, disk.multiple, disk.accept), true);
    assert.equal(pickerOptions?.title, "browser.page.chooseFilesLabel");
    assert.deepEqual(pickerOptions?.properties, ["openFile"]);
    assert.equal((pickerOptions?.filters as Array<{ extensions?: string[] }> | undefined)?.[0]?.extensions?.includes("mp4"), true);
    assert.deepEqual(await event("fileChooserClosed"), { id: disk.id });
    assert.deepEqual(await readFiles(), { draft: "Bundled browser works", files: [{ name: basename(localFile), size: (await stat(localFile)).size }] });
    await action({ type: "release" });
  } finally {
    abort.abort();
    live.closeAll();
    await runtime.closeAll();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}
