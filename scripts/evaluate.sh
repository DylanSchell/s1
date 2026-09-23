#!/usr/bin/env bash
#
# Exercise the s1 evaluate API with curl and pretty-print the response with jq.
#
# Usage:
#   ./scripts/evaluate.sh [request.json] [base-url]
#
# Examples:
#   ./scripts/evaluate.sh
#   ./scripts/evaluate.sh examples/triage-request.json
#   S1_URL=http://localhost:8091 ./scripts/evaluate.sh examples/triage-request.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

REQUEST_FILE="${1:-$ROOT_DIR/examples/triage-request.json}"
BASE_URL="${2:-${S1_URL:-http://localhost:8090}}"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }
[[ -f "$REQUEST_FILE" ]] || { echo "error: no such request file: $REQUEST_FILE" >&2; exit 1; }

# Fail early with a readable message rather than a raw curl connection error.
# (-o /dev/null keeps the health body out of the terminal.)
if ! curl -fsS -o /dev/null "$BASE_URL/health"; then
  echo "error: s1 not reachable at $BASE_URL (start it with: bun run start)" >&2
  exit 1
fi

response="$(curl -sS -X POST "$BASE_URL/v1/evaluate" \
  -H 'content-type: application/json' \
  --data-binary "@$REQUEST_FILE")"

# Surface API-level errors as JSON on stderr and exit non-zero.
if [[ "$(jq -r 'has("error")' <<<"$response" 2>/dev/null)" == "true" ]]; then
  jq . <<<"$response" >&2
  exit 1
fi

jq . <<<"$response"
