"""The Streamlit iframe must remain independent of server asset routes."""
import json
from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from calculator.streamlit_bundle import ROOT, _replace_once, _script_json, build_html, build_worker_source, write_component


class StreamlitBundleTests(unittest.TestCase):
    def test_html_has_all_assets_and_no_backend_requests(self):
        html = build_html()
        self.assertIn("Прогноз офтальмологической нагрузки", html)
        self.assertIn("__OPHTHALMOLOGY_CREATE_WORKER__", html)
        self.assertNotRegex(html, r'<script\s+src=|<link\s+rel="stylesheet"')
        self.assertNotIn('await fetch("/', html)
        self.assertNotIn('new Worker("/', html)
        self.assertIn('"runtime": "browser"', html)
        self.assertEqual(len(re.findall(r"<script>", html)), 2)
        self.assertEqual(len(re.findall(r"</script>", html)), 2)
        self.assertIn("IRIS2024", html)
        self.assertIn("model-guide", html)

    def test_separate_guide_link_uses_the_embedded_utf8_document(self):
        class Links(HTMLParser):
            links = []

            def handle_starttag(self, tag, attrs):
                if tag == "a":
                    self.links.append(dict(attrs))

        html = build_html()
        links = Links()
        links.feed(html)
        self.assertFalse(any(link.get("href") == "/docs/model-guide.html" for link in links.links))
        guide_links = [link for link in links.links if "data-bundled-guide" in link]
        self.assertEqual(len(guide_links), 1)
        self.assertEqual(guide_links[0]["target"], "_blank")
        self.assertIn('guideLink.href = URL.createObjectURL(new Blob(', html)
        self.assertIn('type: "text/html;charset=utf-8"', html)
        self.assertIn('\\u003cmeta charset=\\"utf-8\\"\\u003e', html)

    def test_script_data_cannot_close_its_html_element(self):
        value = {"text": '</script><script>alert("x")</script>&\u2028'}
        encoded = _script_json(value)
        self.assertNotIn("<", encoded)
        self.assertNotIn("&", encoded)
        self.assertEqual(json.loads(encoded), value)

    def test_stale_integration_points_fail_instead_of_silently_breaking(self):
        for source in ("missing", "twice twice"):
            with self.assertRaisesRegex(ValueError, "integration point"):
                _replace_once(source, "twice", "new", "test")

    def test_declared_component_is_one_reproducible_standalone_document(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = write_component(Path(temporary) / "frontend")
            index = directory / "index.html"
            initial = index.stat().st_mtime_ns
            self.assertEqual(index.read_text(encoding="utf-8"), build_html())
            self.assertIn('notify("streamlit:componentReady", {apiVersion: 1})', index.read_text(encoding="utf-8"))
            self.assertIn('notify("streamlit:setFrameHeight", {height: 1000})', index.read_text(encoding="utf-8"))
            write_component(directory)
            self.assertEqual(index.stat().st_mtime_ns, initial)
            self.assertEqual([file.name for file in directory.iterdir()], ["index.html"])

    def test_combined_worker_matches_original_numerical_engine(self):
        node = shutil.which("node")
        if not node:
            bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
            node = str(bundled) if bundled.exists() else None
        if not node:
            self.skipTest("Node.js is required for the numerical worker integration check.")
        worker = build_worker_source()
        self.assertNotRegex(worker, r"(?m)^\s*(?:import|export)\s")
        self.assertIn("Redistribution and use in source and binary forms", worker)
        script = r'''
import vm from "node:vm";
import {pathToFileURL} from "node:url";
const input = JSON.parse(await new Promise(resolve => {
  let data = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", x => data += x); process.stdin.on("end", () => resolve(data));
}));
const {forecast} = await import(pathToFileURL(input.engine));
const payload = structuredClone(input.config.defaults);
payload.iterations = 1000;
let handler, actual;
const context = vm.createContext({performance, structuredClone,
  self: {addEventListener(type, fn) {handler = fn;}, postMessage(result) {actual = result;}}
});
vm.runInContext(input.worker, context);
await handler({data: {requestId: 17, payload, config: input.config}});
if (actual.error) throw new Error(actual.error);
const expected = await forecast(payload, input.config);
for (const result of [actual.result, expected]) {
  result.meta.elapsed_seconds = 0;
  if (result.comparison) result.comparison.meta.elapsed_seconds = 0;
}
if (actual.requestId !== 17 || JSON.stringify(actual.result) !== JSON.stringify(expected)) {
  throw new Error("Bundled worker changed the seeded forecast.");
}
console.log(JSON.stringify(actual.result.interventions.map(x => x.patients.mean)));
'''
        config = json.loads((ROOT / "web/config.json").read_text(encoding="utf-8"))
        completed = subprocess.run([node, "--input-type=module", "-e", script],
                                   input=json.dumps({"config": config, "worker": worker,
                                                     "engine": str(ROOT / "web/engine.mjs")}),
                                   text=True, capture_output=True, encoding="utf-8", timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for actual, expected in zip(json.loads(completed.stdout), (69.5, 127, 3.6)):
            self.assertAlmostEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
