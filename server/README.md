# Server-side

Everything deployed on the VPS: the chat backend, voice services, a reverse proxy, and the VPN entry point.
Orchestration is handled via Docker Compose; application state is stored in `server/data/`, while secrets and
generated configuration files reside in `server/.env` and `server/generated/` (none of these are tracked by Git).

## Requirements

- Ubuntu 24.04 (or another Linux-based system with Docker Engine and the Compose plugin);
- A domain name with an A-record pointing to the server (required for HTTPS certificates and the Reality protocol);
- `openssl` (included by default on most systems);
- For local testing/experimentation, Docker Desktop is sufficient.

## Architecture

Only **port 443** is exposed to the public; it is managed by Xray (using VLESS + Reality). If a client
connects with a valid Reality key, the traffic is routed to the VPN. Any other TLS connection
(such as from a web browser or a censor's probe) is transparently forwarded to Caddy at `caddy:8443`,
which then serves a standard HTTPS site containing our API. Port 80 is also used by Caddy for
ACME HTTP-01 challenges and redirects, as port 443 is already occupied by the proxy.

```
client ──443/tcp──> xray ──┬──> VPN traffic (freedom)
└──fallback──> caddy:8443 ──> gateway / api / events / autumn / january / livekit
client ──7881/tcp, 50000-50100/udp──> livekit (direct media traffic, bypassing the proxy)
```

`gateway` is a custom-built microservice (`gateway/main.go`). Reason: The chat API checks for the existence of an invitation code but does not verify whether it has already been used. Therefore, the only public endpoint—`/api/auth/account/create`—is routed through a gate that validates and invalidates (consumes) the code.

## Initial Launch

```bash
cd server
bash scripts/gen-config.sh      # Creates .env + generated/*; outputs a VLESS link
docker compose up -d
docker compose ps
```

The script is idempotent: running it again will not alter previously generated secrets, but it will regenerate configuration files from the `templates/` directory (e.g., if the domain name has changed).

Before deployment:

1. Set `CHAT_DOMAIN` in `.env` to your actual domain (it defaults to `localhost`).
2. Optionally, pin the image tags using `CHAT_TAG`, `XRAY_IMAGE`, and `LIVEKIT_IMAGE`.
3. Open the following ports in your firewall: `80/tcp`, `443/tcp`, `7881/tcp`, and `50000-50100/udp`.
4. Run `bash scripts/gen-config.sh && docker compose up -d`.

## Accounts and Whitelisting

Registration is restricted (`[api.registration] invite_only = true` in `generated/chat.toml`), meaning accounts can only be created using a one-time invitation code:

```bash
./tools/issue-invite.sh            # Generates a random code
./tools/issue-invite.sh my-code    # Uses a specific code
./tools/issue-invite.sh --list     # Shows who has already used a code
./tools/issue-invite.sh --revoke my-code
```

The code is entered during registration in the client, alongside an email address and password. Single-use mechanism
Enforced by the `gateway`: an empty code results in a `MissingInvite` response, while attempting to reuse a code that has already been used results in `InvalidInvite`. Access to the server can be revoked by deleting or blocking an account via the backend.

## VPN

- Server configuration: `templates/xray.json.tpl` → `generated/xray.json`.
- Reality keys are generated once (using Xray’s built-in `x25519` utility) and stored in `.env`.
- Access to private subnets (`geoip:private` → `block`) is restricted within the VPN to prevent the tunnel from being used as an entry point into the infrastructure.
- `generated/client-vless.txt` contains a `vless://...` link for quick testing with third-party clients; `generated/client-profile.json` contains the same profile, formatted for our application.

Rotating keys (requires all clients to reconnect):

```bash
# Remove the XRAY_PRIVATE_KEY, XRAY_PUBLIC_KEY, XRAY_SHORT_ID, and XRAY_UUID lines from .env
bash scripts/gen-config.sh
docker compose restart xray
```

## Voice

LiveKit runs via `ghcr.io/stoatchat/livekit-server`. Signaling is handled through Caddy (`/livekit`), while media traffic flows directly over `7881/tcp` and `50000-50100/udp`. TURN is disabled: if a provider blocks UDP, the client establishes a tunnel, and media traffic is routed through it.

## Data and Backups

All state is stored in the `data/` directory:

| Directory | Contents |
|---|---|
| `data/db` | MongoDB: accounts, messages, invites |
| `data/minio` | Attachments, avatars, emojis |
| | `data/rabbit` | RabbitMQ queues (not critical) |
| `data/caddy-data` | ACME certificates and private keys |

Minimum backup: `data/db` + `data/minio` (plus `.env` — without it, files cannot be decrypted).
Stopping the stack before copying `data/db` is more reliable than copying it while the system is running.

## Local Testing

With `CHAT_DOMAIN=localhost`, Caddy issues a self-signed certificate (internal CA);
ACME is not used. The stack is brought up just as it would be in production, but the domain and Reality
configuration can only be truly verified on a live server. Since your local browser/`curl`
will not trust Caddy’s CA, you should either use `curl -k` or retrieve the root certificate:
`docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`.

Testing the tunnel itself (launches a one-time Xray client in a container and requests a URL
via SOCKS):

```bash
bash scripts/tunnel-smoke-test.sh
# OK: HTTP 200
```

If Docker Desktop fails to publish the LiveKit UDP port range (because one of the ports is already in use),
adjust the range in your `.env` file (`LIVEKIT_UDP_PORT_START`/`END`, e.g., `51000`/`51010`)
and restart: `bash scripts/gen-config.sh && docker compose up -d livekit`.
The values ​​from `.env` are applied to both `livekit.yml` and the probe configuration.