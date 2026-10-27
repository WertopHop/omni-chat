# omni-chat

A private desktop messenger with a built-in VPN, designed for small groups.
Unified access and a single client: text and voice channels, plus VPN tunnel management.

The project is not built from scratch; rather, it is assembled using proven open-source components:

| Layer | Component | Role |
|---|---|---|
| VPN | [Xray-core](https://github.com/XTLS/Xray-core) | VLESS + Reality on the server; TUN/proxy on the client |
| Chat Backend | [Stoat](https://github.com/stoatchat/stoatchat) | Accounts, channels, messages, permissions, and events |
| Voice | LiveKit | WebRTC SFU for voice channels |
| Proxy/Certificates | Caddy | HTTPS for API, WebSockets, and file serving |
| Client | Tauri v2 + React + TypeScript | Desktop application |

## Repository Structure

```
server/   Server-side: Docker Compose, configurations, secret generator, utilities
app/      Client application (Tauri + React)
```

## Documentation

- [`server/README.md`](server/README.md) — deployment, secrets, invites, VPN keys.
- [`app/README.md`](app/README.md) — client stack, auth flow, local development.

## Server-side Quick Start

```bash
cd server
bash scripts/gen-config.sh     # creates .env, generates secrets and configurations
docker compose up -d
./tools/issue-invite.sh        # issue an invite code for a new account
```

See [`server/README.md`](server/README.md) for details.

## Status

Phase 2 (done): server-side skeleton — compose, Caddy, LiveKit, Xray Reality with fallback,
one-time invite whitelist, admin API in the gateway.

Phase 3 (in progress): desktop client — nickname sign-in, server/channel list, message history
and live updates. VPN switch, voice and admin panel are next.