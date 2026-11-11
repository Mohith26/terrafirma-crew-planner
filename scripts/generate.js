// Seeded synthetic history for the Crew Planner demo: 40 training shifts, 20 held-out shifts and tomorrow's plan.
// The "true" generator below is only used to create data; the page and the planner see the events, never TRUTH.
//   node scripts/generate.js   -> data/history.js
const fs = require('fs'), path = require('path');
const C = require('../core/crew.js');
const perH = (x) => x / 60;
const TRUTH = {
  site: { hourly: [4.5, 2.6, 2.0, 2.2, 2.6, 4.2, 3.0, 2.2, 2.0, 2.8], spill: [0.55, 0.3, 0.15] },
  rates: {
    OBSTACLE: { POND_EXCAVATION: [0.5, 0.45, 5], MASS_EXCAVATION: [0.4, 0.4, 5], ROUGH_GRADING: [0.6, 0.5, 6], FINE_GRADING: [0.3, 0.3, 6], CLEARING: [1.2, 0.6, 5], STOCKPILE: [0.4, 0.3, 5], COMPACTION: [0.2, 0.2, 6] },
    GRADE_CHECK: { POND_EXCAVATION: [0.3, 0.3, 8], ROUGH_GRADING: [0.4, 0.3, 8], FINE_GRADING: [1.0, 0.5, 8], COMPACTION: [0.2, 0.2, 8] },
    MANUAL: { POND_EXCAVATION: [0.15, 0.2, 10], MASS_EXCAVATION: [0.1, 0.2, 10], ROUGH_GRADING: [0.05, 0.1, 10], CLEARING: [0.4, 0.25, 10], STOCKPILE: [0.08, 0.1, 10] },
    TRUCK_SPOT: { MASS_EXCAVATION: [8, 0, 1], STOCKPILE: [3, 0, 1] },
    HANDOFF: { POND_EXCAVATION: [0.4, 0, 1], MASS_EXCAVATION: [0.3, 0, 1], ROUGH_GRADING: [0.5, 0, 1], FINE_GRADING: [0.4, 0, 1], CLEARING: [0.3, 0, 1], STOCKPILE: [0.4, 0, 1], COMPACTION: [0.6, 0, 1] },
  },
  svc: { PERSON_STOP: [0.7, 0.5], MANUAL: [7, 0.5], OBSTACLE: [1.3, 0.6], GRADE_CHECK: [1.8, 0.5], TRUCK_SPOT: [0.45, 0.4], HANDOFF: [0.9, 0.4] },
};
const params = { site: TRUTH.site, rates: {}, svc: {} };
for (const c in TRUTH.rates) { params.rates[c] = {}; for (const t in TRUTH.rates[c]) { const [mu, a, d] = TRUTH.rates[c][t]; params.rates[c][t] = { mu: perH(mu) * (1 - a), alpha: a, beta: 1 / d }; } }
// note: mu above is the immigrant rate; total rate per hour = TRUTH value
for (const c in TRUTH.svc) params.svc[c] = { m: Math.log(TRUTH.svc[c][0]), s: TRUTH.svc[c][1] };

const FLEET = [['EXCAVATOR1', 'excavator'], ['EXCAVATOR2', 'excavator'], ['DOZER1', 'dozer'], ['DOZER2', 'dozer'], ['DOZER3', 'dozer'], ['LOADER1', 'loader'], ['ROLLER1', 'roller'], ['SKIDSTEER1', 'skid steer']];
const TASKS = { excavator: ['POND_EXCAVATION', 'MASS_EXCAVATION'], dozer: ['ROUGH_GRADING', 'FINE_GRADING', 'CLEARING'], loader: ['STOCKPILE'], roller: ['COMPACTION'], 'skid steer': ['CLEARING'] };
// Earthwork jobs move through phases, so a shift's task mix is correlated across machines:
// clearing/grubbing days, excavation days (pond + mass excavation with trucks), and grading/compaction days.
const PHASES = {
  clearing: { excavator: ['MASS_EXCAVATION', 'POND_EXCAVATION'], dozer: ['CLEARING', 'CLEARING', 'ROUGH_GRADING'], loader: ['STOCKPILE'], roller: ['COMPACTION'], 'skid steer': ['CLEARING'] },
  excavation: { excavator: ['MASS_EXCAVATION', 'POND_EXCAVATION'], dozer: ['ROUGH_GRADING', 'ROUGH_GRADING', 'CLEARING'], loader: ['STOCKPILE'], roller: ['COMPACTION'], 'skid steer': ['CLEARING'] },
  grading: { excavator: ['POND_EXCAVATION'], dozer: ['FINE_GRADING', 'FINE_GRADING', 'ROUGH_GRADING'], loader: ['STOCKPILE'], roller: ['COMPACTION'], 'skid steer': ['CLEARING'] },
};
function makePlan(r, nMachines) {
  const fleet = FLEET.slice(0, nMachines), u = r();
  const phase = u < 0.3 ? 'clearing' : u < 0.65 ? 'excavation' : 'grading', TK = PHASES[phase];
  return { phase, machines: fleet.map(([id, type]) => {
    const segs = []; let t = Math.floor(r() * 15);
    while (t < 570) {
      const len = 90 + Math.floor(r() * 150), task = TK[type][Math.floor(r() * TK[type].length)];
      let s = t, e = Math.min(600, t + len);
      if (s < 330 && e > 300) { if (300 - s >= 30) segs.push({ s, e: 300, task }); s = 330; } // lunch 12:00-12:30
      if (e - s >= 20) segs.push({ s, e, task });
      t = e + 5 + Math.floor(r() * 15);
    }
    return { id, type, segs };
  }) };
}
const r = C.mulberry(20261110);
const pack = (plan, ev) => ({ plan, ev: ev.map((e) => [+e.t.toFixed(3), plan.machines.findIndex((m) => m.id === e.m), C.CAUSE[e.c].idx, +e.svc.toFixed(3)]) });
const train = [], test = [];
for (let k = 0; k < 40; k++) { const p = makePlan(r, 5 + Math.floor(r() * 4)); train.push(pack(p, C.simulateShift(params, p, Math.floor(r() * 4294967296)))); }
for (let k = 0; k < 20; k++) { const p = makePlan(r, 5 + Math.floor(r() * 4)); test.push(pack(p, C.simulateShift(params, p, Math.floor(r() * 4294967296)))); }
// tomorrow: a fixed, readable plan (retention pond + building pads, 8 machines)
const tomorrow = { name: 'Retention pond + building pads (synthetic site)', machines: [
  { id: 'EXCAVATOR1', type: 'excavator', segs: [{ s: 0, e: 300, task: 'POND_EXCAVATION' }, { s: 330, e: 600, task: 'POND_EXCAVATION' }] },
  { id: 'EXCAVATOR2', type: 'excavator', segs: [{ s: 15, e: 300, task: 'MASS_EXCAVATION' }, { s: 330, e: 585, task: 'MASS_EXCAVATION' }] },
  { id: 'DOZER1', type: 'dozer', segs: [{ s: 0, e: 180, task: 'CLEARING' }, { s: 195, e: 300, task: 'ROUGH_GRADING' }, { s: 330, e: 600, task: 'ROUGH_GRADING' }] },
  { id: 'DOZER2', type: 'dozer', segs: [{ s: 10, e: 300, task: 'ROUGH_GRADING' }, { s: 330, e: 600, task: 'FINE_GRADING' }] },
  { id: 'DOZER3', type: 'dozer', segs: [{ s: 0, e: 240, task: 'CLEARING' }, { s: 255, e: 300, task: 'ROUGH_GRADING' }, { s: 330, e: 560, task: 'FINE_GRADING' }] },
  { id: 'LOADER1', type: 'loader', segs: [{ s: 20, e: 300, task: 'STOCKPILE' }, { s: 330, e: 590, task: 'STOCKPILE' }] },
  { id: 'ROLLER1', type: 'roller', segs: [{ s: 120, e: 300, task: 'COMPACTION' }, { s: 330, e: 600, task: 'COMPACTION' }] },
  { id: 'SKIDSTEER1', type: 'skid steer', segs: [{ s: 0, e: 300, task: 'CLEARING' }, { s: 330, e: 480, task: 'CLEARING' }] },
] };
const out = { generated: 'node scripts/generate.js (seed 20261110)', causes: C.CAUSES.map((c) => c.id), train, test, tomorrow };
const json = JSON.stringify(out);
fs.writeFileSync(path.join(__dirname, '..', 'data', 'history.js'), '// Synthetic shift history (generated by scripts/generate.js; events are [minute, machine index, cause index, handling minutes])\n(function (r) { const d = ' + json + ';\nif (typeof module === "object" && module.exports) module.exports = d; else r.TF_HISTORY = d; })(typeof self !== "undefined" ? self : this);\n');
fs.writeFileSync(path.join(__dirname, 'truth.json'), JSON.stringify(TRUTH, null, 1));
console.log('train events', train.reduce((a, s) => a + s.ev.length, 0), 'test events', test.reduce((a, s) => a + s.ev.length, 0), 'bytes', json.length);
