"""Exercise the actual iframe bridge against growing and shrinking app views."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

from calculator.streamlit_bundle import build_html


class StreamlitLayoutTests(unittest.TestCase):
    def test_bridge_resizes_for_results_and_view_changes_without_feedback(self):
        node = shutil.which("node")
        if not node:
            bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
            node = str(bundled) if bundled.exists() else None
        if not node:
            self.skipTest("Node.js is required to execute the iframe layout bridge.")

        scripts = re.findall(r"<script>(.*?)</script>", build_html(), flags=re.DOTALL)
        self.assertEqual(len(scripts), 2)
        script = r'''
import vm from "node:vm";
import assert from "node:assert/strict";
const bootstrap = JSON.parse(await new Promise(resolve => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => data += chunk);
  process.stdin.on("end", () => resolve(data));
}));

const messages = [], animationFrames = [], listeners = new Map();
const resizeObservers = [], mutationObservers = [];
const layout = {bottom: 1800};
const parent = {postMessage(message, target) {messages.push({message, target});}};
const window = {
  parent, scrollY: 0,
  addEventListener(type, callback) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(callback);
  }
};
const main = {getBoundingClientRect() {return {bottom: layout.bottom - window.scrollY};}};
const document = {
  body: {scrollHeight: 12000}, documentElement: {scrollHeight: 12000},
  querySelector(selector) {
    if (selector === "main" || selector === ".main") return main;
    if (selector === "a[data-bundled-guide]") return null;
    throw new Error(`Unexpected DOM query: ${selector}`);
  },
  fonts: {ready: Promise.resolve()}
};
const requestAnimationFrame = callback => {
  animationFrames.push(callback);
  return animationFrames.length;
};
class ResizeObserver {
  constructor(callback) {this.callback = callback; resizeObservers.push(this);}
  observe(target) {this.target = target;}
}
class MutationObserver {
  constructor(callback) {this.callback = callback; mutationObservers.push(this);}
  observe(target, options) {this.target = target; this.options = options;}
}
Object.assign(window, {requestAnimationFrame, ResizeObserver, MutationObserver});
vm.runInNewContext(bootstrap, {window, document, requestAnimationFrame, ResizeObserver, MutationObserver});

function flush() {
  let remaining = 20;
  while (animationFrames.length) {
    assert.ok(remaining-- > 0, "Frame resizing must not schedule an infinite feedback loop.");
    animationFrames.splice(0).forEach(callback => callback());
  }
}
function dispatch(type, event = {}) {
  for (const callback of listeners.get(type) || []) callback(event);
}
const heights = () => messages.filter(x => x.message.type === "streamlit:setFrameHeight").map(x => x.message.height);
const lastHeight = () => heights().at(-1);

await Promise.resolve();
flush();
assert.equal(messages.filter(x => x.message.type === "streamlit:componentReady").length, 1);
assert.equal(lastHeight(), 1816, "Initial content must not be clipped to 1000 pixels.");
assert.ok(resizeObservers.some(observer => observer.target === main));
assert.ok(mutationObservers.some(observer => observer.target === document.body && observer.options.subtree));

// Results appear asynchronously after the numerical worker finishes.
layout.bottom = 3000;
resizeObservers.forEach(observer => observer.callback([{target: main}]));
flush();
assert.equal(lastHeight(), 3016);

// The methodology document grows after its inner iframe finishes loading.
layout.bottom = 12000;
mutationObservers.forEach(observer => observer.callback([{target: document.body, type: "attributes"}]));
flush();
assert.equal(lastHeight(), 12016);

// Switching to a shorter view must shrink, even if iframe scrollHeight remains large.
layout.bottom = 2400;
window.scrollY = 250;
mutationObservers.forEach(observer => observer.callback([{target: main, type: "attributes"}]));
flush();
assert.equal(lastHeight(), 2416, "Measure app content, not the previous iframe viewport height.");

const beforeUnchanged = heights().length;
resizeObservers.forEach(observer => observer.callback([{target: main}]));
mutationObservers.forEach(observer => observer.callback([{target: main, type: "childList"}]));
dispatch("resize");
dispatch("load");
flush();
assert.equal(heights().length, beforeUnchanged, "Unchanged content must not post duplicate heights.");

// Render notifications are accepted only from the Streamlit parent.
layout.bottom = 2600;
dispatch("message", {source: {}, data: {type: "streamlit:render"}});
dispatch("message", {source: parent, data: {type: "unrelated"}});
flush();
assert.equal(heights().length, beforeUnchanged);
dispatch("message", {source: parent, data: {type: "streamlit:render"}});
flush();
assert.equal(lastHeight(), 2616);
assert.ok(messages.every(x => x.message.isStreamlitMessage === true && x.target === "*"));
console.log(JSON.stringify({heights: heights(), resizeObservers: resizeObservers.length}));
'''
        completed = subprocess.run(
            [node, "--input-type=module", "-e", script],
            input=json.dumps(scripts[0]), text=True, capture_output=True,
            encoding="utf-8", timeout=20,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["heights"], [1816, 3016, 12016, 2416, 2616])


if __name__ == "__main__":
    unittest.main()
