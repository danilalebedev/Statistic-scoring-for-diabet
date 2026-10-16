/** Run with Node: node tests/test_engine.mjs. Independent of any HTTP server. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forecast, numerical } from '../web/engine.mjs';

const reference = JSON.parse(readFileSync(new URL('./browser_reference.json', import.meta.url), 'utf8'));
const { config, cases } = reference;
const copy = structuredClone;
const byId = result => Object.fromEntries(result.interventions.map(x => [x.id, x]));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}; tolerance ${tolerance}`);
let checks = 0;

for (const fixture of cases) {
  const result = await forecast(fixture.payload, config);
  const expected = byId(fixture.expected);
  for (const item of result.interventions) {
    const source = expected[item.id];
    for (const field of ['course_mean', 'course_variance', 'period_mean', 'period_variance', 'event_variance_patients', 'parameter_variance_patients']) near(item[field], source[field]);
    for (const outcome of ['patients', 'procedures']) {
      for (const field of ['mean', 'variance', 'sd']) near(item[outcome][field], source[outcome][field]);
      for (const [key, value] of Object.entries(item.variance_components[outcome])) near(value, source.variance_components[outcome][key]);
      near(Object.values(item.variance_components[outcome]).reduce((a, b) => a + b, 0), item[outcome].variance);
    }
    for (let g = 0; g < item.groups.length; g++) for (const outcome of ['patients', 'procedures']) for (const field of ['mean', 'variance']) near(item.groups[g][outcome][field], source.groups[g][outcome][field]);
  }
  assert.equal(result.meta.profile, 'expert_annual');
  assert.equal(result.parameters.include_comparison, false);
  assert.equal(result.comparison, undefined);
  JSON.stringify(result);
  console.log(`PASS Python analytic parity: ${fixture.name}`); checks++;
}

const payload = copy(config.defaults);
payload.iterations = 50000;
payload.uncertainty_cv = { prp: 0.35, dme: 0.35, vit: 0.35 };
for (const group of config.groups) {
  payload.populations[group.id] = 40;
  payload.risks_per_1000[group.id] = { prp: 100, dme: 100, vit: 100 };
}
const monteCarlo = await forecast(payload, config);
for (const item of monteCarlo.interventions) for (const outcome of ['patients', 'procedures']) {
  const x = item[outcome];
  near(x.simulation_mean, x.mean, 0.02 * x.mean);
  near(x.simulation_variance, x.variance, 0.03 * x.variance);
}
console.log('PASS 50000-draw Monte Carlo vs analytic means and variances'); checks++;

const fixed = copy(config.defaults);
fixed.iterations = 1000;
const first = await forecast(fixed, config), second = await forecast(copy(fixed), config);
for (const id of ['prp', 'dme', 'vit']) for (const outcome of ['patients', 'procedures']) assert.deepEqual(byId(first)[id][outcome], byId(second)[id][outcome]);
console.log('PASS seeded browser reproducibility'); checks++;

// Original scenario figures are invariant to the retired comparison flag.
for (const flag of [true, false, undefined]) {
  const saved = copy(fixed);
  if (flag === undefined) delete saved.include_comparison;
  else saved.include_comparison = flag;
  const result = await forecast(saved, config);
  assert.equal(result.parameters.include_comparison, false);
  assert.equal(result.comparison, undefined);
  for (const [id, mean] of Object.entries({ prp: 69.5, dme: 127, vit: 3.6 })) near(byId(result)[id].patients.mean, mean);
  for (const [id, mean] of Object.entries({ prp: 168.19, dme: 594.36, vit: 3.78 })) near(byId(result)[id].procedures.mean, mean);
}
console.log('PASS original annual means and no alternative output for legacy flags'); checks++;

for (const profile of ['literature_new', 'unknown', null]) {
  const unsupported = copy(fixed); unsupported.profile = profile;
  await assert.rejects(() => forecast(unsupported, config), /Доступен только прогноз на основе исходного сценария/);
}
const malformedFlag = copy(fixed); malformedFlag.include_comparison = 'true';
await assert.rejects(() => forecast(malformedFlag, config), /include_comparison/);
console.log('PASS unsupported scenario and malformed legacy comparison flag rejected'); checks++;

const edited = copy(fixed);
for (const group of config.groups) edited.populations[group.id] = 0;
edited.populations[config.groups[0].id] = 1234;
edited.risks_per_1000[config.groups[0].id].prp = 17.25;
edited.capture.prp = 0.5;
edited.procedures.prp = { mean: 2, sd: 0 };
const revised = byId(await forecast(edited, config)).prp;
const probability = 17.25 / 1000 * 0.5;
near(revised.patients.mean, 1234 * probability);
near(revised.patients.variance, 1234 * probability * (1 - probability));
near(revised.procedures.mean, 2 * revised.patients.mean);
near(revised.procedures.variance, 4 * revised.patients.variance);
console.log('PASS edited risk and arbitrary population preserve compound binomial moments'); checks++;

for (const kind of ['population', 'risk', 'capture']) {
  const zero = copy(fixed);
  for (const group of config.groups) {
    if (kind === 'population') zero.populations[group.id] = 0;
    if (kind === 'risk') zero.risks_per_1000[group.id] = { prp: 0, dme: 0, vit: 0 };
  }
  if (kind === 'capture') zero.capture = { prp: 0, dme: 0, vit: 0 };
  const r = await forecast(zero, config);
  for (const item of r.interventions) for (const outcome of ['patients', 'procedures']) {
    assert.equal(item[outcome].mean, 0); assert.equal(item[outcome].variance, 0);
    assert.equal(item[outcome].interval.upper, 0); assert.equal(item[outcome].zero_probability, 1);
  }
  console.log(`PASS zero ${kind}`); checks++;
}

const certain = copy(fixed);
certain.profile = 'expert_annual';
for (const group of config.groups) certain.risks_per_1000[group.id] = { prp: 1000, dme: 1000, vit: 1000 };
certain.procedures.prp = { mean: 1, sd: 0 };
certain.procedures.dme = { mean: 1, sd: 0, bilateral_probability: 0 };
certain.procedures.vit = { repeat_probability: 0 };
const deterministic = await forecast(certain, config);
for (const item of deterministic.interventions) for (const outcome of ['patients', 'procedures']) {
  assert.equal(item[outcome].mean, 8000); assert.equal(item[outcome].variance, 0);
  assert.deepEqual(item[outcome].interval, { lower: 8000, upper: 8000 });
}
console.log('PASS p=1 and K=1 deterministic boundaries'); checks++;

const split = copy(fixed);
split.uncertainty_cv = { prp: 0.35, dme: 0.35, vit: 0.35 };
for (const group of config.groups) split.risks_per_1000[group.id] = { prp: 3.12, dme: 3.73, vit: 1.03 };
const pooled = copy(split);
for (const group of config.groups) pooled.populations[group.id] = 0;
pooled.populations[config.groups[0].id] = 8000;
const a = byId(await forecast(split, config)), b = byId(await forecast(pooled, config));
for (const id of ['prp', 'dme', 'vit']) for (const outcome of ['patients', 'procedures']) for (const field of ['mean', 'variance']) near(a[id][outcome][field], b[id][outcome][field]);
console.log('PASS shared uncertainty, pooled vs 8 identical groups'); checks++;

for (const [n, probability] of [[20, 0.25], [1000, 0.3], [1000000, 0.0001], [1000000, 0.999], [80000000, 0.4]]) {
  const rng = new numerical.RNG(987654321), iterations = 120000;
  let mean = 0, m2 = 0;
  for (let i = 0; i < iterations; i++) {
    const x = rng.binomial(n, probability);
    assert.ok(Number.isInteger(x) && x >= 0 && x <= n);
    const delta = x - mean; mean += delta / (i + 1); m2 += delta * (x - mean);
  }
  const expectedMean = n * probability, expectedVariance = expectedMean * (1 - probability);
  near(mean, expectedMean, 5 * Math.sqrt(expectedVariance / iterations));
  near(m2 / iterations, expectedVariance, 0.03 * expectedVariance);
  console.log(`PASS inversion/BTPE sampler moments: n=${n}, p=${probability}`); checks++;
}

// Independent PMF-ratio recurrence catches the historically incorrect signs
// in the final Stirling acceptance test even when moment tests cannot.
for (const [n, p, offset] of [[1000, 0.3, 30], [1000, 0.3, -30], [1000000, 0.2, 300], [80000000, 0.4, 4000]]) {
  const mode = Math.floor((n + 1) * p), value = mode + offset;
  let referenceLogRatio = 0;
  if (value > mode) for (let k = mode + 1; k <= value; k++) referenceLogRatio += Math.log((n - k + 1) * p / (k * (1 - p)));
  else for (let k = value + 1; k <= mode; k++) referenceLogRatio -= Math.log((n - k + 1) * p / (k * (1 - p)));
  near(numerical.logBinomialRatio(n, p, mode, value), referenceLogRatio, 2e-8);
}
console.log('PASS final BTPE log PMF ratio vs independent product recurrence'); checks++;

for (const bad of [NaN, Infinity, true, -1, 1001]) {
  const p = copy(fixed); p.risks_per_1000[config.groups[0].id].prp = bad;
  await assert.rejects(() => forecast(p, config));
}
console.log('PASS invalid input rejected'); checks++;

console.log(`All ${checks} browser numerical checks passed.`);
