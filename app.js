// Onglet Simulation : état du simulateur, graphiques, profil du ménage.
const $ = id => document.getElementById(id);
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
let S = null, dragging = false;

async function post(d) {
  const r = await fetch('/api/control', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(d)});
  S = await r.json(); render();
}

// ------------------------------------------------------------------ onglets
const TABS = ['sim', 'trace', 'config'];
function showTab(name) {
  if (!TABS.includes(name)) name = 'sim';
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  TABS.forEach(t => $('tab-' + t).hidden = t !== name);
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  document.dispatchEvent(new CustomEvent('tabshown', {detail: name}));
  if (name === 'sim') render();
}
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

// Couleur de l'eau : bleu (10 °C) → rouge (70 °C)
function waterColor(t) {
  const x = Math.max(0, Math.min(1, (t - 10) / 60));
  const a = [59, 127, 217], b = [224, 74, 47];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * x)).join(',')})`;
}
const fmt = (v, d = 1) => (+v).toLocaleString('fr-CH', {minimumFractionDigits: d, maximumFractionDigits: d});
const fmtW = v => Math.round(v).toLocaleString('fr-CH') + ' W';

const REG_DESC = {
  100: 'Sonde 1 (haut), °C', 102: 'Sonde 2, °C', 108: 'Mode secours (0/255)', 109: 'Flags d\'état (= 624)',
  110: 'Puissance réelle, W', 200: 'Commande étage', 201: 'Consigne, W', 202: 'Injection, W',
  502: 'Entrées autorisées', 503: 'Arrêt après N min de chauffe', 504: 'Arrêt auto', 510: 'Temp. légionelles',
  595: 'Température minimale, °C', 626: 'Entrée qui pilote', 632: 'État des sondes', 639: 'Étage demandé par le 0-10 V'
};
const s16 = v => v & 0x8000 ? v - 0x10000 : v;
const bin = (v, n) => '0b' + v.toString(2).padStart(n, '0');

function simTime() {
  const d = new Date(S.sim_now);
  return d.toLocaleString('fr-CH', {weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
}

function render() {
  if (!S) return;
  $('b-port').textContent = S.modbus_port;
  $('b-clients').textContent = S.clients.length;
  $('b-time').textContent = simTime() + (S.speed !== 1 ? ` · ×${S.speed}` : '');
  $('b-source').textContent = S.compensate ? 'HA (compteur réel)' : 'simulée';
  if ($('tab-sim').hidden) return;

  // Chauffe-eau
  $('tk-up').setAttribute('fill', waterColor(S.t_up));
  $('tk-low').setAttribute('fill', waterColor(S.t_low));
  $('tk-up-t').textContent = fmt(S.t_up) + ' °C';
  $('tk-low-t').textContent = fmt(S.t_low) + ' °C';
  $('tap').setAttribute('stroke', S.tap_lpm > 0 ? waterColor(S.t_up) : css('--off'));
  S.relays.forEach((on, i) => {
    $('el-' + i).setAttribute('fill', on ? css('--hot') : css('--off'));
    $('r' + i).classList.toggle('on', on);
  });
  $('v-up').textContent = fmt(S.t_up) + ' °C';
  $('v-low').textContent = fmt(S.t_low) + ' °C';
  $('v-l40').textContent = S.litres_40 + ' L';
  $('v-kwh').textContent = fmt(S.energy_kwh, 2) + ' kWh';
  $('v-vol').textContent = S.tank_l + ' L';
  $('f-tap').textContent = fmt(S.tap_lpm);
  $('f-tank').textContent = fmt(S.tank_lpm);
  $('f-cold').innerHTML = S.tap_lpm <= 0 ? '—' : S.cold_tap ? '<span class="crit">froid</span>' : '<span class="ok">ok</span>';
  $('v-draws').innerHTML = S.draws.length ? 'En cours : ' + S.draws.map(d => `<span class="pill hot">${esc(d)}</span>`).join('') : '';

  // Bilan
  const t = S.today;
  $('today').innerHTML = t ? [
    ['Eau à 40 °C puisée', fmt(t.tap_l, 0) + ' L'], ['dont eau chaude du boiler', fmt(t.tank_l, 0) + ' L'],
    ['Corps de chauffe', fmt(t.heater_kwh, 2) + ' kWh'], ['… couverts par le PV', fmt(t.heater_pv_kwh, 2) + ' kWh'],
    ['Production PV', fmt(t.pv_kwh, 2) + ' kWh'], ['Maison', fmt(t.house_kwh, 2) + ' kWh'],
    ['Soutirage réseau', fmt(t.import_kwh, 2) + ' kWh'], ['Injection réseau', fmt(t.export_kwh, 2) + ' kWh'],
    ['Minutes sans eau à 40 °C', `<span class="${t.cold_min > 0 ? 'crit' : ''}">${fmt(t.cold_min, 0)}</span>`],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') : '<dt class="muted">en attente…</dt><dd></dd>';
  const past = S.days.slice(0, -1).slice(-5);
  $('days').innerHTML = past.length ? '<thead><tr><th>Jour</th><th class="num">L 40 °C</th><th class="num">Chauffe kWh</th><th class="num">dont PV</th><th class="num">Froid min</th></tr></thead>' +
    past.map(d => `<tr><td>${d.date.slice(8)}.${d.date.slice(5, 7)}</td><td class="num">${fmt(d.tap_l, 0)}</td><td class="num">${fmt(d.heater_kwh, 1)}</td><td class="num">${fmt(d.heater_pv_kwh, 1)}</td><td class="num">${fmt(d.cold_min, 0)}</td></tr>`).join('')
    : '<tr><td class="muted">Accélérez la simulation pour voir plusieurs jours.</td></tr>';

  // Pilotage
  $('v-load').innerHTML = S.load_w.toLocaleString('fr-CH') + '<small> W</small>';
  $('v-step').textContent = `Étage ${S.step}/7`;
  $('v-mode').textContent = S.mode;
  $('v-thermo').innerHTML = S.thermostat_cut
    ? '<span class="status warn">Thermostat ouvert</span>'
    : S.emergency ? `<span class="status crit">Secours, ${fmt(S.emergency_left_h)} h restantes</span>`
    : '<span class="status ok">Thermostat fermé</span>';
  $('steps').innerHTML = Array.from({length: 7}, (_, i) => `<div class="${i < S.step ? 'on' : ''}"></div>`).join('');
  if (S.watchdog_s === null) {
    $('v-wd').innerHTML = S.auto_off & 1 ? '<span class="muted">aucune commande</span>' : '<span class="status warn">désactivé</span>';
    $('wd-bar').style.width = '0%';
  } else {
    const cls = S.watchdog_s < 15 ? 'crit' : S.watchdog_s < 30 ? 'warn' : 'ok';
    $('v-wd').innerHTML = `<span class="status ${cls}">${fmt(S.watchdog_s, 0)} s</span>`;
    $('wd-bar').style.width = (S.watchdog_s / 60 * 100) + '%';
  }
  $('c-step').textContent = S.cmd.step;
  $('c-sp').textContent = S.cmd.setpoint + ' W';
  $('c-fi').textContent = S.cmd.feedin_active ? S.cmd.feedin + ' W' + (S.compensate ? '' : ' (simulée)') : '—';
  $('c-ha').innerHTML = S.cmd.ha_feedin === null ? '—'
    : S.cmd.ha_feedin + ' W' + (S.compensate ? '' : ' <span class="muted">ignorée</span>');

  // Compteur
  $('g-pv').textContent = fmtW(S.pv_w);
  $('g-house').textContent = fmtW(S.house_w);
  $('g-heat').textContent = fmtW(S.load_w);
  $('g-grid').textContent = (S.grid_w > 0 ? '+' : '') + fmtW(S.grid_w);
  $('g-note').textContent = S.compensate
    ? 'Valeurs simulées pour information : avec la case cochée, le pilotage utilise la mesure envoyée par Home Assistant.'
    : 'Cette mesure simulée remplace la valeur 202 de Home Assistant : la boucle est fermée dans le simulateur.';
  $('g-loads').innerHTML = S.house_loads.length ? 'Appareils en marche : ' + S.house_loads.map(l => `<span class="pill">${esc(l)}</span>`).join('') : '';

  // Registres
  $('regs').innerHTML = Object.entries(S.registers).map(([a, v]) => {
    let shown = [201, 202].includes(+a) ? s16(v) : v;
    if ([109, 502, 504, 626, 632].includes(+a)) shown = bin(v, [109, 502].includes(+a) ? 16 : 8);
    return `<tr><td>${a}</td><td class="muted">${REG_DESC[a] || ''}</td><td class="num"><code>${shown}</code></td></tr>`;
  }).join('');

  // Case de compensation
  const comp = $('i-comp');
  if (document.activeElement !== comp) comp.checked = S.compensate;
  $('comp-explain').classList.toggle('off', !S.compensate);
  $('comp-explain').innerHTML = S.compensate
    ? `<b>Cochée : mesure du compteur réel.</b> Home Assistant écrit dans le registre 202 la puissance mesurée par le gPlug (reçue en MQTT).
       Ce compteur ne voit pas le corps de chauffe simulé : le simulateur ajoute donc sa propre charge à la valeur reçue, comme si le compteur la voyait.
       Sans cela, il croirait le surplus toujours disponible et monterait à 3,5 kW.<div class="note">À utiliser en temps réel (×1) : Home Assistant écrit toutes les 10 s réelles.</div>`
    : `<b>Décochée : mesure simulée.</b> Les écritures de Home Assistant dans le registre 202 sont ignorées (visibles dans l'onglet Échanges Modbus).
       Le simulateur calcule lui-même la mesure au compteur : maison + corps de chauffe − production PV, à partir du profil du ménage.
       <div class="note">Fonctionne à toutes les vitesses. Les registres 200 et 201 écrits par HA restent pris en compte.</div>`;
  $('speed-note').textContent = S.compensate && S.speed > 1
    ? 'En accéléré avec la mesure de HA, 10 s réelles entre deux écritures représentent ' + fmt(10 * S.speed / 60, 0) + ' min simulées : la régulation suit mal. Décochez la case pour une boucle interne.'
    : 'La vitesse accélère le modèle thermique et l\'horloge du ménage. Le watchdog Modbus reste en temps réel, comme sur l\'appareil.';

  // Formulaires (sans écraser une saisie en cours)
  if (!dragging) {
    $('i-draw').value = S.draw_lpm; $('l-draw').textContent = S.draw_lpm;
    $('i-cold').value = S.t_cold; $('l-cold').textContent = S.t_cold;
    $('i-thermo').value = S.thermostat_max; $('l-thermo').textContent = S.thermostat_max;
    $('i-analog').value = S.analog_v; $('l-analog').textContent = fmt(S.analog_v);
  }
  $('l-astep').textContent = S.analog_step;
  if (document.activeElement !== $('i-speed')) $('i-speed').value = String(S.speed);
  if (document.activeElement !== $('i-start') && !$('i-start').dataset.dirty) $('i-start').value = S.sim_start;
  const H = S.household;
  document.querySelectorAll('[data-h]').forEach(el => {
    if (document.activeElement === el) return;
    const v = H[el.dataset.h];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  });
  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('sel', b.dataset.preset === H.preset));

  // Puisages du jour
  const nowHM = S.sim_now.slice(11, 16);
  $('sched').innerHTML = S.schedule.length ? '<thead><tr><th>Heure</th><th>Puisage</th><th class="num">min</th><th class="num">L à 40 °C</th></tr></thead>' +
    S.schedule.map(e => {
      const end = addMin(e.h, e.min);
      const cls = e.h <= nowHM && nowHM < end ? 'now' : end <= nowHM ? 'past' : '';
      return `<tr class="${cls}"><td>${e.h}</td><td>${esc(e.label)}</td><td class="num">${fmt(e.min)}</td><td class="num">${e.litres}</td></tr>`;
    }).join('') : '<tr><td class="muted">Aucun puisage prévu.</td></tr>';

  // Entrées
  $('b-hp').textContent = 'Contact PAC : ' + (S.hp_request ? 'fermé' : 'ouvert');
  $('b-emerg').textContent = S.emergency ? 'Annuler le secours' : 'Bouton secours (24 h)';
  [2, 3, 4, 5, 6, 7, 9].forEach(b => $('i502-' + b).checked = !!(S.input_setting & (1 << b)));
  $('i504-0').checked = !!(S.auto_off & 1);
  $('i504-1').checked = !!(S.auto_off & 2);
  $('v-mintemp').textContent = S.min_temp;

  $('events').innerHTML = S.events.map(e => `<div><span class="muted">${e.t}</span> <span class="src">${esc(e.src)}</span> ${esc(e.msg)}</div>`).join('');

  drawChart('ch-temp', [
    {key: 'up', color: css('--series-1'), name: 'Haut'},
    {key: 'low', color: css('--series-2'), name: 'Bride'}], ' °C', false);
  drawChart('ch-power', [
    {key: 'w', color: css('--series-2'), name: 'Corps de chauffe', stepped: true},
    {key: 'pv', color: css('--series-3'), name: 'PV'},
    {key: 'house', color: css('--series-4'), name: 'Maison'},
    {key: 'grid', color: css('--series-5'), name: 'Réseau'}], ' W', true);
}
function addMin(hm, m) {
  const t = +hm.slice(0, 2) * 60 + +hm.slice(3) + Math.ceil(m);
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// ------------------------------------------------------------------ graphiques
const charts = {};
function drawChart(id, series, unit, power) {
  const cv = $(id);
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height');
  const H = +cv.dataset.h;
  const W = cv.clientWidth, dpr = window.devicePixelRatio || 1;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const data = S.history.filter(p => p[series[0].key] !== undefined);
  const L = 50, R = 62, T = 8, B = 22, pw = W - L - R, ph = H - T - B;
  g.clearRect(0, 0, W, H);
  if (data.length < 2) { g.fillStyle = css('--text-secondary'); g.fillText('En attente de données…', L, T + 20); return; }
  const x0 = data[0].t, x1 = data[data.length - 1].t || x0 + 1e-6;
  let lo = Infinity, hi = -Infinity;
  data.forEach(p => series.forEach(s => { lo = Math.min(lo, p[s.key]); hi = Math.max(hi, p[s.key]); }));
  if (power) { lo = Math.min(0, Math.floor(lo / 1000) * 1000); hi = Math.max(3500, Math.ceil(hi / 1000) * 1000); }
  else { lo = Math.floor(lo / 5) * 5 - 5; hi = Math.ceil(hi / 5) * 5 + 5; }
  const X = t => L + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * pw;
  const Y = v => T + ph - (v - lo) / (hi - lo) * ph;
  g.strokeStyle = css('--grid'); g.lineWidth = 1; g.fillStyle = css('--text-secondary');
  g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
  niceTicks(lo, hi, 4).forEach(v => {
    g.strokeStyle = v === 0 && power ? css('--text-secondary') : css('--grid');
    g.beginPath(); g.moveTo(L, Y(v) + .5); g.lineTo(L + pw, Y(v) + .5); g.stroke();
    g.fillText(power ? (v / 1000).toLocaleString('fr-CH') + ' kW' : v.toLocaleString('fr-CH'), L - 6, Y(v));
  });
  g.textAlign = 'center'; g.textBaseline = 'top';
  niceTicks(x0, x1, 5).forEach(t => { if (t >= x0 && t <= x1) g.fillText(fmtH(t), X(t), T + ph + 6); });
  series.forEach(s => {
    g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
    data.forEach((p, i) => {
      const x = X(p.t), y = Y(p[s.key]);
      if (i === 0) g.moveTo(x, y);
      else if (s.stepped) { g.lineTo(x, Y(data[i - 1][s.key])); g.lineTo(x, y); }
      else g.lineTo(x, y);
    });
    g.stroke();
  });
  const last = data[data.length - 1];
  const labs = series.map(s => ({y: Y(last[s.key]), c: s.color, txt: power ? fmtKW(last[s.key]) : fmt(last[s.key]) + unit}))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 13);
  g.textAlign = 'left'; g.textBaseline = 'middle';
  labs.forEach(l => { g.fillStyle = power ? l.c : css('--text-primary'); g.fillText(l.txt, L + pw + 6, l.y); });
  const hv = charts[id] && charts[id].hover;
  charts[id] = {X, Y, x0, x1, L, pw, T, ph, series, unit, data, power, hover: hv};
  if (hv !== undefined) drawHover(id, hv);
}
const fmtKW = v => (v / 1000).toLocaleString('fr-CH', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' kW';
// heure simulée (h depuis le départ) -> heure du jour
function fmtH(t) {
  const start = new Date(S.sim_start);
  const d = new Date(start.getTime() + t * 3600e3);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function niceTicks(a, b, n) {
  const span = b - a || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 5, 10].map(k => k * mag).find(s => s >= step0);
  const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(6)); return out;
}
function drawHover(id, mx) {
  const c = charts[id]; if (!c || !c.data) return;
  const cv = $(id), g = cv.getContext('2d');
  const t = c.x0 + (mx - c.L) / c.pw * (c.x1 - c.x0);
  let best = c.data[0]; c.data.forEach(p => { if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; });
  const x = c.X(best.t);
  g.strokeStyle = css('--text-secondary'); g.lineWidth = 1; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(x + .5, c.T); g.lineTo(x + .5, c.T + c.ph); g.stroke(); g.setLineDash([]);
  c.series.forEach(s => { g.fillStyle = s.color; g.strokeStyle = css('--surface-1'); g.lineWidth = 2;
    g.beginPath(); g.arc(x, c.Y(best[s.key]), 4, 0, 7); g.fill(); g.stroke(); });
  const tip = $('tip-' + id);
  tip.innerHTML = `<div class="muted">${fmtH(best.t)}</div>` + c.series.map(s =>
    `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${s.color};margin-right:6px"></span>${s.name} : <b>${c.power ? fmtW(best[s.key]) : fmt(best[s.key]) + c.unit}</b></div>`).join('');
  tip.style.display = 'block';
  tip.style.left = Math.min(x + 12, cv.clientWidth - tip.offsetWidth - 4) + 'px'; tip.style.top = '8px';
}
['ch-temp', 'ch-power'].forEach(id => {
  const cv = $(id);
  cv.addEventListener('mousemove', e => { const r = cv.getBoundingClientRect(); charts[id] = charts[id] || {}; charts[id].hover = e.clientX - r.left; render(); });
  cv.addEventListener('mouseleave', () => { if (charts[id]) delete charts[id].hover; $('tip-' + id).style.display = 'none'; render(); });
});

// ------------------------------------------------------------------ contrôles
function slider(id, label, key) {
  const el = $(id);
  el.addEventListener('input', () => { dragging = true; $(label).textContent = el.value; });
  el.addEventListener('change', () => { dragging = false; post({[key]: +el.value}); });
}
slider('i-draw', 'l-draw', 'draw_lpm');
slider('i-cold', 'l-cold', 't_cold');
slider('i-thermo', 'l-thermo', 'thermostat_max');
slider('i-analog', 'l-analog', 'analog_v');
document.querySelectorAll('[data-draw]').forEach(b => b.onclick = () => post({draw_lpm: +b.dataset.draw}));
$('i-speed').onchange = e => post({speed: +e.target.value});
$('i-comp').onchange = e => post({compensate: e.target.checked});
$('i-start').oninput = () => $('i-start').dataset.dirty = '1';
$('b-start').onclick = () => { delete $('i-start').dataset.dirty; post({start: $('i-start').value}); };
$('b-reset').onclick = () => post({reset_temp: +$('i-reset').value});
$('b-emerg').onclick = () => post({emergency: !S.emergency});
$('b-hp').onclick = () => post({hp_request: !S.hp_request});
$('b-write').onclick = () => post({write: {[$('w-reg').value]: +$('w-val').value}});
document.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => post({household: {preset: b.dataset.preset}}));
document.querySelectorAll('[data-h]').forEach(el => el.addEventListener('change', () => {
  const k = el.dataset.h;
  const v = el.type === 'checkbox' ? el.checked : el.type === 'number' || k === 'evening_share' ? +el.value : el.value;
  post({household: {[k]: v}});
}));

async function poll() {
  try { const r = await fetch('/api/state'); S = await r.json(); render(); } catch (e) {}
  setTimeout(poll, 1000);
}
window.addEventListener('resize', render);
showTab(location.hash.slice(1) || 'sim');
poll();
