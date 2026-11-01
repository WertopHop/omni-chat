/**
 * End-to-end check of the voice path, without the desktop shell:
 * account -> server -> voice channel -> `join_call` token -> LiveKit room.
 *
 * It proves the whole chain the client relies on (gateway session, backend
 * permissions, token signing, signalling through the reverse proxy) without a
 * microphone, so it can run in CI and on a headless machine.
 *
 * Run against a local stack:
 *   set NODE_EXTRA_CA_CERTS=..\server\generated\caddy-root.crt
 *   npm run smoke:voice
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Room, RoomEvent } from "livekit-client";

const here = dirname(fileURLToPath(import.meta.url));
const serverUrl = (process.env.SERVER_URL ?? "https://localhost").replace(/\/+$/, "");
const base = `${serverUrl}/api`;
const CONNECT_TIMEOUT_MS = 15000;

function readAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;

  const envPath = resolve(here, "../../server/.env");
  const line = readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("ADMIN_TOKEN="));
  if (!line) throw new Error(`ADMIN_TOKEN is not set in ${envPath}`);
  return line.slice("ADMIN_TOKEN=".length).replace(/^['"]|['"]$/g, "");
}

async function api(path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

function waitForConnect(room) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the voice room did not connect in time")),
      CONNECT_TIMEOUT_MS,
    );
    room.once(RoomEvent.Connected, () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    room.once(RoomEvent.Disconnected, (reason) => {
      clearTimeout(timer);
      reject(new Error(`disconnected while connecting: ${reason ?? "unknown"}`));
    });
  });
}

const suffix = Date.now().toString(36);
const username = `voice${suffix}`;
const password = `voice-pass-${suffix}`;

const invite = await api("/admin/invites", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Admin-Token": readAdminToken() },
  body: JSON.stringify({ code: `voice-${suffix}` }),
});
const session = await api("/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password, invite: invite.code }),
});
console.log(`account: ${username}`);

const auth = { "Content-Type": "application/json", "X-Session-Token": session.token };

const created = await api("/servers/create", {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ name: `voice-${suffix}` }),
});
// The endpoint may wrap the server under its own key, so read both shapes.
const serverId = created._id ?? created.server?._id ?? created.server?.id ?? created.id;
if (!serverId) {
  throw new Error(`unexpected server response: ${JSON.stringify(created).slice(0, 200)}`);
}
console.log(`server: ${serverId}`);

// A voice channel in this backend is a text channel carrying a voice block.
const channel = await api(`/servers/${serverId}/channels`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ type: "Voice", name: "General", voice: { max_users: null } }),
});
const channelId = channel._id ?? channel.id;
if (!channelId) {
  throw new Error(`unexpected channel response: ${JSON.stringify(channel).slice(0, 200)}`);
}
console.log(`voice channel: ${channelId}`);

// The backend signs a token for a named node and rejects an unknown one, so
// the name comes from the API root, exactly like the client does it.
const root = await api("/");
const node = root.features?.livekit?.nodes?.find((entry) => entry?.name)?.name;
if (!node) throw new Error("the API root lists no voice node");
console.log(`voice node: ${node}`);

const call = await api(`/channels/${channelId}/join_call`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ node, force_disconnect: true }),
});
if (!call.token || !call.url) throw new Error("join_call returned no token or url");
console.log(`signalling: ${call.url}`);

const claims = JSON.parse(Buffer.from(call.token.split(".")[1], "base64url").toString());
const roomName = claims.video?.room ?? claims.room;
if (!roomName) throw new Error("the token carries no room");
console.log(`token: room=${roomName} identity=${claims.sub}`);

// Node has no WebRTC, so the media path needs the desktop shell. Everything
// the app itself depends on - signed token, node URL, signalling reachable
// through the reverse proxy - can still be checked here.
if (typeof RTCPeerConnection !== "undefined") {
  const room = new Room({ adaptiveStream: false, dynacast: false });
  try {
    await room.connect(call.url, call.token);
    await waitForConnect(room);
    console.log(`connected as ${room.localParticipant.identity}`);
    if (room.numParticipants < 1) throw new Error("the room reports no participants");
    console.log(`participants: ${room.numParticipants}`);
  } finally {
    await room.disconnect().catch(() => undefined);
  }
} else {
  const probe = await fetch(
    `${serverUrl}/livekit/rtc/validate?access_token=${encodeURIComponent(call.token)}`,
  );
  console.log(`signalling validate: ${probe.status}`);
  if (probe.status !== 200) {
    throw new Error(`the signalling endpoint rejected the token: ${await probe.text()}`);
  }
}

console.log("voice smoke test passed");
