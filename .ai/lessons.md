# Lessons

Local and untracked. Each entry names a mistake made in this repository and the rule that
prevents it next time.

## Never unlink a log file a running process holds open

2026-09-14, measuring `install --parent-model` against a loopback mock gateway.

What happened: I ran `rm -f /tmp/sr-gateway-requests.log` to get a clean reading. The mock
gateway was still running and still held a write fd on that path. Every later write went to
the unlinked inode, so the new file stayed empty. I read the empty file as evidence that no
request had left the client and concluded that Claude Code rejects an unknown
`ANTHROPIC_MODEL` before sending anything. That was wrong; the client's own
`api_error_status: 404` showed a request had reached the gateway.

Rule: to clear a log that a live process writes to, truncate it (`: > file`) instead of
removing it, or restart the writer after removing it. Before reading any empty, zero or
silent result as evidence about the system under test, prove the measurement chain with a
positive control. Here that was one `curl -X POST .../v1/messages -d '{"model":"positive-control"}'`
that had to appear in the log before any real reading counted.

## Never match your own command line with pgrep or pkill

2026-09-14, twice.

`kill $(pgrep -f "sr-mock-gateway.ts")` matched the shell running that very command and
killed the shell (exit 144). The same thing happened earlier with `pkill -f`.

Rule: get the PID from the listening socket (`ss -ltnp` filtered by port) or from the job
the process was started as, and kill by that number. If `pgrep -f` is unavoidable, pipe it
through `head -1` and check the PID is not the current shell first.

## A test that never fails is not an instrument

The test asserting that no generated install file contains the value of an environment
secret was only trustworthy after it was made to fail on purpose: injecting the control
string into the generated README turned the suite to 10 pass / 1 fail, and reverting it
restored 11 pass. A green assertion over an empty or unreachable set proves nothing. Make a
new guard fail once before trusting it.
