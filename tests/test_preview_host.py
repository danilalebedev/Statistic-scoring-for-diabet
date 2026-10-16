"""The development URL must work without opening a Streamlit session."""
import json
import os
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from calculator.preview_host import APPLICATION, Handler, PreviewServer
from calculator.streamlit_bundle import ROOT


class PreviewHostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = PreviewServer(port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        cls.quiet = patch.object(Handler, "log_message")
        cls.quiet.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        cls.quiet.stop()

    def request(self, path, method="GET", data=None):
        request = Request(self.base + path, method=method, data=data)
        try:
            response = urlopen(request, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, response.headers, response.read()

    def test_legacy_url_works_before_any_root_browser_session(self):
        status, headers, legacy = self.request("/component/streamlit_app.ophthalmology/index.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn("Редактировать риски".encode(), legacy)
        self.assertIn(b"__OPHTHALMOLOGY_CREATE_WORKER__", legacy)
        self.assertIn(b'"runtime": "browser"', legacy)
        for route in ("/", "/index.html", "/component/streamlit_app.ophthalmology/"):
            status, _, content = self.request(route)
            self.assertEqual(status, 200)
            self.assertEqual(content, legacy)

    def test_health_identifies_this_process_and_development_root(self):
        status, _, content = self.request("/api/health")
        self.assertEqual(status, 200)
        health = json.loads(content)
        self.assertEqual(health["status"], "ok")
        self.assertEqual(health["application"], APPLICATION)
        self.assertEqual(health["root"], str(ROOT.resolve()))
        self.assertEqual(health["process_id"], os.getpid())
        self.assertEqual(health["port"], self.server.server_port)
        self.assertEqual(health["runtime"], "standalone-preview")
        status, _, content = self.request("/_stcore/health")
        self.assertEqual((status, content), (200, b"ok"))

    def test_head_reports_same_size_without_returning_body(self):
        for route in ("/", "/api/health", "/_stcore/health", "/missing"):
            status, headers, body = self.request(route)
            head_status, head_headers, head_body = self.request(route, method="HEAD")
            self.assertEqual(head_status, status)
            self.assertEqual(head_headers["Content-Type"], headers["Content-Type"])
            self.assertEqual(int(head_headers["Content-Length"]), len(body))
            self.assertEqual(head_body, b"")

    def test_allowlist_rejects_workspace_files_and_encoded_traversal(self):
        for path in ("/README.md", "/web/config.json", "/analysis/isolation.json",
                     "/../web/index.html", "/%2e%2e/web/index.html",
                     "/component/streamlit_app.ophthalmology/../../README.md",
                     "/component/streamlit_app.ophthalmology/%2e%2e%2fREADME.md"):
            with self.subTest(path=path):
                status, _, content = self.request(path)
                self.assertEqual(status, 404)
                self.assertIn("error", json.loads(content))

    def test_post_and_other_mutations_are_not_an_api(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            status, headers, content = self.request("/api/forecast", method, data=b"{}")
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "GET, HEAD")
            self.assertIn("error", json.loads(content))

    def test_rebuilds_current_owned_sources_without_caching(self):
        with patch("calculator.preview_host.build_html", side_effect=["first", "second"]) as build:
            first = self.request("/")
            second = self.request("/")
        self.assertEqual(first[2], b"first")
        self.assertEqual(second[2], b"second")
        self.assertEqual(build.call_count, 2)
        self.assertEqual(first[1]["Cache-Control"], "no-store")

    def test_security_policy_allows_bundled_worker_without_network_fetches(self):
        _, headers, content = self.request("/")
        policy = headers["Content-Security-Policy"]
        self.assertIn("script-src 'unsafe-inline' blob:", policy)
        self.assertIn("worker-src blob:", policy)
        self.assertIn("frame-src 'self' blob:", policy)
        self.assertIn("connect-src 'none'", policy)
        self.assertIn("base-uri 'none'", policy)
        self.assertNotIn(b'await fetch("/', content)


if __name__ == "__main__":
    unittest.main()
