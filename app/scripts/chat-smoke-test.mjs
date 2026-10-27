/**
 * End-to-end check of the client data path, without the desktop shell:
 * gateway sign-up -> stoat.js connect -> create server/channel -> send
 * a message -> read it back from history.
 *
 * Run against a local stack:
 *   set NODE_EXTRA_CA_CERTS=..\server\generated\caddy-root.crt
 *   npm run smoke
 *
 * Self-signed certificates: point NODE_EXTRA_CA_CERTS at Caddy's root CA, the
 * one you exported from the caddy container.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "stoat.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverUrl = (process.env.SERVER_URL ?? "https://localhost").replace(/\/+$/, "");
const base = `${serverUrl}/api`;

function readAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;

  const envPath = resolve(here, "../../server/.env");
  try {
    const line = readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((entry) => entry.startsWith("ADMIN_TOKEN="));
    if (!line) throw new Error("ADMIN_TOKEN is not set");
    return line.slice("ADMIN_TOKEN=".length).replace(/^['"]|['"]$/g, "");
  } catch (error) {
    throw new Error(`cannot read ADMIN_TOKEN from ${envPath}: ${error.message}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${text}`);
  }
  return payload;
}

function waitForReady(client, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (client.ready()) {
      resolve();
      return;
    }

    const timer = setTimeout(() => reject(new Error("ready event timeout")), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };

    client.on("ready", finish);
  });
}

const suffix = Date.now().toString(36);
const username = `smoke${suffix}`;
const password = `smoke-pass-${suffix}`;
const token = readAdminToken();

const invite = await api("/admin/invites", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Admin-Token": token },
  body: JSON.stringify({ code: `smoke-${suffix}` }),
});
console.log(`invite: ${invite.code}`);

const session = await api("/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password, invite: invite.code }),
});
console.log(`registered: ${username}`);

const configuration = await api("/");
const client = new Client({ baseURL: base }, configuration);
client.useExistingSession(session);
client.connect();
await waitForReady(client);
console.log(`ready as: ${client.user?.username}`);

let server = client.servers.toList().find((entry) => entry.name === "smoke");
if (!server) {
  server = await client.servers.createServer({ name: "smoke" });
}
console.log(`server: ${server.name} (${server.id})`);

let channel = server.channels.find((entry) => entry.type === "TextChannel");
if (!channel) {
  channel = await server.createChannel({ name: "general", type: "TextChannel" });
}
console.log(`channel: #${channel.name} (${channel.id})`);

const content = `smoke ${new Date().toISOString()}`;
await channel.sendMessage(content);

const history = await channel.fetchMessages({ limit: 10 });
if (!history.some((message) => message.content === content)) {
  throw new Error("sent message is missing from the fetched history");
}

console.log(`history messages: ${history.length}, last: ${history.at(-1)?.content}`);

client.events.disconnect();
client.removeAllListeners();
console.log("client smoke test passed");
process.exit(0);
