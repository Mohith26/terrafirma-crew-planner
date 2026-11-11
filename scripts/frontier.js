// Cost/reliability frontier on the 20 held-out shifts: planner at several confidence levels vs flat ratios.
//   node scripts/frontier.js
const C = require('../core/crew.js'), D = require('../data/history.js');
const m = C.fitModel(D.train.map(C.unpack)), test = D.test.map(C.unpack);
const sims = test.map((sh, k) => C.forecast(m, sh.plan, 150, 1000 + k));
for (const conf of [0.6, 0.7, 0.8, 0.9, 0.95]) {
  C.SLA.conf = conf;
  const r = C.backtest(test, (p) => { const k = test.findIndex((s) => s.plan === p); return C.planStaffing(sims[k], p).staff; });
  console.log(`planner conf ${conf}: ${Math.round(100 * r.okRate)}% of blocks met, ${r.hoursPerShift.toFixed(1)} operator-h/shift`);
}
C.SLA.conf = 0.9;
for (const ratio of [2, 2.5, 3, 3.5, 4]) { const r = C.backtest(test, (p) => C.flatStaffing(p, ratio)); console.log(`flat 1:${ratio}: ${Math.round(100 * r.okRate)}% of blocks met, ${r.hoursPerShift.toFixed(1)} operator-h/shift`); }
const e = C.backtest(test, (p) => C.erlangStaffing(m, p)); console.log(`Erlang-C: ${Math.round(100 * e.okRate)}% of blocks met, ${e.hoursPerShift.toFixed(1)} operator-h/shift`);
