"""Loopback-only local GUI server. No analytics or outbound requests."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import traceback
from urllib.parse import urlsplit

from calculator.model import default_config, forecast

ROOT = Path(__file__).resolve().parent.parent
CALCULATION_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "OphthalmologyCalculator/1.1"

    def send_content(self, data, status=200, content_type="application/json; charset=utf-8"):
        if isinstance(data, (dict, list)):
            data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; connect-src 'self'")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/api/config":
            return self.send_content(default_config())
        if route == "/api/health":
            return self.send_content({"status": "ok", "application": "ophthalmology-calculator", "version": "1.1.0"})
        files = {
            "/": (ROOT / "web/index.html", "text/html; charset=utf-8"),
            "/index.html": (ROOT / "web/index.html", "text/html; charset=utf-8"),
            "/app.js": (ROOT / "web/app.js", "text/javascript; charset=utf-8"),
            "/styles.css": (ROOT / "web/styles.css", "text/css; charset=utf-8"),
            "/config.json": (ROOT / "web/config.json", "application/json; charset=utf-8"),
            "/compute-worker.js": (ROOT / "web/compute-worker.js", "text/javascript; charset=utf-8"),
            "/engine.mjs": (ROOT / "web/engine.mjs", "text/javascript; charset=utf-8"),
            "/quadrature.mjs": (ROOT / "web/quadrature.mjs", "text/javascript; charset=utf-8"),
            "/docs/model-guide.html": (ROOT / "docs/model-guide.html", "text/html; charset=utf-8"),
            "/docs/model-guide.txt": (ROOT / "docs/model-guide.txt", "text/plain; charset=utf-8"),
        }
        if route not in files:
            return self.send_content({"error": "Страница не найдена."}, 404)
        path, content_type = files[route]
        if not path.is_file():
            return self.send_content({"error": "Файл приложения ещё не готов."}, 503)
        return self.send_content(path.read_bytes(), content_type=content_type)

    def do_POST(self):
        if urlsplit(self.path).path != "/api/forecast":
            return self.send_content({"error": "Неизвестный запрос."}, 404)
        # JSON and an origin check prevent cross-site form submissions to a
        # user's local application. The server listens only on loopback.
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send_content({"error": "Ожидается application/json."}, 415)
        origin = self.headers.get("Origin")
        allowed = {f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"}
        if origin and origin not in allowed:
            return self.send_content({"error": "Недопустимый источник запроса."}, 403)
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 200000:
                return self.send_content({"error": "Недопустимый размер запроса."}, 413)
            payload = json.loads(self.rfile.read(length))
            if not CALCULATION_LOCK.acquire(blocking=False):
                return self.send_content({"error": "Расчёт уже выполняется. Дождитесь завершения."}, 409)
            try:
                result = forecast(payload)
            finally:
                CALCULATION_LOCK.release()
            return self.send_content(result)
        except (ValueError, json.JSONDecodeError) as exc:
            return self.send_content({"error": str(exc)}, 400)
        except Exception:
            traceback.print_exc()
            return self.send_content({"error": "Внутренняя ошибка расчёта; подробности сохранены в журнале сервера."}, 500)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Local: http://127.0.0.1:{server.server_port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
