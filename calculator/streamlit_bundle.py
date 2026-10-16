"""Embed the existing calculator in Streamlit without a second web server.

Only application-owned, checked-in assets are bundled. Config, documentation,
CSS, UI code and the numerical worker travel in a single iframe document;
patient scenarios and simulation results stay in the visiting browser.
"""
from __future__ import annotations

import json
from pathlib import Path
import tempfile


ROOT = Path(__file__).resolve().parent.parent


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    """Fail visibly when a source edit makes an integration replacement stale."""
    if source.count(old) != 1:
        raise ValueError(f"Streamlit bundle: expected one {label} integration point.")
    return source.replace(old, new, 1)


def _script_json(value) -> str:
    """Serialize data safely inside a script element, including closing tags."""
    return (json.dumps(value, ensure_ascii=False, allow_nan=False)
            .replace("&", "\\u0026").replace("<", "\\u003c")
            .replace(">", "\\u003e").replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def build_worker_source(root: Path = ROOT) -> str:
    """Join the unchanged quadrature, engine and worker in one module Blob."""
    notices = (root / "web/THIRD_PARTY_NOTICES.txt").read_text(encoding="utf-8")
    quadrature = (root / "web/quadrature.mjs").read_text(encoding="utf-8")
    quadrature = _replace_once(quadrature, "export const NODES", "const NODES", "quadrature nodes")
    quadrature = _replace_once(quadrature, "export const WEIGHTS", "const WEIGHTS", "quadrature weights")
    engine = (root / "web/engine.mjs").read_text(encoding="utf-8")
    engine = _replace_once(engine, "import { NODES, WEIGHTS } from './quadrature.mjs';", "", "engine import")
    engine = _replace_once(engine, "export async function forecast", "async function forecast", "forecast export")
    engine = _replace_once(engine, "export const numerical", "const numerical", "numerical export")
    worker = (root / "web/compute-worker.js").read_text(encoding="utf-8")
    worker = _replace_once(worker, "import { forecast } from './engine.mjs';", "", "worker import")
    return "\n\n".join(("/*\n" + notices.replace("*/", "* /") + "\n*/", quadrature, engine, worker))


def build_html(root: Path = ROOT) -> str:
    """Return the full GUI, adapted for an inline Streamlit iframe."""
    page = (root / "web/index.html").read_text(encoding="utf-8")
    styles = (root / "web/styles.css").read_text(encoding="utf-8")
    app = (root / "web/app.js").read_text(encoding="utf-8")
    config = json.loads((root / "web/config.json").read_text(encoding="utf-8"))
    config["runtime"] = "browser"
    guide = ('<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
             + (root / "docs/model-guide.html").read_text(encoding="utf-8"))
    bundle = _script_json({"config": config, "guide": guide, "workerSource": build_worker_source(root)})

    app = _replace_once(app, 'new Worker("/compute-worker.js", {type: "module"})',
                        "window.__OPHTHALMOLOGY_CREATE_WORKER__()", "worker creation")
    guide_fetch = '''const response = await fetch("/docs/model-guide.html");
      if (!response.ok) throw new Error("Описание модели пока недоступно.");
      const content = await response.text();'''
    app = _replace_once(app, guide_fetch,
                        "const content = window.__OPHTHALMOLOGY_BUNDLE__.guide;", "guide loading")
    config_fetch = '''try {
        const response = await fetch("/config.json");
        if (!response.ok) throw new Error("Нет статической конфигурации.");
        config = await response.json();
      } catch {
        const response = await fetch("/api/config");
        if (!response.ok) throw new Error("Не удалось загрузить параметры модели.");
        config = await response.json();
      }'''
    app = _replace_once(app, config_fetch,
                        "config = clone(window.__OPHTHALMOLOGY_BUNDLE__.config);", "configuration loading")
    forecast_fetch = '''if (config.runtime === "browser") return calculateInBrowser(payload);
    const response = await fetch("/api/forecast", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось выполнить расчёт.");
    return data;'''
    app = _replace_once(app, forecast_fetch, "return calculateInBrowser(payload);", "forecast loading")
    app = _replace_once(app, ' Убедитесь, что локальный сервер запущен, затем обновите страницу.',
                        ' Обновите страницу и повторите попытку.', "initialization error")

    # A Worker Blob keeps the original numerical engine, its BSD attribution,
    # and GH96 nodes intact. Revoke its URL once the first reply/error arrives.
    bootstrap = """window.__OPHTHALMOLOGY_BUNDLE__ = Object.freeze(BUNDLE_DATA);
window.__OPHTHALMOLOGY_CREATE_WORKER__ = function () {
  const url = URL.createObjectURL(new Blob([window.__OPHTHALMOLOGY_BUNDLE__.workerSource], {type: "text/javascript"}));
  try {
    const worker = new Worker(url, {type: "module"});
    const release = () => URL.revokeObjectURL(url);
    worker.addEventListener("message", release, {once: true});
    worker.addEventListener("error", release, {once: true});
    setTimeout(release, 180000);
    return worker;
  } catch (error) { URL.revokeObjectURL(url); throw error; }
};
const guideLink = document.querySelector("a[data-bundled-guide]");
if (guideLink) {
  guideLink.href = URL.createObjectURL(new Blob([window.__OPHTHALMOLOGY_BUNDLE__.guide], {type: "text/html;charset=utf-8"}));
}
if (window.parent !== window) {
  const notify = (type, data) => window.parent.postMessage({isStreamlitMessage: true, type, ...data}, "*");
  window.addEventListener("message", event => {
    if (event.source === window.parent && event.data?.type === "streamlit:render") {
      notify("streamlit:setFrameHeight", {height: 1000});
    }
  });
  notify("streamlit:componentReady", {apiVersion: 1});
  notify("streamlit:setFrameHeight", {height: 1000});
}""".replace("BUNDLE_DATA", bundle)

    # Script data is serialized above; owned app code currently has no closing
    # script tag. Refuse such a future change instead of producing broken HTML.
    if "</script" in app.lower() or "</style" in styles.lower():
        raise ValueError("Streamlit bundle: an inline asset contains a closing HTML tag.")
    page = _replace_once(page, '<link rel="stylesheet" href="/styles.css">',
                         f"<style>{styles}</style>", "stylesheet")
    page = _replace_once(page, '<script src="/app.js" defer></script>', "", "app script")
    page = _replace_once(page, 'href="/docs/model-guide.html"',
                         'href="#" data-bundled-guide', "separate guide link")
    page = _replace_once(page, "</body>", f"<script>{bootstrap}</script>\n<script>{app}</script>\n</body>", "body end")
    return page


def write_component(destination: Path | None = None, root: Path = ROOT) -> Path:
    """Publish only the self-contained GUI to Streamlit's component handler.

    The generated directory contains no patient data or workspace files. Its
    index can also be opened directly, bypassing Streamlit's framework assets.
    """
    directory = destination if destination is not None else root / "streamlit_component"
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "index.html"
    html = build_html(root)
    if not target.exists() or target.read_text(encoding="utf-8") != html:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         prefix=".index-", suffix=".tmp", dir=directory,
                                         delete=False) as output:
            output.write(html)
            temporary = Path(output.name)
        temporary.replace(target)
    return directory
