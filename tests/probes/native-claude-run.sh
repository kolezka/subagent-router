#!/bin/bash
# Drive the REAL installed `claude` CLI against the local mock gateway only.
# Strict env allowlist via `env -i`: no inherited ANTHROPIC_API_KEY, no CCR vars,
# no provider credentials. Loopback base URL + fake token only.
# Usage: native-claude-run.sh <simple|delegate>
set -uo pipefail

MODE="${1:-simple}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="$ROOT/tests/probes/.runs/$MODE-$$"
HOMEDIR="$RUN/home"
CFG="$RUN/config"
WORK="$RUN/work"
mkdir -p "$HOMEDIR" "$CFG" "$WORK" "$RUN/capture"

PROBE_OUT="$RUN/capture" PROBE_MODE="$MODE" \
  node "$ROOT/tests/probes/native-claude-gateway.mjs" >"$RUN/gateway.log" 2>&1 &
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
for pair in "alpha:haiku" "beta:sonnet"; do
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
env -i \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin" \
  HOME="$HOMEDIR" \
  PWD="$WORK" \
  CLAUDE_CONFIG_DIR="$CFG" \
  ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
  ANTHROPIC_AUTH_TOKEN="fake-local-token-not-a-credential" \
  ANTHROPIC_MODEL="probe-parent-model" \
  "$TIMEOUT" 90 /Users/me/.local/bin/claude \
    -p "$PROMPT" --output-format json \
  >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
echo "exit=$? (see $RUN)"
echo "--- captured requests:"; ls -1 "$RUN/capture" 2>/dev/null
echo "$RUN" > "$ROOT/tests/probes/.last-run"
