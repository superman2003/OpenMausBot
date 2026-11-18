// One-off dependency build, not part of normal app packaging. After native
// Windows verification, publish these bytes and pin their digest in the app.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executableTarget } from "./prepare-cloudflared.mjs";
import { bundleInventory, releaseBytes } from "./prepare-browser.mjs";
import { AGENT_BROWSER_WINDOWS_VERSION } from "../server/browser-engine-release.ts";

export const WINDOWS_VENDOR_VERSION = AGENT_BROWSER_WINDOWS_VERSION;
export const WINDOWS_VENDOR_TARGET = "x86_64-pc-windows-gnu";
export const WINDOWS_VENDOR_NATIVE_TARGET = "x86_64-pc-windows-msvc";
export const WINDOWS_VENDOR_SOURCE = {
  commit: "eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
  asset: "agent-browser-eb05921bad874cd2a1b4fa5d1149f1ed26576cae.tar.gz",
  url: "https://codeload.github.com/vercel-labs/agent-browser/tar.gz/eb05921bad874cd2a1b4fa5d1149f1ed26576cae",
  bytes: 1904718,
  sha256: "ed24a72a5260d9c1ea454cd849c44159bac570a6939ac645e4c5bdb98a421646",
};
export const WINDOWS_VENDOR_PATCH_SHA256 = "1effd70af2c7918eebfb656bdc8e93577f2e4a2cc589366b18b2448da696f39d";
export const WINDOWS_VENDOR_RUST = "1.97.1";
export const WINDOWS_VENDOR_PNPM = "11.1.3";
const repository = fileURLToPath(new URL("../", import.meta.url));
const patchPath = join(repository, "third_party/browser/agent-browser-windows-stdio.patch");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseVendorBuildArgs(args) {
  if (args.length !== 2 || args[0] !== "--output" || !isAbsolute(args[1])) {
    throw new Error("Usage: node scripts/build-windows-browser-vendor.mjs --output ABSOLUTE_NEW_DIRECTORY");
  }
  return resolve(args[1]);
}

export function verifyVendorPatch(bytes) {
  assert.equal(digest(bytes), WINDOWS_VENDOR_PATCH_SHA256, "Windows vendor patch failed pinned SHA-256 verification");
}

// Candidate artifacts are tested before their executable digest is committed
// to the normal release resolver. This verifies build identity and transport
// integrity, not publication approval; normal packaging never uses this path.
export function verifyVendorCandidate(provenance, bytes) {
  assert.equal(provenance.version, WINDOWS_VENDOR_VERSION);
  assert([WINDOWS_VENDOR_TARGET, WINDOWS_VENDOR_NATIVE_TARGET].includes(provenance.target), "Unexpected Windows vendor build target");
  assert.deepEqual(provenance.source, WINDOWS_VENDOR_SOURCE);
  assert.equal(provenance.patch.sha256, WINDOWS_VENDOR_PATCH_SHA256);
  assert.equal(provenance.executable.asset, "agent-browser-win32-x64.exe");
  assert.equal(provenance.executable.bytes, bytes.length, "Candidate executable size differs from build provenance");
  assert.equal(provenance.executable.sha256, digest(bytes), "Candidate executable SHA-256 differs from build provenance");
}

function command(file, args, cwd, { input, capture = false } = {}) {
  const result = spawnSync(file, args, {
    cwd, input, encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024,
    stdio: capture || input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: "x86_64-w64-mingw32-gcc" },
  });
  if (result.error || result.status !== 0) throw new Error(`${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim() ?? "";
}

export async function buildWindowsBrowserVendor(output) {
  const native = process.platform === "win32";
  assert(native || process.platform === "linux", "The Windows vendor build needs a Windows or Linux host");
  assert.equal(process.arch, "x64", "The Windows vendor build needs an x64 host");
  const target = native ? WINDOWS_VENDOR_NATIVE_TARGET : WINDOWS_VENDOR_TARGET;
  const pnpmCli = process.env.OMB_VENDOR_PNPM_CLI;
  assert(!native || (pnpmCli && isAbsolute(pnpmCli)), "Set OMB_VENDOR_PNPM_CLI to the absolute path of the pinned pnpm CLI on Windows");
  const runPnpm = (args, cwd, options) => native
    ? command(process.execPath, [pnpmCli, ...args], cwd, options)
    : command("pnpm", args, cwd, options);
  assert(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or later is required");
  assert(isAbsolute(output) && !existsSync(output), "Output must be a new absolute directory; existing artifacts are never overwritten");
  const patch = readFileSync(patchPath);
  verifyVendorPatch(patch);
  const rust = command("rustc", ["--version"], repository, { capture: true });
  const cargo = command("cargo", ["--version"], repository, { capture: true });
  const mingw = native ? null : command("x86_64-w64-mingw32-gcc", ["--version"], repository, { capture: true }).split("\n")[0];
  const linker = native ? "MSVC" : command("x86_64-w64-mingw32-ld", ["--version"], repository, { capture: true }).split("\n")[0];
  assert(rust.startsWith(`rustc ${WINDOWS_VENDOR_RUST} `), `Expected Rust ${WINDOWS_VENDOR_RUST}, got ${rust}`);
  assert(cargo.startsWith(`cargo ${WINDOWS_VENDOR_RUST} `), `Expected Cargo ${WINDOWS_VENDOR_RUST}, got ${cargo}`);
  const scratch = mkdtempSync(join(tmpdir(), "omb-browser-vendor-"));
  try {
    const source = join(scratch, "source");
    mkdirSync(source);
    const archive = join(scratch, WINDOWS_VENDOR_SOURCE.asset);
    writeFileSync(archive, await releaseBytes(WINDOWS_VENDOR_SOURCE, process.env.OMB_BROWSER_ARCHIVE_DIR));
    command("tar", ["-xzf", archive, "--strip-components=1", "-C", source], scratch);
    command("git", ["apply", "--check", "-"], source, { input: patch });
    command("git", ["apply", "--whitespace=error-all", "-"], source, { input: patch });
    const pnpm = runPnpm(["--version"], source, { capture: true });
    assert.equal(pnpm, WINDOWS_VENDOR_PNPM, `Expected pnpm ${WINDOWS_VENDOR_PNPM}`);
    // Keep the real upstream dashboard: build.rs otherwise silently embeds a
    // placeholder. The frozen pnpm lock and Cargo --locked retain dependencies.
    runPnpm(["install", "--frozen-lockfile", "--ignore-scripts"], source);
    runPnpm(["--filter", "dashboard", "build"], source);
    const dashboard = join(source, "packages/dashboard/out");
    assert(!readFileSync(join(dashboard, "index.html"), "utf8").includes("Dashboard not built"));
    command("cargo", ["build", "--locked", "--release", "--manifest-path", "cli/Cargo.toml", "--target", target], source);
    const targetDirectory = resolve(source, process.env.CARGO_TARGET_DIR ?? "cli/target");
    const binary = join(targetDirectory, target, "release/agent-browser.exe");
    const bytes = readFileSync(binary);
    assert.equal(executableTarget(bytes), "win32-x64", "Vendor build did not produce a Windows x64 executable");
    mkdirSync(output, { recursive: true });
    const asset = "agent-browser-win32-x64.exe";
    copyFileSync(binary, join(output, asset));
    const testArtifacts = command("cargo", ["test", "--bin", "agent-browser", "--locked", "--release", "--no-run", "--message-format=json", "--manifest-path", "cli/Cargo.toml", "--target", target], source, { capture: true })
      .split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.reason === "compiler-artifact" && entry.profile?.test && entry.executable);
    assert.equal(testArtifacts.length, 1, "Expected one native vendor regression-test binary");
    copyFileSync(testArtifacts[0].executable, join(output, "agent-browser-tests.exe"));
    for (const [from, to] of [
      ["LICENSE", "agent-browser-LICENSE.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core.txt", "LICENSE-axe-core.txt"],
      ["cli/src/native/a11y/LICENSE-axe-core-THIRD-PARTY.txt", "LICENSE-axe-core-THIRD-PARTY.txt"],
    ]) copyFileSync(join(source, from), join(output, to));
    copyFileSync(patchPath, join(output, "agent-browser-windows-stdio.patch"));
    copyFileSync(join(repository, "third_party/browser/README.md"), join(output, "README.md"));
    const provenance = {
      schemaVersion: 1, version: WINDOWS_VENDOR_VERSION, target,
      source: WINDOWS_VENDOR_SOURCE,
      patch: { upstream: "https://github.com/vercel-labs/agent-browser/pull/1781", commit: "81a98c349d04195396ffae6898bd375ad64280de", sha256: WINDOWS_VENDOR_PATCH_SHA256, scope: "Windows handle inheritance and direct Chrome launch without a console" },
      toolchain: { rust, cargo, pnpm, node: process.version, mingw, linker },
      cargoLockSha256: digest(readFileSync(join(source, "cli/Cargo.lock"))),
      pnpmLockSha256: digest(readFileSync(join(source, "pnpm-lock.yaml"))),
      dashboardInventorySha256: digest(JSON.stringify(bundleInventory(dashboard))),
      executable: { asset, bytes: bytes.length, sha256: digest(bytes) },
    };
    writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(JSON.stringify(provenance, null, 2));
    return provenance;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildWindowsBrowserVendor(parseVendorBuildArgs(process.argv.slice(2)));
}
