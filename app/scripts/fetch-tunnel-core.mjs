#!/usr/bin/env node
// Fetches the prebuilt tunnel engine used as the Tauri sidecar: the executable,
// the Wintun driver library its TUN inbound loads on Windows, and the license
// texts that have to travel with them.
//
// Binaries are not committed: run `npm run fetch:tunnel` once after cloning (or
// when bumping CORE_VERSION). Everything lands in src-tauri/binaries/, with the
// sidecar renamed to `tunnel-core-<triple>` because that is the name Tauri
// expects from `bundle.externalBin`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Version pin: must stay in step with the source tree under `vendor/`. */
const CORE_VERSION = "v26.10.21";
const SIDECAR_NAME = "tunnel-core";

// `core` is the file name inside the release archive; we rename it on the way
// out. `wintun` marks the archives that bundle the driver library.
const PLATFORMS = {
  "x86_64-pc-windows-msvc": { asset: "Xray-windows-64.zip", core: "xray.exe", wintun: true },
  "aarch64-pc-windows-msvc": { asset: "Xray-windows-arm64-v8a.zip", core: "xray.exe", wintun: true },
  "x86_64-unknown-linux-gnu": { asset: "Xray-linux-64.zip", core: "xray" },
  "aarch64-unknown-linux-gnu": { asset: "Xray-linux-arm64-v8a.zip", core: "xray" },
  "x86_64-apple-darwin": { asset: "Xray-mac-amd64.zip", core: "xray" },
  "aarch64-apple-darwin": { asset: "Xray-mac-arm64-v8a.zip", core: "xray" },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const binariesDir = join(scriptDir, "..", "src-tauri", "binaries");
const licensesDir = join(binariesDir, "licenses");
const force = process.argv.includes("--force");

function hostTriple() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) throw new Error("Cannot detect the Rust target triple (run `rustc -vV`)");
  return match[1].trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function unzip(archive, workDir, triple) {
  if (triple.includes("windows")) {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${workDir}'`],
      { stdio: "inherit" },
    );
  } else {
    execFileSync("unzip", ["-oq", archive, "-d", workDir], { stdio: "inherit" });
  }
}

async function fetchArchive(url, workDir) {
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  const archive = join(workDir, url.split("/").pop());
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  console.log(`sha256 ${await sha256(archive)}`);
  return archive;
}

/** Drops the pre-rename sidecar so stale copies cannot be picked up. */
function removeLegacy(triple, suffix) {
  for (const name of [`xray-${triple}${suffix}`, `xray.exe`, `xray`]) {
    const path = join(binariesDir, name);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      console.log(`removed legacy ${path}`);
    }
  }
}

async function main() {
  const triple = hostTriple();
  const platform = PLATFORMS[triple];
  if (!platform) {
    throw new Error(`Unsupported target triple: ${triple}`);
  }

  const suffix = triple.includes("windows") ? ".exe" : "";
  const core = join(binariesDir, `${SIDECAR_NAME}-${triple}${suffix}`);
  const engineLicense = join(licensesDir, "engine.txt");
  const wintun = join(binariesDir, "wintun.dll");
  const wintunLicense = join(licensesDir, "wintun.txt");

  const targets = [core, engineLicense, ...(platform.wintun ? [wintun, wintunLicense] : [])];
  if (!force && targets.every(existsSync)) {
    console.log(`already present: ${core}`);
    console.log("pass --force to re-download");
    return;
  }

  const url = `https://github.com/XTLS/Xray-core/releases/download/${CORE_VERSION}/${platform.asset}`;
  const workDir = mkdtempSync(join(tmpdir(), "tunnel-core-"));
  try {
    const archive = await fetchArchive(url, workDir);
    unzip(archive, workDir, triple);

    mkdirSync(licensesDir, { recursive: true });
    writeFileSync(core, readFileSync(join(workDir, platform.core)));
    if (!platform.wintun) execFileSync("chmod", ["755", core]);
    writeFileSync(engineLicense, readFileSync(join(workDir, "LICENSE")));

    if (platform.wintun) {
      // The release bundles a driver build that matches the engine, so it comes
      // from the same archive instead of a second download.
      writeFileSync(wintun, readFileSync(join(workDir, "wintun.dll")));
      writeFileSync(wintunLicense, readFileSync(join(workDir, "LICENSE-Wintun")));
    }

    removeLegacy(triple, suffix);

    const version = execFileSync(core, ["version"], { encoding: "utf8" }).trim().split("\n")[0];
    console.log(`installed ${core} (${version})`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
