#!/usr/bin/env bash
#
# Whitelist management: account creation on the chat backend is invite-only,
# so a new account needs a single-use code inserted into `account_invites`.
#
#   ./tools/issue-invite.sh              issue a random code
#   ./tools/issue-invite.sh my-code      issue a specific code
#   ./tools/issue-invite.sh --list       show all codes
#   ./tools/issue-invite.sh --revoke my-code
#
# A used code cannot be reused: issue a fresh one per person.
set -euo pipefail

cd "$(dirname "$0")/.."

mongo_eval() {
	docker compose exec -T database mongosh --quiet revolt --eval "$1"
}

validate_code() {
	printf '%s' "$1" | grep -qE '^[A-Za-z0-9_-]{4,32}$' || {
		echo "code must be 4-32 chars of [A-Za-z0-9_-]" >&2
		exit 1
	}
}

case "${1:-}" in
--list)
	mongo_eval 'db.account_invites.find({}, { used: 1, claimed_by: 1 }).toArray().forEach(i => print(i._id + (i.used ? "  used" : "  free")))'
	;;
--revoke)
	code=${2:?usage: $0 --revoke <code>}
	validate_code "$code"
	mongo_eval "print(db.account_invites.deleteOne({ _id: '$code' }).deletedCount ? 'revoked: $code' : 'not found: $code')"
	;;
*)
	code=${1:-$(openssl rand -hex 6)}
	validate_code "$code"
	mongo_eval "
		if (db.account_invites.findOne({ _id: '$code' })) {
			print('already exists: $code')
		} else {
			db.account_invites.insertOne({ _id: '$code', used: false });
			print('issued: $code');
		}
	"
	;;
esac
