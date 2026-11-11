/* Crew Planner UI. Everything is computed here from data/history.js with core/crew.js:
   the Hawkes/Poisson fit, the Monte Carlo forecast, the staffing plan, the backtest and the automation ranking. */
(function () {
  'use strict';
  const C = window.CREW, D = window.TF_HISTORY, $ = (id) => document.getElementById(id);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const N_SIMS = 300, N_BT = 150, SEED = 11;
  const TASK = { POND_EXCAVATION: ['Excavator', 'Retention pond excavation'], MASS_EXCAVATION: ['Excavator', 'Mass excavation, truck loading'], ROUGH_GRADING: ['Bulldozer', 'Building pad rough grading'],
    FINE_GRADING: ['Bulldozer', 'Fine grading to final surface'], CLEARING: ['Clearing', 'Clearing and grubbing'], STOCKPILE: ['Loader', 'Stockpile and truck loading'], COMPACTION: ['Roller', 'Pad compaction'] };
  const STATE = { POND_EXCAVATION: 'EXCAVATOR_GRADE_ASSIST', MASS_EXCAVATION: 'EXCAVATOR_LOAD_ASSIST', ROUGH_GRADING: 'DOZER_BLADE_ASSIST', FINE_GRADING: 'DOZER_CONTOUR_ASSIST', CLEARING: 'CLEARING_ASSIST', STOCKPILE: 'LOADER_ASSIST', COMPACTION: 'ROLLER_PASS_PLAN' };
  const hhmm = (m) => { const h = 7 + Math.floor(m / 60), mm = Math.round(m % 60); return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
  const st = { policy: 'planner' };
  const qp = new URLSearchParams(location.search).get('policy'); if (qp === 'flat' || qp === 'erlang') st.policy = qp;

  if (window.Chart) {
    Chart.defaults.font.family = "'DejaVu Sans Mono', ui-monospace, monospace";
    Chart.defaults.font.size = 11.5; Chart.defaults.color = '#c9d1d9';
    Chart.defaults.plugins.tooltip.backgroundColor = '#0a0e12'; Chart.defaults.plugins.tooltip.borderColor = '#1d8f99'; Chart.defaults.plugins.tooltip.borderWidth = 1; Chart.defaults.plugins.tooltip.cornerRadius = 0;
  }

  function boot() {
    const train = D.train.map(C.unpack), test = D.test.map(C.unpack), plan = D.tomorrow;
    const model = C.fitModel(train);
    const sims = C.forecast(model, plan, N_SIMS, SEED);
    const P = { planner: C.planStaffing(sims, plan).staff, flat: C.flatStaffing(plan, 3), erlang: C.erlangStaffing(model, plan) };
    Object.assign(st, { train, test, plan, model, sims, P });
    $('siteName').textContent = plan.name;
    $('nTrain').textContent = train.length;
    renderObjectives(); renderCauses(); renderFleet(); renderPolicyButtons(); renderPolicy(); renderROI();
    setTimeout(runBacktest, 60);
  }

  // ------------------------------------------------------------------ left column
  function renderObjectives() {
    const agg = new Map();
    for (const m of st.plan.machines) for (const g of m.segs) { const k = g.task; const a = agg.get(k) || { min: 0, machines: new Set(), s: 1e9, e: 0 }; a.min += g.e - g.s; a.machines.add(m.id); a.s = Math.min(a.s, g.s); a.e = Math.max(a.e, g.e); agg.set(k, a); }
    const tot = [...agg.values()].reduce((x, a) => x + a.min, 0);
    $('objectives').innerHTML = [...agg.entries()].sort((a, b) => b[1].min - a[1].min).map(([k, a]) => `<div class="obj"><div class="n">[${TASK[k][0]}] ${TASK[k][1]}</div><div class="bar"><i style="width:${(100 * a.min / tot).toFixed(1)}%"></i></div><div class="m">${[...a.machines].join(', ')} &middot; ${hhmm(a.s)}&ndash;${hhmm(a.e)} &middot; ${(a.min / 60).toFixed(1)} machine-h</div></div>`).join('');
  }
  function causeStats() {
    const N = st.sims.length, out = {};
    for (const c of C.CAUSES) out[c.id] = { n: 0, opmin: 0, groups: 0 };
    for (const ev of st.sims) { const seen = new Set(); for (const e of ev) { const o = out[e.c]; o.n += 1 / N; o.opmin += e.svc / N; if (e.c === 'PERSON_STOP' && !seen.has(e.t)) { seen.add(e.t); o.groups += 1 / N; } } }
    return out;
  }
  function burstOf(cid) { // exposure-weighted branching ratio over tomorrow's tasks
    const r = st.model.rates[cid]; if (!r) return null;
    let w = 0, s = 0; for (const m of st.plan.machines) for (const g of m.segs) { const p = r[g.task]; if (!p || !p.n) continue; const d = g.e - g.s; w += d; s += d * p.alpha; }
    return w ? s / w : 0;
  }
  function renderCauses() {
    const cs = causeStats(); st.cs = cs;
    const mh = C.activeMinutes(st.plan).reduce((a, b) => a + b, 0) / 60;
    $('causes').innerHTML = C.CAUSES.map((c) => {
      const s = cs[c.id], svc = st.model.svc[c.id], mean = Math.exp(svc.m + svc.s * svc.s / 2);
      const b = burstOf(c.id);
      let d = `${(s.n / mh).toFixed(2)}/machine-h &middot; ${fmtMin(mean)} each`;
      if (c.id === 'PERSON_STOP') d += ` &middot; ${(s.n / Math.max(s.groups, 1e-9)).toFixed(2)} machines per event`;
      if (b != null && b > 0) d += ` &middot; burst ${b.toFixed(2)}<span class="burst" style="width:${Math.round(b * 40)}px"></span>`;
      return `<div class="cause"><div class="nm">${c.id}</div><div class="v">${s.n.toFixed(1)}/shift</div><div class="d">${d}</div></div>`;
    }).join('') + `<div class="fine" style="margin-top:8px">Burst = share of stops triggered by an earlier stop on the same machine (fitted Hawkes branching ratio).</div>`;
  }
  const fmtMin = (m) => (m < 1 ? Math.round(m * 60) + ' s' : m.toFixed(1) + ' min');

  // ------------------------------------------------------------------ fleet
  function renderFleet() {
    $('fleet').innerHTML = st.plan.machines.map((m) => {
      let rate = 0, mins = 0, bw = 0, bs = 0;
      for (const g of m.segs) { const d = g.e - g.s; mins += d; for (const cid in st.model.rates) { const p = st.model.rates[cid][g.task]; if (p && p.n) { rate += p.mu / (1 - p.alpha) * d; if (p.alpha > 0) { bw += d; bs += d * p.alpha; } } } }
      return `<div class="mcard"><div class="id">${m.id}</div><div class="ln">${STATE[m.segs[0].task]}</div><div class="ln">Stops: <b>${(rate / mins * 60).toFixed(2)}/h</b></div><div class="ln">Window: ${hhmm(m.segs[0].s)}&ndash;${hhmm(m.segs[m.segs.length - 1].e)}</div></div>`;
    }).join('');
  }

  // ------------------------------------------------------------------ policies
  const POL = { planner: 'Crew Planner (calibrated)', flat: 'Flat ratio 1:3', erlang: 'Erlang-C' };
  function renderPolicyButtons() {
    $('policyBtns').innerHTML = Object.entries(POL).map(([k, v]) => `<button class="btn ${k === st.policy ? 'on' : ''}" data-p="${k}">${v}</button>`).join('');
    $('policyBtns').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { st.policy = b.dataset.p; renderPolicyButtons(); renderPolicy(); }));
  }
  function evalStaff(staff) {
    const N = st.sims.length, okB = Array(C.NB).fill(0); let wait = 0; const p95 = [];
    for (const ev of st.sims) { const q = C.runQueue(ev, staff, st.plan); q.forEach((x, b) => { if (x.ok) okB[b]++; wait += x.wait / N; }); p95.push(Math.max(...q.map((x) => x.safetyP95))); }
    p95.sort((a, b) => a - b);
    return { okB: okB.map((x) => x / N), wait, safety: p95[Math.floor(0.5 * N)] };
  }
  function renderPolicy() {
    const staff = st.P[st.policy], e = evalStaff(staff), mh = C.activeMinutes(st.plan).reduce((a, b) => a + b, 0) / 60, oh = C.opHours(staff);
    $('crewState').textContent = st.policy === 'planner' ? 'RECOMMENDED' : st.policy === 'flat' ? 'FLAT_RATIO' : 'ERLANG_C';
    $('crewBlocks').innerHTML = staff.map((k, b) => `<div class="blk"><span class="t">${hhmm(b * C.BLOCK)}&ndash;${hhmm((b + 1) * C.BLOCK)}</span><span class="ops">${[1, 2, 3, 4, 5].map((n) => `<span class="${n === k ? 'on' : ''}">${n}</span>`).join('')}</span><span class="p" style="color:${e.okB[b] < C.SLA.conf ? "#ef4b4b" : ""}" title="chance the block meets the service level">${Math.round(100 * e.okB[b])}%</span></div>`).join('');
    const minOk = Math.min(...e.okB);
    $('slReadouts').innerHTML = `<div class="r ${minOk < C.SLA.conf ? 'bad' : ''}"><span>Weakest block:</span><span>${Math.round(100 * minOk)}%</span></div>
      <div class="r"><span>Machine wait:</span><span>${e.wait.toFixed(0)} min</span></div>
      <div class="r"><span>Operator-hours:</span><span>${oh.toFixed(0)} h</span></div>
      <div class="r"><span>Machines/operator:</span><span>${(mh / oh).toFixed(2)}</span></div>`;
    drawLoad(staff);
  }

  // ------------------------------------------------------------------ chart
  function drawLoad(staff) {
    const prof = C.concurrencyProfile(st.sims, 10);
    const labels = prof.map((x) => hhmm(x.t));
    const step = (s) => prof.map((x) => s[Math.min(C.NB - 1, Math.floor(x.t / C.BLOCK))]);
    if (st.chart) st.chart.destroy();
    st.chart = new Chart($('loadChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'P90', data: prof.map((x) => x.p90), borderColor: 'rgba(0,0,0,0)', backgroundColor: 'rgba(29,143,153,.30)', fill: '+1', pointRadius: 0, stepped: true },
        { label: 'Median', data: prof.map((x) => x.p50), borderColor: '#4fd1c1', borderWidth: 2, pointRadius: 0, fill: false, stepped: true },
        { label: 'P99', data: prof.map((x) => x.p99), borderColor: '#4fd1c1', borderWidth: 1, borderDash: [2, 3], pointRadius: 0, fill: false, stepped: true },
        { label: 'Crew', data: step(staff), borderColor: '#39db58', borderWidth: 2.5, pointRadius: 0, stepped: true, fill: false },
        { label: 'Flat 1:3', data: step(st.P.flat), borderColor: '#e98b2a', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, stepped: true, fill: false },
      ] },
      options: { animation: false, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}` } } },
        scales: { x: { grid: { color: '#16262c' }, ticks: { maxTicksLimit: 11, maxRotation: 0 } }, y: { beginAtZero: true, suggestedMax: 6, grid: { color: '#16262c' }, ticks: { stepSize: 1 }, title: { display: true, text: 'machines stopped at once' } } } },
    });
    $('loadLegend').innerHTML = `<span><i style="background:rgba(29,143,153,.55)"></i>median&ndash;P90 peak, ${st.sims.length} simulated shifts</span><span><i style="background:#4fd1c1;height:2px"></i>median</span><span><i style="border-top:1px dashed #4fd1c1;height:0"></i>P99</span><span><i style="background:#39db58;height:3px"></i>${POL[st.policy]}</span><span><i style="background:#e98b2a;height:2px"></i>flat 1:3</span>`;
    drawTimeline(staff);
  }

  const CCOL = { PERSON_STOP: '#ef4b4b', MANUAL: '#b07cf0', OBSTACLE: '#e98b2a', GRADE_CHECK: '#f2d04b', TRUCK_SPOT: '#4fd1c1', HANDOFF: '#8fa3b5' };
  function drawTimeline(staff) {
    // pick the simulated shift with the median number of stops, and replay it with the selected crew
    // pick the simulated shift whose machine wait under this crew is the median, and replay it
    const order = st.sims.map((e, i) => [C.runQueue(e, staff, st.plan).reduce((a, b) => a + b.wait, 0), i]).sort((a, b) => a[0] - b[0]), ev = st.sims[order[order.length >> 1][1]];
    const trace = [], q = C.runQueue(ev, staff, st.plan, trace);
    const cv = $('timeline'), W = cv.clientWidth || 700, H = 250, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    const L = 104, R = W - 8, top = 6, rh = (H - 30) / st.plan.machines.length, x = (t) => L + (R - L) * t / C.SHIFT;
    g.font = "11px 'DejaVu Sans Mono', monospace"; g.textBaseline = 'middle';
    for (let b = 0; b <= C.NB; b++) { g.strokeStyle = '#16262c'; g.beginPath(); g.moveTo(x(b * C.BLOCK), top); g.lineTo(x(b * C.BLOCK), H - 22); g.stroke(); g.fillStyle = '#8a97a3'; g.textAlign = 'center'; g.fillText(hhmm(b * C.BLOCK), Math.min(R - 18, Math.max(L + 18, x(b * C.BLOCK))), H - 10); }
    st.plan.machines.forEach((m, i) => {
      const y = top + i * rh + rh / 2;
      g.fillStyle = '#4fd1c1'; g.textAlign = 'left'; g.fillText(m.id, 2, y);
      for (const s of m.segs) { g.fillStyle = '#1b2a33'; g.fillRect(x(s.s), y - rh * 0.32, x(s.e) - x(s.s), rh * 0.64); }
      for (const e of trace.filter((e) => e.m === m.id)) {
        if (e.start - e.t > 0.05) { g.fillStyle = '#ffffff'; g.globalAlpha = 0.85; g.fillRect(x(e.t), y - rh * 0.32, Math.max(1, x(e.start) - x(e.t)), rh * 0.64); g.globalAlpha = 1; }
        g.fillStyle = CCOL[e.c]; g.fillRect(x(e.start), y - rh * 0.32, Math.max(1.5, x(e.start + e.svc) - x(e.start)), rh * 0.64);
      }
    });
    const w = q.reduce((a, b) => a + b.wait, 0), sp = Math.max(...q.map((b) => b.safetyP95));
    $('tlSub').innerHTML = `median shift: <b>${ev.length}</b> stops &middot; <b>${w.toFixed(1)}</b> min wait &middot; <b>${q.filter((b) => b.ok).length}/${q.length}</b> blocks met`;
    $('tlLegend').innerHTML = C.CAUSES.map((c) => `<span><i style="background:${CCOL[c.id]}"></i>${c.id}</span>`).join('') + '<span><i style="background:#fff"></i>waiting for an operator</span>';
  }

  // ------------------------------------------------------------------ automation ranking
  function renderROI() {
    const lower = st.P.planner.map((k) => Math.max(1, k - 1));
    const meet = (evs) => { let ok = 0, n = 0; for (const ev of evs) { C.runQueue(ev, lower, st.plan).forEach((x) => { n++; if (x.ok) ok++; }); } return ok / n; };
    const base = meet(st.sims), r = C.mulberry(5);
    const rows = C.CAUSES.map((c) => ({ c, v: meet(st.sims.map((ev) => ev.filter((e) => e.c !== c.id || r() < 0.5))), n: st.cs[c.id].n, om: st.cs[c.id].opmin }));
    rows.sort((a, b) => b.v - a.v);
    const mostFreq = rows.slice().sort((a, b) => b.n - a.n)[0], mostTime = rows.slice().sort((a, b) => b.om - a.om)[0];
    st.roi = { base, rows, mostFreq, mostTime, lower };
    $('roi').innerHTML = `<div class="fine" style="margin-bottom:8px">If one stop type happened half as often, how likely is a crew of <b class="g">${lower.join('-')}</b> (one fewer operator) to still meet the service level? Today: <b class="g">${Math.round(100 * base)}%</b>.</div>` +
      rows.map((x, k) => `<div class="roi-row ${k === 0 ? 'best' : ''}"><div class="top"><span>${x.c.id}</span><span>${Math.round(100 * x.v)}%</span></div><div class="bar"><i style="width:${(100 * x.v).toFixed(1)}%"></i></div><div class="d">${x.n.toFixed(0)}/shift &middot; ${x.om.toFixed(0)} operator-min${x === mostFreq ? ' &middot; most frequent' : ''}${x === mostTime ? ' &middot; most operator time' : ''}</div></div>`).join('');
  }

  // ------------------------------------------------------------------ backtest
  async function runBacktest() {
    const test = st.test; $('btN').textContent = test.length;
    const plans = [];
    for (let k = 0; k < test.length; k++) { plans.push(C.planStaffing(C.forecast(st.model, test[k].plan, N_BT, 1000 + k), test[k].plan).staff); if (k % 4 === 3) await tick(); }
    const idx = (plan) => test.findIndex((s) => s.plan === plan);
    const res = { planner: C.backtest(test, (p) => plans[idx(p)]), flat: C.backtest(test, (p) => C.flatStaffing(p, 3)), erlang: C.backtest(test, (p) => C.erlangStaffing(st.model, p)) };
    st.bt = res;
    const row = (k, lab) => `<div class="r ${res[k].okRate < C.SLA.conf ? 'bad' : ''}"><span>${lab}:</span><span>${Math.round(100 * res[k].okRate)}% met</span></div><div class="r"><span>&nbsp;</span><span style="color:#c9d1d9;font-weight:400">${res[k].hoursPerShift.toFixed(1)} op-h/shift</span></div>`;
    $('btReadouts').innerHTML = row('planner', 'Crew Planner') + row('flat', 'Flat 1:3') + row('erlang', 'Erlang-C') +
      `<div class="hr"></div><div class="fine">${res.planner.blocks} two-hour blocks. Planner targets &ge; ${Math.round(100 * C.SLA.conf)}% per block; Erlang-C assumes stops arrive independently.</div>`;
    document.body.dataset.ready = '1';
  }

  boot();
})();
