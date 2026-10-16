"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const html = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[character]));
  const numberFormat = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 1});
  const preciseFormat = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 3});
  const wholeFormat = new Intl.NumberFormat("ru-RU", {maximumFractionDigits: 0});
  const fmt = (value) => Number.isFinite(Number(value)) ? (Math.abs(Number(value)) > 0 && Math.abs(Number(value)) < 0.1 ? preciseFormat.format(Number(value)) : numberFormat.format(Number(value))) : "—";
  const pct = (value) => `${preciseFormat.format(Number(value) * 100)}%`;
  const integer = (value) => Number.isFinite(Number(value)) ? wholeFormat.format(Number(value)) : "—";
  const interval = (summary) => `${fmt(summary?.interval?.lower)}–${fmt(summary?.interval?.upper)}`;
  const shortNames = {prp: "ПРЛК", dme: "ИВВ при ДМО", vit: "Витрэктомия"};
  const maximumPopulation = 80000000;
  const fallbackMomentPresets = [
    {id: "IRIS2024", label: "IRIS · 3,9 ± 2,8", mean: 3.9, sd: 2.8, source_id: "IRIS2024", note: "Первый год оказанного лечения на глаз. Реальная практика США; возможны недолечивание и цензурирование."},
    {id: "Peto2022", label: "Peto · 7,7 ± 1,9", mean: 7.7, sd: 1.9, source_id: "Peto2022", note: "Первый год на глаз в наблюдаемой подгруппе трёх NHS-клиник. Среднее не относится ко всем пациентам исходной когорты."},
    {id: "DRAKO2023", label: "DRAKO · 6,4 ± 2,1", mean: 6.4, sd: 2.1, source_id: "DRAKO2023", note: "Первый год у ранее не леченных пациентов с данными в окне наблюдения. PPW: 388 из 507 пациентов."}
  ];
  const colors = {prp: {fill: "#85b5a5", stroke: "#417768", pale: "#f2f8f5"}, dme: {fill: "#a2a1c3", stroke: "#75779e", pale: "#f6f6fa"}, vit: {fill: "#c4ab89", stroke: "#9c805d", pale: "#faf7f2"}};
  const icons = {
    prp: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17m10-10 1.4-1.4"/></svg>',
    dme: '<svg viewBox="0 0 24 24"><path d="m16 3 5 5m-3-3-3 3M14 7l3 3-8 8H6v-3zM6 18l-3 3M11 10l3 3"/></svg>',
    vit: '<svg viewBox="0 0 24 24"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
  };
  let config = null;
  let state = null;
  let result = null;
  let selectedMeasure = "patients";
  let selectedIntervention = "prp";
  let running = false;
  let toastTimer;
  let guideLoaded = false;
  let riskEditing = false;
  let forecastWorker = null;
  let workerSequence = 0;
  const workerRequests = new Map();

  function showToast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3800);
  }

  function showError(message) {
    $("#app-error").textContent = message;
    $("#app-error").hidden = !message;
  }

  function switchView(view) {
    $$(".nav-item").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $$(".view").forEach((section) => {
      const active = section.id === `view-${view}`;
      section.classList.toggle("active", active);
      section.hidden = !active;
    });
    if (view === "method") { showError(""); loadGuide(); }
    if (view === "calculation" && result) requestAnimationFrame(renderChart);
    window.scrollTo({top: 0, behavior: "instant"});
  }

  function currentProfile() {
    return config?.profiles.find((profile) => profile.id === "expert_annual");
  }

  function groupType(group) {
    const value = String(group.type || "");
    if (/2/.test(value)) return "СД2";
    if (/1/.test(value)) return "СД1";
    return value;
  }

  function groupDuration(group) {
    return String(group.duration || group.label || "").replace(/^СД\s*[12][\s,·:—-]*/, "");
  }

  function groupLabel(group, rich = false) {
    const type = groupType(group);
    const duration = groupDuration(group);
    return rich ? `<span class="group-type-label ${type === "СД2" ? "t2" : ""}">${html(type)}</span>${html(duration)}` : `${type} · ${duration}`;
  }

  function syncProfile() {
    const profile = currentProfile();
    const note = profile?.description || "Проверьте исходные допущения перед использованием прогноза.";
    $("#profile-note span").textContent = note;
    $("#parameters-profile-note").textContent = `${profile?.title || "Годовая потребность по группам"}. ${note}`;
    $("#risk-provenance").innerHTML = '<strong>Экспертный сценарий исходного документа.</strong> Все 24 исходных коэффициента — предположения годовой потребности, а не измеренные московские вероятности. Расчёт охватывает полный год, включая продолжающееся лечение. При появлении новых данных обновите нужные ячейки и укажите источник. <a href="#method" data-view-link="method">Методика и источники ↗</a>';
    $("#multiplicity-note").textContent = "Среднее и SD задают полный объём процедур за прогнозные 12 месяцев. ИВВ — на глаз; второй глаз моделируется отдельно. Стандартное отклонение не равно ошибке среднего. Моменты кратности считаются фиксированными: неопределённость их оценки в интервал не включена.";
  }

  function renderPopulation() {
    const types = [...new Set(config.groups.map(groupType))];
    $("#population-body").innerHTML = types.map((type) => {
      const groups = config.groups.filter((group) => groupType(group) === type);
      return `<tr><th scope="row"><span class="type-pill ${type === "СД2" ? "t2" : ""}">${html(type)}</span><span class="type-description">${type === "СД1" ? "1 тип" : "2 тип"}</span></th>${groups.map((group) => `<td><input class="population-input" data-group="${html(group.id)}" type="number" min="0" max="${maximumPopulation}" step="1" value="${state.populations[group.id]}" aria-label="Численность: ${html(groupLabel(group))}"></td>`).join("")}</tr>`;
    }).join("");
    updatePopulationTotal();
  }

  function updatePopulationTotal() {
    const total = Object.values(state.populations).reduce((sum, value) => sum + Number(value || 0), 0);
    $("#population-total").textContent = integer(total);
    $("#overall-population").value = total;
    $("#overall-population").classList.toggle("invalid", total > maximumPopulation);
    $("#population-allocation-note").textContent = "Размер распределяется пропорционально текущему составу восьми групп.";
  }

  function applyPopulation(equal = false, notify = true) {
    const total = readNumber($("#overall-population"));
    if (total === null) {
      showError("Размер контингента должен быть целым числом от 0 до 80 000 000.");
      $("#overall-population").focus();
      return false;
    }
    const groups = config.groups;
    const currentTotal = groups.reduce((sum, group) => sum + Number(state.populations[group.id] || 0), 0);
    const shares = groups.map((group, index) => {
      const weight = equal || currentTotal === 0 ? 1 / groups.length : state.populations[group.id] / currentTotal;
      const quota = total * weight;
      return {id: group.id, index, count: Math.floor(quota), remainder: quota - Math.floor(quota)};
    });
    const remaining = total - shares.reduce((sum, item) => sum + item.count, 0);
    [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index).slice(0, remaining).forEach((item) => { item.count += 1; });
    shares.forEach((item) => { state.populations[item.id] = item.count; });
    renderPopulation();
    $("#population-allocation-note").textContent = equal || currentTotal === 0
      ? `Распределено поровну с целочисленным остатком: сумма групп точно ${integer(total)}.`
      : `Состав групп сохранён пропорционально; целочисленное округление сохраняет точную сумму ${integer(total)}.`;
    showError("");
    markDirty();
    if (notify) showToast(`Контингент ${integer(total)} человек распределён по восьми группам.`);
    return true;
  }

  function applyPendingPopulation() {
    const value = readNumber($("#overall-population"));
    if (value === null) {
      showError("Размер контингента должен быть целым числом от 0 до 80 000 000. Проверьте также сумму восьми групп.");
      switchView("calculation");
      $("#overall-population").focus();
      return false;
    }
    const sum = Object.values(state.populations).reduce((total, count) => total + count, 0);
    return value === sum || applyPopulation(false, false);
  }

  function renderRisks() {
    $("#risk-body").innerHTML = config.groups.map((group, index) => `<tr${index && groupType(group) !== groupType(config.groups[index - 1]) ? ' class="type-separator"' : ""}><td>${groupLabel(group, true)}</td>${config.interventions.map((intervention) => `<td><input class="risk-input" data-group="${html(group.id)}" data-intervention="${html(intervention.id)}" type="number" min="0" max="1000" step="0.001" value="${state.risks_per_1000[group.id][intervention.id]}" aria-label="Риск на тысячу: ${html(groupLabel(group))}, ${html(shortNames[intervention.id] || intervention.name)}"></td>`).join("")}</tr>`).join("");
    const revision = state.risk_revision || {};
    $("#risk-source").value = revision.source || "";
    $("#risk-data-date").value = revision.as_of || "";
    $("#risk-revision-note").value = revision.note || "";
    syncRiskLock();
  }

  function risksDifferFromBaseline() {
    const baseline = currentProfile()?.risks_per_1000;
    return config.groups.some((group) => config.interventions.some((intervention) =>
      Number(state.risks_per_1000[group.id][intervention.id]) !== Number(baseline?.[group.id]?.[intervention.id])));
  }

  function syncRiskLock() {
    const modified = risksDifferFromBaseline();
    $("#risk-card").classList.toggle("risk-editing", riskEditing);
    $$(".risk-input, #risk-source, #risk-data-date, #risk-revision-note").forEach((input) => {
      input.readOnly = !riskEditing;
      input.setAttribute("aria-readonly", String(!riskEditing));
    });
    const toggle = $("#toggle-risk-editing");
    toggle.textContent = riskEditing ? "Зафиксировать значения" : "Редактировать риски";
    toggle.setAttribute("aria-pressed", String(riskEditing));
    $("#risk-lock-status").textContent = riskEditing ? "Редактирование рисков включено" : "Риски зафиксированы";
    $("#risk-baseline-badge").textContent = modified ? "Изменённый сценарий" : "Исходные значения";
    $("#risk-baseline-badge").classList.toggle("modified", modified);
    $("#risk-lock-note").textContent = riskEditing
      ? "Измените нужные ячейки и зафиксируйте значения. Исходная таблица профиля сохранится."
      : "Таблица защищена от случайных изменений. Для обновления включите редактирование.";
    const updatedAt = state.risk_revision?.updated_at;
    const stamp = updatedAt ? `Последнее изменение: ${new Intl.DateTimeFormat("ru-RU", {dateStyle: "short", timeStyle: "short"}).format(new Date(updatedAt))}. ` : "";
    $("#risk-revision-stamp").textContent = `${stamp}Изменения относятся только к текущему сценарию. Сохраните JSON, чтобы использовать их позже.`;
  }

  function touchRiskRevision() {
    state.risk_revision = {
      source: $("#risk-source").value.trim(),
      as_of: $("#risk-data-date").value,
      note: $("#risk-revision-note").value.trim(),
      updated_at: new Date().toISOString()
    };
    syncRiskLock();
  }

  function validateRiskRevision() {
    const invalid = $$(".risk-input, #risk-source, #risk-data-date, #risk-revision-note").find((input) =>
      input.matches("input[type=number]") ? readNumber(input) === null : !input.checkValidity());
    if (!invalid) return true;
    switchView("parameters");
    showError("Проверьте риски: допустимы значения от 0 до 1 000 с точностью до 0,001. Дата данных должна быть в пределах 1900–2100 годов.");
    invalid.focus();
    return false;
  }

  function restoreRisks() {
    state.risks_per_1000 = clone(currentProfile().risks_per_1000);
    delete state.risk_revision;
    riskEditing = false;
    renderRisks();
    markDirty();
    showError("");
  }

  function renderUncertainty() {
    $("#uncertainty-body").innerHTML = config.interventions.map((intervention) => `<tr><td>${html(shortNames[intervention.id] || intervention.name)}</td><td><input class="uncertainty-input" data-intervention="${html(intervention.id)}" type="number" min="0" max="500" step="1" value="${roundPercent(state.uncertainty_cv[intervention.id])}" aria-label="CV интенсивности, ${html(shortNames[intervention.id])}, проценты"></td><td><input class="capture-input" data-intervention="${html(intervention.id)}" type="number" min="0" max="100" step="0.1" value="${roundPercent(state.capture[intervention.id])}" aria-label="Доля потока, ${html(shortNames[intervention.id])}, проценты"></td></tr>`).join("");
  }

  function momentPresets() { return Array.isArray(config.dme_moment_presets) && config.dme_moment_presets.length ? config.dme_moment_presets : fallbackMomentPresets; }

  function selectedMomentPreset() {
    const parameters = state.procedures.dme;
    return momentPresets().find((preset) => (!parameters.moment_source || preset.id === parameters.moment_source || preset.source_id === parameters.moment_source) && Math.abs(Number(preset.mean) - parameters.mean) < 0.000001 && Math.abs(Number(preset.sd) - parameters.sd) < 0.000001);
  }

  function syncMomentPreset() {
    const preset = selectedMomentPreset();
    const select = $("#dme-moment-source");
    if (!select) return;
    select.value = preset?.id || "custom";
    const source = preset ? config.sources.find((item) => item.id === preset.source_id) : null;
    $("#dme-moment-note").textContent = preset?.note || "Пользовательские моменты кратности. Укажите среднее и стандартное отклонение числа инъекций на один лечащийся глаз.";
    const link = $("#dme-moment-link");
    const url = safeURL(source?.url);
    link.hidden = !url;
    if (url) link.href = url;
  }

  function roundPercent(value) { return Math.round(Number(value) * 100000) / 1000; }

  function procedureInput(id, parameter, value, label, maximum = 100) {
    return `<div class="multiplicity-field"><label for="procedure-${id}-${parameter}">${html(label)}</label><input id="procedure-${id}-${parameter}" class="procedure-input" data-intervention="${id}" data-parameter="${parameter}" type="number" min="${parameter === "mean" ? "1" : "0"}" max="${maximum}" step="0.01" value="${value}"></div>`;
  }

  function renderMultiplicity() {
    const procedures = state.procedures;
    $("#multiplicity-controls").innerHTML = `
      <div class="multiplicity-row"><div class="multiplicity-label">ПРЛК<small>сеансов на пациента</small></div>${procedureInput("prp", "mean", procedures.prp.mean, "Среднее")}${procedureInput("prp", "sd", procedures.prp.sd, "Станд. откл.")}</div>
      <div class="dme-preset-control"><label for="dme-moment-source">ИВВ: источник среднего и стандартного отклонения</label><select id="dme-moment-source">${momentPresets().map((preset) => `<option value="${html(preset.id)}">${html(preset.label)}</option>`).join("")}<option value="custom">Свой сценарий кратности</option></select><p id="dme-moment-note"></p><a id="dme-moment-link" href="#" target="_blank" rel="noopener noreferrer" hidden>Источник моментов ↗</a></div>
      <div class="multiplicity-row"><div class="multiplicity-label">ИВВ при ДМО<small>инъекций на глаз</small></div>${procedureInput("dme", "mean", procedures.dme.mean, "Среднее")}${procedureInput("dme", "sd", procedures.dme.sd, "Станд. откл.")}</div>
      <p class="dme-sd-explanation">SD — разброс числа инъекций между глазами, а не ошибка среднего. Его квадрат участвует в дисперсии числа процедур. Опубликованные моменты первого года не являются вероятностью ДМО.</p>
      <div class="multiplicity-row single"><div class="multiplicity-label">Второй глаз при ИВВ<small>вероятность лечения второго глаза</small></div>${procedureInput("dme", "bilateral_probability", roundPercent(procedures.dme.bilateral_probability), "Вероятность, %", 100)}</div>
      <div class="multiplicity-row single"><div class="multiplicity-label">Повторная витрэктомия<small>одна дополнительная операция</small></div>${procedureInput("vit", "repeat_probability", roundPercent(procedures.vit.repeat_probability), "Вероятность, %", 100)}</div>
      <p class="multiplicity-preset">ПРЛК: исходные моменты SOURCE — 2,42 ± 1,51. Среднее 1,2 из СД.docx не задаёт собственного SD. Второй глаз и повторная операция остаются сценарными допущениями. Изменения сохраняются в сценарии.</p>`;
    syncMomentPreset();
  }

  function safeURL(value) {
    try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : ""; } catch { return ""; }
  }

  function syncGeneralControls() {
    $("#coverage-custom").value = roundPercent(state.coverage);
    $("#iterations").value = state.iterations;
    $("#seed").value = state.seed;
    syncCoverageButtons();
  }

  function syncCoverageButtons() {
    $$("#coverage-presets button").forEach((button) => {
      const selected = Math.abs(Number(button.dataset.coverage) / 100 - state.coverage) < 0.000001;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
  }

  function renderInputs() {
    syncProfile();
    renderPopulation();
    renderRisks();
    renderUncertainty();
    renderMultiplicity();
    syncGeneralControls();
  }

  function markDirty() {
    if (state) {
      const hasUncertainty = Object.values(state.uncertainty_cv).some((value) => value > 0);
      $("#concrete-model-description").textContent = hasUncertainty
        ? "К биномиальному риску добавлен общий множитель интенсивности (CV > 0). SD кратности отдельно входит в дисперсию числа процедур."
        : "Риски фиксированы (CV = 0). Дисперсия числа процедур включает SD кратности, лечение второго глаза и повторную витрэктомию.";
    }
    if (!result) return;
    const status = $("#result-status");
    status.textContent = "Параметры изменены";
    status.className = "result-status stale";
  }

  function readNumber(input) {
    const value = Number(input.value);
    const valid = input.value.trim() !== "" && Number.isFinite(value) && input.checkValidity();
    input.classList.toggle("invalid", !valid);
    return valid ? value : null;
  }

  function updateFromInput(input) {
    if (input.classList.contains("risk-input") && !riskEditing) return;
    const value = readNumber(input);
    if (value === null) { markDirty(); return; }
    if (input.id === "overall-population") {
      $("#population-allocation-note").textContent = "Новый размер будет распределён при нажатии «Применить размер» или при расчёте.";
    } else if (input.classList.contains("population-input")) {
      state.populations[input.dataset.group] = value;
      updatePopulationTotal();
    } else if (input.classList.contains("risk-input")) {
      state.risks_per_1000[input.dataset.group][input.dataset.intervention] = value;
      touchRiskRevision();
    } else if (input.classList.contains("uncertainty-input")) {
      state.uncertainty_cv[input.dataset.intervention] = value / 100;
    } else if (input.classList.contains("capture-input")) {
      state.capture[input.dataset.intervention] = value / 100;
    } else if (input.classList.contains("procedure-input")) {
      const probability = input.dataset.parameter.endsWith("probability");
      state.procedures[input.dataset.intervention][input.dataset.parameter] = probability ? value / 100 : value;
      if (input.dataset.intervention === "dme" && ["mean", "sd"].includes(input.dataset.parameter)) {
        state.procedures.dme.moment_source = "custom";
        syncMomentPreset();
      }
    } else if (input.id === "coverage-custom") {
      state.coverage = value / 100;
      syncCoverageButtons();
    } else if (input.id === "iterations") state.iterations = value;
    else if (input.id === "seed") state.seed = value;
    markDirty();
  }

  function validateInputs() {
    if (riskEditing && !validateRiskRevision()) return false;
    const invalid = $$("input[type=number]").find((input) => readNumber(input) === null);
    if (invalid) {
      const view = invalid.closest(".view");
      if (view) switchView(view.id.replace("view-", ""));
      showError(`Проверьте поле «${invalid.getAttribute("aria-label") || invalid.id}»: требуется число в допустимом диапазоне.`);
      invalid.focus();
      return false;
    }
    return true;
  }

  function setRunning(value) {
    running = value;
    $("#calculate").disabled = value;
    $("#calculate").classList.toggle("loading", value);
    $("#calculate span").textContent = value ? "Вычисление…" : "Рассчитать прогноз";
    $(".results-section").setAttribute("aria-busy", String(value));
    $("#result-content").classList.toggle("loading-overlay", value);
  }

  function calculateInBrowser(payload) {
    return new Promise((resolve, reject) => {
      if (!forecastWorker) {
        try { forecastWorker = new Worker("/compute-worker.js", {type: "module"}); }
        catch { reject(new Error("Не удалось запустить расчёт в браузере. Обновите страницу или проверьте поддержку Web Workers.")); return; }
        forecastWorker.onmessage = (event) => {
          const message = event.data || {};
          const pending = workerRequests.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          workerRequests.delete(message.requestId);
          if (message.error) pending.reject(new Error(String(message.error)));
          else if (message.result) pending.resolve(message.result);
          else pending.reject(new Error("Расчёт в браузере вернул неполные данные."));
        };
        forecastWorker.onerror = (event) => {
          event.preventDefault();
          workerRequests.forEach((pending) => { clearTimeout(pending.timeout); pending.reject(new Error("Модуль расчёта недоступен. Обновите страницу и повторите попытку.")); });
          workerRequests.clear();
          forecastWorker.terminate();
          forecastWorker = null;
        };
      }
      const requestId = ++workerSequence;
      const timeout = setTimeout(() => {
        workerRequests.delete(requestId);
        forecastWorker?.terminate();
        forecastWorker = null;
        reject(new Error("Расчёт занял слишком много времени. Уменьшите число симуляций и повторите попытку."));
      }, 180000);
      workerRequests.set(requestId, {resolve, reject, timeout});
      forecastWorker.postMessage({requestId, payload, config});
    });
  }

  async function requestForecast(payload) {
    if (config.runtime === "browser") return calculateInBrowser(payload);
    const response = await fetch("/api/forecast", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(payload)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось выполнить расчёт.");
    return data;
  }

  async function calculate() {
    if (!state || running || !applyPendingPopulation() || !validateInputs()) return;
    showError("");
    setRunning(true);
    const payload = clone(state);
    try {
      const data = await requestForecast(payload);
      if (!Array.isArray(data.interventions) || !data.meta) throw new Error("Сервер вернул неполные результаты расчёта.");
      result = data;
      renderResults();
      const draftTotal = Number($("#overall-population").value);
      const currentTotal = Object.values(state.populations).reduce((sum, value) => sum + value, 0);
      if (JSON.stringify(state) !== JSON.stringify(payload) || draftTotal !== currentTotal) markDirty();
    } catch (error) {
      showError(error.message || "Нет связи с локальным сервером расчёта.");
      showToast("Расчёт не завершён. Проверьте сообщение об ошибке.");
    } finally { setRunning(false); }
  }

  function summaryCard(intervention) {
    const {patients, procedures} = intervention;
    return `<article class="summary-card ${selectedIntervention === intervention.id ? "selected" : ""}" data-key="${html(intervention.id)}"><button type="button" class="card-select" data-select-intervention="${html(intervention.id)}" aria-label="Показать ${html(shortNames[intervention.id] || intervention.name)} по группам"></button><div class="summary-top"><h3 class="summary-name">${html(shortNames[intervention.id] || intervention.name)}</h3><span class="summary-icon">${icons[intervention.id] || icons.prp}</span></div><div class="summary-primary"><strong class="summary-number">${fmt(patients.mean)}</strong><span class="summary-unit">пациентов</span></div><div class="summary-interval">Интервал ${pct(result.meta.coverage)}: ${interval(patients)}</div><div class="summary-secondary"><span>Процедур за 12 месяцев<span class="summary-mini-interval">Интервал: ${interval(procedures)}</span></span><span><strong>${fmt(procedures.mean)}</strong></span></div></article>`;
  }

  function selectedResult() { return result?.interventions.find((item) => item.id === selectedIntervention) || result?.interventions[0]; }

  function renderResults() {
    $("#result-empty").hidden = true;
    $("#result-content").hidden = false;
    $("#summary-cards").innerHTML = result.interventions.map(summaryCard).join("");
    $("#result-status").textContent = "Рассчитано";
    $("#result-status").className = "result-status ready";
    const elapsed = Number(result.meta.elapsed_seconds);
    $("#results-meta").textContent = `12 месяцев · ${integer(result.meta.population_total)} пациентов в базе · ${pct(result.meta.coverage)}${Number.isFinite(elapsed) ? ` · ${fmt(elapsed)} с` : ""}`;
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    $("#result-warnings").innerHTML = warnings.map((warning) => `<div class="warning-item">${html(warning)}</div>`).join("");
    renderSelectedResult();
  }

  function renderSelectedResult() {
    if (!result) return;
    const active = selectedResult();
    selectedIntervention = active.id;
    $$("#intervention-tabs button").forEach((button) => {
      const selected = button.dataset.intervention === selectedIntervention;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $$("#measure-toggle button").forEach((button) => {
      const selected = button.dataset.measure === selectedMeasure;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $$(".summary-card").forEach((card) => card.classList.toggle("selected", card.dataset.key === selectedIntervention));
    const metric = selectedMeasure === "patients" ? "Пациенты" : "Процедуры";
    const coverage = pct(result.meta.coverage);
    $("#chart-description").textContent = `${metric.toLowerCase()} · ${shortNames[active.id] || active.name} · среднее и предиктивный интервал`;
    $("#detail-description").textContent = `${shortNames[active.id] || active.name} · ${metric.toLowerCase()} за 12 месяцев`;
    $("#legend-coverage").textContent = `Интервал ${coverage}`;
    $("#interval-column-label").textContent = `Интервал ${coverage}`;
    $("#capacity-column-label").textContent = `Мощность P${roundPercent(result.meta.coverage)}`;
    $("#capacity-explanation").textContent = `Мощность P${roundPercent(result.meta.coverage)} — односторонний квантиль: при принятых допущениях этого объёма достаточно с вероятностью ${coverage}.`;
    const rows = active.groups.map((group, index) => {
      const knownGroup = config.groups.find((item) => item.id === group.id) || {label: group.label, type: "", duration: group.label};
      const summary = group[selectedMeasure];
      const separator = index && groupType(knownGroup) !== groupType(config.groups.find((item) => item.id === active.groups[index - 1].id) || {});
      return `<tr${separator ? ' class="type-separator"' : ""}><td>${groupLabel(knownGroup, true)}</td><td>${fmt(summary.mean)}</td><td>${fmt(summary.variance)}</td><td>${fmt(summary.sd)}</td><td>${interval(summary)}</td><td>${fmt(summary.upper_quantile)}</td></tr>`;
    });
    const total = active[selectedMeasure];
    rows.push(`<tr class="total-row"><td>Все группы</td><td>${fmt(total.mean)}</td><td>${fmt(total.variance)}</td><td>${fmt(total.sd)}</td><td>${interval(total)}</td><td>${fmt(total.upper_quantile)}</td></tr>`);
    $("#detail-body").innerHTML = rows.join("");
    const palette = colors[active.id] || colors.prp;
    $(".legend-bar").style.background = palette.fill;
    $(".legend-interval").style.color = palette.stroke;
    requestAnimationFrame(renderChart);
  }

  function niceMaximum(value) {
    if (!(value > 0)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    const normalized = value / magnitude;
    return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 4 ? 4 : normalized <= 5 ? 5 : normalized <= 8 ? 8 : 10) * magnitude;
  }

  function renderChart() {
    if (!result || $("#view-calculation").hidden) return;
    const container = $("#forecast-chart");
    const style = getComputedStyle(container);
    const width = Math.max(290, container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const compact = width < 500;
    const labelWidth = compact ? 105 : 136;
    const rightWidth = compact ? 36 : 52;
    const plotWidth = Math.max(100, width - labelWidth - rightWidth);
    const height = 325;
    const rowHeight = 31;
    const top = 36;
    const active = selectedResult();
    const palette = colors[active.id] || colors.prp;
    const maximum = niceMaximum(Math.max(...active.groups.map((group) => Math.max(group[selectedMeasure].mean, group[selectedMeasure].interval.upper))));
    const scale = (value) => labelWidth + Math.max(0, Number(value || 0)) / maximum * plotWidth;
    const tickCount = compact ? 3 : 4;
    const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-labelledby="chart-title chart-desc" role="img"><title id="chart-title">${html(shortNames[active.id])}: ${selectedMeasure === "patients" ? "пациенты" : "процедуры"} по типу и стажу диабета</title><desc id="chart-desc">Столбцы показывают среднее, отрезки — центральный предиктивный интервал ${pct(result.meta.coverage)}. Числа справа — средние значения.</desc>`];
    svg.push(`<text x="0" y="13" class="chart-axis-label">ТИП И СТАЖ ДИАБЕТА</text><text x="${width}" y="13" class="chart-axis-label" text-anchor="end">СРЕДНЕЕ</text>`);
    for (let i = 0; i <= tickCount; i++) {
      const value = maximum * i / tickCount;
      const x = scale(value);
      svg.push(`<line x1="${x}" y1="25" x2="${x}" y2="295" class="chart-tick"/><text x="${x}" y="315" text-anchor="middle" class="chart-axis-label">${fmt(value)}</text>`);
    }
    active.groups.forEach((group, index) => {
      const y = top + index * rowHeight + (index >= 4 ? 12 : 0);
      const summary = group[selectedMeasure];
      const knownGroup = config.groups.find((item) => item.id === group.id);
      const label = knownGroup ? groupLabel(knownGroup) : group.label;
      const meanX = scale(summary.mean);
      const lowerX = scale(summary.interval.lower);
      const upperX = scale(summary.interval.upper);
      const barWidth = summary.mean > 0 ? Math.max(1.5, meanX - labelWidth) : 0;
      if (index % 2 === 0) svg.push(`<rect x="${labelWidth}" y="${y - 3}" width="${plotWidth}" height="26" fill="${palette.pale}" rx="3"/>`);
      if (index === 4) svg.push(`<line x1="0" y1="${y - 11}" x2="${width}" y2="${y - 11}" class="chart-divider"/>`);
      svg.push(`<g><title>${html(label)}: среднее ${fmt(summary.mean)}, интервал ${interval(summary)}</title><text x="0" y="${y + 14}" class="chart-row-title" style="font-size:${compact ? 10 : 11}px">${html(label)}</text><rect x="${labelWidth}" y="${y + 4}" width="${barWidth}" height="13" rx="3" fill="${palette.fill}"/><line x1="${lowerX}" y1="${y + 10.5}" x2="${upperX}" y2="${y + 10.5}" stroke="${palette.stroke}" stroke-width="1.3"/><line x1="${lowerX}" y1="${y + 6}" x2="${lowerX}" y2="${y + 15}" stroke="${palette.stroke}" stroke-width="1.3"/><line x1="${upperX}" y1="${y + 6}" x2="${upperX}" y2="${y + 15}" stroke="${palette.stroke}" stroke-width="1.3"/><circle cx="${meanX}" cy="${y + 10.5}" r="2.3" fill="${palette.stroke}"/><text x="${width}" y="${y + 14}" text-anchor="end" class="chart-value" style="fill:${palette.stroke}">${fmt(summary.mean)}</text></g>`);
    });
    svg.push("</svg>");
    container.innerHTML = svg.join("");
    container.setAttribute("aria-label", `${shortNames[active.id]}: ${selectedMeasure === "patients" ? "пациенты" : "процедуры"}, ${pct(result.meta.coverage)} предиктивные интервалы по восьми группам.`);
  }

  function download(filename, content, type) {
    const blob = new Blob([content], {type});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveScenario() {
    if (!state || !applyPendingPopulation() || !validateInputs()) return;
    const scenario = {format: "ophthalmology-workload-scenario", format_version: 1, model_version: config.model_version, parameters: clone(state)};
    download("ophthalmology-scenario.json", JSON.stringify(scenario, null, 2), "application/json;charset=utf-8");
    showToast("Сценарий сохранён в JSON.");
  }

  function importedParameters(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Файл не содержит объект сценария.");
    const parameters = data.parameters || data;
    if (parameters.profile !== "expert_annual") throw new Error("Поддерживается только годовой сценарий по группам из СД.docx (expert_annual). Загрузите JSON этого сценария; файлы с другой основой расчёта автоматически не преобразуются.");
    const next = clone(config.defaults);
    const check = (value, minimum, maximum, name, whole = false) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (whole && !Number.isInteger(value))) throw new Error(`Недопустимое значение «${name}» в файле сценария.`);
      return value;
    };
    next.profile = "expert_annual";
    next.include_comparison = false;
    next.coverage = check(parameters.coverage, 0.5, 0.999, "вероятность покрытия");
    next.iterations = check(parameters.iterations, 20000, 100000, "симуляции", true);
    if (![20000, 50000, 100000].includes(next.iterations)) throw new Error("В сценарии допустимы 20 000, 50 000 или 100 000 симуляций.");
    next.seed = check(parameters.seed, 0, 4294967295, "seed", true);
    for (const group of config.groups) {
      next.populations[group.id] = check(parameters.populations?.[group.id], 0, maximumPopulation, group.label, true);
      for (const intervention of config.interventions) next.risks_per_1000[group.id][intervention.id] = check(parameters.risks_per_1000?.[group.id]?.[intervention.id], 0, 1000, `риск ${group.label} / ${intervention.name}`);
    }
    if (Object.values(next.populations).reduce((sum, value) => sum + value, 0) > maximumPopulation) throw new Error("Общий размер контингента превышает 80 000 000 человек.");
    for (const intervention of config.interventions) {
      next.uncertainty_cv[intervention.id] = check(parameters.uncertainty_cv?.[intervention.id], 0, 5, `CV ${intervention.name}`);
      next.capture[intervention.id] = check(parameters.capture?.[intervention.id], 0, 1, `доля потока ${intervention.name}`);
    }
    for (const key of ["prp", "dme"]) {
      next.procedures[key].mean = check(parameters.procedures?.[key]?.mean, 1, 100, `среднее ${key}`);
      next.procedures[key].sd = check(parameters.procedures?.[key]?.sd, 0, 100, `SD ${key}`);
    }
    next.procedures.dme.bilateral_probability = check(parameters.procedures?.dme?.bilateral_probability, 0, 1, "второй глаз");
    const source = parameters.procedures?.dme?.moment_source;
    next.procedures.dme.moment_source = typeof source === "string" && (source === "custom" || momentPresets().some((preset) => preset.id === source || preset.source_id === source)) ? source : "custom";
    next.procedures.vit.repeat_probability = check(parameters.procedures?.vit?.repeat_probability, 0, 1, "повторная витрэктомия");
    if (parameters.risk_revision !== undefined) {
      const revision = parameters.risk_revision;
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) throw new Error("Некорректные сведения об обновлении рисков.");
      const text = (key, maximum) => {
        const value = revision[key] ?? "";
        if (typeof value !== "string" || value.length > maximum) throw new Error(`Некорректное поле обновления рисков: ${key}.`);
        return value.trim();
      };
      const source = text("source", 512);
      const note = text("note", 2000);
      const asOf = text("as_of", 10);
      if (asOf && (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf < "1900-01-01" || asOf > "2100-12-31" || Number.isNaN(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf)) throw new Error("Некорректная дата обновления рисков.");
      const updatedAt = text("updated_at", 40);
      if (updatedAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(updatedAt) || Number.isNaN(Date.parse(updatedAt)))) throw new Error("Некорректное время изменения рисков.");
      next.risk_revision = {source, as_of: asOf, note, ...(updatedAt ? {updated_at: new Date(updatedAt).toISOString()} : {})};
    }
    return next;
  }

  async function loadScenario(file) {
    if (!file || !state) return;
    try {
      if (file.size > 1000000) throw new Error("Сценарий слишком большой: допустим JSON до 1 МБ.");
      const next = importedParameters(JSON.parse(await file.text()));
      state = next;
      riskEditing = false;
      renderInputs();
      markDirty();
      showError("");
      switchView("calculation");
      showToast("Сценарий загружен. Нажмите «Рассчитать прогноз».");
    } catch (error) { showError(error instanceof SyntaxError ? "Не удалось прочитать JSON. Выберите сохранённый файл сценария." : error.message); }
    finally { $("#scenario-file").value = ""; }
  }

  function exportCSV() {
    if (!result) return;
    const header = ["Профиль", "Покрытие", "Вмешательство", "Группа", "Показатель", "Среднее", "Дисперсия", "Стандартное отклонение", "Нижняя граница", "Верхняя граница", "Односторонний квантиль", "Вероятность нуля", "Seed", "Симуляции"];
    const rows = [header];
    for (const intervention of result.interventions) {
      for (const group of [...intervention.groups, {label: "Все группы", patients: intervention.patients, procedures: intervention.procedures}]) {
        for (const metric of ["patients", "procedures"]) {
          const summary = group[metric];
          rows.push([result.meta.profile, result.meta.coverage, shortNames[intervention.id] || intervention.name, group.label, metric === "patients" ? "Пациенты" : "Процедуры", summary.mean, summary.variance, summary.sd, summary.interval.lower, summary.interval.upper, summary.upper_quantile, summary.zero_probability, result.meta.seed, result.meta.iterations]);
        }
      }
    }
    const csvValue = (value) => {
      const text = typeof value === "number" ? String(value).replace(".", ",") : String(value ?? "");
      return `"${text.replace(/"/g, '""')}"`;
    };
    download("ophthalmology-forecast.csv", "\uFEFF" + rows.map((row) => row.map(csvValue).join(";")).join("\r\n"), "text/csv;charset=utf-8");
    showToast("Все вмешательства и группы сохранены в CSV.");
  }

  async function loadGuide() {
    if (guideLoaded) return;
    guideLoaded = true;
    try {
      const response = await fetch("/docs/model-guide.html");
      if (!response.ok) throw new Error("Описание модели пока недоступно.");
      const content = await response.text();
      const frame = $("#model-guide");
      frame.srcdoc = content;
      frame.hidden = false;
      $("#guide-loading").hidden = true;
      frame.addEventListener("load", () => {
        try {
          const documentInside = frame.contentDocument;
          const updateHeight = () => { const article = documentInside.querySelector("article"); frame.style.height = `${Math.max(500, article ? article.scrollHeight + 36 : documentInside.body.scrollHeight + 36)}px`; };
          documentInside.querySelectorAll("a").forEach((link) => { if (/^https?:/.test(link.href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; } });
          updateHeight();
          if (typeof ResizeObserver !== "undefined") new ResizeObserver(updateHeight).observe(documentInside.body);
        } catch { frame.style.height = "1100px"; }
      }, {once: true});
    } catch (error) {
      guideLoaded = false;
      $("#guide-loading").textContent = `${error.message} Обновите страницу или нажмите «Открыть отдельно».`;
    }
  }

  function bindEvents() {
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    $(".brand").addEventListener("click", (event) => { event.preventDefault(); switchView("calculation"); });
    document.addEventListener("click", (event) => {
      const link = event.target.closest("[data-view-link]");
      if (link) { event.preventDefault(); switchView(link.dataset.viewLink); }
      const parameterButton = event.target.closest("[data-open-parameters]");
      if (parameterButton) switchView("parameters");
      const card = event.target.closest("[data-select-intervention]");
      if (card && result) { selectedIntervention = card.dataset.selectIntervention; renderSelectedResult(); }
    });
    document.addEventListener("input", (event) => {
      if (state && event.target.matches("input[type=number]")) updateFromInput(event.target);
      if (state && riskEditing && event.target.matches("#risk-source, #risk-data-date, #risk-revision-note")) {
        touchRiskRevision();
        markDirty();
      }
    });
    $("#toggle-risk-editing").addEventListener("click", () => {
      if (!state || (riskEditing && !validateRiskRevision())) return;
      riskEditing = !riskEditing;
      syncRiskLock();
      showError("");
      if (riskEditing) $(".risk-input").focus();
      else showToast("Риски зафиксированы в текущем сценарии. Для повторного использования сохраните JSON.");
    });
    $("#restore-risks").addEventListener("click", () => {
      if (!state) return;
      restoreRisks();
      showToast("Восстановлены исходные риски выбранного профиля. Таблица зафиксирована.");
    });
    $("#iterations").addEventListener("change", (event) => updateFromInput(event.target));
    $("#multiplicity-controls").addEventListener("change", (event) => {
      if (!state || event.target.id !== "dme-moment-source") return;
      const preset = momentPresets().find((item) => item.id === event.target.value);
      if (preset) {
        state.procedures.dme.mean = Number(preset.mean);
        state.procedures.dme.sd = Number(preset.sd);
        state.procedures.dme.moment_source = preset.source_id || preset.id;
        renderMultiplicity();
      } else {
        state.procedures.dme.moment_source = "custom";
        syncMomentPreset();
      }
      showError("");
      markDirty();
    });
    $$("#coverage-presets button").forEach((button) => button.addEventListener("click", () => {
      if (!state) return;
      state.coverage = Number(button.dataset.coverage) / 100;
      $("#coverage-custom").value = button.dataset.coverage;
      $("#coverage-custom").classList.remove("invalid");
      syncCoverageButtons();
      markDirty();
    }));
    $$("#measure-toggle button").forEach((button) => button.addEventListener("click", () => { selectedMeasure = button.dataset.measure; renderSelectedResult(); }));
    $$("#intervention-tabs button").forEach((button) => button.addEventListener("click", () => { selectedIntervention = button.dataset.intervention; renderSelectedResult(); }));
    $("#calculate").addEventListener("click", calculate);
    $("#return-calculate").addEventListener("click", () => switchView("calculation"));
    $("#apply-population").addEventListener("click", () => { if (state) applyPopulation(false); });
    $("#equal-population").addEventListener("click", () => { if (state) applyPopulation(true); });
    $("#reset-population").addEventListener("click", () => {
      if (!state) return;
      config.groups.forEach((group) => { state.populations[group.id] = 1000; });
      renderPopulation();
      markDirty();
      showError("");
      showToast("Установлено по 1 000 пациентов в каждой группе.");
    });
    $("#reset-parameters").addEventListener("click", () => {
      if (!state) return;
      state.risks_per_1000 = clone(currentProfile().risks_per_1000);
      delete state.risk_revision;
      riskEditing = false;
      state.procedures = clone(config.defaults.procedures);
      state.uncertainty_cv = clone(config.defaults.uncertainty_cv);
      state.capture = clone(config.defaults.capture);
      renderInputs();
      markDirty();
      showError("");
      showToast("Риски и кратность возвращены к исходным значениям профиля.");
    });
    $("#save-scenario").addEventListener("click", saveScenario);
    $("#load-scenario").addEventListener("click", () => $("#scenario-file").click());
    $("#scenario-file").addEventListener("change", (event) => loadScenario(event.target.files[0]));
    $("#export-csv").addEventListener("click", exportCSV);
    $("#export-json").addEventListener("click", () => { if (result) download("ophthalmology-forecast.json", JSON.stringify(result, null, 2), "application/json;charset=utf-8"); });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => { if (result) renderChart(); }).observe($("#forecast-chart"));
    else window.addEventListener("resize", renderChart);
  }

  async function initialize() {
    bindEvents();
    $("#calculate").disabled = true;
    try {
      try {
        const response = await fetch("/config.json");
        if (!response.ok) throw new Error("Нет статической конфигурации.");
        config = await response.json();
      } catch {
        const response = await fetch("/api/config");
        if (!response.ok) throw new Error("Не удалось загрузить параметры модели.");
        config = await response.json();
      }
      if (!config.defaults || !Array.isArray(config.groups) || !Array.isArray(config.interventions) || !Array.isArray(config.profiles)) throw new Error("Параметры модели имеют неподдерживаемый формат.");
      state = clone(config.defaults);
      state.profile = "expert_annual";
      state.include_comparison = false;
      if (!currentProfile()) throw new Error("В конфигурации отсутствует исходный годовой сценарий по группам.");
      renderInputs();
      markDirty();
      if (config.runtime === "browser") {
        $("#runtime-label").textContent = "В браузере";
        $("#runtime-privacy").innerHTML = "Расчёт на вашем устройстве.<br>Сценарий не отправляется<br>на сервер.";
      } else {
        $("#runtime-label").textContent = "Локальный расчёт";
        $("#runtime-privacy").innerHTML = "Данные сценария остаются<br>на этом компьютере.";
      }
      $("#calculate").disabled = false;
      $(".page-footer span:first-child").textContent = `Исследовательское планирование · модель ${config.model_version || "1.0"}`;
      await calculate();
    } catch (error) {
      showError(`${error.message} Убедитесь, что локальный сервер запущен, затем обновите страницу.`);
      $("#profile-note span").textContent = "Нет связи с сервером модели. Значения и результаты не загружены.";
    }
  }

  initialize();
})();
