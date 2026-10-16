"""Local API contract and input-boundary checks."""
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from calculator.server import Handler


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, data=None, headers=None):
        req = Request(self.base + path, data=data, headers=headers or {})
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_health_identifies_the_application(self):
        status, result = self.request("/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(result["application"], "ophthalmology-calculator")

    def test_config_and_forecast_are_compatible(self):
        _, config = self.request("/api/config")
        config["defaults"]["iterations"] = 1000
        status, result = self.request("/api/forecast", json.dumps(config["defaults"]).encode(), {"Content-Type": "application/json", "Origin": self.base})
        self.assertEqual(status, 200)
        self.assertEqual(result["meta"]["population_total"], 8000)
        self.assertEqual(len(result["interventions"]), 3)
        self.assertEqual(len(result["interventions"][0]["groups"]), 8)

    def test_bad_json_and_invalid_inputs_are_actionable_errors(self):
        for body in (b"{", b"{}", b"[]"):
            status, result = self.request("/api/forecast", body, {"Content-Type": "application/json"})
            self.assertEqual(status, 400)
            self.assertTrue(result["error"])

    def test_non_json_and_unrelated_origins_are_rejected(self):
        status, _ = self.request("/api/forecast", b"{}", {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        status, _ = self.request("/api/forecast", b"{}", {"Content-Type": "application/json", "Origin": "https://example.org"})
        self.assertEqual(status, 403)

    def test_unknown_routes_do_not_expose_workspace_files(self):
        status, _ = self.request("/analysis/source_extracted.json")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
