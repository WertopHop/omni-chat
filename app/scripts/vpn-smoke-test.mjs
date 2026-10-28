/**
 * End-to-end check of the VPN path, without the desktop shell:
 * gateway profile endpoint -> local tunnel sidecar (proxy mode) -> a request
 * that leaves through the tunnel. The full tunnel config is validated as well,
 * since starting it needs administrator rights and cannot run here.
 *
 * Run against a local stack:
 *   set NODE_EXTRA_CA_CERTS=..\server\generated\caddy-root.crt
 *   npm run smoke:vpn
 *
 * The rendered config mirrors src-tauri/src/vpn.rs (same inbounds/outbound),
 * so a failure here means the tunnel itself is misconfigured, not the UI.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverUrl = (process.env.SERVER_URL ?? "https://localhost").replace(/\/+$/, "");
const base = `${serverUrl}/api`;
const SOCKS_PORT = 19080;
const HTTP_PORT = 19081;

function readAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;

  const envPath = resolve(here, "../../server/.env");
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("ADMIN_TOKEN="));
  if (!line) throw new Error(`ADMIN_TOKEN is not set in ${envPath}`);
  return line.slice("ADMIN_TOKEN=".length).replace(/^['"]|['"]$/g, "");
}

function sidecarPath() {
  const dir = resolve(here, "../src-tauri/binaries");
  const binary = readdirSync(dir).find((name) => name.startsWith("tunnel-core-"));
  if (!binary) {
    throw new Error(`the tunnel sidecar is missing in ${dir}: run "npm run fetch:tunnel"`);
  }
  return join(dir, binary);
}

function renderConfig(profile, mode = "proxy") {
  const inbounds = [
    { tag: "socks", listen: "127.0.0.1", port: SOCKS_PORT, protocol: "socks", settings: { auth: "noauth", udp: false } },
    { tag: "http", listen: "127.0.0.1", port: HTTP_PORT, protocol: "http" },
  ];

  if (mode === "tun") {
    inbounds.push({
      tag: "tun",
      port: 0,
      protocol: "tun",
      settings: {
        name: "omni-chat",
        desc: "Wintun",
        mtu: 1500,
        dns: ["1.1.1.1"],
        autoSystemRoutingTable: ["0.0.0.0/0", "::/0"],
        autoSystemWfpBlockLeak: ["dns"],
      },
    });
  }

  return {
    log: { loglevel: "warning" },
    inbounds,
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: profile.host,
              port: profile.port,
              users: [{ id: profile.uuid, encryption: "none", flow: profile.flow || null }],
            },
          ],
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            serverName: profile.reality.serverName,
            fingerprint: profile.reality.fingerprint || "chrome",
            publicKey: profile.reality.publicKey,
            shortId: profile.reality.shortId,
          },
        },
      },
      { tag: "direct", protocol: "freedom" },
      { tag: "block", protocol: "blackhole" },
    ],
    routing: {
      domainStrategy: "AsIs",
      // Explicit ranges instead of geoip:private: the sidecar has no geoip.dat.
      rules: [
        {
          type: "field",
          ip: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
            "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"],
          outboundTag: "direct",
        },
      ],
    },
  };
}

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolvePromise();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} did not open`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

const suffix = Date.now().toString(36);
const username = `vpn${suffix}`;
const password = `vpn-pass-${suffix}`;

const invite = await api("/admin/invites", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Admin-Token": readAdminToken() },
  body: JSON.stringify({ code: `vpn-${suffix}` }),
});
const session = await api("/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password, invite: invite.code }),
});
console.log(`account: ${username}`);

const anonymous = await fetch(`${base}/vpn/profile`);
console.log(`profile without session: ${anonymous.status}`);
if (anonymous.status !== 401) throw new Error("profile endpoint must reject anonymous callers");

const profileResponse = await fetch(`${base}/vpn/profile`, {
  headers: { "X-Session-Token": session.token },
});
if (!profileResponse.ok) throw new Error(`profile -> ${profileResponse.status}`);
const profile = await profileResponse.json();
console.log(`profile: ${profile.name} ${profile.host}:${profile.port} (reality ${profile.reality.serverName})`);
const workDir = mkdtempSync(join(tmpdir(), "omni-vpn-"));
const configPath = join(workDir, "tunnel.json");
writeFileSync(configPath, JSON.stringify(renderConfig(profile), null, 2));

const tunConfigPath = join(workDir, "tunnel-tun.json");
writeFileSync(tunConfigPath, JSON.stringify(renderConfig(profile, "tun"), null, 2));
execFileSync(sidecarPath(), ["-test", "-c", tunConfigPath], { stdio: "pipe" });
console.log("full tunnel config: valid");

const core = spawn(sidecarPath(), ["-c", configPath], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
core.stdout.on("data", (chunk) => (output += chunk.toString()));
core.stderr.on("data", (chunk) => (output += chunk.toString()));

try {
  await waitForPort(SOCKS_PORT);
  console.log(`socks ready on 127.0.0.1:${SOCKS_PORT}`);

  const response = execFileSync(
    "curl",
    ["-s", "--max-time", "25", "--socks5-hostname", `127.0.0.1:${SOCKS_PORT}`, "https://api.ipify.org"],
    { encoding: "utf8" },
  ).trim();
  console.log(`exit address through tunnel: ${response}`);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(response)) {
    throw new Error(`unexpected tunnel response: ${response}`);
  }

  const proxied = execFileSync(
    "curl",
    ["-s", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}",
      "--max-time", "25", "-x", `http://127.0.0.1:${HTTP_PORT}`, "https://api.ipify.org"],
    { encoding: "utf8" },
  ).trim();
  console.log(`http inbound status: ${proxied}`);
  if (proxied !== "200") throw new Error(`http inbound failed: ${proxied}`);

  console.log("vpn smoke test passed");
} finally {
  core.kill();
  rmSync(workDir, { recursive: true, force: true });
  if (output.trim()) console.log(`--- tunnel engine ---\n${output.trim()}`);
}
