#!/usr/bin/env bash
# End-to-end check of the USB server: serves the site, enforces auth and
# CSRF, blocks traversal, and round-trips a file through the admin API.
#
#   tools/smoke-test.sh [port]
#
# Runs against a throwaway data directory so it never touches a real install.

set -uo pipefail

PORT="${1:-18080}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USB="$ROOT/usb"
JAR="$(mktemp -d)/cookies.txt"
PASS=0
FAIL=0

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$USB/data" 2>/dev/null
  [[ -d "$BACKUP" ]] && mv "$BACKUP" "$USB/data"
  rm -f "$USB/site/smoke-test.html" "$USB/site/smoke-upload.bin" 2>/dev/null
  rm -rf "$USB/site/smoke-dir" 2>/dev/null
}
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  \033[32mPASS\033[0m  %-46s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %-46s got %s, wanted %s\n' "$label" "$actual" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m  %s (no "%s" in response)\n' "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

# Stash any real data dir so the test starts from a clean first run.
BACKUP="$USB/data.smoke-backup"
rm -rf "$BACKUP"
[[ -d "$USB/data" ]] && mv "$USB/data" "$BACKUP"

echo
echo "Self-Host Starter smoke test (port $PORT)"
echo "==============================================================="

node "$USB/server/server.js" --port "$PORT" >"$JAR.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "  server did not start; log follows:"
  cat "$JAR.log"
  exit 1
fi

BASE="http://127.0.0.1:$PORT"
ADMIN="$BASE/__admin"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo
echo "-- public site ------------------------------------------------"
check "GET / serves the home page"            200 "$(code "$BASE/")"
check "GET /about resolves the clean URL"     200 "$(code "$BASE/about")"
check "GET /assets/style.css"                 200 "$(code "$BASE/assets/style.css")"
check "GET /missing returns the 404 page"     404 "$(code "$BASE/missing")"
check "GET /healthz"                          200 "$(code "$BASE/healthz")"
check "HEAD / is allowed"                     200 "$(code -I "$BASE/")"
check "POST / is rejected"                    405 "$(code -X POST "$BASE/")"
contains "home page contains its heading" "It works." "$(curl -s "$BASE/")"

echo
echo "-- caching and ranges -----------------------------------------"
ETAG=$(curl -sI "$BASE/assets/style.css" | tr -d '\r' | awk -F': ' '/^ETag/{print $2}')
check "conditional GET returns 304"           304 "$(code -H "If-None-Match: $ETAG" "$BASE/assets/style.css")"
check "range request returns 206"             206 "$(code -H 'Range: bytes=0-9' "$BASE/assets/style.css")"
check "unsatisfiable range returns 416"       416 "$(code -H 'Range: bytes=99999999-' "$BASE/assets/style.css")"
contains "gzip is negotiated" "content-encoding: gzip" \
  "$(curl -sI -H 'Accept-Encoding: gzip' "$BASE/assets/style.css" | tr 'A-Z' 'a-z')"

echo
echo "-- path traversal ---------------------------------------------"
check "encoded ../ traversal blocked"         404 "$(code "$BASE/..%2f..%2fetc%2fpasswd")"
check "double-encoded traversal blocked"      404 "$(code "$BASE/%2e%2e%2f%2e%2e%2fetc%2fpasswd")"
check "backslash traversal blocked"           404 "$(code "$BASE/..\\..\\etc\\passwd")"
check "dotfile access blocked"                404 "$(code "$BASE/.env")"
check "data dir is not reachable"             404 "$(code "$BASE/../data/users.json")"

echo
echo "-- admin authentication ---------------------------------------"
check "admin path redirects to trailing /"    301 "$(code "$ADMIN")"
check "admin panel loads"                     200 "$(code "$ADMIN/")"
check "admin assets load"                     200 "$(code "$ADMIN/app.js")"
check "status without a session is 401"       401 "$(code "$ADMIN/api/status")"
check "tree without a session is 401"         401 "$(code "$ADMIN/api/tree")"

PASSWORD=$(awk -F': ' '/password:/{print $2}' "$USB/data/FIRST-RUN-PASSWORD.txt" | tr -d ' \r')
if [[ -z "$PASSWORD" ]]; then
  echo "  could not read the generated password; aborting"
  exit 1
fi

check "wrong password is rejected"            401 \
  "$(code -X POST -H 'Content-Type: application/json' \
      -d '{"username":"admin","password":"definitely-not-it"}' "$ADMIN/api/login")"

LOGIN=$(curl -s -c "$JAR" -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" "$ADMIN/api/login")
CSRF=$(printf '%s' "$LOGIN" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')
contains "login returns a CSRF token" '"csrf"' "$LOGIN"

auth() { curl -s -b "$JAR" "$@"; }
authcode() { curl -s -b "$JAR" -o /dev/null -w '%{http_code}' "$@"; }

check "status with a session is 200"          200 "$(authcode "$ADMIN/api/status")"
contains "status reports the site root" '"root"' "$(auth "$ADMIN/api/status")"
contains "tree lists index.html" '"index.html"' "$(auth "$ADMIN/api/tree")"

echo
echo "-- CSRF protection --------------------------------------------"
check "write without a CSRF token is 403"     403 \
  "$(authcode -X PUT -H 'Content-Type: application/json' \
      -d '{"content":"nope"}' "$ADMIN/api/file?path=smoke-test.html")"
check "write with a bad CSRF token is 403"    403 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H 'X-CSRF-Token: wrong' \
      -d '{"content":"nope"}' "$ADMIN/api/file?path=smoke-test.html")"
check "cross-origin request is 403"           403 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -H 'Origin: https://evil.example' \
      -d '{"content":"nope"}' "$ADMIN/api/file?path=smoke-test.html")"

echo
echo "-- admin file operations --------------------------------------"
check "traversal via the API is 400"          400 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"content":"x"}' "$ADMIN/api/file?path=../data/users.json")"
check "non-editable type is refused"          415 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"content":"x"}' "$ADMIN/api/file?path=evil.exe")"

check "create a page"                         200 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"content":"<h1>smoke</h1>"}' "$ADMIN/api/file?path=smoke-test.html")"
contains "the new page is served publicly" "<h1>smoke</h1>" "$(curl -s "$BASE/smoke-test.html")"
contains "reading it back returns the content" 'smoke' \
  "$(auth "$ADMIN/api/file?path=smoke-test.html")"

check "mkdir"                                 200 \
  "$(authcode -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"path":"smoke-dir"}' "$ADMIN/api/mkdir")"
check "binary upload"                         200 \
  "$(authcode -X POST -H 'Content-Type: application/octet-stream' -H "X-CSRF-Token: $CSRF" \
      --data-binary 'BINARYDATA' "$ADMIN/api/upload?path=smoke-upload.bin")"
check "download the upload"                   200 "$(authcode "$ADMIN/api/download?path=smoke-upload.bin")"
check "rename"                                200 \
  "$(authcode -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"from":"smoke-upload.bin","to":"smoke-dir/moved.bin"}' "$ADMIN/api/rename")"
check "delete a non-empty dir needs a flag"   409 \
  "$(authcode -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"path":"smoke-dir"}' "$ADMIN/api/delete")"
check "recursive delete succeeds"             200 \
  "$(authcode -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"path":"smoke-dir","recursive":true}' "$ADMIN/api/delete")"
check "delete the test page"                  200 \
  "$(authcode -X POST -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"path":"smoke-test.html"}' "$ADMIN/api/delete")"
check "the deleted page is gone"              404 "$(code "$BASE/smoke-test.html")"

echo
echo "-- config and logs --------------------------------------------"
contains "config hides the DDNS token" '"token"' "$(auth "$ADMIN/api/config")"
check "config update"                         200 \
  "$(authcode -X PUT -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
      -d '{"site":{"cleanUrls":true},"logging":{"accessLog":true}}' "$ADMIN/api/config")"
contains "access log has entries" '"lines"' "$(auth "$ADMIN/api/logs?which=access&lines=5")"

echo
echo "-- sign out ---------------------------------------------------"
check "logout"                                200 "$(authcode -X POST "$ADMIN/api/logout")"
check "session is dead after logout"          401 "$(authcode "$ADMIN/api/status")"

echo
echo "==============================================================="
printf '  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
