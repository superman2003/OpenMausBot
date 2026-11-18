const CHANNEL = "browser:pick-files";
const UPLOAD_PATH = /^\/api\/bots\/[\w-]{1,128}\/browser\/upload$/;
const CHOOSER = /^[\w-]{1,64}$/;

export function installFilePickers({ ipcMain, localOnly, dialog, windowFor, t, browserUpload }) {
  ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
    const result = await dialog.showOpenDialog(windowFor(event.sender), {
      title: t("native.picker.workingFolder"),
      properties: ["openDirectory", "createDirectory"],
      ...(typeof current === "string" && current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }));
  if (!browserUpload) return;
  const { origin, request } = browserUpload;
  const uploading = new Set();
  ipcMain.handle(CHANNEL, localOnly(CHANNEL, async (event, address, multiple, accept) => {
    if (event.senderFrame !== event.sender.mainFrame || typeof address !== "string" || address.length > 2048) {
      throw new Error("Invalid browser file picker.");
    }
    const base = origin();
    const target = new URL(address, base);
    const chooser = target.searchParams.getAll("chooser");
    const threads = target.searchParams.getAll("threadId");
    if (target.origin !== base || target.username || target.password || target.hash || !UPLOAD_PATH.test(target.pathname)
      || chooser.length !== 1 || !CHOOSER.test(chooser[0]) || threads.length > 1
      || [...target.searchParams.keys()].some((key) => key !== "chooser" && key !== "threadId")) {
      throw new Error("Invalid browser file picker.");
    }
    if (typeof multiple !== "boolean" || typeof accept !== "string" || accept.length > 2048) {
      throw new Error("Invalid browser file picker.");
    }
    const owner = event.sender.id;
    if (uploading.has(owner)) throw new Error("A file selection is already in progress.");
    uploading.add(owner);
    try {
      const filters = browserFileFilters(accept);
      const selection = await dialog.showOpenDialog(windowFor(event.sender), {
        title: t("browser.page.chooseFilesLabel"),
        properties: ["openFile", ...(multiple ? ["multiSelections"] : [])],
        ...(filters.length ? { filters } : {}),
      });
      if (selection.canceled || !selection.filePaths.length) return false;
      if (selection.filePaths.length > 20 || (!multiple && selection.filePaths.length !== 1)) throw new Error("Choose up to 20 local files.");
      const response = await request(target.pathname + target.search, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: selection.filePaths }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 204) return true;
      const result = await response.json().catch(() => null);
      throw new Error(typeof result?.error === "string" ? result.error : "The browser could not take the selected files.");
    } finally {
      uploading.delete(owner);
    }
  }));
}

const ACCEPT_GROUPS = new Map([
  ["image/*", ["apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"]],
  ["audio/*", ["aac", "aif", "aiff", "flac", "m4a", "mid", "midi", "mp3", "oga", "ogg", "opus", "wav", "weba", "wma"]],
  ["video/*", ["3gp", "avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "ts", "webm", "wmv"]],
]);

function browserFileFilters(accept) {
  const values = new Set();
  for (const entry of accept.split(",")) {
    const value = entry.trim().toLowerCase();
    if (/^\.[a-z0-9][a-z0-9+_-]{0,19}$/.test(value)) values.add(value.slice(1));
    else {
      for (const extension of ACCEPT_GROUPS.get(value) ?? []) values.add(extension);
      const mime = /^([a-z0-9.+-]+)\/[a-z0-9.+-]+$/.exec(value);
      if (mime) for (const [group, extensions] of ACCEPT_GROUPS) if (mime[1] === group.slice(0, -2)) {
        for (const extension of extensions) values.add(extension);
      }
    }
  }
  return values.size ? [{ name: "Accepted files", extensions: [...values] }] : [];
}
