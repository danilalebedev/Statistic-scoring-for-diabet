/**
 * Stratified compound binomial model with optional shared lognormal hazard.
 * Numerical moments reproduce calculator/model.py; seeded browser simulation
 * has its own PRNG and need not reproduce NumPy's individual random draws.
 * No patient data, backend, network service, or normal count approximation.
 *
 * The inversion / BTPE binomial sampler is adapted from NumPy v2.3.3:
 * numpy/random/src/distributions/distributions.c. Copyright (c) 2005-2025,
 * NumPy Developers; Copyright (c) 2019 Kevin Sheppard. BSD-3-Clause license
 * and component notices are reproduced in THIRD_PARTY_NOTICES.txt.
 */
import { NODES, WEIGHTS } from './quadrature.mjs';

const clone = value => structuredClone(value);
const sum = xs => xs.reduce((a, b) => a + b, 0);
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const positiveCache = new Map();

// Stirling correction to log Gamma(z).  In the BTPE final branch all four
// arguments are safely away from zero.  Keep numerator signs positive and
// denominator signs negative.  This is derived from the log PMF ratio; some
// historical BTPE implementations have two erroneous plus signs here.
function stirlingCorrection(z) {
  const inverseSquare = 1 / (z * z);
  return (1 / 12 - inverseSquare * (1 / 360 - inverseSquare * (1 / 1260 - inverseSquare * (1 / 1680 - inverseSquare / 1188)))) / z;
}

function logBinomialRatio(n, p, mode, value) {
  const x = value + 1, f = mode + 1, z = n + 1 - mode, w = n - value + 1;
  return (mode + 0.5) * Math.log(f / x)
    + (n - mode + 0.5) * Math.log(z / w)
    + (value - mode) * Math.log(w * p / (x * (1 - p)))
    + stirlingCorrection(f) + stirlingCorrection(z)
    - stirlingCorrection(x) - stirlingCorrection(w);
}

function number(value, label, low, high, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${label}: требуется ${integer ? 'целое ' : ''}число от ${low} до ${high}.`);
  }
  return value;
}

function validate(payload, config) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Настройки должны быть JSON-объектом.');
  const p = clone(payload);
  try {
    if (p.profile !== 'expert_annual' || !config.profiles.some(x => x.id === p.profile)) {
      throw new Error('Доступен только прогноз на основе исходного сценария (expert_annual). Выберите исходный сценарий или обновите файл настроек.');
    }
    number(p.coverage, 'Уровень вероятности', 0.5, 0.999);
    number(p.iterations, 'Число симуляций', 1000, 200000, true);
    number(p.seed, 'Seed', 0, 2 ** 32 - 1, true);
    for (const group of config.groups) {
      number(p.populations[group.id], `Численность ${group.label}`, 0, 80000000, true);
      for (const spec of config.interventions) number(p.risks_per_1000[group.id][spec.id], `Частота ${group.label}, ${spec.name}`, 0, 1000);
    }
    if (sum(config.groups.map(g => p.populations[g.id])) > 80000000) throw new Error('Общая численность не должна превышать 80 000 000 человек.');
    if (p.include_comparison !== undefined && typeof p.include_comparison !== 'boolean') throw new Error('include_comparison должен быть логическим значением.');
    // Legacy saved scenarios can carry this flag. The original scenario is the
    // only supported forecast, so it must never enable an alternative result.
    p.include_comparison = false;
    for (const spec of config.interventions) {
      number(p.uncertainty_cv[spec.id], `CV интенсивности ${spec.name}`, 0, 2);
      number(p.capture[spec.id], `Доля направлений ${spec.name}`, 0, 1);
    }
    for (const id of ['prp', 'dme']) {
      number(p.procedures[id].mean, `Средняя кратность ${id}`, 1, 30);
      number(p.procedures[id].sd, `SD кратности ${id}`, 0, 30);
    }
    number(p.procedures.dme.bilateral_probability, 'Вероятность лечения второго глаза', 0, 1);
    number(p.procedures.vit.repeat_probability, 'Вероятность дополнительной витрэктомии', 0, 1);
    const dme = p.procedures.dme;
    const matched = (config.dme_moment_presets || []).find(x => Math.abs(dme.mean - x.mean) < 1e-10 && Math.abs(dme.sd - x.sd) < 1e-10);
    dme.moment_source = matched ? matched.id : 'custom';
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Не хватает обязательных настроек или нарушена структура сценария.');
    throw error;
  }
  return p;
}

/** Seeded xoshiro128**; open 53-bit uniforms, Box-Muller normal draws. */
class RNG {
  constructor(seed) {
    let state = seed >>> 0;
    this.s = Array.from({ length: 4 }, () => {
      state = (state + 0x9e3779b9) >>> 0;
      let x = state;
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
      return (x ^ (x >>> 15)) >>> 0;
    });
    this.spare = null;
    this.binomialCache = new Map();
  }
  uint32() {
    const s = this.s;
    const x = Math.imul(s[1], 5);
    const result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
    const t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t;
    s[3] = (s[3] << 11) | (s[3] >>> 21);
    return result;
  }
  uniform() { return Math.min(1 - Number.EPSILON / 2, ((this.uint32() >>> 5) * 67108864 + (this.uint32() >>> 6) + 0.5) / 9007199254740992); }
  normal() {
    if (this.spare !== null) { const x = this.spare; this.spare = null; return x; }
    const r = Math.sqrt(-2 * Math.log(this.uniform())), angle = 2 * Math.PI * this.uniform();
    this.spare = r * Math.sin(angle);
    return r * Math.cos(angle);
  }
  binomial(n, p) {
    if (n === 0 || p <= 0) return 0;
    if (p >= 1) return n;
    const flip = p > 0.5, r = flip ? 1 - p : p, q = 1 - r;
    let y;
    if (n * r <= 30) {
      const initial = Math.exp(n * Math.log1p(-r));
      const bound = Math.floor(Math.min(n, n * r + 10 * Math.sqrt(n * r * q + 1)));
      let mass = initial, u = this.uniform();
      y = 0;
      while (u > mass) {
        y++;
        if (y > bound) { y = 0; mass = initial; u = this.uniform(); }
        else { u -= mass; mass *= ((n - y + 1) * r) / (y * q); }
      }
    } else {
      y = this.btpe(n, r, q);
    }
    return flip ? n - y : y;
  }
  btpe(n, r, q) {
    const key = `${n}|${r}`;
    let c = this.binomialCache.get(key);
    if (!c) {
      const fm = n * r + r, m = Math.floor(fm);
      const p1 = Math.floor(2.195 * Math.sqrt(n * r * q) - 4.6 * q) + 0.5;
      const xm = m + 0.5, xl = xm - p1, xr = xm + p1, height = 0.134 + 20.5 / (15.3 + m);
      const al = (fm - xl) / (fm - xl * r), ar = (xr - fm) / (xr * q);
      const laml = al * (1 + al / 2), lamr = ar * (1 + ar / 2);
      const p2 = p1 * (1 + 2 * height), p3 = p2 + height / laml, p4 = p3 + height / lamr;
      c = { m, p1, xm, xl, xr, height, laml, lamr, p2, p3, p4 };
      if (this.binomialCache.size > 512) this.binomialCache.clear();
      this.binomialCache.set(key, c);
    }
    const { m, p1, xm, xl, xr, height, laml, lamr, p2, p3, p4 } = c;
    const nrq = n * r * q;
    for (;;) {
      const u = this.uniform() * p4;
      let v = this.uniform(), y;
      if (u <= p1) return Math.floor(xm - p1 * v + u);
      if (u <= p2) {
        const x = xl + (u - p1) / height;
        v = v * height + 1 - Math.abs(m - x + 0.5) / p1;
        if (v > 1) continue;
        y = Math.floor(x);
      } else if (u <= p3) {
        y = Math.floor(xl + Math.log(v) / laml);
        if (y < 0) continue;
        v *= (u - p2) * laml;
      } else {
        y = Math.floor(xr - Math.log(v) / lamr);
        if (y > n) continue;
        v *= (u - p3) * lamr;
      }
      const k = Math.abs(y - m);
      if (k <= 20 || k >= nrq / 2 - 1) {
        const s = r / q, a = s * (n + 1);
        let ratio = 1;
        if (m < y) for (let i = m + 1; i <= y; i++) ratio *= a / i - s;
        else for (let i = y + 1; i <= m; i++) ratio /= a / i - s;
        if (v <= ratio) return y;
        continue;
      }
      const rho = (k / nrq) * ((k * (k / 3 + 0.625) + 1 / 6) / nrq + 0.5);
      const t = -k * k / (2 * nrq), logv = Math.log(v);
      if (logv < t - rho) return y;
      if (logv > t + rho) continue;
      if (logv <= logBinomialRatio(n, r, m, y)) return y;
    }
  }
}

function positivePmf(mean, sd) {
  const key = `${mean}|${sd}`;
  if (positiveCache.has(key)) return positiveCache.get(key);
  const x = mean - 1, variance = sd * sd, fraction = x - Math.floor(x), minimum = fraction * (1 - fraction);
  if (variance < minimum - 1e-9) throw new Error(`Среднее ${mean} и SD ${sd} несовместимы с целым числом процедур; минимальная дисперсия ${minimum}.`);
  if (x < 1e-12) {
    if (variance > 1e-9) throw new Error('При среднем 1 положительное целое число процедур равно 1; SD должен быть 0.');
    return { pmf: [0, 1], family: 'фиксированная 1 процедура', tail: 0 };
  }
  let result, family;
  if (variance <= x + 1e-10) {
    const mixture = Math.abs(x - minimum) < 1e-12 ? 0 : clamp((variance - minimum) / (x - minimum), 0, 1);
    if (mixture <= 1e-12) {
      result = Array(Math.ceil(mean) + 1).fill(0);
      result[Math.floor(mean)] += 1 - fraction; result[Math.ceil(mean)] += fraction;
      return { pmf: result, family: 'два соседних целых значения', tail: 0 };
    }
    const values = [Math.exp(-x)]; let cumulative = values[0];
    for (let j = 1; j <= 10000; j++) {
      values.push(values[j - 1] * x / j); cumulative += values[j];
      if (j > x && 1 - cumulative < 1e-13) break;
    }
    result = [0, ...values.map(v => mixture * v)];
    result[Math.floor(mean)] += (1 - mixture) * (1 - fraction);
    result[Math.ceil(mean)] += (1 - mixture) * fraction;
    family = mixture > 1 - 1e-10 ? '1 + Пуассон' : 'смесь положительных целочисленных распределений';
  } else {
    const shape = x * x / (variance - x), success = x / variance;
    const values = [Math.exp(shape * Math.log(success))]; let cumulative = values[0];
    for (let j = 1; j <= 10000; j++) {
      values.push(values[j - 1] * (j - 1 + shape) / j * (1 - success)); cumulative += values[j];
      if (j > mean && 1 - cumulative < 1e-13) break;
    }
    result = [0, ...values]; family = '1 + отрицательное биномиальное';
  }
  const mass = sum(result), tail = Math.max(0, 1 - mass);
  if (tail > 1e-10) throw new Error('Слишком тяжёлый хвост кратности: уменьшите SD или увеличьте среднее.');
  result = result.map(v => v / mass);
  const actualMean = result.reduce((s, v, i) => s + i * v, 0);
  const actualVariance = result.reduce((s, v, i) => s + (i - actualMean) ** 2 * v, 0);
  if (Math.abs(actualMean - mean) > 1e-6 || Math.abs(actualVariance - variance) > 1e-5) throw new Error('Не удалось достаточно точно представить заданные моменты кратности.');
  const output = { pmf: result, family, tail };
  if (positiveCache.size > 256) positiveCache.clear();
  positiveCache.set(key, output);
  return output;
}

function course(id, p) {
  const pp = p.procedures[id];
  let pmf, mean, variance, family, tail = 0;
  if (id === 'vit') {
    const r = pp.repeat_probability;
    pmf = [0, 1 - r, r]; mean = 1 + r; variance = r * (1 - r); family = '1 + Бернулли дополнительной операции';
  } else {
    const fitted = positivePmf(pp.mean, pp.sd);
    pmf = [...fitted.pmf]; mean = pp.mean; variance = pp.sd ** 2; family = fitted.family; tail = fitted.tail;
    if (id === 'dme') {
      const b = pp.bilateral_probability, two = Array(2 * pmf.length - 1).fill(0);
      for (let i = 1; i < pmf.length; i++) for (let j = 1; j < pmf.length; j++) two[i + j] += pmf[i] * pmf[j];
      const full = two.map(x => b * x);
      for (let i = 0; i < pmf.length; i++) full[i] += (1 - b) * pmf[i];
      pmf = full;
      variance = (1 + b) * variance + b * (1 - b) * mean ** 2;
      mean *= 1 + b;
    }
  }
  const courseMean = mean, courseVariance = variance;
  const mass = sum(pmf); pmf = pmf.map(x => x / mass);
  const active = [], conditional = []; let remainingMass = 1;
  for (let i = 1; i < pmf.length; i++) if (pmf[i] > 0) {
    active.push(i); conditional.push(clamp(pmf[i] / remainingMass, 0, 1)); remainingMass -= pmf[i];
  }
  return { pmf, active, conditional, course_mean: courseMean, course_variance: courseVariance, period_mean: mean, period_variance: variance, distribution_family: family, truncated_mass_bound: tail };
}

function randomSum(rng, patients, distribution) {
  if (!patients) return 0;
  const { active, conditional } = distribution;
  if (active.length === 1) return patients * active[0];
  let remaining = patients, result = 0;
  for (let i = 0; i < active.length - 1; i++) {
    const count = rng.binomial(remaining, conditional[i]);
    result += count * active[i]; remaining -= count;
    if (!remaining) return result;
  }
  return result + remaining * active[active.length - 1];
}

function hazardCurve(means, cv) {
  if (cv === 0) return { hazards: [...means], curves: means.map(p => [p]), weights: [1], sigma: 0 };
  const sigma = Math.sqrt(Math.log1p(cv * cv)), factors = NODES.map(z => Math.exp(sigma * z - sigma * sigma / 2));
  const hazards = [], curves = [];
  const expectation = h => factors.reduce((s, f, i) => s + WEIGHTS[i] * -Math.expm1(-h * f), 0);
  for (const probability of means) {
    if (probability === 0 || probability === 1) { hazards.push(probability ? Infinity : 0); curves.push(factors.map(() => probability)); continue; }
    let low = 0, high = Math.max(1, -Math.log1p(-probability));
    while (expectation(high) < probability) high *= 2;
    for (let i = 0; i < 65; i++) { const m = (low + high) / 2; if (expectation(m) < probability) low = m; else high = m; }
    const h = (low + high) / 2;
    hazards.push(h); curves.push(factors.map(f => -Math.expm1(-h * f)));
  }
  return { hazards, curves, weights: WEIGHTS, sigma };
}

function summary(samples, mean, variance, coverage) {
  let average = 0, m2 = 0, zero = 0;
  for (let i = 0; i < samples.length; i++) {
    const delta = samples[i] - average; average += delta / (i + 1); m2 += delta * (samples[i] - average);
    if (!samples[i]) zero++;
  }
  const ordered = samples.slice().sort();
  const quantile = q => ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)];
  const alpha = (1 - coverage) / 2, v = Math.max(0, variance);
  return { mean, variance: v, sd: Math.sqrt(v), interval: { lower: quantile(alpha), upper: quantile(1 - alpha) }, upper_quantile: quantile(coverage), zero_probability: zero / samples.length, simulation_mean: average, simulation_variance: m2 / samples.length };
}

function warnings() {
  const result = [
    'Прогнозные интервалы условны на выбранные источники и допущения; модель не проверена на данных Москвы или конкретной больницы.',
    'Опубликованные SD числа процедур определяют разброс кратности лечения. CV риска — отдельная необязательная сценарная неопределённость переноса.',
    'При CV=0 интервалы условны на фиксированные риски. Опубликованные SD количества процедур включены как SD²; это не неопределённость вероятности вмешательства.',
    'Средние, SD кратности, доля второго глаза, повторных операций и направлений заданы как фиксированные параметры. Их неопределённость исследуется изменением сценария.',
    'Пациенты разных вмешательств могут совпадать. Общий итог уникальных людей по трём вмешательствам не рассчитывается.',
    'Квантили оценены воспроизводимой браузерной симуляцией; её генератор отличается от NumPy. Средние и дисперсии отдельно вычисляются интегрированием модели.',
    'Сезонные месячные коэффициенты не заданы. Результат относится ко всему 12-месячному периоду.',
  ];
  result.unshift(
    'Групповые годовые частоты из СД.docx — экспертные сценарии, а не измеренные вероятности. Ошибка исходной сводной строки витрэктомии не используется.',
    'Кратность первого года исследований переносится на годовой контингент как редактируемое допущение.',
  );
  return result;
}

function calculate(payload, config) {
  const start = performance.now(), p = validate(payload, config);
  const populations = config.groups.map(g => p.populations[g.id]), count = p.iterations, outputs = [];
  for (let j = 0; j < config.interventions.length; j++) {
    const spec = config.interventions[j], id = spec.id;
    const rng = new RNG((p.seed ^ Math.imul(j + 1, 0x9e3779b9)) >>> 0);
    const means = config.groups.map(g => p.risks_per_1000[g.id][id] / 1000);
    const cv = p.uncertainty_cv[id], capture = p.capture[id], hc = hazardCurve(means, cv);
    const { weights, sigma } = hc, curves = hc.curves.map(xs => xs.map(x => capture * x));
    for (let g = 0; g < means.length; g++) if (Math.abs(dot(hc.curves[g], weights) - means[g]) > 1e-11) throw new Error('Проверка калибровки вероятностей не пройдена.');
    const groupMeans = means.map((x, g) => populations[g] * capture * x);
    const groupEvents = curves.map((xs, g) => populations[g] * xs.reduce((s, x, k) => s + weights[k] * x * (1 - x), 0));
    const groupParameters = curves.map((xs, g) => xs.reduce((s, x, k) => s + weights[k] * (populations[g] * x - groupMeans[g]) ** 2, 0));
    const totalMean = sum(groupMeans), totalEvents = sum(groupEvents);
    const totalParameters = weights.reduce((s, w, k) => s + w * (curves.reduce((m, xs, g) => m + populations[g] * xs[k], 0) - totalMean) ** 2, 0);
    const totalVariance = totalEvents + totalParameters, distribution = course(id, p);
    const km = distribution.period_mean, kv = distribution.period_variance;
    const patients = populations.map(() => new Float64Array(count)), procedures = populations.map(() => new Float64Array(count));
    const totalPatients = new Float64Array(count), totalProcedures = new Float64Array(count);
    for (let draw = 0; draw < count; draw++) {
      const h = cv ? Math.exp(sigma * rng.normal() - sigma * sigma / 2) : 1;
      for (let g = 0; g < populations.length; g++) {
        const probability = cv && means[g] > 0 && means[g] < 1 ? -Math.expm1(-hc.hazards[g] * h) : means[g];
        const y = rng.binomial(populations[g], clamp(capture * probability, 0, 1));
        const w = randomSum(rng, y, distribution);
        patients[g][draw] = y; procedures[g][draw] = w; totalPatients[draw] += y; totalProcedures[draw] += w;
      }
    }
    const rows = config.groups.map((group, g) => {
      const v = groupEvents[g] + groupParameters[g];
      return { ...clone(group), n: populations[g], risk_per_1000: means[g] * 1000,
        patients: summary(patients[g], groupMeans[g], v, p.coverage),
        procedures: summary(procedures[g], groupMeans[g] * km, groupMeans[g] * kv + v * km * km, p.coverage),
        variance_components: { patients: { event: groupEvents[g], parameter: groupParameters[g] }, procedures: { course: groupMeans[g] * kv, patients: groupEvents[g] * km * km, parameter: groupParameters[g] * km * km } },
      };
    });
    outputs.push({ ...clone(spec), course_mean: distribution.course_mean, course_variance: distribution.course_variance,
      period_mean: km, period_variance: kv, distribution_family: distribution.distribution_family, truncated_mass_bound: distribution.truncated_mass_bound,
      patients: summary(totalPatients, totalMean, totalVariance, p.coverage),
      procedures: summary(totalProcedures, totalMean * km, totalMean * kv + totalVariance * km * km, p.coverage), groups: rows,
      parameter_variance_patients: totalParameters, event_variance_patients: totalEvents,
      variance_components: { patients: { event: totalEvents, parameter: totalParameters }, procedures: { course: totalMean * kv, patients: totalEvents * km * km, parameter: totalParameters * km * km } },
    });
  }
  return { meta: { profile: p.profile, coverage: p.coverage, iterations: count, seed: p.seed, population_total: sum(populations), elapsed_seconds: Math.round(performance.now() - start) / 1000,
    model_version: config.model_version || '1.0.0', model_name: config.model_name || 'Стратифицированная биномиальная модель пациентов с составным распределением числа процедур', engine: 'browser-js-xoshiro128ss-btpe', timing_label: 'Годовой контингент · полный 12-месячный период', interval_kind: 'marginal_central_predictive', quadrature_nodes: 96 },
    warnings: warnings(), parameters: p, interventions: outputs };
}

/** The original annual scenario is calculated locally in a Web Worker. */
export async function forecast(payload, config) {
  return calculate(payload, config);
}

// Exposed for independent numerical verification; not used by the interface.
export const numerical = { RNG, positivePmf, course, hazardCurve, calculate, logBinomialRatio };
