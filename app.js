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
  316: 'État (= 109 / 624)', 317: 'Puissance réelle, W (= 110)', 318: 'Commande étage (= 200)',
  319: 'Consigne, W (= 201)', 320: 'Injection, W (= 202)', 321: 'Mode secours (0/255)', 322: 'Contact PAC (0/255)',
  502: 'Entrées autorisées', 503: 'Arrêt après N min de chauffe', 504: 'Arrêt auto', 510: 'Temp. légionelles',
  595: 'Température minimale, °C', 626: 'Entrée qui pilote', 632: 'État des sondes', 639: 'Étage demandé par le 0-10 V'
};
// libellés courts pour la grille compacte (description complète au survol)
const REG_SHORT = {316: 'État', 317: 'Puissance W', 318: 'Étage', 319: 'Consigne W', 320: 'Injection W', 321: 'Secours',
  322: 'Contact PAC', 502: 'Entrées', 503: 'Arrêt min', 504: 'Arrêt auto', 510: 'Légio °C', 595: 'Temp. min °C',
  626: 'Entrée active', 632: 'Sondes', 639: 'Étage 0-10 V'};
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
  $('b-source').textContent = S.compensate ? 'piloté par HA' : 'autonome';
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === S.run_mode));
  renderLog();
  if ($('tab-sim').hidden) return;

  // Bandeau
  $('k-up').textContent = fmt(S.t_up) + ' °C';
  $('k-low').textContent = fmt(S.t_low) + ' °C';
  $('k-l40').innerHTML = S.litres_40 + '<small> L</small>';
  $('k-load').innerHTML = fmtW(S.load_w) + ` <small>ét. ${S.step}</small>`;
  $('k-pv').textContent = fmtKW(S.pv_w);
  $('k-house').textContent = fmtKW(S.house_w);
  $('k-grid').innerHTML = `<span class="${S.grid_w < 0 ? 'ok' : S.grid_w > 0 ? 'warn' : ''}">${S.grid_w > 0 ? '+' : ''}${fmtKW(S.grid_w)}</span>` +
    ` <small>${S.grid_w < 0 ? 'injection' : S.grid_w > 0 ? 'soutirage' : ''}</small>`;

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

  // Puisages du jour
  const nowHM = S.sim_now.slice(11, 16);
  $('sched').innerHTML = S.schedule.length ? '<thead><tr><th>Heure</th><th>Puisage</th><th class="num">min</th><th class="num">L à 40 °C</th></tr></thead>' +
    S.schedule.map(e => {
      const end = addMin(e.h, e.min);
      const cls = e.h <= nowHM && nowHM < end ? 'now' : end <= nowHM ? 'past' : '';
      return `<tr class="${cls}"><td>${e.h}</td><td>${esc(e.label)}</td><td class="num">${fmt(e.min)}</td><td class="num">${e.litres}</td></tr>`;
    }).join('') : '<tr><td class="muted">Aucun puisage prévu.</td></tr>';

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

  // Ligne d'information sous le bandeau
  $('g-note').textContent = S.compensate
    ? `Mode piloté : Home Assistant envoie la mesure de son compteur (320 / 202) et lit l'état en Modbus (${S.clients.length} client${S.clients.length > 1 ? 's' : ''}). PV, maison et réseau affichés ici sont simulés, pour information.`
    : 'Mode autonome : port Modbus fermé, aucun échange avec Home Assistant. Réseau = maison + corps de chauffe − PV, calculé par le simulateur.';
  $('g-loads').innerHTML = S.house_loads.length ? 'Appareils en marche : ' + S.house_loads.map(l => `<span class="pill">${esc(l)}</span>`).join('') : '';
  if (document.activeElement !== $('i-speed')) $('i-speed').value = String(S.speed);
  renderSettings();
  renderCharts();

}

// Registres et journal : onglet Échanges Modbus
function renderLog() {
  $('regs').innerHTML = Object.entries(S.registers).map(([a, v]) => {
    let shown = [319, 320].includes(+a) ? s16(v) : v, tip = REG_DESC[a] || '';
    if ([316, 502, 504, 626, 632].includes(+a)) {          // flags : hexadécimal, binaire au survol
      shown = '0x' + v.toString(16).toUpperCase().padStart([316, 502].includes(+a) ? 4 : 2, '0');
      tip += ' : ' + bin(v, [316, 502].includes(+a) ? 16 : 8);
    }
    return `<div title="${tip}"><span class="ra">${a}</span><span class="rd">${REG_SHORT[a] || REG_DESC[a] || ''}</span><code>${shown}</code></div>`;
  }).join('');
  $('events').innerHTML = S.events.map(e => `<div><span class="muted">${e.t}</span> <span class="src">${esc(e.src)}</span> ${esc(e.msg)}</div>`).join('');
}

function renderSettings() {
  // Mode de fonctionnement
  $('comp-explain').classList.toggle('off', !S.compensate);
  $('comp-explain').innerHTML = S.compensate
    ? `<b>Piloté par HA.</b> Home Assistant écrit dans le registre 320 (ou 202) la puissance mesurée par son compteur (gPlug, reçu en MQTT)
       et lit l'état du chauffe-eau en Modbus. Ce compteur ne voit pas le corps de chauffe simulé : le simulateur ajoute donc sa propre
       charge à la valeur reçue, sinon il croirait le surplus toujours disponible et monterait à 3,5 kW.
       <div class="note">Le simulateur ne fait que lire ce que HA lui envoie : les données réelles de consommation dans HA (compteur, tableau Énergie)
       ne sont jamais modifiées. À utiliser en temps réel (×1), HA écrivant toutes les 10 s réelles.</div>`
    : `<b>Autonome.</b> Le port Modbus est fermé : aucune donnée n'est échangée avec Home Assistant, dont les entités Askoheat passent
       « indisponible ». Le simulateur calcule lui-même la mesure au compteur (maison + corps de chauffe − production PV) à partir du profil du ménage.
       <div class="note">Fonctionne à toutes les vitesses (×1 à ×1440). Les commandes reçues de HA sont effacées au changement de mode.</div>`;
  $('speed-note').textContent = S.compensate && S.speed > 1
    ? '· En accéléré, HA écrit toutes les ' + fmt(10 * S.speed / 60, 0) + ' min simulées : passez en mode autonome pour une simulation fidèle.'
    : '';

  // Formulaires (sans écraser une saisie en cours)
  if ($('drawer').hidden) return;
  if (!dragging) {
    $('i-draw').value = S.draw_lpm; $('l-draw').textContent = S.draw_lpm;
    $('i-cold').value = S.t_cold; $('l-cold').textContent = S.t_cold;
    $('i-thermo').value = S.thermostat_max; $('l-thermo').textContent = S.thermostat_max;
    $('i-analog').value = S.analog_v; $('l-analog').textContent = fmt(S.analog_v);
  }
  $('l-astep').textContent = S.analog_step;
  if (document.activeElement !== $('i-start') && !$('i-start').dataset.dirty) $('i-start').value = S.sim_start;
  const H = S.household;
  document.querySelectorAll('[data-h]').forEach(el => {
    if (document.activeElement === el) return;
    const v = H[el.dataset.h];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  });
  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('sel', b.dataset.preset === H.preset));

  // Entrées
  $('b-hp').textContent = 'Contact PAC : ' + (S.hp_request ? 'fermé' : 'ouvert');
  $('b-emerg').textContent = S.emergency ? 'Annuler le secours' : 'Bouton secours (24 h)';
  [2, 3, 4, 5, 6, 7, 9].forEach(b => $('i502-' + b).checked = !!(S.input_setting & (1 << b)));
  $('i504-0').checked = !!(S.auto_off & 1);
  $('i504-1').checked = !!(S.auto_off & 2);
  $('v-mintemp').textContent = S.min_temp;

}

function renderCharts() {
  drawMain();
}
function addMin(hm, m) {
  const t = +hm.slice(0, 2) * 60 + +hm.slice(3) + Math.ceil(m);
  return String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

// ------------------------------------------------------------------ graphique combiné
// Deux zones sur un même canevas et un même axe du temps : températures en haut, puissances en bas.
const PANES = () => [
  {h: .5, unit: ' °C', series: [
    {key: 'up', color: css('--series-1'), name: 'Haut'},
    {key: 'low', color: css('--series-2'), name: 'Bride'}]},
  {h: .5, unit: ' W', power: true, series: [
    {key: 'w', color: css('--hot'), name: 'Corps de chauffe', stepped: true},
    {key: 'pv', color: css('--series-3'), name: 'PV'},
    {key: 'house', color: css('--series-4'), name: 'Maison'},
    {key: 'grid', color: css('--series-5'), name: 'Réseau'}]},
];
let chart = null, hoverX;
function drawMain() {
  const cv = $('ch-main');
  if (!cv.dataset.h) cv.dataset.h = cv.getAttribute('height');
  const H = +cv.dataset.h, W = cv.clientWidth, dpr = window.devicePixelRatio || 1;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  g.font = '11px system-ui, sans-serif';
  const data = S.history.filter(p => p.pv !== undefined);
  const L = 54, R = 66, T = 6, B = 20, GAP = 16, pw = W - L - R;
  if (data.length < 2) { g.fillStyle = css('--text-secondary'); g.fillText('En attente de données…', L, T + 20); chart = null; return; }
  const x0 = data[0].t, x1 = data[data.length - 1].t || x0 + 1e-6;
  const X = t => L + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * pw;
  const avail = H - T - B - GAP;
  let top = T;
  const panes = PANES().map(pn => {
    const ph = avail * pn.h, y0 = top;
    top += ph + GAP;
    let lo = Infinity, hi = -Infinity;
    data.forEach(p => pn.series.forEach(s => { lo = Math.min(lo, p[s.key]); hi = Math.max(hi, p[s.key]); }));
    if (pn.power) { lo = Math.min(0, Math.floor(lo / 1000) * 1000); hi = Math.max(3500, Math.ceil(hi / 1000) * 1000); }
    else { lo = Math.floor(lo / 5) * 5 - 2; hi = Math.ceil(hi / 5) * 5 + 2; }
    const Y = v => y0 + ph - (v - lo) / (hi - lo) * ph;
    // grille et graduations
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillStyle = css('--text-secondary');
    niceTicks(lo, hi, 3).forEach(v => {
      g.strokeStyle = v === 0 && pn.power ? css('--text-secondary') : css('--grid'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(L, Math.round(Y(v)) + .5); g.lineTo(L + pw, Math.round(Y(v)) + .5); g.stroke();
      g.fillText(pn.power ? (v / 1000).toLocaleString('fr-CH') + ' kW' : v.toLocaleString('fr-CH') + ' °C', L - 6, Y(v));
    });
    pn.series.forEach(s => {
      g.strokeStyle = s.color; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
      data.forEach((p, i) => {
        const x = X(p.t), y = Y(p[s.key]);
        if (i === 0) g.moveTo(x, y);
        else if (s.stepped) { g.lineTo(x, Y(data[i - 1][s.key])); g.lineTo(x, y); }
        else g.lineTo(x, y);
      });
      g.stroke();
    });
    // valeurs actuelles en bout de courbe, écartées de 13 px minimum
    const last = data[data.length - 1];
    const labs = pn.series.map(s => ({y: Y(last[s.key]), c: s.color, txt: pn.power ? fmtKW(last[s.key]) : fmt(last[s.key]) + ' °C'}))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < labs.length; i++) labs[i].y = Math.max(labs[i].y, labs[i - 1].y + 13);
    g.textAlign = 'left';
    labs.forEach(l => { g.fillStyle = l.c; g.fillText(l.txt, L + pw + 6, Math.min(l.y, y0 + ph)); });
    return {...pn, Y, y0, ph};
  });
  g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = css('--text-secondary');
  niceTicks(x0, x1, 6).forEach(t => { if (t >= x0 && t <= x1) g.fillText(fmtH(t), X(t), H - B + 6); });
  chart = {X, x0, x1, L, pw, panes, data, T, H, B};
  if (hoverX !== undefined) drawHover(hoverX);
}
const fmtKW = v => (v / 1000).toLocaleString('fr-CH', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' kW';
// heure simulée (h depuis le départ) -> heure du jour
function fmtH(t) {
  const d = new Date(new Date(S.sim_start).getTime() + t * 3600e3);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function niceTicks(a, b, n) {
  const span = b - a || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 5, 10].map(k => k * mag).find(s => s >= step0);
  const out = []; for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(+v.toFixed(6)); return out;
}
function drawHover(mx) {
  const c = chart; if (!c) return;
  const cv = $('ch-main'), g = cv.getContext('2d');
  const t = c.x0 + (mx - c.L) / c.pw * (c.x1 - c.x0);
  let best = c.data[0]; c.data.forEach(p => { if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p; });
  const x = c.X(best.t);
  g.strokeStyle = css('--text-secondary'); g.lineWidth = 1; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(x + .5, c.T); g.lineTo(x + .5, c.H - c.B); g.stroke(); g.setLineDash([]);
  c.panes.forEach(pn => pn.series.forEach(s => {
    g.fillStyle = s.color; g.strokeStyle = css('--surface-1'); g.lineWidth = 2;
    g.beginPath(); g.arc(x, pn.Y(best[s.key]), 4, 0, 7); g.fill(); g.stroke();
  }));
  const dot = c => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:6px"></span>`;
  const tip = $('tip-ch-main');
  tip.innerHTML = `<div class="muted">${fmtH(best.t)}</div>` + c.panes.map(pn => pn.series.map(s =>
    `<div>${dot(s.color)}${s.name} : <b>${pn.power ? fmtW(best[s.key]) : fmt(best[s.key]) + ' °C'}</b></div>`).join('')).join('');
  tip.style.display = 'block';
  tip.style.left = (x + 12 + tip.offsetWidth > cv.clientWidth ? x - tip.offsetWidth - 12 : x + 12) + 'px';
  tip.style.top = '8px';
}
$('ch-main').addEventListener('mousemove', e => { hoverX = e.clientX - $('ch-main').getBoundingClientRect().left; drawMain(); });
$('ch-main').addEventListener('mouseleave', () => { hoverX = undefined; $('tip-ch-main').style.display = 'none'; drawMain(); });

// ------------------------------------------------------------------ journée (onglets internes)
document.querySelectorAll('[data-jtab]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-jtab]').forEach(x => x.setAttribute('aria-selected', x === b));
  document.querySelectorAll('[data-jpane]').forEach(x => x.hidden = x.dataset.jpane !== b.dataset.jtab);
});

// ------------------------------------------------------------------ tiroir « Réglages »
function setDrawer(open) {
  $('drawer').hidden = !open;
  document.body.classList.toggle('drawer-open', open);
  $('b-drawer').setAttribute('aria-expanded', open);
  localStorage.setItem('askoheat-drawer', open ? '1' : '');
  render();
  setTimeout(render, 220);              // le contenu change de largeur : redessine le graphique
}
$('b-drawer').onclick = () => setDrawer($('drawer').hidden);
$('b-drawer-close').onclick = () => setDrawer(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('drawer').hidden) setDrawer(false); });
const dsecState = JSON.parse(localStorage.getItem('askoheat-dsec') || '{}');
document.querySelectorAll('.dsec').forEach(d => {
  if (d.dataset.dsec in dsecState) d.open = dsecState[d.dataset.dsec];
  d.addEventListener('toggle', () => { dsecState[d.dataset.dsec] = d.open; localStorage.setItem('askoheat-dsec', JSON.stringify(dsecState)); });
});
document.addEventListener('tabshown', e => { if (e.detail !== 'sim' && !$('drawer').hidden) { $('drawer').hidden = true; document.body.classList.remove('drawer-open'); } });

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
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (S && S.run_mode !== b.dataset.mode) post({mode: b.dataset.mode}); });
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
if (localStorage.getItem('askoheat-drawer') && innerWidth >= 1000 && (location.hash.slice(1) || 'sim') === 'sim') { $('drawer').hidden = false; document.body.classList.add('drawer-open'); }
poll();
