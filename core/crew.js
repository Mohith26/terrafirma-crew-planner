/*
 * Crew Planner: forecast remote-operator interventions for a shift plan and size the operator crew.
 * Unofficial concept by Mohith Gajjela. Not affiliated with TerraFirma. Synthetic data.
 *
 * Model (all times in minutes from shift start, shift = 600 min, 5 blocks of 120 min):
 *  - PERSON_STOP: site-level ground-crew events (inhomogeneous Poisson by hour) that stop 1-3 nearby machines at once.
 *  - OBSTACLE, GRADE_CHECK, MANUAL: self-exciting (Hawkes, exponential kernel) per machine and task: one hard
 *    patch of ground tends to cause more stops in the next minutes. Fitted by EM.
 *  - TRUCK_SPOT, HANDOFF: Poisson per task.
 *  - Handling time per cause: lognormal, fitted by maximum likelihood.
 * Planner: Monte Carlo of the fitted model for tomorrow's plan, a non-preemptive priority queue for k operators,
 * and the smallest k per block whose chance of meeting the service level (machine wait <= 5% of machine time and
 * safety-stop response p95 <= 60 s) is at least 90%. Blocks are solved in time order (later blocks never
 * change earlier ones in a forward-in-time queue).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CREW = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const SHIFT = 600, BLOCK = 120, NB = SHIFT / BLOCK;
  const CAUSES = [
    { id: 'PERSON_STOP', label: 'Person detected', prio: 0, kind: 'site' },
    { id: 'MANUAL', label: 'Manual segment', prio: 1, kind: 'hawkes' },
    { id: 'OBSTACLE', label: 'Obstacle / low confidence', prio: 1, kind: 'hawkes' },
    { id: 'GRADE_CHECK', label: 'Grade out of tolerance', prio: 2, kind: 'hawkes' },
    { id: 'TRUCK_SPOT', label: 'Truck spotting', prio: 2, kind: 'poisson' },
    { id: 'HANDOFF', label: 'Workflow handoff', prio: 3, kind: 'poisson' },
  ];
  const CAUSE = Object.fromEntries(CAUSES.map((c, i) => [c.id, Object.assign({ idx: i }, c)]));
  const SLA = { waitShare: 0.05, safetyP95: 1.0 /* min */, conf: 0.9 };

  // ------------------------------------------------------------------ RNG
  function mulberry(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0; let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const expo = (r, rate) => -Math.log(1 - r()) / rate;
  function normal(r) { const u = r() || 1e-12, v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function poisson(r, m) { if (m > 30) return Math.max(0, Math.round(m + Math.sqrt(m) * normal(r))); let L = Math.exp(-m), k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }
  function gamma(r, k) { // Marsaglia-Tsang, shape k, scale 1
    if (k < 1) return gamma(r, k + 1) * Math.pow(r(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) { let x, v; do { x = normal(r); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = r(); if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; }
  }

  // ------------------------------------------------------------------ simulation of interventions
  // params: { site: { hourly: [10 rates per hour], spill: [p1,p2,p3] },
  //           rates: { [cause]: { [task]: {mu (per min), alpha, beta (per min)} } },
  //           svc: { [cause]: {m (log-min mean), s} } }
  // plan: { machines: [{id, type, segs: [{s, e, task}]}] }
  function hawkesSeq(r, mu, alpha, beta, s, e) {
    const out = [];
    let t = s;
    const imm = [];
    for (;;) { t += expo(r, mu); if (t >= e) break; imm.push(t); }
    const stack = imm.slice();
    while (stack.length) {
      const p = stack.pop(); out.push(p);
      if (alpha <= 0) continue;
      const n = poisson(r, alpha);
      for (let k = 0; k < n; k++) { const c = p + expo(r, beta); if (c < e) stack.push(c); }
    }
    return out.sort((a, b) => a - b);
  }
  function simulateShift(params, plan, seed, opt) {
    const r = mulberry(seed), ev = [], scale = (opt && opt.scale) || {};
    const sc = (c) => (scale[c] == null ? 1 : scale[c]);
    const svc = (c) => Math.exp(params.svc[c].m + params.svc[c].s * normal(r));
    const active = (m, t) => m.segs.find((g) => t >= g.s && t < g.e);
    // site events
    for (let h = 0; h < SHIFT / 60; h++) {
      const lam = params.site.hourly[h] * sc('PERSON_STOP');
      let t = h * 60;
      for (;;) {
        t += expo(r, lam / 60); if (t >= (h + 1) * 60) break;
        const cand = plan.machines.filter((m) => active(m, t));
        if (!cand.length) continue;
        const u = r(); let n = 1, acc = params.site.spill[0];
        while (n < params.site.spill.length && u > acc) { acc += params.site.spill[n]; n++; }
        for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
        cand.slice(0, n).forEach((m) => ev.push({ t, m: m.id, c: 'PERSON_STOP', svc: svc('PERSON_STOP'), g: 1 }));
      }
    }
    // per-machine causes
    for (const m of plan.machines) for (const g of m.segs) for (const c of CAUSES) {
      if (c.kind === 'site') continue;
      const p = params.rates[c.id] && params.rates[c.id][g.task];
      if (!p || p.mu <= 0) continue;
      const mu = p.mu * sc(c.id);
      const ts = c.kind === 'hawkes' ? hawkesSeq(r, mu, p.alpha, p.beta, g.s, g.e) : hawkesSeq(r, mu, 0, 1, g.s, g.e);
      for (const t of ts) ev.push({ t, m: m.id, c: c.id, svc: svc(c.id) });
    }
    return ev.sort((a, b) => a.t - b.t);
  }

  // ------------------------------------------------------------------ fitting
  function hawkesEM(seqs, iters) { // seqs: [{ts:[...], s, e}]
    let n = 0, T = 0;
    for (const q of seqs) { n += q.ts.length; T += q.e - q.s; }
    if (!n) return { mu: 0, alpha: 0, beta: 0.2, n: 0, T };
    let mu = n / T * 0.6, alpha = 0.3, beta = 0.2;
    for (let it = 0; it < (iters || 60); it++) {
      let sBg = 0, sOff = 0, sOffDt = 0, sComp = 0;
      for (const q of seqs) {
        const ts = q.ts;
        for (let i = 0; i < ts.length; i++) {
          let lam = mu; const ks = [];
          for (let j = i - 1; j >= 0; j--) { const dt = ts[i] - ts[j]; if (dt > 12 / beta) break; const k = alpha * beta * Math.exp(-beta * dt); ks.push([k, dt]); lam += k; }
          sBg += mu / lam;
          for (const [k, dt] of ks) { sOff += k / lam; sOffDt += k / lam * dt; }
          sComp += 1 - Math.exp(-beta * (q.e - ts[i]));
        }
      }
      mu = sBg / T; alpha = Math.min(0.95, sOff / Math.max(sComp, 1e-9)); beta = sOff > 1e-9 ? sOff / sOffDt : beta;
    }
    return { mu, alpha, beta, n, T };
  }
  function fitModel(history) {
    const tasks = new Set(); history.forEach((h) => h.plan.machines.forEach((m) => m.segs.forEach((g) => tasks.add(g.task))));
    // site process: group PERSON_STOP events that share a timestamp
    const hourly = Array(SHIFT / 60).fill(0), sizes = [0, 0, 0, 0];
    for (const h of history) {
      const groups = new Map();
      h.events.filter((e) => e.c === 'PERSON_STOP').forEach((e) => groups.set(e.t, (groups.get(e.t) || 0) + 1));
      for (const [t, k] of groups) { hourly[Math.floor(t / 60)]++; sizes[Math.min(3, k)]++; }
    }
    const nGroups = sizes.reduce((a, b) => a + b, 0);
    const site = { hourly: hourly.map((x) => x / history.length), spill: sizes.slice(1).map((x, i) => (x + (i === 0 ? sizes[0] : 0)) / Math.max(nGroups, 1)) };
    const rates = {}, fitInfo = {};
    for (const c of CAUSES) {
      if (c.kind === 'site') continue;
      rates[c.id] = {};
      for (const task of tasks) {
        const seqs = [];
        for (const h of history) for (const m of h.plan.machines) for (const g of m.segs) if (g.task === task)
          seqs.push({ s: g.s, e: g.e, ts: h.events.filter((e) => e.m === m.id && e.c === c.id && e.t >= g.s && e.t < g.e).map((e) => e.t) });
        if (!seqs.length) continue;
        let f;
        if (c.kind === 'hawkes') f = hawkesEM(seqs, 80);
        else { const n = seqs.reduce((a, q) => a + q.ts.length, 0), T = seqs.reduce((a, q) => a + q.e - q.s, 0); f = { mu: n / T, alpha: 0, beta: 1, n, T }; }
        rates[c.id][task] = { mu: f.mu, alpha: f.alpha, beta: f.beta, n: f.n, T: f.T };
      }
    }
    const svc = {};
    for (const c of CAUSES) {
      const x = []; history.forEach((h) => h.events.forEach((e) => { if (e.c === c.id) x.push(Math.log(e.svc)); }));
      const m = x.reduce((a, b) => a + b, 0) / Math.max(x.length, 1);
      svc[c.id] = { m, s: Math.sqrt(x.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(x.length - 1, 1)), n: x.length };
    }
    return { site, rates, svc, nShifts: history.length };
  }
  // draw one parameter set from the posterior of the fitted rates (Gamma for event counts; keeps alpha, beta)
  function drawParams(model, r) {
    const out = { site: { hourly: model.site.hourly.map((x) => gamma(r, x * model.nShifts + 0.5) / model.nShifts), spill: model.site.spill }, rates: {}, svc: model.svc };
    for (const c in model.rates) {
      out.rates[c] = {};
      for (const t in model.rates[c]) { const p = model.rates[c][t]; const imm = p.n * (1 - p.alpha); out.rates[c][t] = { mu: gamma(r, imm + 0.5) / p.T, alpha: p.alpha, beta: p.beta }; }
    }
    return out;
  }

  // ------------------------------------------------------------------ queue
  // staffing: array of NB operator counts. Non-preemptive priority (cause prio, then arrival).
  // Returns per-block metrics attributed to the arrival block.
  function runQueue(events, staffing, plan, trace) {
    const blk = (t) => Math.min(NB - 1, Math.floor(t / BLOCK));
    let queue = [], i = 0, now = 0;
    const res = Array.from({ length: NB }, () => ({ wait: 0, n: 0, safety: [], busy: 0 }));
    const capAt = (t) => staffing[blk(t)];
    // event-driven: process arrivals and service completions
    const evs = events.slice();
    const busy = []; // end times of jobs in service
    const schedule = () => {
      busy.sort((a, b) => a - b);
      while (queue.length) {
        const inService = busy.filter((x) => x > now + 1e-9).length;
        if (inService >= capAt(now)) break;
        queue.sort((a, b) => CAUSE[a.c].prio - CAUSE[b.c].prio || a.t - b.t);
        const j = queue.shift();
        const w = now - j.t, b = blk(j.t);
        res[b].wait += w; res[b].n++;
        if (j.c === 'PERSON_STOP') res[b].safety.push(w);
        busy.push(now + j.svc);
        if (trace) trace.push({ t: j.t, m: j.m, c: j.c, svc: j.svc, start: now });
        res[blk(now)].busy += j.svc;
      }
    };
    while (i < evs.length || queue.length) {
      const nextArr = i < evs.length ? evs[i].t : Infinity;
      const pend = busy.filter((x) => x > now + 1e-9);
      const nextDone = pend.length ? Math.min(...pend) : Infinity;
      const nextBlock = (Math.floor(now / BLOCK) + 1) * BLOCK;
      const tNext = Math.min(nextArr, nextDone, queue.length ? nextBlock : Infinity);
      if (!isFinite(tNext)) break;
      now = tNext;
      while (i < evs.length && evs[i].t <= now + 1e-12) queue.push(evs[i++]);
      for (let k = busy.length - 1; k >= 0; k--) if (busy[k] <= now + 1e-9) busy.splice(k, 1);
      schedule();
    }
    const mins = activeMinutes(plan);
    return res.map((x, b) => {
      const s = x.safety.slice().sort((a, b) => a - b);
      const p95 = s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : 0;
      return { waitShare: x.wait / Math.max(mins[b], 1), wait: x.wait, n: x.n, safetyP95: p95, nSafety: s.length, busy: x.busy, ok: x.wait / Math.max(mins[b], 1) <= SLA.waitShare && p95 <= SLA.safetyP95 };
    });
  }
  function activeMinutes(plan) {
    const out = Array(NB).fill(0);
    for (const m of plan.machines) for (const g of m.segs) for (let b = 0; b < NB; b++) out[b] += Math.max(0, Math.min(g.e, (b + 1) * BLOCK) - Math.max(g.s, b * BLOCK));
    return out;
  }

  // ------------------------------------------------------------------ planner
  function forecast(model, plan, nSims, seed, opt) {
    const r = mulberry(seed), sims = [];
    for (let k = 0; k < nSims; k++) { const p = drawParams(model, r); sims.push(simulateShift(p, plan, Math.floor(r() * 4294967296), opt)); }
    return sims;
  }
  function planStaffing(sims, plan, maxOps) {
    maxOps = maxOps || 8;
    const staff = Array(NB).fill(1), probs = Array(NB).fill(0), curve = [];
    for (let b = 0; b < NB; b++) {
      const row = [];
      for (let k = 1; k <= maxOps; k++) {
        staff[b] = k;
        const ok = sims.filter((ev) => runQueue(ev, staff, plan)[b].ok).length / sims.length;
        row.push(ok);
        if (ok >= SLA.conf) break;
      }
      probs[b] = row[row.length - 1]; curve.push(row);
    }
    return { staff: staff.slice(), probs, curve };
  }
  // load profile: operators busy per 10-minute bin, quantiles across sims (with the given staffing)
  function loadProfile(sims, plan, staff, bin) {
    bin = bin || 10; const nb = SHIFT / bin;
    const per = sims.map((ev) => { const a = Array(nb).fill(0); for (const e of ev) { let t = e.t, rem = e.svc; while (rem > 0 && t < SHIFT) { const k = Math.floor(t / bin), d = Math.min(rem, (k + 1) * bin - t); a[k] += d / bin; rem -= d; t += d; } } return a; });
    const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    return Array.from({ length: nb }, (_, k) => ({ t: k * bin, p10: q(per.map((a) => a[k]), 0.1), p50: q(per.map((a) => a[k]), 0.5), p90: q(per.map((a) => a[k]), 0.9) }));
  }
  // peak concurrent stops per bin: with unlimited operators, how many machines are stopped at the same moment
  // (max over the bin), quantiles across simulated shifts. This is what a crew has to absorb.
  function concurrencyProfile(sims, bin) {
    bin = bin || 10; const nb = SHIFT / bin;
    const per = sims.map((ev) => {
      const pts = []; for (const e of ev) { pts.push([e.t, 1]); pts.push([e.t + e.svc, -1]); }
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const a = Array(nb).fill(0); let cur = 0, kb = 0;
      for (const [t, d] of pts) {
        const k = Math.min(nb, Math.floor(t / bin));
        while (kb < k) { kb++; if (kb < nb && cur > a[kb]) a[kb] = cur; } // stops carried into a new bin
        cur += d; if (k < nb && cur > a[k]) a[k] = cur;
      }
      return a;
    });
    const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    return Array.from({ length: nb }, (_, k) => ({ t: k * bin, p50: q(per.map((a) => a[k]), 0.5), p90: q(per.map((a) => a[k]), 0.9), p99: q(per.map((a) => a[k]), 0.99) }));
  }
  // Erlang-C baseline: Poisson arrivals at the fitted mean rate (immigrants / (1 - alpha)), exponential service
  function erlangC(c, a) { // a = offered load (Erlangs); returns P(wait)
    if (a >= c) return 1;
    let s = 0, t = 1; for (let k = 0; k < c; k++) { if (k > 0) t *= a / k; s += t; }
    const tc = t * a / c; const pc = tc * c / (c - a); return pc / (s + pc);
  }
  function erlangStaffing(model, plan, maxOps) {
    maxOps = maxOps || 8;
    const mins = activeMinutes(plan), staff = [];
    const meanSvc = {}; for (const c of CAUSES) { const s = model.svc[c.id]; meanSvc[c.id] = Math.exp(s.m + s.s * s.s / 2); }
    for (let b = 0; b < NB; b++) {
      let lam = 0, work = 0; // per minute
      const site = model.site.hourly.slice(b * 2, b * 2 + 2).reduce((x, y) => x + y, 0) / 120;
      const spillMean = model.site.spill.reduce((x, p, i) => x + p * (i + 1), 0);
      lam += site * spillMean; work += site * spillMean * meanSvc.PERSON_STOP;
      for (const m of plan.machines) for (const g of m.segs) {
        const ov = Math.max(0, Math.min(g.e, (b + 1) * BLOCK) - Math.max(g.s, b * BLOCK)) / BLOCK;
        if (!ov) continue;
        for (const c in model.rates) { const p = model.rates[c][g.task]; if (!p) continue; const rate = p.mu / (1 - p.alpha) * ov; lam += rate; work += rate * meanSvc[c]; }
      }
      const es = work / Math.max(lam, 1e-9), a = work;
      let k = 1;
      for (; k < maxOps; k++) { if (a >= k) continue; const wq = erlangC(k, a) * es / (k - a); if (lam * wq * BLOCK / Math.max(mins[b], 1) <= SLA.waitShare) break; }
      staff.push(k);
    }
    return staff;
  }
  function flatStaffing(plan, ratio) { return Array(NB).fill(Math.ceil(plan.machines.length / (ratio || 3))); }
  function unpack(sh) { return { plan: sh.plan, events: sh.ev.map((e) => ({ t: e[0], m: sh.plan.machines[e[1]].id, c: CAUSES[e[2]].id, svc: e[3] })) }; }
  // backtest a staffing policy on realized shifts: fraction of blocks meeting the service level, operator-hours
  function backtest(shifts, policy) {
    let blocks = 0, ok = 0, hours = 0, wait = 0, mins = 0; const rows = [];
    for (const sh of shifts) {
      const staff = policy(sh.plan), q = runQueue(sh.events, staff, sh.plan), am = activeMinutes(sh.plan);
      q.forEach((x, b) => { if (am[b] <= 0) return; blocks++; if (x.ok) ok++; wait += x.wait; mins += am[b]; });
      hours += opHours(staff); rows.push({ staff, q });
    }
    return { blocks, ok, okRate: ok / blocks, hours, hoursPerShift: hours / shifts.length, waitShare: wait / mins, rows };
  }
  const opHours = (staff) => staff.reduce((a, b) => a + b, 0) * BLOCK / 60;

  return { SHIFT, BLOCK, NB, CAUSES, CAUSE, SLA, mulberry, poisson, gamma, hawkesSeq, simulateShift, hawkesEM, fitModel, drawParams,
    runQueue, activeMinutes, forecast, unpack, backtest, planStaffing, loadProfile, concurrencyProfile, erlangC, erlangStaffing, flatStaffing, opHours };
});
