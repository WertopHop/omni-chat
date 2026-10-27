#!/usr/bin/env bash
#
# Renders the runtime configuration for the compose stack.
#
# - creates .env from .env.example on first run and fills every empty secret
# - writes generated/{chat.toml,livekit.yml,xray.json,stoat.json,client-profile.json}
# - prints the VLESS share link for manual client tests
#
# Re-running is safe: existing secrets are kept as they are.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=.env
GEN_DIR=generated

command -v openssl >/dev/null 2>&1 || {
	echo "openssl is required to generate secrets" >&2
	exit 1
}

[ -f "$ENV_FILE" ] || cp .env.example "$ENV_FILE"
# The file is sourced by other scripts, so a stray CR from a Windows editor
# would end up inside every value.
sed -i 's/\r$//' "$ENV_FILE"
chmod 600 "$ENV_FILE"

get_var() {
	local value
	value=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)
	value=${value%$'\r'}
	value=${value#\'}
	value=${value%\'}
	value=${value#\"}
	value=${value%\"}
	printf '%s' "$value"
}

set_var() {
	local key=$1 value=$2 tmp
	if grep -qE "^${key}=" "$ENV_FILE"; then
		tmp=$(mktemp)
		awk -v k="$key" -v v="$value" '
			{
				split($0, parts, "=")
				if (parts[1] == k) {
					print k "=\047" v "\047"
					next
				}
				print
			}
		' "$ENV_FILE" >"$tmp"
		mv "$tmp" "$ENV_FILE"
	else
		printf "%s='%s'\n" "$key" "$value" >>"$ENV_FILE"
	fi
	chmod 600 "$ENV_FILE"
}

ensure() {
	local key=$1
	shift
	if [ -z "$(get_var "$key")" ]; then
		set_var "$key" "$("$@")"
		echo "generated $key"
	fi
}

new_uuid() {
	openssl rand -hex 16 | sed -E 's/(.{8})(.{4})(.{4})(.{4})(.{12})/\1-\2-\3-\4-\5/'
}

ensure CHAT_DOMAIN echo localhost
[ -n "$(get_var CHAT_DOMAIN)" ] || set_var CHAT_DOMAIN localhost

ensure XRAY_UUID new_uuid
ensure XRAY_SHORT_ID openssl rand -hex 8

# Reality keypair has to come from Xray itself: the keys are curve25519 and
# printed as base64url, which openssl cannot reproduce in the expected form.
if [ -z "$(get_var XRAY_PRIVATE_KEY)" ] || [ -z "$(get_var XRAY_PUBLIC_KEY)" ]; then
	XRAY_IMAGE=$(get_var XRAY_IMAGE)
	[ -n "$XRAY_IMAGE" ] || XRAY_IMAGE=ghcr.io/xtls/xray-core:latest
	keys=$(docker run --rm "$XRAY_IMAGE" x25519)
	# Newer builds print "PrivateKey: ..." / "Password (PublicKey): ...",
	# older ones "Private key: ..." / "Public key: ...".
	private=$(printf '%s\n' "$keys" | awk 'tolower($1) ~ /^privatekey:?$/ { print $NF }')
	public=$(printf '%s\n' "$keys" | awk 'tolower($0) ~ /public/ { print $NF }')
	if [ -z "$private" ] || [ -z "$public" ]; then
		echo "could not parse 'xray x25519' output:" >&2
		printf '%s\n' "$keys" >&2
		exit 1
	fi
	set_var XRAY_PRIVATE_KEY "$private"
	set_var XRAY_PUBLIC_KEY "$public"
	echo "generated XRAY_PRIVATE_KEY / XRAY_PUBLIC_KEY"
fi

ensure LIVEKIT_API_KEY openssl rand -hex 6
ensure LIVEKIT_API_SECRET openssl rand -hex 24
ensure ADMIN_TOKEN openssl rand -hex 24
ensure S3_ROOT_USER echo omni
ensure S3_ROOT_PASSWORD openssl rand -base64 24
ensure REVOLT__FILES__ENCRYPTION_KEY openssl rand -base64 32

# VAPID keypair for web push: private key is base64 of a P-256 PEM, public key
# is the uncompressed point without padding.
if [ -z "$(get_var REVOLT__PUSHD__VAPID__PRIVATE_KEY)" ] || [ -z "$(get_var REVOLT__PUSHD__VAPID__PUBLIC_KEY)" ]; then
	vapid_pem=$(mktemp)
	openssl ecparam -name prime256v1 -genkey -noout -out "$vapid_pem"
	private=$(base64 <"$vapid_pem" | tr -d '\n=' )
	public=$(openssl ec -in "$vapid_pem" -outform DER 2>/dev/null | tail --bytes 65 | base64 | tr '/+' '_-' | tr -d '\n=')
	rm -f "$vapid_pem"
	set_var REVOLT__PUSHD__VAPID__PRIVATE_KEY "$private"
	set_var REVOLT__PUSHD__VAPID__PUBLIC_KEY "$public"
	echo "generated VAPID keys"
fi

# The chat backend must use exactly the same LiveKit credentials.
set_var REVOLT__API__LIVEKIT__NODES__WORLDWIDE__KEY "$(get_var LIVEKIT_API_KEY)"
set_var REVOLT__API__LIVEKIT__NODES__WORLDWIDE__SECRET "$(get_var LIVEKIT_API_SECRET)"

CHAT_DOMAIN=$(get_var CHAT_DOMAIN)
S3_ROOT_USER=$(get_var S3_ROOT_USER)
S3_ROOT_PASSWORD=$(get_var S3_ROOT_PASSWORD)
LIVEKIT_API_KEY=$(get_var LIVEKIT_API_KEY)
LIVEKIT_API_SECRET=$(get_var LIVEKIT_API_SECRET)
XRAY_UUID=$(get_var XRAY_UUID)
XRAY_PRIVATE_KEY=$(get_var XRAY_PRIVATE_KEY)
XRAY_PUBLIC_KEY=$(get_var XRAY_PUBLIC_KEY)
XRAY_SHORT_ID=$(get_var XRAY_SHORT_ID)
VPN_PORT=$(get_var VPN_PORT)
[ -n "$VPN_PORT" ] || VPN_PORT=443
LIVEKIT_TCP_PORT=$(get_var LIVEKIT_TCP_PORT)
[ -n "$LIVEKIT_TCP_PORT" ] || LIVEKIT_TCP_PORT=7881
LIVEKIT_UDP_PORT_START=$(get_var LIVEKIT_UDP_PORT_START)
[ -n "$LIVEKIT_UDP_PORT_START" ] || LIVEKIT_UDP_PORT_START=50000
LIVEKIT_UDP_PORT_END=$(get_var LIVEKIT_UDP_PORT_END)
[ -n "$LIVEKIT_UDP_PORT_END" ] || LIVEKIT_UDP_PORT_END=50100

mkdir -p "$GEN_DIR"

render() {
	local template=$1 output=$2 content
	content=$(cat "$template")
	content=${content//@CHAT_DOMAIN@/$CHAT_DOMAIN}
	content=${content//@S3_ROOT_USER@/$S3_ROOT_USER}
	content=${content//@S3_ROOT_PASSWORD@/$S3_ROOT_PASSWORD}
	content=${content//@LIVEKIT_API_KEY@/$LIVEKIT_API_KEY}
	content=${content//@LIVEKIT_API_SECRET@/$LIVEKIT_API_SECRET}
	content=${content//@XRAY_UUID@/$XRAY_UUID}
	content=${content//@XRAY_PRIVATE_KEY@/$XRAY_PRIVATE_KEY}
	content=${content//@XRAY_PUBLIC_KEY@/$XRAY_PUBLIC_KEY}
	content=${content//@XRAY_SHORT_ID@/$XRAY_SHORT_ID}
	content=${content//@VPN_PORT@/$VPN_PORT}
	content=${content//@LIVEKIT_TCP_PORT@/$LIVEKIT_TCP_PORT}
	content=${content//@LIVEKIT_UDP_PORT_START@/$LIVEKIT_UDP_PORT_START}
	content=${content//@LIVEKIT_UDP_PORT_END@/$LIVEKIT_UDP_PORT_END}
	printf '%s\n' "$content" >"$output"
	chmod 600 "$output"
}

render templates/chat.toml.tpl "$GEN_DIR/chat.toml"
render templates/livekit.yml.tpl "$GEN_DIR/livekit.yml"
render templates/xray.json.tpl "$GEN_DIR/xray.json"
render templates/client-profile.json.tpl "$GEN_DIR/client-profile.json"

printf '{"api":"https://%s/api"}\n' "$CHAT_DOMAIN" >"$GEN_DIR/stoat.json"

share_link="vless://$XRAY_UUID@$CHAT_DOMAIN:$VPN_PORT?encryption=none&flow=xtls-rprx-vision&security=reality&sni=$CHAT_DOMAIN&fp=chrome&pbk=$XRAY_PUBLIC_KEY&sid=$XRAY_SHORT_ID&type=tcp#omni-chat"
printf '%s\n' "$share_link" >"$GEN_DIR/client-vless.txt"

echo
echo "Rendered configuration into $GEN_DIR/"
echo "Domain: $CHAT_DOMAIN"
echo
echo "VLESS share link (for a quick test with any ready-made client):"
cat "$GEN_DIR/client-vless.txt"

if [ "$CHAT_DOMAIN" = "localhost" ]; then
	echo
	echo "CHAT_DOMAIN is still localhost: Caddy will use its internal CA and the"
	echo "VPN entry point is only reachable locally. Set the real domain in .env"
	echo "and re-run this script before deploying."
fi
