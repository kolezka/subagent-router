#!/bin/bash
# Drive the REAL installed `claude` CLI against the local mock gateway only.
# Strict env allowlist via `env -i`: no inherited ANTHROPIC_API_KEY, no CCR vars,
# no provider credentials. Loopback base URL + fake token only.
# Usage: native-claude-run.sh <simple|delegate>
set -uo pipefail

MODE="${1:-simple}"
case "$MODE" in
  simple|delegate|handler) ;;
  *) echo "FAIL: unknown mode '$MODE' (expected simple, delegate, or handler)" >&2; exit 2 ;;
esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/tests/probes/.runs" || exit 1
RUN="$(mktemp -d "$ROOT/tests/probes/.runs/$MODE-XXXXXX")" || exit 1
HOMEDIR="$RUN/home"
CFG="$RUN/config"
WORK="$RUN/work"
mkdir -p "$HOMEDIR" "$CFG" "$WORK" "$RUN/capture"

if [ "$MODE" = "handler" ]; then
  # The handler binds its alternate marker slot to the exact client version it is told
  # about, so observe that version first, from the same isolated environment the real
  # run below uses. No network: --version answers locally.
  VERSION_OUT="$(
    cd "$WORK" && env -i \
      PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin" \
      HOME="$HOMEDIR" CLAUDE_CONFIG_DIR="$CFG" \
      DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      ANTHROPIC_BASE_URL="http://127.0.0.1:1" ANTHROPIC_AUTH_TOKEN="fake-local-token-not-a-credential" \
      /Users/me/.local/bin/claude --version 2>/dev/null
  )"
  CLIENT_VERSION="$(printf '%s' "$VERSION_OUT" | /usr/bin/grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | /usr/bin/head -1)"
  [ -z "$CLIENT_VERSION" ] && { echo "FAIL: could not observe client version"; exit 1; }
  printf '%s\n' "$CLIENT_VERSION" > "$RUN/capture/client-version"
  # Real production createHandler + scripted mock upstream (Bun), not the plain
  # Node gateway: this is how channel A (the parent's explicit model= marker) gets
  # exercised end to end against a real native client.
  PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
    bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
else
  PROBE_OUT="$RUN/capture" PROBE_MODE="$MODE" \
    node "$ROOT/tests/probes/native-claude-gateway.mjs" >"$RUN/gateway.log" 2>&1 &
fi
GW=$!
trap 'kill $GW 2>/dev/null' EXIT

for _ in $(seq 1 50); do [ -s "$RUN/capture/port" ] && break; sleep 0.1; done
PORT="$(cat "$RUN/capture/port" 2>/dev/null)"
[ -z "$PORT" ] && { echo "FAIL: gateway did not bind"; cat "$RUN/gateway.log"; exit 1; }

# Minimal config so the CLI treats this as an onboarded, trusted, non-interactive workspace.
# Narrow allow-list ONLY for the Task tool in this throwaway config. The permission
# system stays ON; child agents declare `tools: []` so they can execute nothing.
cat >"$CFG/settings.json" <<'JSON'
{ "includeCoAuthoredBy": false,
  "permissions": { "allow": ["Agent"], "deny": ["Bash", "Write", "Edit", "WebFetch"] } }
JSON
cat >"$HOMEDIR/.claude.json" <<JSON
{ "hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true,
  "projects": { "$WORK": { "hasTrustDialogAccepted": true, "allowedTools": [],
    "history": [], "onboardingSeenCount": 5 } } }
JSON

# Two child agents with DIFFERENT models + explicit marker, per the routing question.
mkdir -p "$CFG/agents"
if [ "$MODE" = "handler" ]; then
  # Channel A selects the model via the first-line marker, not agent frontmatter:
  # both fixture agents must inherit so the marker is what's actually being tested.
  AGENT_PAIRS="alpha:inherit beta:inherit"
else
  AGENT_PAIRS="alpha:haiku beta:sonnet"
fi
for pair in $AGENT_PAIRS; do
  name="native-probe-${pair%%:*}"; model="${pair##*:}"
  cat >"$CFG/agents/$name.md" <<MD
---
name: $name
description: Local probe agent $name
model: $model
tools: []
---
Reply with exactly: DONE-$name
MD
done

# SubagentStart hook: capture whatever payload the CLI actually delivers.
cat >"$RUN/hook.sh" <<HOOK
#!/bin/bash
cat > "$RUN/capture/hook-subagentstart-\$\$.json"
echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"PROBE_HOOK_CTX"}}'
HOOK
chmod +x "$RUN/hook.sh"
python3 - "$CFG/settings.json" "$RUN/hook.sh" <<'PY'
import json,sys
p,h=sys.argv[1],sys.argv[2]
d=json.load(open(p))
d["hooks"]={"SubagentStart":[{"hooks":[{"type":"command","command":h}]}]}
json.dump(d,open(p,"w"),indent=2)
PY

TIMEOUT="$(command -v timeout || command -v gtimeout)"
[ -x "$TIMEOUT" ] || { echo "FAIL: no timeout/gtimeout binary"; exit 1; }
PROMPT="${PROBE_PROMPT:-Say PARENT_ROUNDTRIP_OK}"
echo "=== RUN mode=$MODE port=$PORT run=$RUN"
# PWD alone does not change the client's working directory.
(
  cd "$WORK" || exit 1
  env -i \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin" \
    HOME="$HOMEDIR" \
    PWD="$WORK" \
    CLAUDE_CONFIG_DIR="$CFG" \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
    ANTHROPIC_AUTH_TOKEN="fake-local-token-not-a-credential" \
    ANTHROPIC_MODEL="probe-parent-model" \
    "$TIMEOUT" 90 /Users/me/.local/bin/claude \
      -p "$PROMPT" --output-format json \
    >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
)
CLI_EXIT=$?
echo "exit=$CLI_EXIT (see $RUN)"
echo "--- captured requests:"; ls -1 "$RUN/capture" 2>/dev/null
echo "$RUN" > "$ROOT/tests/probes/.last-run"
exit "$CLI_EXIT"
