#!/usr/bin/env node
// Downloads the Xray-core binary used as the Tauri sidecar.
//
// The binary is ~25 MB, so it is not committed: run `npm run fetch:xray` once
// after cloning (or when bumping XRAY_VERSION). The file lands in
// src-tauri/binaries/ named with the Rust target triple, which is the layout
// Tauri expects for `bundle.externalBin`.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const XRAY_VERSION = "v26.10.21";

const PLATFORMS = {
  "x86_64-pc-windows-msvc": { asset: "Xray-windows-64.zip", binary: "xray.exe" },
  "aarch64-pc-windows-msvc": { asset: "Xray-windows-arm64-v8a.zip", binary: "xray.exe" },
  "x86_64-unknown-linux-gnu": { asset: "Xray-linux-64.zip", binary: "xray" },
  "aarch64-unknown-linux-gnu": { asset: "Xray-linux-arm64-v8a.zip", binary: "xray" },
  "x86_64-apple-darwin": { asset: "Xray-mac-amd64.zip", binary: "xray" },
  "aarch64-apple-darwin": { asset: "Xray-mac-arm64-v8a.zip", binary: "xray" },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const binariesDir = join(scriptDir, "..", "src-tauri", "binaries");
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

async function main() {
  const triple = hostTriple();
  const platform = PLATFORMS[triple];
  if (!platform) {
    throw new Error(`Unsupported target triple: ${triple}`);
  }

  const target = join(binariesDir, `xray-${triple}${triple.includes("windows") ? ".exe" : ""}`);
  if (existsSync(target) && !force) {
    console.log(`already present: ${target}`);
    console.log("pass --force to re-download");
    return;
  }

  const url = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${platform.asset}`;
  console.log(`downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);

  const workDir = mkdtempSync(join(tmpdir(), "xray-"));
  try {
    const archive = join(workDir, platform.asset);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    console.log(`sha256 ${await sha256(archive)}`);

    if (triple.includes("windows")) {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${workDir}'`],
        { stdio: "inherit" },
      );
    } else {
      execFileSync("unzip", ["-oq", archive, "-d", workDir], { stdio: "inherit" });
    }

    mkdirSync(binariesDir, { recursive: true });
    const extracted = join(workDir, platform.binary);
    writeFileSync(target, readFileSync(extracted));
    if (!triple.includes("windows")) execFileSync("chmod", ["755", target]);

    const version = execFileSync(target, ["version"], { encoding: "utf8" }).trim();
    console.log(`installed ${target} (${version})`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
