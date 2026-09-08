import http.server, json, sys, re, os

LOG = os.environ.get("MOCK_GATEWAY_LOG", "/tmp/oc_trial/requests.log")
TOKEN = os.environ.get("MOCK_GATEWAY_TOKEN", "")

def sse_chunk(delta, finish_reason=None):
    choice = {"index": 0, "delta": delta, "finish_reason": finish_reason}
    return "data: " + json.dumps({"id": "mock-1", "object": "chat.completion.chunk", "created": 0, "model": "mock-model", "choices": [choice]}) + "\n\n"

class H(http.server.BaseHTTPRequestHandler):
    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n) if n else b""
        with open(LOG, "a") as f:
            f.write("PATH=" + self.path + "\n")
            f.write("BODY=" + body.decode("utf-8", "replace") + "\n---\n")
        return body

    def _headers(self, content_type, length=None):
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        else:
            self.send_header("Transfer-Encoding", "chunked")
        # lets the test's readiness probe confirm it is talking to THIS instance,
        # not some other process that happened to be listening on the same port.
        self.send_header("X-Mock-Gateway-Token", TOKEN)
        self.end_headers()

    def _sse_write(self, text):
        # manual chunked-transfer framing since we declared Transfer-Encoding: chunked
        data = text.encode()
        self.wfile.write(("%x\r\n" % len(data)).encode() + data + b"\r\n")

    def _sse_end(self):
        self.wfile.write(b"0\r\n\r\n")

    def do_POST(self):
        body = self._read()
        try:
            req = json.loads(body) if body else {}
        except Exception:
            req = {}
        messages = req.get("messages", [])
        is_title = any("title generator" in (m.get("content") or "") for m in messages if isinstance(m.get("content"), str))
        has_tool_result = any(m.get("role") == "tool" for m in messages)
        stream = req.get("stream", False)

        user_text = " ".join(
            (m.get("content") if isinstance(m.get("content"), str) else json.dumps(m.get("content")))
            for m in messages if m.get("role") == "user"
        )
        match = re.search(r"spawn:([\w@.\-]+)", user_text)
        subagent_type = match.group(1) if match else "reviewer@fast"

        if is_title or has_tool_result:
            content = "ok" if not is_title else "Mock title"
            if stream:
                self.send_response(200)
                self._headers("text/event-stream")
                self._sse_write(sse_chunk({"role": "assistant", "content": content}))
                self._sse_write(sse_chunk({}, finish_reason="stop"))
                self._sse_write("data: [DONE]\n\n")
                self._sse_end()
            else:
                resp = {"id": "mock-1", "object": "chat.completion", "created": 0, "model": "mock-model",
                        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
                payload = json.dumps(resp).encode()
                self.send_response(200)
                self._headers("application/json", len(payload))
                self.wfile.write(payload)
            return

        tool_args = json.dumps({"subagent_type": subagent_type, "description": "test", "prompt": "hello"})
        if stream:
            self.send_response(200)
            self._headers("text/event-stream")
            self._sse_write(sse_chunk({"role": "assistant", "content": None}))
            self._sse_write(sse_chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                "function": {"name": "task", "arguments": tool_args}}]}))
            self._sse_write(sse_chunk({}, finish_reason="tool_calls"))
            self._sse_write("data: [DONE]\n\n")
            self._sse_end()
        else:
            resp = {"id": "mock-1", "object": "chat.completion", "created": 0, "model": "mock-model",
                    "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                        "role": "assistant", "content": None,
                        "tool_calls": [{"id": "call_1", "type": "function",
                                        "function": {"name": "task", "arguments": tool_args}}]}}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
            payload = json.dumps(resp).encode()
            self.send_response(200)
            self._headers("application/json", len(payload))
            self.wfile.write(payload)

    def do_GET(self):
        self._read()
        if "/models" in self.path:
            payload = json.dumps({"object": "list", "data": [{"id": "mock-model", "object": "model"}]}).encode()
        else:
            payload = b"{}"
        self.send_response(200)
        self._headers("application/json", len(payload))
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    # port 0 asks the OS for a free ephemeral port instead of guessing a fixed
    # or random-but-fixed one that could collide with an unrelated listener.
    requested_port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    srv = http.server.HTTPServer(("127.0.0.1", requested_port), H)
    # announce the actually-bound port so the caller never has to guess it.
    print("LISTENING:" + str(srv.server_address[1]), flush=True)
    srv.serve_forever()
