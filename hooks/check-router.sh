#!/bin/sh
# Session-start check for the subagent-router plugin. Silent when routing is live.
# It never blocks a session: it exits 0 whatever it finds.
#
# The installed plugin cannot know which router an operator runs, so the check reads the address
# the session itself uses. ANTHROPIC_BASE_URL is the only integration point; everything else is a
# guess about a machine this script cannot see.

BASE_URL=${ANTHROPIC_BASE_URL:-}
HEALTH_PATH=/subagent-router/control/instance

if [ -z "$BASE_URL" ]; then
  echo "subagent-router: ANTHROPIC_BASE_URL is not set, so subagent model routing is off in this session. Run /subagent-router:setup."
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "subagent-router: curl is missing, so the endpoint at ANTHROPIC_BASE_URL was not checked."
  exit 0
fi

# The control endpoint answers in the serving process and is never forwarded upstream, so its
# body is what tells a router apart from any other endpoint that returns 200.
if ! curl -sf --max-time 2 "${BASE_URL%/}${HEALTH_PATH}" 2>/dev/null | grep -q handlerInstanceId; then
  echo "subagent-router: no router answers at ANTHROPIC_BASE_URL${HEALTH_PATH}, so this session is not routing subagent models. Start the router, or run /subagent-router:setup."
fi
exit 0
