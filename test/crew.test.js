// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core/crew.js');
const D = require('../data/history.js');
const TRUTH = require('../scripts/truth.json');

test('Erlang-C formula: c = 2, a = 1 Erlang gives P(wait) = 1/3', () => {
  assert.ok(Math.abs(C.erlangC(2, 1) - 1 / 3) < 1e-12);
  assert.equal(C.erlangC(2, 2.5), 1);
});

test('Hawkes simulation has the right mean count, and EM recovers mu, alpha, beta', () => {
  const r = C.mulberry(3), mu = 0.02, alpha = 0.5, beta = 0.2, seqs = [];
  let n = 0;
  for (let k = 0; k < 400; k++) { const ts = C.hawkesSeq(r, mu, alpha, beta, 0, 600); n += ts.length; seqs.push({ s: 0, e: 600, ts }); }
  const expect = 400 * mu * 600 / (1 - alpha);
  assert.ok(Math.abs(n - expect) / expect < 0.06, `${n} vs ${expect}`);
  const f = C.hawkesEM(seqs, 150);
  assert.ok(Math.abs(f.mu - mu) / mu < 0.12, `mu ${f.mu}`);
  assert.ok(Math.abs(f.alpha - alpha) < 0.06, `alpha ${f.alpha}`);
  assert.ok(Math.abs(1 / f.beta - 1 / beta) < 1.0, `delay ${1 / f.beta}`);
});

test('queue simulator matches Erlang-C mean wait for Poisson arrivals and exponential service', () => {
  const r = C.mulberry(9), lam = 1.6, svcMean = 1.0, c = 2; // per minute; a = 1.6 Erlangs
  const plan = { machines: [{ id: 'M', segs: [{ s: 0, e: 600, task: 'X' }] }] };
  let wsum = 0, nsum = 0;
  for (let k = 0; k < 60; k++) {
    const ev = []; let t = 0;
    for (;;) { t += -Math.log(1 - r()) / lam; if (t >= 600) break; ev.push({ t, m: 'M', c: 'HANDOFF', svc: -Math.log(1 - r()) * svcMean }); }
    const q = C.runQueue(ev, Array(C.NB).fill(c), plan);
    q.forEach((b) => { wsum += b.wait; nsum += b.n; });
  }
  const a = lam * svcMean, wq = C.erlangC(c, a) * svcMean / (c - a);
  assert.ok(Math.abs(wsum / nsum - wq) / wq < 0.12, `sim ${wsum / nsum} vs Erlang-C ${wq}`);
});

test('queue serves safety stops first (non-preemptive priority)', () => {
  const plan = { machines: [{ id: 'A', segs: [{ s: 0, e: 600, task: 'X' }] }, { id: 'B', segs: [{ s: 0, e: 600, task: 'X' }] }, { id: 'P', segs: [{ s: 0, e: 600, task: 'X' }] }] };
  const ev = [{ t: 0, m: 'A', c: 'MANUAL', svc: 5 }, { t: 1, m: 'B', c: 'HANDOFF', svc: 1 }, { t: 2, m: 'P', c: 'PERSON_STOP', svc: 1 }];
  const tr = []; C.runQueue(ev, Array(C.NB).fill(1), plan, tr);
  assert.deepEqual(tr.map((x) => x.c), ['MANUAL', 'PERSON_STOP', 'HANDOFF']);
  assert.equal(tr[1].start, 5);
});

test('peak concurrency counts overlapping stops, including ones carried across bins', () => {
  const ev = [{ t: 1, svc: 30 }, { t: 2, svc: 1 }, { t: 25, svc: 2 }];
  const p = C.concurrencyProfile([ev], 10);
  assert.deepEqual(p.slice(0, 4).map((x) => x.p50), [2, 1, 2, 1]);
});

test('fit on the 40 training shifts recovers the generator (rates, burstiness, handling times, spill)', () => {
  const m = C.fitModel(D.train.map(C.unpack));
  const ob = m.rates.OBSTACLE.CLEARING, fg = m.rates.GRADE_CHECK.FINE_GRADING;
  assert.ok(Math.abs(ob.mu / (1 - ob.alpha) * 60 - TRUTH.rates.OBSTACLE.CLEARING[0]) < 0.15);
  assert.ok(Math.abs(ob.alpha - TRUTH.rates.OBSTACLE.CLEARING[1]) < 0.1);
  assert.ok(Math.abs(fg.alpha - TRUTH.rates.GRADE_CHECK.FINE_GRADING[1]) < 0.1);
  for (const c in TRUTH.svc) assert.ok(Math.abs(Math.exp(m.svc[c].m) / TRUTH.svc[c][0] - 1) < 0.08, c);
  assert.ok(Math.abs(m.site.spill.reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('planner: chance of meeting the target rises with crew size and the chosen crew meets the 90% target', () => {
  const m = C.fitModel(D.train.map(C.unpack)), sims = C.forecast(m, D.tomorrow, 120, 11);
  const p = C.planStaffing(sims, D.tomorrow);
  p.curve.forEach((row) => { for (let k = 1; k < row.length; k++) assert.ok(row[k] >= row[k - 1] - 1e-9); });
  p.probs.forEach((x) => assert.ok(x >= C.SLA.conf));
});

test('backtest on 20 held-out shifts reproduces the page numbers', () => {
  const m = C.fitModel(D.train.map(C.unpack)), test = D.test.map(C.unpack);
  const plans = test.map((sh, k) => C.planStaffing(C.forecast(m, sh.plan, 150, 1000 + k), sh.plan).staff);
  const pl = C.backtest(test, (p) => plans[test.findIndex((s) => s.plan === p)]);
  const fl = C.backtest(test, (p) => C.flatStaffing(p, 3)), er = C.backtest(test, (p) => C.erlangStaffing(m, p));
  assert.equal(pl.blocks, 100);
  assert.deepEqual([pl.ok, fl.ok, er.ok], [95, 81, 40]);
  assert.ok(pl.okRate >= C.SLA.conf);
});
