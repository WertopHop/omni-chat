# Desktop application

Tauri v2 + React + TypeScript client for omni-chat: chat with voice channels and an
embedded VPN switch.

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri v2 (Rust) |
| UI | React 19 + TypeScript + Vite |
| Chat data | `stoat.js` (MIT SDK of the chat backend) |
| Auth | own gateway (`server/gateway`): nickname + password + invite code |

## Scripts

```bash
npm install
npm run fetch:xray # downloads the Xray sidecar into src-tauri/binaries (~25 MB)
npm run dev        # Vite only, in a browser
npm run build      # type-check + production bundle
npm run tauri dev  # desktop window with hot reload
npm run tauri build
```

`npm run fetch:xray` is required once before the desktop build: the binary is not
committed, and `bundle.externalBin` expects `src-tauri/binaries/xray-<triple>`.
Pass `-- --force` to re-download after bumping `XRAY_VERSION` in the script.

## How the client talks to the server

1. `POST /api/auth/login` or `/api/auth/register` on the gateway. The gateway
   hides the backend's e-mail accounts: the user only enters a nickname, a
   password and (for sign-up) an invite code. It returns a session object.
2. The session goes to `stoat.js` (`Client.useExistingSession` + `connect()`),
   which opens the WebSocket for live events and uses `/api` for REST.
3. `baseURL` is `${serverUrl}/api`, so the same build works against any server;
   the address is entered on the login screen and remembered.

Session state is kept in `localStorage` for now; moving it into the OS keyring
through Tauri is still on the list.

## VPN (proxy mode)

The tunnel lives in Rust: [`src-tauri/src/vpn.rs`](src-tauri/src/vpn.rs:1) renders an
Xray config from the profile and runs the sidecar.

1. `useVpn` asks the server for the profile: `GET /api/vpn/profile` with the
   session token (the gateway answers, so keys are only handed to known accounts).
2. The profile is stored in the app config directory (`vpn/vpn-profile.json`) and
   pushed to Rust via `vpn_set_profile`.
3. `vpn_start` writes `vpn/xray.json` with two loopback inbounds (SOCKS `10808`,
   HTTP `10809`) and a VLESS+Reality outbound, spawns the sidecar, waits for the
   port, then flips the Windows system proxy to `127.0.0.1:10809` (reverse
   restore on stop). Private ranges bypass the tunnel.
4. `vpn_stop` kills the sidecar and restores the previous proxy settings; the app
   exit hook does the same, so no orphaned `xray.exe` stays behind.

Status, logs and the toggle are shown in the panel behind the `VPN` chip in the
chat header. TUN mode (full traffic, per-app rules, `wintun.dll`) comes next.

Verify the whole path without the UI:

```bash
set NODE_EXTRA_CA_CERTS=..\server\generated\caddy-root.crt
npm run smoke:vpn
```

## Local development against `server/`

`server/` uses Caddy's internal CA for `https://localhost`, and the webview
rejects unknown CAs. Either:

- trust Caddy's root certificate once:

  ```bash
  docker compose -f ../server/compose.yml exec caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
  certutil -user -addstore Root caddy-root.crt
  ```

- or point the app at the deployed server with a real certificate.

Login button uses the gateway, so the invite code must be issued first:

```bash
cd ../server && ./tools/issue-invite.sh
```

## Application icon

`src-tauri/app-icon.png` is the single source image (512x512 or larger, square).
Every platform icon set (`icons/*.png`, `icon.ico`, `icon.icns`, Appx, Android, iOS)
is generated from it:

```bash
npx tauri icon src-tauri/app-icon.png
```

`public/app-icon.png` is the web/favicon copy used by the login screen; refresh it by
copying `src-tauri/icons/128x128.png` after regenerating.

## Layout

```
src/
  i18n/       typed dictionaries (en, ru) and the language provider
  lib/        gateway calls, session persistence, URL helpers, VPN bridge
  hooks/      useChatClient (SDK client and events), useVpn (tunnel state)
  components/ LoginScreen, ChatShell, VpnPanel, LanguageSwitcher
```

## Localization

English is the source language and the fallback; Russian ships alongside it. The
language is picked from the switcher on the login screen or in the chat header and
is remembered in `localStorage`.

- [`src/i18n/en.ts`](src/i18n/en.ts:1) holds every key with its English text.
- [`src/i18n/ru.ts`](src/i18n/ru.ts:1) is typed as `Record<MessageKey, string>`, so a
  missing or extra key breaks the build.
- [`src/i18n/index.tsx`](src/i18n/index.tsx:1) provides `useI18n()` with `t(key, params)`,
  `locale`, `setLocale` and `intlLocale` (for date formatting).

To add a language: copy `en.ts` to `<code>.ts`, translate the values, add the
file to `dictionaries` and to the `Locale` type / `LOCALES` list in `index.tsx`.
Placeholders use `{name}` syntax.

## Roadmap

- attachments, replies, reactions, DMs, member list;
- full-tunnel mode with a helper, per-app routing;
- voice channels via LiveKit, admin panel for invites and accounts.
