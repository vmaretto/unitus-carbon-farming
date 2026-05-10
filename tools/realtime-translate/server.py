#!/usr/bin/env python3
"""Tiny dev server for the realtime translator web UI.

- ``GET  /`` serves ``index.html``.
- ``POST /session`` calls the OpenAI Realtime API to mint an ephemeral
  client token configured with the IT<->EN translator instructions, and
  forwards the response to the browser.

Standard library only.  Run::

    export OPENAI_API_KEY=sk-...
    python server.py            # http://127.0.0.1:8787

The browser uses the ephemeral token to open a WebRTC peer connection
straight to ``api.openai.com``; this process never sees the audio.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib import error, request

ROOT = Path(__file__).parent
MODEL = os.environ.get("REALTIME_MODEL", "gpt-4o-realtime-preview")
VOICE = os.environ.get("REALTIME_VOICE", "alloy")

INSTRUCTIONS = (
    "You are a real-time simultaneous interpreter between Italian and English. "
    "Detect the language of the user's speech automatically: "
    "if the user speaks Italian, translate the meaning into fluent English; "
    "if the user speaks English, translate the meaning into fluent Italian. "
    "Output ONLY the translated sentence as natural spoken audio, with no "
    "preamble, no commentary, no language labels. Keep the speaking pace "
    "close to the speaker's and never repeat or paraphrase yourself."
)

SESSION_PAYLOAD = {
    "model": MODEL,
    "voice": VOICE,
    "modalities": ["audio", "text"],
    "instructions": INSTRUCTIONS,
    "turn_detection": {
        "type": "server_vad",
        "threshold": 0.5,
        "prefix_padding_ms": 200,
        "silence_duration_ms": 350,
        "create_response": True,
        "interrupt_response": True,
    },
}


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path in ("/", "/index.html"):
            try:
                html = (ROOT / "index.html").read_bytes()
            except FileNotFoundError:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(html)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/session":
            self.send_response(404)
            self.end_headers()
            return

        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            self._send_json(500, {"error": "OPENAI_API_KEY is not set"})
            return

        body = json.dumps(SESSION_PAYLOAD).encode()
        req = request.Request(
            "https://api.openai.com/v1/realtime/sessions",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "OpenAI-Beta": "realtime=v1",
            },
        )
        try:
            with request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as e:
            try:
                detail = json.loads(e.read().decode("utf-8", "replace"))
            except Exception:
                detail = {"message": str(e)}
            self._send_json(e.code, {"error": detail})
            return
        except Exception as e:  # urllib URLError, timeout, ...
            self._send_json(502, {"error": str(e)})
            return

        self._send_json(200, data)

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> None:
    port = int(os.environ.get("PORT", "8787"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Realtime translator UI on http://127.0.0.1:{port}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
