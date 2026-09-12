#!/bin/bash
# Drive the REAL installed `claude` CLI against the local mock gateway only.
# Strict env allowlist via `env -i`: no inherited ANTHROPIC_API_KEY, no CCR vars,
# no provider credentials. Loopback base URL + fake token only.
# Usage: native-claude-run.sh <simple|delegate|handler|next-turn|resume|nested|compaction>
# Set PROBE_CLAUDE_BIN to pin which client binary a run uses.
set -uo pipefail

MODE="${1:-simple}"
case "$MODE" in
  simple|delegate|handler|next-turn|resume|nested|compaction) ;;
  *) echo "FAIL: unknown mode '$MODE' (expected simple, delegate, handler, next-turn, resume, nested, or compaction)" >&2; exit 2 ;;
esac

# Pin one binary. The default path is a symlink the client updater repoints mid-run, so freeze
# the canonical target now and run that exact file everywhere below.
CLAUDE_BIN_SELECTED="${PROBE_CLAUDE_BIN:-/Users/me/.local/bin/claude}"
[ -x "$CLAUDE_BIN_SELECTED" ] || { echo "FAIL: PROBE_CLAUDE_BIN is not executable: $CLAUDE_BIN_SELECTED" >&2; exit 2; }
# Relative and bare names resolve against the caller cwd here, before any subshell cd, never via PATH.
CLAUDE_BIN="$(/usr/bin/readlink -f "$CLAUDE_BIN_SELECTED" 2>/dev/null)"
[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || { echo "FAIL: could not resolve PROBE_CLAUDE_BIN to a canonical executable: $CLAUDE_BIN_SELECTED" >&2; exit 2; }

# handler, next-turn, resume and nested share the same bun-driven fixture (native-claude-handler.ts)
# and the same isolation setup. next-turn additionally forces each routed child to issue two upstream
# requests (see PROBE_CHILD_READ_FILE below) and declares mode "next-turn" in the run manifest.
# resume runs TWO sequential CLI invocations against the same session (PROBE_RESUME below) and
# declares mode "resume". nested lets exactly ONE child (native-probe-alpha) delegate to the other
# (PROBE_NESTED_AGENT below) so a grandchild request can be measured for
# x-claude-code-parent-agent-id; handler mode stays exactly as before (one invocation, one request
# per child). compaction reuses next-turn's forced-Read channel with a large file and more than one
# round, plus the client's auto-compaction env vars, so one child's own conversation crosses the
# compaction threshold and still has a turn left afterwards.
is_handler_like() { [ "$MODE" = "handler" ] || [ "$MODE" = "next-turn" ] || [ "$MODE" = "resume" ] || [ "$MODE" = "nested" ] || [ "$MODE" = "compaction" ]; }
# Modes driving a routed child through the forced Read tool, which needs the tool actually allowed.
uses_child_read() { [ "$MODE" = "next-turn" ] || [ "$MODE" = "compaction" ]; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT/tests/probes/.runs" || exit 1
RUN="$(mktemp -d "$ROOT/tests/probes/.runs/$MODE-XXXXXX")" || exit 1
HOMEDIR="$RUN/home"
CFG="$RUN/config"
WORK="$RUN/work"
mkdir -p "$HOMEDIR" "$CFG" "$WORK" "$RUN/capture"

# Copy the resolved executable before any client invocation. The updater can replace the original
# target after resolution, so every invocation, including --version, runs this read-only snapshot.
CLAUDE_BIN_SOURCE="$CLAUDE_BIN"
CLAUDE_BIN="$RUN/client-binary"
/bin/cp "$CLAUDE_BIN_SOURCE" "$CLAUDE_BIN" || exit 1
/bin/chmod 500 "$CLAUDE_BIN" || exit 1
printf '%s\n' "$CLAUDE_BIN_SOURCE" > "$RUN/capture/client-binary-source"
printf '%s\n' "$CLAUDE_BIN" > "$RUN/capture/client-binary"
/usr/bin/shasum -a 256 "$CLAUDE_BIN" | awk '{print $1}' > "$RUN/capture/client-binary.sha256" || exit 1

if is_handler_like; then
  # The handler binds its alternate marker slot to the exact client version it is told
  # about, so observe that version first, from the same isolated environment the real
  # run below uses. No network: --version answers locally.
  VERSION_OUT="$(
    cd "$WORK" && env -i \
      PATH="/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin" \
      HOME="$HOMEDIR" CLAUDE_CONFIG_DIR="$CFG" \
      DISABLE_AUTOUPDATER=1 DISABLE_UPDATES=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      ANTHROPIC_BASE_URL="http://127.0.0.1:1" ANTHROPIC_AUTH_TOKEN="fake-local-token-not-a-credential" \
      "$CLAUDE_BIN" --version 2>/dev/null
  )"
  CLIENT_VERSION="$(printf '%s' "$VERSION_OUT" | /usr/bin/grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | /usr/bin/head -1)"
  [ -z "$CLIENT_VERSION" ] && { echo "FAIL: could not observe client version"; exit 1; }
  printf '%s\n' "$CLIENT_VERSION" > "$RUN/capture/client-version"
  if [ "$MODE" = "next-turn" ]; then
    # Only next-turn forces the two-request-per-child flow: a file inside the CLI's own
    # sandboxed WORK dir that the fixture's forced tool_use (Read) points the real client's
    # Read tool at, so the second request is a genuine tool_result round trip, not a fake one.
    PROBE_CHILD_READ_FILE="$WORK/probe-child-read.txt"
    printf 'probe-child-read-notice\n' > "$PROBE_CHILD_READ_FILE"
    PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
      PROBE_LAYOUT="${PROBE_LAYOUT:-}" \
      PROBE_CHILD_READ_FILE="$PROBE_CHILD_READ_FILE" \
      bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
  elif [ "$MODE" = "compaction" ]; then
    # compaction reuses next-turn's forced-Read channel, with three differences. The client does
    # NOT estimate context size from the transcript: it anchors on the last assistant message
    # carrying `usage` and sums that, so a long history alone never triggers anything.
    # PROBE_CHILD_USAGE_INPUT_TOKENS is what actually moves the estimate, making a routed child's
    # reply report 5000 input_tokens: past the ~800-token threshold forced below with margin, and
    # still far under the window itself. The large Read file gives the child real history to
    # compact, and PROBE_CHILD_READ_ROUNDS keeps issuing Reads so the child still has turns left
    # once the client has compacted. One of those later requests is the one expected to carry
    # compact_boundary in its history.
    #
    # PROBE_CHILD_USAGE_RAMP_AFTER_ROUNDS is why 5000 does not start on the first reply. A measured
    # run showed the decision firing seven times (level=compact) and then bailing inside the
    # client's reactive compactor with "fewer than 2 groups, nothing to compact": the threshold was
    # crossed while the child's conversation was still two messages long, so there was nothing old
    # enough to summarize. Holding the small usage back for the first 3 completed rounds means the
    # child has four assistant turns behind it before the threshold trips, and 6 rounds leaves
    # three more requests afterwards to carry the boundary.
    #
    # PROBE_ANSWER_COMPACTION_SUMMARIES is the step after that. Once the compactor has work it
    # sends a summarizer request through the gateway that looks like an answered Read round, and
    # the fixture used to reply with the next forced Read. The compactor reads the last assistant
    # text block, so a tool_use-only reply is rejected as "empty summary text" and there is no
    # retry. With this set the fixture answers that one request with a real summary instead.
    #
    # PROBE_CORRELATION_SCAFFOLD is forwarded from the invoking environment, never set here. With
    # it the handler's profile also opens the correlation gate, so a child whose compacted history
    # no longer carries the channel-A marker can still be routed by its agent id. Only this mode
    # forwards it: it is the phase where the marker is the thing that goes missing.
    PROBE_CHILD_READ_FILE="$WORK/probe-child-read.txt"
    python3 -c 'import sys; sys.stdout.write("probe compaction filler line carrying enough words to be worth counting\n" * 400)' > "$PROBE_CHILD_READ_FILE"
    PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
      PROBE_LAYOUT="${PROBE_LAYOUT:-}" \
      PROBE_CORRELATION_SCAFFOLD="${PROBE_CORRELATION_SCAFFOLD:-}" \
      PROBE_CHILD_READ_FILE="$PROBE_CHILD_READ_FILE" \
      PROBE_CHILD_READ_ROUNDS=6 \
      PROBE_CHILD_USAGE_INPUT_TOKENS=5000 \
      PROBE_CHILD_USAGE_RAMP_AFTER_ROUNDS=3 \
      PROBE_ANSWER_COMPACTION_SUMMARIES=1 \
      bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
  elif [ "$MODE" = "resume" ]; then
    # resume is handler-like but enables the fixture's resume re-delegation opt-in so a second,
    # resumed CLI invocation re-delegates instead of replaying the first round's final answer.
    # No PROBE_CHILD_READ_FILE: the two requests per child come from TWO separate invocations,
    # never a forced tool_use within one.
    PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
      PROBE_LAYOUT="${PROBE_LAYOUT:-}" \
      PROBE_RESUME=1 \
      PROBE_RESUME_EXISTING_CHILD="${PROBE_RESUME_EXISTING_CHILD:-}" \
      bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
  elif [ "$MODE" = "nested" ]; then
    # nested is handler-like but enables the fixture's nested-delegation opt-in: exactly one child
    # (native-probe-alpha) is answered with a forced Agent tool_use delegating to the other child
    # (native-probe-beta) on its first request, so a grandchild request is produced whose
    # x-claude-code-parent-agent-id header (if the client sends one) can be measured. No
    # PROBE_CHILD_READ_FILE: the second request comes from executing the nested Agent tool, not a
    # forced Read.
    PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
      PROBE_LAYOUT="${PROBE_LAYOUT:-}" \
      PROBE_NESTED_AGENT="native-probe-alpha" \
      bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
  else
    # Real production createHandler + scripted mock upstream (Bun), not the plain
    # Node gateway: this is how channel A (the parent's explicit model= marker) gets
    # exercised end to end against a real native client. Byte-identical to before
    # next-turn mode existed: no PROBE_CHILD_READ_FILE, one request per child.
    PROBE_OUT="$RUN/capture" RUN_NATIVE_PROBES=1 PROBE_CLIENT_VERSION="$CLIENT_VERSION" \
      PROBE_LAYOUT="${PROBE_LAYOUT:-}" \
      bun "$ROOT/tests/probes/native-claude-handler.ts" >"$RUN/gateway.log" 2>&1 &
  fi
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
# system stays ON; child agents declare `tools: []` so they can execute nothing, except
# next-turn and compaction modes which add the harmless `Read` tool (see PROBE_CHILD_READ_FILE
# above).
if uses_child_read; then
  ALLOW_JSON='["Agent", "Read"]'
elif [ "$MODE" = "resume" ] && [ "${PROBE_RESUME_EXISTING_CHILD:-}" = "1" ]; then
  ALLOW_JSON='["Agent", "SendMessage", "TaskOutput"]'
else
  ALLOW_JSON='["Agent"]'
fi
cat >"$CFG/settings.json" <<JSON
{ "includeCoAuthoredBy": false,
  "permissions": { "allow": $ALLOW_JSON, "deny": ["Bash", "Write", "Edit", "WebFetch"] } }
JSON
cat >"$HOMEDIR/.claude.json" <<JSON
{ "hasCompletedOnboarding": true, "bypassPermissionsModeAccepted": true,
  "projects": { "$WORK": { "hasTrustDialogAccepted": true, "allowedTools": [],
    "history": [], "onboardingSeenCount": 5 } } }
JSON

# Two child agents with DIFFERENT models + explicit marker, per the routing question.
mkdir -p "$CFG/agents"
if is_handler_like; then
  # Channel A selects the model via the first-line marker, not agent frontmatter:
  # both fixture agents must inherit so the marker is what's actually being tested.
  AGENT_PAIRS="alpha:inherit beta:inherit"
else
  AGENT_PAIRS="alpha:haiku beta:sonnet"
fi
# next-turn's and compaction's forced tool_use needs an actual tool the child is allowed to call;
# handler mode (and simple/delegate) keep tools: [] exactly as before -- their children can execute
# nothing. nested additionally grants ONLY native-probe-alpha the Agent tool (the one delegating
# child), so it can issue a grandchild request; beta and every other mode keep their existing line.
if uses_child_read; then
  CHILD_TOOLS_LINE="[Read]"
else
  CHILD_TOOLS_LINE="[]"
fi
for pair in $AGENT_PAIRS; do
  name="native-probe-${pair%%:*}"; model="${pair##*:}"
  if [ "$MODE" = "nested" ] && [ "$name" = "native-probe-alpha" ]; then
    AGENT_TOOLS_LINE="[Agent]"
  else
    AGENT_TOOLS_LINE="$CHILD_TOOLS_LINE"
  fi
  cat >"$CFG/agents/$name.md" <<MD
---
name: $name
description: Local probe agent $name
model: $model
tools: $AGENT_TOOLS_LINE
---
Reply with exactly: DONE-$name
MD
done

# SubagentStart hook: capture whatever payload the CLI actually delivers.
# Default (fake): a static script that echoes a canned marker, never a real measurement.
# Opt-in production hook (handler or next-turn mode, PROBE_FRESHNESS_HOOK=production): tee the
# raw event to the same capture file the fake hook writes, then feed it to the REAL published
# claude-hook entrypoint (src/transport/claude-hook.ts) pointed at THIS run's own front
# server, so M10-freshness measures the real hook, never a stand-in.
FRESHNESS_HOOK="${PROBE_FRESHNESS_HOOK:-fake}"
if is_handler_like && [ "$FRESHNESS_HOOK" = "production" ]; then
  cat >"$RUN/router-config.json" <<JSON
{ "version": 1,
  "modelSource": { "sourceId": "native-probe-gateway", "baseUrlEnv": "SUBAGENT_ROUTER_UNUSED_MODELS_URL", "endpointPath": "/v1/models", "headersEnv": [], "timeoutMs": 10000, "fetchLimit": 1000, "staleAfterSeconds": 86400 },
  "modelOverrides": {},
  "roles": { "claude-code:native-probe-alpha": { "routeOverride": "gateway/fast-worker" }, "claude-code:native-probe-beta": { "routeOverride": "gateway/smart-worker" } },
  "defaults": { "child": null, "unmarkedSubagent": "error" },
  "agentRoots": { "claude-code": { "configRoot": null }, "opencode": { "configRoot": null }, "codex": { "configRoot": null } },
  "gateway": { "urlEnv": "SUBAGENT_ROUTER_UNUSED_GATEWAY_URL", "headersEnv": [] },
  "harness": { "claudeCode": { "correlation": "off", "secretEnv": "SUBAGENT_ROUTER_SECRET" }, "opencode": { "providerId": "gateway" }, "codex": { "emitModelCatalog": false } } }
JSON
  cat >"$RUN/hook.sh" <<HOOK
#!/bin/bash
tee "$RUN/capture/hook-subagentstart-\$\$.json" | bun "$ROOT/src/transport/claude-hook.ts" \\
  --config "$RUN/router-config.json" \\
  --profile-dir "$ROOT/tests/fixtures/capabilities" \\
  --client-version "$CLIENT_VERSION" \\
  --control-url "http://127.0.0.1:$PORT"
HOOK
else
  cat >"$RUN/hook.sh" <<HOOK
#!/bin/bash
cat > "$RUN/capture/hook-subagentstart-\$\$.json"
echo '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"PROBE_HOOK_CTX"}}'
HOOK
fi
chmod +x "$RUN/hook.sh"
python3 - "$CFG/settings.json" "$RUN/hook.sh" <<'PY'
import json,sys
p,h=sys.argv[1],sys.argv[2]
d=json.load(open(p))
d["hooks"]={"SubagentStart":[{"hooks":[{"type":"command","command":h}]}]}
json.dump(d,open(p,"w"),indent=2)
PY

# Run declaration: which lifecycle phases this run means to exercise (never inferred, always
# explicit -- see tests/probes/evidence-m10.ts's readRunManifest). native-claude-run.sh's own
# scenarios (simple/delegate) never exercise next-turn/resume/compaction/nested/parallel on
# purpose, so this defaults to declaring nothing; an operator driving a real lifecycle
# transition sets PROBE_PHASES_EXERCISED (comma-separated) before invoking this script. Only
# handler-like (handler, next-turn) modes write NNN-profile.json etc. at all, so only they get
# a manifest; the manifest's own "mode" field is whichever of the two was actually invoked.
if is_handler_like; then
  PHASES_JSON="$(printf '%s' "${PROBE_PHASES_EXERCISED:-}" | python3 -c 'import json,sys
s = sys.stdin.read().strip()
print(json.dumps([p for p in s.split(",") if p]))')"
  # Read from the invoking environment, not from the branch that forwarded it: the handler is
  # started as a plain child of this shell and inherits the whole environment, so whatever the
  # operator exported is what it actually saw. tests/probes/fixture-writer.ts refuses a lifecycle
  # pass from a scaffolded run on the strength of this flag, so it has to match reality.
  CORRELATION_SCAFFOLD_JSON=false
  [ "${PROBE_CORRELATION_SCAFFOLD:-}" = "1" ] && CORRELATION_SCAFFOLD_JSON=true
  RESUME_STRATEGY=unknown
  if [ "$MODE" = "resume" ]; then
    if [ "${PROBE_RESUME_EXISTING_CHILD:-}" = "1" ]; then
      RESUME_STRATEGY=message-existing
    else
      RESUME_STRATEGY=re-delegate
    fi
  fi
  cat >"$RUN/capture/000-run-manifest.json" <<JSON
{ "mode": "$MODE", "phasesExercised": $PHASES_JSON, "freshnessHook": "$FRESHNESS_HOOK", "correlationScaffold": $CORRELATION_SCAFFOLD_JSON, "resumeStrategy": "$RESUME_STRATEGY" }
JSON
fi

TIMEOUT="$(command -v timeout || command -v gtimeout)"
[ -x "$TIMEOUT" ] || { echo "FAIL: no timeout/gtimeout binary"; exit 1; }
PROMPT="${PROBE_PROMPT:-Say PARENT_ROUNDTRIP_OK}"
echo "=== RUN mode=$MODE port=$PORT run=$RUN"
# PWD alone does not change the client's working directory.
# SUBAGENT_ROUTER_SECRET is only ever added to the client's env for handler or next-turn mode
# with the production freshness hook (the only path that needs it, to sign a
# FreshDelegationEnvelope proof). simple and delegate mode must stay byte-identical to before
# this var existed: it may not appear in their env -i invocation, not even set to an empty
# value. A bash array would be the tidy way to add one conditional assignment, but /bin/bash on
# this machine is 3.2.57, where "${ARR[@]}" on a never-populated array throws "unbound variable"
# under `set -u` -- confirmed empirically, not assumed -- so this uses a duplicated branch
# instead of an array trick.
#
# resume is the one mode that needs TWO sequential CLI invocations against the SAME session: the
# first creates the session under a fixed --session-id (the CLI echoes that id back), the second
# resumes it with -c (continue; passing the same --session-id again fails with "already in use",
# confirmed empirically) so the parent re-delegates and each child issues a second routed request
# across the resume boundary. The handler server stays up for BOTH invocations (the EXIT trap
# only kills it at script end), and both write to the SAME $RUN/capture dir.
if [ "$MODE" = "resume" ]; then
  # resume drives TWO real CLI invocations, so its two env -i calls carry no
  # SUBAGENT_ROUTER_SECRET (that var belongs to the handler+production-freshness-hook branch
  # below, which is single-invocation). Running the production freshness hook under resume would
  # silently drop the secret the hook needs, so refuse the combination up front rather than run a
  # half-wired measurement.
  if [ "$FRESHNESS_HOOK" = "production" ]; then
    echo "FAIL: resume mode does not support PROBE_FRESHNESS_HOOK=production yet" >&2
    exit 2
  fi
  PROBE_SESSION_ID="c0ffee00-0000-4000-8000-000000000000"
  PROMPT2="${PROBE_PROMPT2:-Delegate again}"
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
      "$TIMEOUT" 90 "$CLAUDE_BIN" \
        -p "$PROMPT" --output-format json --session-id "$PROBE_SESSION_ID" \
      >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
  )
  CLI1_EXIT=$?
  printf '%s\n' "$CLI1_EXIT" > "$RUN/cli-exit-status"
  if [ "$CLI1_EXIT" -ne 0 ]; then
    # A timed-out or failed invocation 1 must never be masked by a later invocation 2's success:
    # report the first failure, leave .last-run pointing at this run, and stop before resuming.
    echo "exit=$CLI1_EXIT (see $RUN)"
    echo "--- captured requests:"; ls -1 "$RUN/capture" 2>/dev/null
    echo "$RUN" > "$ROOT/tests/probes/.last-run"
    exit "$CLI1_EXIT"
  fi
  echo "exit-inv1=$CLI1_EXIT"
  # Where invocation 1's captures stop. Nothing in a request says which CLI invocation produced
  # it, so the resume judge splits each agent's requests at this seq: at or below it is
  # pre-boundary, above it is post-boundary. Taken here, after invocation 1 has finished writing
  # and before invocation 2 writes anything. Leading zeros are stripped because JSON rejects 007
  # and bash printf %d reads 008 as a bad octal number; %s then writes the plain digits.
  BOUNDARY_SEQ="$(/bin/ls -1 "$RUN/capture" 2>/dev/null \
    | /usr/bin/sed -n 's/^\([0-9][0-9]*\)-.*\.json$/\1/p' \
    | /usr/bin/sort -n | /usr/bin/tail -n 1 | /usr/bin/sed 's/^0*//')"
  [ -z "$BOUNDARY_SEQ" ] && BOUNDARY_SEQ=0
  printf '{ "afterSeq": %s }\n' "$BOUNDARY_SEQ" > "$RUN/capture/invocation-boundary.json"
  echo "boundary-after-seq=$BOUNDARY_SEQ"
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
      "$TIMEOUT" 90 "$CLAUDE_BIN" \
        -c -p "$PROMPT2" --output-format json \
      >"$RUN/cli2-stdout.json" 2>"$RUN/cli2-stderr.txt"
  )
  CLI_EXIT=$?
  printf '%s\n' "$CLI_EXIT" > "$RUN/cli2-exit-status"
  echo "exit=$CLI_EXIT (see $RUN)"
  echo "--- captured requests:"; ls -1 "$RUN/capture" 2>/dev/null
  echo "$RUN" > "$ROOT/tests/probes/.last-run"
  exit "$CLI_EXIT"
fi

# compaction needs two extra vars in the client's env, so it gets its own branch rather than an
# array (see the bash 3.2 note above). CLAUDE_CODE_AUTO_COMPACT_WINDOW is floored at 100000 by the
# client, so a smaller value would be silently raised; CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1 is what
# actually drops the fire threshold to roughly 800 tokens counted over conversation messages.
# DISABLE_COMPACT and DISABLE_AUTO_COMPACT must stay UNSET here: auto-compaction is opt-out only,
# so naming either of them at all would turn off the very thing this mode exists to measure.
#
# This branch also asks the client to write its own debug log, because a run that produces no
# compact_boundary cannot otherwise be told apart from one where the decision never fired. The
# client logs "autocompact: tokens=N level=..." at every check: level=compact means the decision
# fired and the failure is downstream, level=ok means the injected usage never moved the estimate,
# and no line at all means the check never ran. The log sink is pinned inside $RUN so it stays
# with the rest of the run's evidence; the client rotates to cli-debug.1.txt in the same dir.
if [ "$MODE" = "compaction" ]; then
  # Same reasoning as resume: this branch carries no SUBAGENT_ROUTER_SECRET, so running the
  # production freshness hook here would silently drop the secret the hook needs to sign a
  # FreshDelegationEnvelope. Refuse up front rather than run a half-wired measurement.
  if [ "$FRESHNESS_HOOK" = "production" ]; then
    echo "FAIL: compaction mode does not support PROBE_FRESHNESS_HOOK=production yet" >&2
    exit 2
  fi
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
      CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 \
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1 \
      "$TIMEOUT" 90 "$CLAUDE_BIN" \
        --debug-file "$RUN/cli-debug.txt" \
        -p "$PROMPT" --output-format json \
      >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
  )
elif is_handler_like && [ "$FRESHNESS_HOOK" = "production" ]; then
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
      SUBAGENT_ROUTER_SECRET="${PROBE_ROUTER_SECRET:-}" \
      "$TIMEOUT" 90 "$CLAUDE_BIN" \
        -p "$PROMPT" --output-format json \
      >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
  )
else
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
      "$TIMEOUT" 90 "$CLAUDE_BIN" \
        -p "$PROMPT" --output-format json \
      >"$RUN/cli-stdout.json" 2>"$RUN/cli-stderr.txt"
  )
fi
CLI_EXIT=$?
printf '%s\n' "$CLI_EXIT" > "$RUN/cli-exit-status"
echo "exit=$CLI_EXIT (see $RUN)"
echo "--- captured requests:"; ls -1 "$RUN/capture" 2>/dev/null
echo "$RUN" > "$ROOT/tests/probes/.last-run"
exit "$CLI_EXIT"
