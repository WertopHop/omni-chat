#!/usr/bin/env bash
#
# Smoke test for the VPN entry point.
#
# Starts a throwaway Xray client in Docker, sends one request through its local
# SOCKS inbound and prints the result. Proves that the Reality handshake,
# the credentials in .env and the server routing all work together.
#
#   ./scripts/tunnel-smoke-test.sh                 # default: https://api.ipify.org
#   ./scripts/tunnel-smoke-test.sh https://chat.example.com/api
#
# Locally the chat host resolves to the server itself, so with CHAT_DOMAIN=localhost
# only internet egress can be verified here; the chat hostname is testable on the VPS.
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
. <(tr -d '\r' <./.env)
set +a

url=${1:-https://api.ipify.org}
container=omni-chat-smoke-test
config=generated/smoke-client.json

cat >"$config" <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "socks",
      "listen": "0.0.0.0",
      "port": 10808,
      "protocol": "socks",
      "settings": { "udp": true }
    }
  ],
  "outbounds": [
    {
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "host.docker.internal",
            "port": ${VPN_PORT:-443},
            "users": [
              {
                "id": "$XRAY_UUID",
                "encryption": "none",
                "flow": "xtls-rprx-vision"
              }
            ]
          }
        ]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "serverName": "$CHAT_DOMAIN",
          "fingerprint": "chrome",
          "publicKey": "$XRAY_PUBLIC_KEY",
          "shortId": "$XRAY_SHORT_ID"
        }
      }
    }
  ]
}
EOF

host_path=$(cygpath -w "$PWD/$config" 2>/dev/null || echo "$PWD/$config")

cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm --name "$container" \
	--add-host host.docker.internal:host-gateway \
	-p 10808:10808 \
	-v "$host_path:/etc/xray/client.json:ro" \
	"${XRAY_IMAGE:-ghcr.io/xtls/xray-core:latest}" \
	run -config /etc/xray/client.json >/dev/null

sleep 3

echo "Requesting $url through the tunnel..."
code=$(curl --socks5-hostname 127.0.0.1:10808 -s -o /dev/null -w '%{http_code}' "$url" || true)

if [ "$code" = "000" ]; then
	echo "FAILED: the tunnel did not carry the request" >&2
	exit 1
fi

echo "OK: HTTP $code"
