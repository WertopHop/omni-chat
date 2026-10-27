#!/usr/bin/env bash
#
# End-to-end check of the authentication facade:
# register by nickname + invite, login by nickname, duplicate nickname,
# invite reuse, admin token enforcement.
#
#   ./scripts/auth-smoke-test.sh                        # https://localhost
#   BASE_URL=https://chat.example.com ./scripts/auth-smoke-test.sh
#
# Creates and removes its own invite; the smoke account stays in the database.
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
. <(tr -d '\r' <./.env)
set +a

base=${BASE_URL:-https://localhost}
insecure=()
case "$base" in
*localhost* | *127.0.0.1*) insecure=(-k) ;;
esac

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

failures=0

request() { # method path [json] [extra-header]
	local method=$1 path=$2 data=${3:-} header=${4:-}
	local args=(-sS -X "$method" -o "$tmp" -w '%{http_code}')
	if [ -n "$data" ]; then
		args+=(-H 'Content-Type: application/json' -d "$data")
	fi
	if [ -n "$header" ]; then
		args+=(-H "$header")
	fi
	curl "${insecure[@]}" "${args[@]}" "$base$path"
}

expect() { # description expected actual
	if [ "$2" = "$3" ]; then
		echo "PASS  $1 ($3)"
	else
		echo "FAIL  $1 (expected $2, got $3): $(cat "$tmp")"
		failures=$((failures + 1))
	fi
}

suffix=$(date +%s)
invite="smoke-$suffix"
username="smoke$suffix"
password="smoke-pass-$suffix"

if [ -z "${ADMIN_TOKEN:-}" ]; then
	echo "ADMIN_TOKEN is empty in .env, run scripts/gen-config.sh first" >&2
	exit 1
fi

code=$(request POST /api/admin/invites "{\"code\":\"$invite\"}" "X-Admin-Token: $ADMIN_TOKEN")
expect "admin creates invite" 201 "$code"

code=$(request GET /api/admin/invites "" "X-Admin-Token: wrong")
expect "admin rejects wrong token" 401 "$code"

code=$(request POST /api/auth/register "{\"username\":\"$username\",\"password\":\"$password\",\"invite\":\"$invite\"}")
expect "register by nickname" 201 "$code"
grep -q '"token"' "$tmp" || {
	echo "FAIL  register response has no session token: $(cat "$tmp")"
	failures=$((failures + 1))
}

code=$(request POST /api/auth/login "{\"username\":\"$username\",\"password\":\"$password\"}")
expect "login by nickname" 200 "$code"

code=$(request POST /api/auth/login "{\"username\":\"$username\",\"password\":\"wrong-password\"}")
expect "login rejects wrong password" 401 "$code"

code=$(request POST /api/auth/account/create "{\"email\":\"x@users.localhost\",\"password\":\"$password\",\"invite\":\"$invite\"}")
expect "used invite is rejected" 400 "$code"

second="second-$suffix"
request POST /api/admin/invites "{\"code\":\"$second\"}" "X-Admin-Token: $ADMIN_TOKEN" >/dev/null
code=$(request POST /api/auth/register "{\"username\":\"$username\",\"password\":\"$password\",\"invite\":\"$second\"}")
expect "duplicate nickname is rejected" 409 "$code"
request DELETE "/api/admin/invites/$second" "" "X-Admin-Token: $ADMIN_TOKEN" >/dev/null

code=$(request GET /api/auth/username-available "?username=$username")
expect "username-available reports taken" 200 "$code"
grep -q '"available":false' "$tmp" || {
	echo "FAIL  username-available payload: $(cat "$tmp")"
	failures=$((failures + 1))
}

code=$(request DELETE "/api/admin/invites/$invite" "" "X-Admin-Token: $ADMIN_TOKEN")
expect "admin revokes used invite" 200 "$code"

echo
if [ "$failures" -ne 0 ]; then
	echo "$failures check(s) failed"
	exit 1
fi
echo "all checks passed"
