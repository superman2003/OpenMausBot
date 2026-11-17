import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { verifyWindowsRelease } from "./verify-windows-release.mjs";

const directories = [];
const metadata = { version: "0.1.166", repository: { url: "https://github.com/superman2003/OpenMausBot.git" } };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omb-update-release-"));
  directories.push(directory);
  mkdirSync(join(directory, "win-unpacked/resources"), { recursive: true });
  writeFileSync(join(directory, "win-unpacked/resources/app-update.yml"), stringify({ provider: "github", owner: "superman2003", repo: "OpenMausBot" }));
  const installer = "OpenMausBot-0.1.166-setup.exe";
  const bytes = Buffer.from("fixture installer");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  writeFileSync(join(directory, installer), bytes);
  writeFileSync(join(directory, `${installer}.blockmap`), "fixture blockmap");
  writeFileSync(join(directory, "latest.yml"), stringify({ version: metadata.version, files: [{ url: installer, sha512, size: bytes.length }], path: installer, sha512 }));
  return directory;
}

function edit(directory, name, mutate) {
  const file = join(directory, name);
  const value = parse(readFileSync(file, "utf8"));
  mutate(value);
  writeFileSync(file, stringify(value));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("accepts an installer whose update destination and both feed hashes match", async () => {
  await expect(verifyWindowsRelease(fixture(), metadata)).resolves.toMatchObject({ version: "0.1.166", repository: "superman2003/OpenMausBot" });
});

it("rejects a build still following the upstream updater", async () => {
  const directory = fixture();
  edit(directory, "win-unpacked/resources/app-update.yml", (update) => { update.owner = "milind-soni"; });
  await expect(verifyWindowsRelease(directory, metadata)).rejects.toThrow("wrong updater owner");
});

it("rejects a stale feed or fallback hash and changed installer bytes", async () => {
  for (const [mutate, error] of [
    [(feed) => { feed.version = "0.1.165"; }, "latest.yml must describe this build"],
    [(feed) => { feed.sha512 = "stale"; }, "fallback SHA-512"],
  ]) {
    const directory = fixture();
    edit(directory, "latest.yml", mutate);
    await expect(verifyWindowsRelease(directory, metadata)).rejects.toThrow(error);
  }
  const directory = fixture();
  writeFileSync(join(directory, "OpenMausBot-0.1.166-setup.exe"), "changed installer");
  await expect(verifyWindowsRelease(directory, metadata)).rejects.toThrow("installer SHA-512");
});

it("requires the blockmap and rejects signatures required by an unsigned installer", async () => {
  const directory = fixture();
  rmSync(join(directory, "OpenMausBot-0.1.166-setup.exe.blockmap"));
  await expect(verifyWindowsRelease(directory, metadata)).rejects.toThrow();
  edit(directory, "win-unpacked/resources/app-update.yml", (update) => { update.publisherName = "Other publisher"; });
  await expect(verifyWindowsRelease(directory, metadata)).rejects.toThrow("publisher signature");
});
