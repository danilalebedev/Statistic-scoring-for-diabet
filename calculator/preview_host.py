"""Serve the development GUI without Streamlit session registration.

Only the self-contained calculator and health endpoints are exposed. The
legacy component URL remains valid after a server restart or browser closure.
All patient scenarios and numerical work remain in the visiting browser.
"""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import traceback
from urllib.parse import urlsplit

from calculator.streamlit_bundle import ROOT, build_html


APPLICATION = "ophthalmology-calculator-development"
HTML_ROUTES = frozenset({
    "/", "/index.html",
    "/component/streamlit_app.ophthalmology/",
    "/component/streamlit_app.ophthalmology/index.html",
})
# The bundle contains owned inline assets and a module Worker created from a
# Blob. No server API, external asset, or network connection is needed by it.
CONTENT_SECURITY_POLICY = (
    "default-src 'none'; script-src 'unsafe-inline' blob:; "
    "style-src 'unsafe-inline'; img-src data:; worker-src blob:; "
    "frame-src 'self' blob:; connect-src 'none'; object-src 'none'; "
    "base-uri 'none'; form-action 'none'"
)


class PreviewServer(ThreadingHTTPServer):
    """A loopback server with an explicit application root for identification."""

    daemon_threads = True

    def __init__(self, port: int = 8502, root: Path = ROOT):
        self.root = Path(root).resolve()
        super().__init__(("127.0.0.1", port), Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = "OphthalmologyDevelopment/1.0"
    server: PreviewServer

    def send_content(self, data, status=200,
                     content_type="application/json; charset=utf-8", *, head=False,
                     allow=False):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        elif isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        if allow:
            self.send_header("Allow", "GET, HEAD")
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def respond(self, *, head=False):
        route = urlsplit(self.path).path
        if route == "/api/health":
            return self.send_content({
                "status": "ok", "application": APPLICATION,
                "runtime": "standalone-preview", "root": str(self.server.root),
                "process_id": os.getpid(), "port": self.server.server_port,
            }, head=head)
        if route == "/_stcore/health":
            return self.send_content("ok", content_type="text/plain; charset=utf-8", head=head)
        if route not in HTML_ROUTES:
            return self.send_content({"error": "Страница не найдена."}, 404, head=head)
        try:
            # Assemble on each navigation so development edits appear after a
            # reload, with no generated-file writes or Streamlit browser session.
            page = build_html(self.server.root)
        except Exception:
            traceback.print_exc()
            return self.send_content({"error": "Не удалось собрать интерфейс. Подробности в журнале сервера."},
                                     503, head=head)
        return self.send_content(page, content_type="text/html; charset=utf-8", head=head)

    def do_GET(self):
        self.respond()

    def do_HEAD(self):
        self.respond(head=True)

    def do_POST(self):
        self.send_content({"error": "Разрешены только GET и HEAD."}, 405, allow=True)

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST
    do_OPTIONS = do_POST
    do_TRACE = do_POST


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8502)
    args = parser.parse_args()
    with PreviewServer(args.port) as server:
        print(f"Development: http://127.0.0.1:{server.server_port}/", flush=True)
        print(f"Application root: {server.root}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
