// Onglet Échanges Modbus : trames brutes entre les clients (Home Assistant) et le simulateur.
(() => {
  const MAX = 3000;
  let frames = [], last = 0, paused = false, selected = null, pending = 0;
  const known = new Set();

  const REG_NAMES = {
    100: 'sonde 1 (haut)', 102: 'sonde 2', 108: 'secours', 109: 'état', 110: 'puissance',
    200: 'étage', 201: 'consigne', 202: 'injection', 318: 'étage (EMA)', 319: 'consigne (EMA)', 320: 'injection (EMA)',
    502: 'entrées autorisées', 503: 'arrêt après N min', 504: 'arrêt auto', 510: 'légionelles', 595: 'temp. minimale',
    624: 'état', 625: 'puissance', 626: 'entrée qui pilote', 632: 'état sondes', 639: 'étage 0-10 V'
  };
  const SIGNED = new Set([201, 202, 319, 320]);

  // Trame hexadécimale : en-tête MBAP (7 octets) grisé, code fonction en gras
  function hexHtml(hex) {
    if (!hex) return '';
    const b = hex.match(/../g);
    const sp = a => a.join(' ');
    return `<span class="mbap">${sp(b.slice(0, 7))}</span> <span class="fc">${b[7] || ''}</span> ${sp(b.slice(8))}`;
  }

  function valuesText(f) {
    if (!f.values || f.addr === null) return '';
    if (f.values.length > 6) return ` → ${f.values.length} valeurs`;
    return ' → ' + f.values.map((v, i) => {
      const a = f.addr + i;
      return SIGNED.has(a) ? (v & 0x8000 ? v - 0x10000 : v) : v;
    }).join(', ');
  }

  function decodeHtml(f) {
    const name = f.addr !== null && REG_NAMES[f.addr] ? ` <span class="muted">(${REG_NAMES[f.addr]})</span>` : '';
    let s = esc(f.desc) + name;
    if (f.kind === 'read') s += esc(valuesText(f));
    if (f.note) s += ` <span class="ign">${esc(f.note)}</span>`;
    return s;
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
        `<td>${esc(f.client)}${f.tid !== undefined ? `<div class="rep">tid ${f.tid}</div>` : ''}</td><td>${hex}</td><td class="dec">${decodeHtml(f)}</td></tr>`;
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
      lines.push('Registres :');
      f.values.forEach((v, i) => {
        const a = f.addr + i;
        const sv = SIGNED.has(a) && v & 0x8000 ? v - 0x10000 : v;
        lines.push(`  ${String(a).padStart(4)}  0x${v.toString(16).padStart(4, '0')}  ${String(sv).padStart(6)}  ${REG_NAMES[a] || ''}`);
      });
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
