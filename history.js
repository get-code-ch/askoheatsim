// Onglet Historique : températures, puissances et bilans sur plusieurs jours (temps simulé).
// Données : /api/history, un point par quart d'heure (moyennes) + bilans journaliers.
(() => {
  let H = null, days = 7, timer = null;
  const hover = {};                         // id du canevas -> abscisse survolée (px) ou undefined
  const STEP_H = 0.25;                      // un point = 15 min
  const kwh = w => w * STEP_H / 1000;       // puissance moyenne (W) sur un quart d'heure -> kWh
  const fmtK = v => fmt(v, v < 10 ? 2 : 1) + ' kWh';
  const tdate = s => new Date(s);           // "AAAA-MM-JJTHH:MM", heure simulée
  const dayLabel = d => d.toLocaleDateString('fr-CH', {weekday: 'short', day: '2-digit', month: '2-digit'});
  const timeLabel = d => dayLabel(d) + ' ' + d.toLocaleTimeString('fr-CH', {hour: '2-digit', minute: '2-digit'});
  const dot = c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px"></span>`;

  const TEMP = () => [
    {key: 'up', color: css('--series-1'), name: 'Haut'},
    {key: 'low', color: css('--series-2'), name: 'Bride'}];
  const POW = () => [
    {key: 'heater', color: css('--hot'), name: 'Corps de chauffe'},
    {key: 'pv', color: css('--series-3'), name: 'PV'},
    {key: 'house', color: css('--series-4'), name: 'Maison'},
    {key: 'grid', color: css('--series-5'), name: 'Réseau (+ soutirage, − injection)'}];
  const DAYS = () => [
    {key: 'pv', color: css('--series-3'), name: 'Depuis le PV'},
    {key: 'grid', color: css('--series-5'), name: 'Depuis le réseau'}];

  function legend(id, series, square) {
    $(id).innerHTML = series.map(s => `<span class="${square ? 'sw' : ''}" style="--c:${s.color}">${esc(s.name)}</span>`).join('');
  }

  // ---------------------------------------------------------------- données de la période
  function period() {
    const pts = H.points.map(p => ({...p, d: tdate(p.t), grid: p.imp - p.exp}));
    if (!pts.length) return {pts, dayRows: []};
    const end = pts[pts.length - 1].d;
    const start = new Date(end); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
    const sel = pts.filter(p => p.d >= start);
    const dayRows = H.days.filter(d => d.date >= localISO(start));
    return {pts: sel, dayRows, start, end};
  }
  const localISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---------------------------------------------------------------- chiffres clés
  function kpis(pts) {
    let heater = 0, heaterPv = 0, pv = 0, house = 0, imp = 0, exp = 0, tap = 0, tmin = Infinity, tmax = -Infinity;
    pts.forEach(p => {
      heater += kwh(p.heater); pv += kwh(p.pv); house += kwh(p.house); imp += kwh(p.imp); exp += kwh(p.exp);
      heaterPv += kwh(Math.min(p.heater, Math.max(0, p.pv - p.house)));
      tap += p.tap; tmin = Math.min(tmin, p.up); tmax = Math.max(tmax, p.up);
    });
    const share = heater > 0 ? Math.round(heaterPv / heater * 100) : 0;
    const k = (label, val, small = '') => `<div class="kpi"><span>${label}</span><b>${val}${small ? ` <small>${small}</small>` : ''}</b></div>`;
    $('h-kpis').innerHTML = !pts.length ? '<span class="muted">En attente de données…</span>' : [
      k('Corps de chauffe', fmtK(heater), heater > 0 ? `${share} % PV` : ''),
      k('Production PV', fmtK(pv)),
      k('Maison', fmtK(house)),
      k('Soutirage', fmtK(imp)),
      k('Injection', fmtK(exp)),
      k('Eau puisée', Math.round(tap).toLocaleString('fr-CH') + ' L'),
      k('Haut min – max', isFinite(tmin) ? `${fmt(tmin, 0)} – ${fmt(tmax, 0)} °C` : '–'),
    ].join('');
  }

  // ---------------------------------------------------------------- courbes
  function setupCanvas(cv) {
    if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height');
    const Hh = +cv.dataset.h, W = cv.clientWidth, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = Hh * dpr; cv.style.height = Hh + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, Hh);
    g.font = '11px system-ui, sans-serif';
    return {g, W, H: Hh};
  }

  function lineChart(id, tipId, pts, series, opt) {
    const cv = $(id), {g, W, H: Hh} = setupCanvas(cv);
    if (!W) return;
    const L = 52, R = 12, T = 8, B = 22, pw = W - L - R, ph = Hh - T - B;
    if (pts.length < 2) { g.fillStyle = css('--text-secondary'); g.fillText('En attente de données…', L, T + 20); return; }
    const x0 = pts[0].d.getTime(), x1 = pts[pts.length - 1].d.getTime();
    const X = d => L + (d.getTime() - x0) / (x1 - x0 || 1) * pw;
    let lo = Infinity, hi = -Infinity;
    pts.forEach(p => series.forEach(s => { lo = Math.min(lo, p[s.key]); hi = Math.max(hi, p[s.key]); }));
    ({lo, hi} = opt.range(lo, hi));
    const Y = v => T + ph - (v - lo) / (hi - lo) * ph;

    // nuits : 0 h - 6 h et 20 h - 24 h grisées légèrement, séparateurs de jours et dates
    const d0 = new Date(x0); d0.setHours(0, 0, 0, 0);
    g.textAlign = 'left'; g.textBaseline = 'top';
    for (let d = new Date(d0); d.getTime() <= x1; d.setDate(d.getDate() + 1)) {
      const mid = d.getTime();
      if (mid > x0) {
        const x = Math.round(L + (mid - x0) / (x1 - x0) * pw) + .5;
        g.strokeStyle = css('--border'); g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke();
      }
      const lx = Math.max(L, L + (mid - x0) / (x1 - x0) * pw);
      const nextX = L + (mid + 86400e3 - x0) / (x1 - x0) * pw;
      const lab = dayLabel(d), lw = g.measureText(lab).width;
      if (Math.min(nextX, L + pw) - lx > lw + 8) { g.fillStyle = css('--text-secondary'); g.fillText(lab, lx + 4, Hh - B + 6); }
    }
    // grille horizontale
    g.textAlign = 'right'; g.textBaseline = 'middle';
    niceTicks(lo, hi, opt.ticks || 4).forEach(v => {
      g.strokeStyle = v === 0 && opt.zero ? css('--text-secondary') : css('--grid'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, Math.round(Y(v)) + .5); g.lineTo(L + pw, Math.round(Y(v)) + .5); g.stroke();
      g.fillStyle = css('--text-secondary'); g.fillText(opt.tick(v), L - 6, Y(v));
    });
    // courbes (interrompues s'il manque des points, par exemple simulateur arrêté)
    series.forEach(s => {
      g.strokeStyle = s.color; g.lineWidth = opt.thin ? 1.5 : 2; g.lineJoin = 'round'; g.beginPath();
      pts.forEach((p, i) => {
        const gap = i > 0 && p.d - pts[i - 1].d > 20 * 60e3;
        if (i === 0 || gap) g.moveTo(X(p.d), Y(p[s.key])); else g.lineTo(X(p.d), Y(p[s.key]));
      });
      g.stroke();
    });
    // survol : réticule, points, infobulle
    const mx = hover[id];
    if (mx === undefined) { $(tipId).style.display = 'none'; return; }
    const t = x0 + (mx - L) / pw * (x1 - x0);
    let best = pts[0]; pts.forEach(p => { if (Math.abs(p.d - t) < Math.abs(best.d - t)) best = p; });
    const x = X(best.d);
    g.strokeStyle = css('--text-secondary'); g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x + .5, T); g.lineTo(x + .5, T + ph); g.stroke(); g.setLineDash([]);
    series.forEach(s => {
      g.fillStyle = s.color; g.strokeStyle = css('--surface-1'); g.lineWidth = 2;
      g.beginPath(); g.arc(x, Y(best[s.key]), 4, 0, 7); g.fill(); g.stroke();
    });
    const tip = $(tipId);
    tip.innerHTML = `<div class="muted">${timeLabel(best.d)}${best.partial ? ' (en cours)' : ''}</div>` +
      series.map(s => `<div>${dot(s.color)}${esc(s.name)} : <b>${opt.val(best[s.key])}</b></div>`).join('');
    tip.style.display = 'block';
    tip.style.left = (x + 12 + tip.offsetWidth > W ? Math.max(0, x - tip.offsetWidth - 12) : x + 12) + 'px';
    tip.style.top = '8px';
  }

  // ---------------------------------------------------------------- barres journalières (empilées)
  let barGeom = [];
  function dayBars(rows) {
    const id = 'h-days', cv = $(id), {g, W, H: Hh} = setupCanvas(cv);
    if (!W) return;
    const L = 46, R = 8, T = 8, B = 22, pw = W - L - R, ph = Hh - T - B;
    barGeom = [];
    if (!rows.length) { g.fillStyle = css('--text-secondary'); g.fillText('En attente de données…', L, T + 20); return; }
    const hi = Math.max(1, ...rows.map(r => r.heater_kwh));
    const tk = niceTicks(0, hi, 4), stepK = tk[1] - tk[0];
    const top = Math.ceil(hi / stepK) * stepK;
    const Y = v => T + ph - v / top * ph;
    g.textAlign = 'right'; g.textBaseline = 'middle';
    niceTicks(0, top, 4).forEach(v => {
      g.strokeStyle = v === 0 ? css('--text-secondary') : css('--grid'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, Math.round(Y(v)) + .5); g.lineTo(L + pw, Math.round(Y(v)) + .5); g.stroke();
      g.fillStyle = css('--text-secondary'); g.fillText(v.toLocaleString('fr-CH') + ' kWh', L - 6, Y(v));
    });
    const slot = pw / rows.length, bw = Math.min(42, slot * .6);
    const [sPv, sGrid] = DAYS();
    rows.forEach((r, i) => {
      const cx = L + slot * (i + .5), x = cx - bw / 2;
      const pv = r.heater_pv_kwh, grid = Math.max(0, r.heater_kwh - r.heater_pv_kwh);
      const today = i === rows.length - 1 && r.date === H.sim_now.slice(0, 10);
      g.globalAlpha = today ? .55 : 1;
      // segment bas (PV), puis segment haut (réseau) avec 2 px d'écart et extrémité arrondie
      const yPv = Y(pv), yAll = Y(pv + grid);
      if (pv > 0) { g.fillStyle = sPv.color; roundTop(g, x, yPv, bw, Y(0) - yPv, grid > 0 ? 0 : 4); g.fill(); }
      if (grid > 0) { g.fillStyle = sGrid.color; roundTop(g, x, yAll, bw, Math.max(0, yPv - yAll - (pv > 0 ? 2 : 0)), 4); g.fill(); }
      g.globalAlpha = 1;
      g.fillStyle = css('--text-secondary'); g.textAlign = 'center'; g.textBaseline = 'top';
      const d = new Date(r.date + 'T12:00');
      const lab = slot > 54 ? dayLabel(d) : d.toLocaleDateString('fr-CH', {day: '2-digit', month: '2-digit'});
      if (slot > 30 || i % 2 === 0) g.fillText(lab, cx, Hh - B + 6);
      barGeom.push({x0: cx - slot / 2, x1: cx + slot / 2, cx, r, pv, grid, today, y: yAll});
    });
    const mx = hover[id], tip = $('h-tip-days');
    const b = mx === undefined ? null : barGeom.find(b => mx >= b.x0 && mx < b.x1);
    if (!b) { tip.style.display = 'none'; return; }
    g.strokeStyle = css('--text-secondary'); g.lineWidth = 1;
    g.strokeRect(b.cx - bw / 2 - 2.5, b.y - 2.5, bw + 5, Y(0) - b.y + 3);
    const d = new Date(b.r.date + 'T12:00');
    tip.innerHTML = `<div class="muted">${dayLabel(d)}${b.today ? ' (en cours)' : ''}</div>` +
      `<div>${dot(sPv.color)}Depuis le PV : <b>${fmtK(b.pv)}</b></div>` +
      `<div>${dot(sGrid.color)}Depuis le réseau : <b>${fmtK(b.grid)}</b></div>` +
      `<div>Total : <b>${fmtK(b.r.heater_kwh)}</b></div>`;
    tip.style.display = 'block';
    tip.style.left = (b.cx + bw / 2 + 8 + tip.offsetWidth > W ? Math.max(0, b.cx - bw / 2 - tip.offsetWidth - 8) : b.cx + bw / 2 + 8) + 'px';
    tip.style.top = '8px';
  }
  function roundTop(g, x, y, w, h, r) {
    r = Math.min(r, h, w / 2); g.beginPath();
    g.moveTo(x, y + h); g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r); g.lineTo(x + w, y + h); g.closePath();
  }

  // ---------------------------------------------------------------- tableau (vue accessible)
  function table(rows) {
    const head = ['Jour', 'Eau puisée', 'Corps de chauffe', 'dont PV', 'PV', 'Maison', 'Soutirage', 'Injection'];
    $('h-table').innerHTML = `<thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
      rows.slice().reverse().map(r => {
        const today = r.date === H.sim_now.slice(0, 10);
        const share = r.heater_kwh > 0 ? Math.round(r.heater_pv_kwh / r.heater_kwh * 100) + ' %' : '–';
        return `<tr class="${today ? 'today' : ''}"><td>${dayLabel(new Date(r.date + 'T12:00'))}${today ? ' (en cours)' : ''}</td>` +
          `<td>${Math.round(r.tap_l)} L</td><td>${fmt(r.heater_kwh, 2)}</td><td>${share}</td><td>${fmt(r.pv_kwh, 2)}</td>` +
          `<td>${fmt(r.house_kwh, 2)}</td><td>${fmt(r.import_kwh, 2)}</td><td>${fmt(r.export_kwh, 2)}</td></tr>`;
      }).join('') + '</tbody>';
  }

  // ---------------------------------------------------------------- rendu et rafraîchissement
  function draw() {
    if (!H || $('tab-hist').hidden) return;
    const {pts, dayRows, start, end} = period();
    $('h-range').textContent = pts.length ? `du ${dayLabel(start)} au ${timeLabel(end)}` : '';
    kpis(pts);
    lineChart('h-temp', 'h-tip-temp', pts, TEMP(), {
      range: (lo, hi) => ({lo: Math.floor(lo / 5) * 5 - 2, hi: Math.ceil(hi / 5) * 5 + 2}),
      ticks: 6, tick: v => v.toLocaleString('fr-CH') + ' °C', val: v => fmt(v) + ' °C'});
    lineChart('h-pow', 'h-tip-pow', pts, POW(), {
      zero: true, thin: pts.length > 300,
      range: (lo, hi) => ({lo: Math.min(0, Math.floor(lo / 1000) * 1000), hi: Math.max(1000, Math.ceil(hi / 1000) * 1000)}),
      tick: v => (v / 1000).toLocaleString('fr-CH') + ' kW', val: v => fmtW(v)});
    dayBars(dayRows);
    table(dayRows);
  }
  async function load() {
    try { H = await (await fetch('/api/history')).json(); draw(); } catch (e) { /* réseau : on réessaie au prochain tour */ }
  }
  function start() { load(); clearInterval(timer); timer = setInterval(() => { if (!$('tab-hist').hidden) load(); }, 10000); }

  legend('h-leg-t', TEMP()); legend('h-leg-p', POW()); legend('h-leg-d', DAYS(), true);
  document.querySelectorAll('[data-hdays]').forEach(b => b.onclick = () => {
    days = +b.dataset.hdays;
    document.querySelectorAll('[data-hdays]').forEach(x => x.setAttribute('aria-selected', x === b));
    draw();
  });
  ['h-temp', 'h-pow', 'h-days'].forEach(id => {
    const cv = $(id);
    cv.addEventListener('pointermove', e => { hover[id] = e.clientX - cv.getBoundingClientRect().left; draw(); });
    cv.addEventListener('pointerdown', e => { hover[id] = e.clientX - cv.getBoundingClientRect().left; draw(); });
    cv.addEventListener('pointerleave', () => { hover[id] = undefined; draw(); });
  });
  window.addEventListener('resize', draw);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    legend('h-leg-t', TEMP()); legend('h-leg-p', POW()); legend('h-leg-d', DAYS(), true); draw();
  });
  document.addEventListener('tabshown', e => { if (e.detail === 'hist') start(); else clearInterval(timer); });
  if (location.hash === '#hist') start();
})();
