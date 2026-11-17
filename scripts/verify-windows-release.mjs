import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function verifyWindowsRelease(directory, metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))) {
  const { version } = metadata;
  assert.match(version, /^\d+\.\d+\.\d+$/, "a stable version is required");
  const repository = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(metadata.repository.url);
  assert.ok(repository, "package.json must name the release repository");
  const update = parse(readFileSync(join(directory, "win-unpacked/resources/app-update.yml"), "utf8"));
  assert.equal(update.provider, "github", "updates must come from GitHub Releases");
  assert.equal(update.owner, repository[1], "wrong updater owner");
  assert.equal(update.repo, repository[2], "wrong updater repository");
  assert.equal(update.publisherName, undefined, "an unsigned Windows build cannot require a publisher signature");

  const feed = parse(readFileSync(join(directory, "latest.yml"), "utf8"));
  assert.equal(feed.version, version, "latest.yml must describe this build");
  assert.equal(feed.files?.length, 1, "expected one Windows installer");
  const [entry] = feed.files;
  const installer = `OpenMausBot-${version}-setup.exe`;
  assert.equal(entry.url, basename(entry.url), "the update asset must be a file name");
  assert.equal(entry.url, installer, "latest.yml must name the versioned installer");
  assert.equal(feed.path, installer, "the fallback update path must name the same installer");
  assert.equal(entry.size, statSync(join(directory, installer)).size, "installer size differs from latest.yml");
  const digest = createHash("sha512");
  for await (const chunk of createReadStream(join(directory, installer))) digest.update(chunk);
  const sha512 = digest.digest("base64");
  assert.equal(entry.sha512, sha512, "installer SHA-512 differs from latest.yml");
  assert.equal(feed.sha512, sha512, "fallback SHA-512 differs from the installer");
  assert.ok(statSync(join(directory, `${installer}.blockmap`)).size > 0, "the installer blockmap is missing");
  return { version, repository: `${update.owner}/${update.repo}`, installer, size: entry.size, sha512 };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyWindowsRelease(resolve(process.argv[2] ?? join(root, "release"))), null, 2));
}
