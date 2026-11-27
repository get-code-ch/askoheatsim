// Onglet Échanges Modbus : trames brutes entre les clients (Home Assistant) et le simulateur.
(() => {
  const MAX = 3000;
  let frames = [], last = 0, paused = false, selected = null, pending = 0;
  const known = new Set();

  // Trame hexadécimale : en-tête MBAP (7 octets) grisé, code fonction en gras. Les espaces entre
  // octets sont sécables : une longue réponse se replie dans la colonne.
  function hexHtml(hex) {
    if (!hex) return '';
    const b = hex.match(/../g);
    return `<span class="mbap">${b.slice(0, 7).join(' ')}</span> <span class="fc">${b[7] || ''}</span> ${b.slice(8).join(' ')}`;
  }

  // ------------------------------------------------------------ table des registres (doc Askoma v1.16)
  // type : u16, s16, f32 (2 mots), str (n mots), st624, st626, st632, step, b255, r502, r504
  const RM = {};
  const def = (a, name, type, unit = '', n = 1) => { RM[a] = {name, type, unit, n}; };
  def(0, 'numéro de série', 'str', '', 16); def(300, 'numéro de série', 'str', '', 16);
  [1, 2, 3, 4].forEach(i => def(98 + 2 * i, `sonde ${i}${i === 1 ? ' (haut)' : ''}`, 'u16', '°C'));
  def(108, 'mode secours', 'b255'); def(109, 'état', 'st624'); def(110, 'puissance', 'u16', 'W');
  def(200, 'étage commandé', 'step'); def(201, 'consigne', 's16', 'W'); def(202, 'injection', 's16', 'W');
  def(316, 'état', 'st624'); def(317, 'puissance', 'u16', 'W');
  def(318, 'étage commandé', 'step'); def(319, 'consigne', 's16', 'W'); def(320, 'injection', 's16', 'W');
  def(321, 'mode secours', 'b255'); def(322, 'contact PAC', 'b255');
  def(323, 'entrée 0-10 V', 'f32', 'V', 2);
  ['sonde 0 (bride)', 'sonde 1 (haut)', 'sonde 2', 'sonde 3', 'sonde 4'].forEach((n, i) => def(325 + 2 * i, n, 'f32', '°C', 2));
  def(335, 'réservé', 'f32', '', 2);
  def(502, 'entrées autorisées', 'r502'); def(503, 'arrêt après chauffe continue', 'u16', 'min');
  def(504, 'arrêt automatique', 'r504'); def(510, 'température légionelles', 'u16', '°C');
  def(595, 'température minimale', 'u16', '°C');
  def(624, 'état', 'st624'); def(625, 'puissance', 'u16', 'W'); def(626, 'entrée qui pilote', 'st626');
  def(631, 'erreurs', 'u16'); def(632, 'état des sondes', 'st632');
  [4, 3, 2, 1, 0].forEach((i, k) => def(634 + k, `sonde ${i}`, 'u16', '°C'));
  def(639, 'étage demandé par le 0-10 V', 'u16');
  [4, 3, 2, 1, 0].forEach((i, k) => def(706 + 2 * k, `sonde ${i}`, 'f32', '°C', 2));
  def(716, 'entrée 0-10 V', 'f32', 'V', 2);

  const s16v = v => v & 0x8000 ? v - 0x10000 : v;
  const h4 = v => v.toString(16).padStart(4, '0');
  const nf = (v, d) => v.toLocaleString('fr-CH', {minimumFractionDigits: d, maximumFractionDigits: d});
  const f32 = (hi, lo) => { const b = new DataView(new ArrayBuffer(4)); b.setUint16(0, hi); b.setUint16(2, lo); return b.getFloat32(0); };
  const bits = (v, names) => names.map((n, i) => n && v & (1 << i) ? n : null).filter(Boolean);

  function flags624(v) {
    const r = bits(v, ['R1', 'R2', 'R3']);
    const lo = bits(v, [null, null, null, 'pompe', 'carte relais', 'courant', 'contact PAC', 'secours']);
    const hi = bits(v >> 8, ['légionelles', '0-10 V actif', 'consigne active', 'injection active', 'arrêt auto',
                              'post-circulation', 'limite de température', 'erreur']);
    return (r.length ? 'résistances ' + r.join('+') + ` (${((v & 7) * 500)} W)` : 'résistances coupées') +
      (lo.length || hi.length ? ' · ' + [...lo, ...hi].join(', ') : '');
  }
  function interpret(d, w) {
    const v = w[0];
    switch (d.type) {
      case 's16': {
        const x = s16v(v);
        if (d.name === 'injection') return `${nf(x, 0)} W ` + (x < 0 ? '(surplus injecté)' : x > 0 ? '(soutirage : arrêt)' : '');
        return `${nf(x, 0)} ${d.unit}`;
      }
      case 'u16': return `${nf(v, 0)} ${d.unit}`.trim();
      case 'f32': return w.length < 2 ? 'mot incomplet' : `${nf(f32(w[0], w[1]), d.unit === '°C' ? 1 : 2)} ${d.unit}`.trim();
      case 'str': return '« ' + w.map(x => String.fromCharCode(x >> 8, x & 255)).join('').replace(/\0.*$/s, '') + ' »';
      case 'b255': return v === 255 ? 'actif' : v === 0 ? 'inactif' : String(v);
      case 'step': return `étage ${v & 7} (${(v & 7) * 500} W)` + (v & 7 ? ' · ' + bits(v, ['R1', 'R2', 'R3']).join('+') : '');
      case 'st624': return flags624(v);
      case 'st626': return bits(v, ['température minimale', 'heures creuses', 'étage (200)', 'entrée 0-10 V', 'contact PAC',
                                    'secours', 'injection (202)', 'consigne (201)']).join(', ') || 'aucune';
      case 'st632': return `sondes ${bits(v, ['0', '1', '2', '3', '4']).join(', ') || 'aucune'}` + (v & 64 ? ' · limite atteinte' : '');
      case 'r502': return bits(v, [null, null, 'injection', 'consigne', 'étage', '0-10 V', 'contact PAC', 'secours',
                                   'heures creuses', 'temp. minimale', 'SMA SEMP', 'SENEC']).join(', ') || 'aucune';
      case 'r504': return bits(v, ['arrêt après 60 s', 'reprise auto', null, null, 'Modbus', '0-10 V', 'contact PAC', 'secours']).join(', ') || 'désactivé';
    }
    return String(v);
  }
  // Découpe une suite de registres en champs lisibles
  function fields(addr, values) {
    const out = [];
    for (let i = 0; i < values.length;) {
      const a = addr + i, d = RM[a];
      if (!d) {                               // registre sans définition : regroupe les suivants
        let j = i; while (j < values.length && !RM[addr + j]) j++;
        out.push({a: j - i > 1 ? `${a}-${addr + j - 1}` : `${a}`, name: 'non décrit', text: values.slice(i, j).every(x => !x) ? '0' : values.slice(i, j).join(', '),
                  hex: values.slice(i, j).map(h4).join(' '), dim: true});
        i = j; continue;
      }
      const n = Math.min(d.n, values.length - i);
      const w = values.slice(i, i + n);
      out.push({a: n > 1 ? `${a}-${a + n - 1}` : `${a}`, name: d.name, text: interpret(d, w), hex: w.map(h4).join(' ')});
      i += n;
    }
    return out;
  }

  function decodeHtml(f) {
    let s = `<div>${esc(f.desc)}${f.note ? ` <span class="ign">${esc(f.note)}</span>` : ''}</div>`;
    if (!f.values || f.addr === null) return s;
    const fl = fields(f.addr, f.values);
    const line = x => `<div class="fld${x.dim ? ' dim' : ''}"><span class="fa">${x.a}</span> <span class="fn">${esc(x.name)}</span> <b>${esc(x.text)}</b> <span class="fh">${x.hex.length > 24 ? x.hex.slice(0, 19) + ' …' : x.hex}</span></div>`;
    if (fl.length <= 4) return s + fl.map(line).join('');
    return s + fl.slice(0, 3).map(line).join('') +
      `<details><summary>${fl.length - 3} autres champs</summary>${fl.slice(3).map(line).join('')}</details>`;
  }
  function valuesText(f) {
    if (!f.values || f.addr === null) return '';
    return ' → ' + fields(f.addr, f.values).map(x => `${x.a} ${x.name} = ${x.text}`).join(' ; ');
  }

  function signature(f) { return [f.client, f.fc, f.addr, f.count, (f.values || []).join(',')].join('|'); }

  function visible() {
    const client = $('t-client').value, addr = $('t-addr').value.trim();
    const show = {read: $('t-reads').checked, write: $('t-writes').checked, exc: $('t-exc').checked, web: $('t-web').checked};
    const rows = [];
    for (const f of frames) {
      if (!show[f.kind]) continue;
      if (client && f.client !== client) continue;
      if (addr && !(f.addr !== null && +addr >= f.addr && +addr < f.addr + (f.count || 1))) continue;
      const prev = rows[rows.length - 1];
      if ($('t-group').checked && f.kind === 'read' && prev && prev.f.kind === 'read' && signature(prev.f) === signature(f)) {
        prev.rep++; prev.f = f; continue;
      }
      rows.push({f, rep: 1});
    }
    return rows;
  }

  function render() {
    if ($('tab-trace').hidden) return;
    const wrap = $('t-wrap');
    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 40;
    const rows = visible();
    $('t-body').innerHTML = rows.slice(-800).map(({f, rep}) => {
      const cls = [f.kind, f.seq === selected ? 'sel' : ''].join(' ');
      const hex = f.kind === 'web' ? '<span class="muted">(pas de trame : commande de l\'interface)</span>'
        : `<span class="hex rx"><span class="arrow">▶</span>${hexHtml(f.req)}</span><span class="hex tx"><span class="arrow">◀</span>${hexHtml(f.resp)}</span>`;
      return `<tr class="${cls}" data-seq="${f.seq}"><td>${f.t}${rep > 1 ? `<div class="rep">×${rep} identiques</div>` : ''}</td>` +
        `<td>${esc(f.client)}${f.tid !== undefined ? `<div class="rep">tid ${f.tid}</div>` : ''}</td><td class="hx">${hex}</td><td class="dec">${decodeHtml(f)}</td></tr>`;
    }).join('') || '<tr><td colspan="4" class="muted" style="padding:16px">Aucun échange pour l\'instant. Les requêtes de Home Assistant apparaîtront ici dès qu\'il se connecte au port Modbus.</td></tr>';
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;
    $('t-stats').textContent = `${frames.length} transactions` + (paused && pending ? ` · ${pending} en attente` : '');
  }

  function detail(f) {
    if (!f) return;
    const lines = [];
    const part = (label, hex) => {
      if (!hex) return;
      const b = hex.match(/../g);
      const tid = parseInt(b[0] + b[1], 16), pid = parseInt(b[2] + b[3], 16), len = parseInt(b[4] + b[5], 16), unit = parseInt(b[6], 16);
      lines.push(`${label}`);
      lines.push(`  MBAP  transaction=${tid}  protocole=${pid}  longueur=${len}  unité=${unit}`);
      lines.push(`  PDU   ${b.slice(7).join(' ')}`);
      const fc = parseInt(b[7], 16);
      if (fc & 0x80) lines.push(`        fonction ${fc & 0x7f} en erreur, code d'exception ${parseInt(b[8], 16)}`);
    };
    part('▶ Requête (HA → simulateur)', f.req);
    part('◀ Réponse (simulateur → HA)', f.resp);
    if (f.values && f.addr !== null) {
      lines.push('Registres (adresse, mots hexadécimaux, interprétation) :');
      fields(f.addr, f.values).forEach(x =>
        lines.push(`  ${x.a.padEnd(8)} ${x.hex.padEnd(20)} ${x.name} : ${x.text}`));
    }
    if (f.note) lines.push('Remarque : ' + f.note);
    $('t-detail').textContent = lines.join('\n') || f.desc;
  }

  async function poll() {
    try {
      const r = await fetch('/api/frames?after=' + last);
      const d = await r.json();
      if (d.last < last) { frames = []; }        // simulateur redémarré
      last = d.last;
      if (d.frames.length) {
        if (paused) pending += d.frames.length;
        frames.push(...d.frames);
        if (frames.length > MAX) frames = frames.slice(-MAX);
        d.frames.forEach(f => {
          if (f.client && !known.has(f.client)) {
            known.add(f.client);
            $('t-client').insertAdjacentHTML('beforeend', `<option>${esc(f.client)}</option>`);
          }
        });
        $('tab-count').textContent = `(${frames.length})`;
        if (!paused) render();
      }
    } catch (e) {}
    setTimeout(poll, 1000);
  }

  ['t-client', 't-reads', 't-writes', 't-exc', 't-web', 't-group'].forEach(id => $(id).onchange = render);
  $('t-addr').oninput = render;
  $('t-pause').onclick = () => {
    paused = !paused; pending = 0;
    $('t-pause').textContent = paused ? 'Reprendre' : 'Pause';
    $('t-pause').classList.toggle('sel', paused);
    render();
  };
  $('t-clear').onclick = () => { frames = []; selected = null; $('tab-count').textContent = ''; render(); };
  $('t-export').onclick = () => {
    const txt = frames.map(f => [f.t, f.client, f.req ? '> ' + f.req : '', f.resp ? '< ' + f.resp : '', f.desc + valuesText(f), f.note || '']
      .filter(Boolean).join('  ')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], {type: 'text/plain'}));
    a.download = 'askoheat-modbus-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('t-body').onclick = e => {
    const tr = e.target.closest('tr[data-seq]');
    if (!tr) return;
    selected = +tr.dataset.seq;
    detail(frames.find(f => f.seq === selected));
    render();
  };
  document.addEventListener('tabshown', e => { if (e.detail === 'trace') { render(); $('t-wrap').scrollTop = $('t-wrap').scrollHeight; } });
  poll();
})();
