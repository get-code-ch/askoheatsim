// Onglet Configuration Home Assistant : voies de pilotage de l'ASKOHEAT+ 2.0, avantages /
// inconvénients, et générateur de package HA. Sources : table Modbus Askoma v1.16 (13.05.2024).
(() => {
  const OPTIONS = [
    {
      id: 'feedin', title: 'Modbus · registre 320 « injection » (Power to Heat)', tag: 'recommandé avec un compteur', tagCls: 'ok',
      short: 'HA transmet la mesure du compteur, l\'appareil régule seul.',
      how: `Home Assistant recopie toutes les 10 s la puissance mesurée au compteur (négative = injection) dans le registre 320
            du bloc gestionnaire d'énergie (identique au 202). L'ASKOHEAT+ choisit lui-même l'étage pour consommer le surplus. Bit 2 du registre 502.`,
      pros: [
        'Une seule automation dans HA : elle transmet la mesure, la régulation est dans l\'appareil',
        'Réagit à chaque écriture, sans boucle de régulation à mettre au point',
        'Valeur positive = soutirage : l\'appareil s\'arrête de lui-même',
        'Retour d\'état complet par la même liaison (températures, puissance, entrée active)',
        'Sécurité : sans écriture pendant 60 s, les commandes 318-320 (et 200-202) sont effacées (504 bit 0)',
      ],
      cons: [
        'Pas de réserve, de priorité ni d\'horaire côté HA : l\'appareil prend tout le surplus disponible',
        'Paliers de 500 W : jusqu\'à ~499 W de surplus restent injectés',
        'Si d\'autres charges pilotables (voiture, batterie) visent le même surplus, elles se le disputent',
        'Dépend de HA, du réseau et du compteur : panne = plus de chauffe solaire (mais arrêt sûr)',
        'Disponible depuis le firmware 4.2.1',
      ],
      regs: '320 = 202 (int16, −30000…30000 W, fonction 6) · lecture 316 état, 317 puissance, 325-334 sondes · 502 bit 2 · 504 bit 0/1 · 539 délai · 597 limite de température',
    },
    {
      id: 'setpoint', title: 'Modbus · registre 319 « consigne de puissance »', tag: 'le plus de contrôle', tagCls: 'warn',
      short: 'HA calcule la puissance à donner, avec réserve et priorités.',
      how: `Home Assistant calcule la puissance à donner au corps de chauffe (surplus − réserve) et l'écrit en W dans le registre 319
            (identique au 201). L'appareil prend l'étage inférieur ou égal à la consigne. Bit 3 du registre 502.`,
      pros: [
        'Réserve d\'injection, puissance minimale, horaires et priorités réglables dans HA',
        'Se coordonne avec les autres charges (voiture, batterie, pompe à chaleur)',
        'Même retour d\'état et même sécurité watchdog que le 320',
        'La consigne peut venir d\'autre chose que du PV (tarif, prévision météo, prix dynamique)',
      ],
      cons: [
        'La régulation (consigne = puissance actuelle − mesure au compteur − réserve) est à écrire et à maintenir dans HA',
        'Consigne minimale de 250 W (doc Askoma) ; paliers de 500 W',
        'Boucle plus lente : HA lit la puissance, calcule, puis écrit',
      ],
      regs: '319 = 201 (int16, 250…30000 W, fonction 6) · 502 bit 3 · 504 bit 0/1 · 597 limite de température',
    },
    {
      id: 'step', title: 'Modbus · registre 318 « étage »', tag: 'manuel / scénarios', tagCls: '',
      short: 'HA impose l\'étage : tests, bouton « boost », scénarios.',
      how: `Home Assistant impose directement l'étage 0 à 7 dans le registre 318 (identique au 200 ; bits 0-2 = résistances 1 à 3). Bit 4 du registre 502.`,
      pros: [
        'Contrôle total et prévisible : idéal pour les tests, un bouton « boost » ou un scénario horaire',
        'Indépendant de toute mesure de compteur',
      ],
      cons: [
        'Aucune régulation automatique sur le surplus',
        'L\'étage doit être réécrit au moins toutes les 60 s si le watchdog est actif',
        'Une entrée 0-10 V active a la priorité sur le registre 318 / 200',
      ],
      regs: '318 = 200 (bits 0-2, fonction 6) · 502 bit 4 · 596 limite de température',
    },
    {
      id: 'analog', title: 'Entrée 0-10 V (par ex. Shelly Pro Dimmer 0/1-10V)', tag: 'sans Modbus pour piloter', tagCls: '',
      short: 'Un module 0-10 V commandé par HA fournit la consigne en tension.',
      how: `Un module 0-10 V (Shelly) commandé par HA fournit une tension à l'entrée analogique de l'ASKOHEAT+.
            L'appareil traduit la tension en étage avec 8 seuils réglables (registres 556-589). Bit 5 du registre 502.
            HA règle la luminosité du Shelly comme une consigne de puissance.`,
      pros: [
        'Câblage simple et robuste, sans dépendre du protocole Modbus pour piloter',
        'Le Shelly reste pilotable seul (application, scènes) si HA est arrêté',
        'Seuils et étages réglables dans l\'appareil ; limite de température dédiée',
        'Combinable : piloter en 0-10 V et lire les températures en Modbus',
      ],
      cons: [
        'Matériel et câblage en plus (électricien), à faire valider pour l\'entrée de l\'appareil',
        'Résolution identique (7 étages) ; seuils à caler sur la sortie du Shelly',
        'Pas de watchdog réseau : si HA s\'arrête, le Shelly garde sa dernière valeur (le thermostat reste la sécurité)',
        'Pas de retour d\'état sans Modbus en plus',
        'Dans ce simulateur, l\'entrée 0-10 V est un curseur : HA ne peut pas la commander',
      ],
      regs: '502 bit 5 · seuils 556-589 · lecture 323-324 tension mesurée (float32), 316 état · 504 bit 5',
    },
  ];

  const AUTONOMOUS = [
    ['Température minimale', '502 octet haut bit 1 · 595', 'L\'appareil maintient une température plancher, même sans PV (énergie du réseau). Confort garanti, mais consommation hors surplus.'],
    ['Heures creuses', '502 octet haut bit 0 · 552-555 · 598', 'Chauffe pendant une plage horaire (tarif bas), jusqu\'à une limite de température propre.'],
    ['Anti-légionelles', '509-515 · 510', 'Montée périodique à 50-65 °C, en préférant l\'énergie injectée (509 bit 14) ou en attendant le PV des jours suivants.'],
    ['Contact « Heatpump Request » / SG-Ready', '502 bit 6 · 590-591 · 599', 'Un contact sec (onduleur, pompe à chaleur, gestionnaire d\'énergie) impose un étage. Fonctionne sans réseau.'],
    ['Bouton secours', '502 bit 7 · 592 · 503', 'Pleine puissance pendant la durée du registre 503 si la production principale est en panne.'],
    ['Limite de chauffe continue', '503 (2-10080 min) · 504 bits 4-7', 'Arrêt après N minutes de chauffe continue, par source de commande.'],
    ['Gestionnaires d\'énergie intégrés', '502 octet haut bits 2-3', 'SMA SEMP (Sunny Home Manager) et SENEC.Home : l\'appareil se pilote sans HA.'],
  ];

  const MATRIX = [
    ['Registre écrit', '320', '319', '318', 'aucun (Shelly)'],
    ['Logique dans HA', 'minimale', 'régulation', 'scénarios', 'régulation'],
    ['Réserve / priorités', 'non', 'oui', 'manuel', 'oui'],
    ['Matériel en plus', 'non', 'non', 'non', 'module 0-10 V'],
    ['Si HA s\'arrête', 'arrêt en 60 s', 'arrêt en 60 s', 'arrêt en 60 s', 'garde la dernière valeur'],
    ['Retour d\'état', 'Modbus', 'Modbus', 'Modbus', 'Modbus en option'],
    ['Simulable ici', 'oui', 'oui', 'oui', 'curseur seulement'],
  ];

  const DEFAULTS = {
    mode: 'feedin', target: 'real', host: 'askoheat.local', simhost: 'askoheatsim.askoheatsim.svc.cluster.local',
    meter: 'two', imp: 'sensor.gplug_puissance_soutiree', exp: 'sensor.gplug_puissance_injectee',
    signed: 'sensor.puissance_reseau', unit: 'W', interval: 10, watchdog: true, restart: true,
    writecfg: true, offmin: 1440, mintemp: false, mintempv: 45, hp: true, emerg: true,
    reserve: 100, minimum: 500, light: 'light.chauffe_eau',
  };
  let C = {...DEFAULTS, ...JSON.parse(localStorage.getItem('askoheat-cfg') || '{}')};
  let openedFor = null;

  function guideHtml() {
    const opt = o => `<details class="opt" id="opt-${o.id}">
      <summary><span class="t">${o.title}</span> ${o.tag ? `<span class="tag ${o.tagCls}">${o.tag}</span>` : ''}<span class="s">${o.short}</span></summary>
      <div class="body">
      <div>${o.how}</div>
      <div class="pc">
        <div><h4 class="ok">Avantages</h4><ul>${o.pros.map(p => `<li>${p}</li>`).join('')}</ul></div>
        <div><h4 class="crit">Inconvénients</h4><ul>${o.cons.map(p => `<li>${p}</li>`).join('')}</ul></div>
      </div>
      <div class="regs-line">Registres : ${o.regs}</div>
      <div style="margin-top:8px"><button data-use="${o.id}">Choisir cette voie</button></div>
      </div>
    </details>`;
    return `<section class="card">
      <h2>Piloter l'ASKOHEAT+ 2.0 depuis Home Assistant</h2>
      <p style="margin-top:0">L'appareil accepte plusieurs entrées de commande, activées bit par bit dans le registre <code>502</code>.
      Quatre voies se prêtent à Home Assistant. Elles peuvent coexister ; quand plusieurs sont actives, l'appareil applique sa propre priorité
      (la documentation précise seulement que secours et contact PAC passent avant le registre 200, et que le 0-10 V l'emporte sur le 200).
      Le générateur utilise le <b>bloc gestionnaire d'énergie 300-336</b> : état, puissance, températures et commandes au même endroit,
      les registres 318-320 étant identiques à 200-202. Cliquez une voie pour voir le détail ; celle choisie dans le générateur s'ouvre seule.</p>
      <table class="matrix"><thead><tr><th></th><th>Injection</th><th>Consigne</th><th>Étage</th><th>0-10 V</th></tr></thead>
      <tbody>${MATRIX.map(r => `<tr><th>${r[0]}</th>${r.slice(1).map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>
    </section>
    <div style="margin-top:16px">${OPTIONS.map(opt).join('')}</div>
    <details class="opt">
      <summary><span class="t">Fonctions autonomes de l'appareil</span><span class="s">Température minimale, heures creuses, légionelles, contact PAC, secours, SMA SEMP…</span></summary>
      <div class="body">
      <p style="margin-top:0">Elles fonctionnent sans Home Assistant et se combinent avec les voies ci-dessus.</p>
      <table><thead><tr><th>Fonction</th><th>Registres</th><th>Effet</th></tr></thead>
      <tbody>${AUTONOMOUS.map(r => `<tr><td><b>${r[0]}</b></td><td><code>${r[1]}</code></td><td>${r[2]}</td></tr>`).join('')}</tbody></table>
      </div>
    </details>
    <details class="opt">
      <summary><span class="t">Bonnes pratiques Modbus</span><span class="s">Fréquence d'interrogation, watchdog, codes de fonction, bloc 300-336…</span></summary>
      <div class="body">
      <ul style="margin:0;padding-left:18px">
        <li>Bloc gestionnaire d'énergie 300-336 (fonction 4, 37 registres) : 300-315 numéro de série, 316 état, 317 puissance,
            318-320 commandes (écriture en fonction 6), 321 secours, 322 contact PAC, 323-334 tension 0-10 V et sondes 0-4 en float32.
            Une intégration peut tout lire en une seule requête ; l'intégration Modbus de HA fait une lecture par capteur.</li>
        <li>L'appareil met ses valeurs à jour chaque seconde : interroger plus vite n'apporte rien. 5-10 s suffisent.</li>
        <li>Écrire la commande toutes les 10 s : bien en dessous des 60 s du watchdog, même si une écriture échoue.</li>
        <li>Fonctions 3/6 pour 200-202 et 500-555 (holding), fonction 4 pour 100-109, 300-336, 600-698 et 700-758 (input).</li>
        <li>8 connexions simultanées au maximum. L'identifiant d'unité est ignoré.</li>
        <li>Les valeurs négatives (319/320, 201/202) s'écrivent en complément à deux : <code>valeur % 65536</code>.</li>
        <li>Pas d'authentification : gardez le port 502 dans un réseau de confiance.</li>
        <li>Non documenté, à vérifier sur l'appareil : ordre des mots des float32 (supposé mot fort en premier), priorité exacte entre entrées.</li>
      </ul>
      </div>
    </details>`;
  }

  function formHtml() {
    const opt = (v, t) => `<option value="${v}">${t}</option>`;
    return `<div class="row" style="justify-content:space-between;margin-bottom:12px">
        <h2 style="margin:0">Générateur de package Home Assistant</h2>
        <button class="ghost" id="cfg-show" hidden>Afficher le YAML</button></div>
      <div class="grid2">
        <div><label>Voie de pilotage</label><select data-c="mode">
          ${opt('feedin', '320 injection')}${opt('setpoint', '319 consigne')}${opt('step', '318 étage')}${opt('analog', '0-10 V (Shelly)')}</select></div>
        <div><label>Cible</label><select data-c="target">${opt('real', 'appareil réel')}${opt('sim', 'ce simulateur')}</select></div>
      </div>
      <label>Adresse de l'ASKOHEAT+</label><input type="text" data-c="host">
      <label>Adresse du simulateur (Modbus TCP, port 502)</label><input type="text" data-c="simhost">
      <div data-show="meter">
        <label>Mesure au compteur</label><select data-c="meter">${opt('two', 'deux capteurs : soutirage et injection')}${opt('one', 'un capteur signé (+ soutirage, − injection)')}</select>
        <div class="grid2" data-show="two">
          <div><label>Capteur soutirage</label><input type="text" data-c="imp"></div>
          <div><label>Capteur injection</label><input type="text" data-c="exp"></div>
        </div>
        <div data-show="one"><label>Capteur signé</label><input type="text" data-c="signed"></div>
        <div class="grid2">
          <div><label>Unité des capteurs</label><select data-c="unit">${opt('W', 'W')}${opt('kW', 'kW')}</select></div>
          <div><label>Écriture toutes les (s)</label><input type="number" data-c="interval" min="1" max="300"></div>
        </div>
      </div>
      <div class="grid2" data-show="reg">
        <div><label>Réserve d'injection (W)</label><input type="number" data-c="reserve" min="0" max="2000" step="50"></div>
        <div><label>Puissance minimale (W)</label><input type="number" data-c="minimum" min="0" max="3500" step="50"></div>
      </div>
      <div data-show="analog"><label>Entité du module 0-10 V</label><input type="text" data-c="light"></div>
      <label class="check"><input type="checkbox" data-c="writecfg"> Écrire la configuration (502, 503, 504, 595) au démarrage de HA</label>
      <div data-show="writecfg">
        <label class="check"><input type="checkbox" data-c="watchdog"> 504 bit 0 · arrêt après 60 s sans écriture</label>
        <label class="check"><input type="checkbox" data-c="restart"> 504 bit 1 · reprise automatique après une coupure</label>
        <label class="check"><input type="checkbox" data-c="hp"> 502 bit 6 · contact PAC autorisé</label>
        <label class="check"><input type="checkbox" data-c="emerg"> 502 bit 7 · bouton secours autorisé</label>
        <label class="check"><input type="checkbox" data-c="mintemp"> Température minimale (502 bit 9, reg. 595)</label>
        <div class="grid2">
          <div data-show="mintemp"><label>Température minimale (°C)</label><input type="number" data-c="mintempv" min="20" max="65"></div>
          <div><label>Arrêt après chauffe continue (min, 503)</label><input type="number" data-c="offmin" min="2" max="10080"></div>
        </div>
      </div>
      <div id="cfg-warn"></div>
      <div id="cfg-regs" class="note"></div>
      <div class="row" style="margin-top:10px"><button id="cfg-reset">Valeurs par défaut</button></div>`;
  }

  // ---------------------------------------------------------------- génération
  const q = s => JSON.stringify(String(s));                 // chaîne YAML sûre (JSON ⊂ YAML)

  function registers() {
    let r502 = 0;
    if (C.mode === 'feedin') r502 |= 1 << 2;
    if (C.mode === 'setpoint') r502 |= 1 << 3;
    if (C.mode === 'step') r502 |= 1 << 4;
    if (C.mode === 'analog') r502 |= 1 << 5;
    if (C.hp) r502 |= 1 << 6;
    if (C.emerg) r502 |= 1 << 7;
    if (C.mintemp) r502 |= 1 << 9;
    const r504 = (C.watchdog ? 1 : 0) | (C.watchdog && C.restart ? 2 : 0);
    return {r502, r504};
  }

  function gridExpr() {
    const f = C.unit === 'kW' ? ' * 1000' : '';
    const g = C.meter === 'two'
      ? `((states('${C.imp}') | float(0)) - (states('${C.exp}') | float(0)))${f}`
      : `(states('${C.signed}') | float(0))${f}`;
    return g;
  }
  function gridAvail() {
    return C.meter === 'two' ? `has_value('${C.imp}') and has_value('${C.exp}')` : `has_value('${C.signed}')`;
  }

  function yaml() {
    const host = C.target === 'sim' ? C.simhost : C.host;
    const {r502, r504} = registers();
    const L = [];
    L.push(`# ASKOHEAT+ 2.0 – package Home Assistant généré par le simulateur (${new Date().toLocaleDateString('fr-CH')})`);
    L.push(`# Voie : ${OPTIONS.find(o => o.id === C.mode).title}`);
    L.push(`# Cible : ${C.target === 'sim' ? 'simulateur' : 'appareil réel'}`);
    L.push('');
    L.push('modbus:');
    L.push('  - name: askoheat');
    L.push('    type: tcp');
    L.push(`    host: ${q(host)}`);
    L.push('    port: 502');
    L.push('    timeout: 5');
    L.push('    sensors:');
    const sensor = (name, uid, addr, type, dt, extra) => {
      L.push(`      - name: ${q(name)}`);
      L.push(`        unique_id: ${uid}`);
      L.push(`        address: ${addr}`);
      L.push(`        input_type: ${type}`);
      L.push(`        data_type: ${dt}`);
      extra.forEach(e => L.push('        ' + e));
    };
    const temp = ['unit_of_measurement: "°C"', 'device_class: temperature', 'state_class: measurement', 'scan_interval: 10'];
    // Bloc gestionnaire d'énergie (EMA) 300-336, lu en fonction 4 (input)
    sensor('Askoheat température bride', 'askoheat_temp_bride', 325, 'input', 'float32', ['precision: 1', ...temp]);   // sonde 0
    sensor('Askoheat température haut', 'askoheat_temp_haut', 327, 'input', 'float32', ['precision: 1', ...temp]);     // sonde 1
    sensor('Askoheat puissance', 'askoheat_puissance', 317, 'input', 'uint16',
      ['unit_of_measurement: W', 'device_class: power', 'state_class: measurement', 'scan_interval: 5']);
    sensor('Askoheat état', 'askoheat_etat', 316, 'input', 'uint16', ['scan_interval: 5']);
    if (C.mode === 'feedin') sensor('Askoheat injection reçue', 'askoheat_injection_recue', 320, 'input', 'int16', ['unit_of_measurement: W', 'scan_interval: 10']);
    if (C.mode === 'setpoint') sensor('Askoheat consigne', 'askoheat_consigne', 319, 'input', 'int16', ['unit_of_measurement: W', 'scan_interval: 10']);
    if (C.mode === 'step') sensor('Askoheat étage commandé', 'askoheat_etage_commande', 318, 'input', 'uint16', ['scan_interval: 10']);
    if (C.mode === 'analog') sensor('Askoheat tension 0-10 V', 'askoheat_tension_analogique', 323, 'input', 'float32',
      ['precision: 2', 'unit_of_measurement: V', 'device_class: voltage', 'scan_interval: 10']);

    // Aides
    L.push('');
    L.push('input_boolean:');
    L.push('  askoheat_pv:');
    L.push(`    name: ${q(C.mode === 'step' ? 'Askoheat – pilotage manuel' : 'Askoheat – chauffe sur surplus PV')}`);
    L.push('    icon: mdi:water-boiler');
    if (C.mode === 'setpoint' || C.mode === 'analog') {
      L.push('');
      L.push('input_number:');
      L.push('  askoheat_reserve:');
      L.push(`    name: ${q('Askoheat – réserve d\'injection')}`);
      L.push('    min: 0\n    max: 2000\n    step: 50');
      L.push(`    initial: ${C.reserve}`);
      L.push('    unit_of_measurement: W\n    mode: box');
      L.push('  askoheat_minimum:');
      L.push(`    name: ${q('Askoheat – puissance minimale')}`);
      L.push('    min: 0\n    max: 3500\n    step: 50');
      L.push(`    initial: ${C.minimum}`);
      L.push('    unit_of_measurement: W\n    mode: box');
    }
    if (C.mode === 'step') {
      L.push('');
      L.push('input_number:');
      L.push('  askoheat_etage:');
      L.push(`    name: ${q('Askoheat – étage (× 500 W)')}`);
      L.push('    min: 0\n    max: 7\n    step: 1\n    mode: slider');
    }

    // Capteurs dérivés
    L.push('');
    L.push('template:');
    L.push('  - sensor:');
    if (C.mode !== 'step') {
      L.push(`      - name: ${q('Askoheat réseau')}`);
      L.push('        unique_id: askoheat_reseau');
      L.push('        unit_of_measurement: W');
      L.push('        device_class: power');
      L.push('        state_class: measurement');
      L.push(`        state: ${q(`{{ (${gridExpr()}) | round(0) | int }}`)}`);
      L.push(`        availability: ${q(`{{ ${gridAvail()} }}`)}`);
    }
    L.push(`      - name: ${q('Askoheat pilotée par')}`);
    L.push('        unique_id: askoheat_pilotee_par');
    L.push('        state: >-');
    // déduit des flags du registre 316 (= 624)
    L.push("          {% set v = states('sensor.askoheat_etat') | int(0) %}");
    L.push("          {% if v // 128 % 2 %}secours{% elif v // 64 % 2 %}contact PAC");
    L.push("          {% elif v // 512 % 2 %}entrée 0-10 V{% elif v // 1024 % 2 %}consigne (319)");
    L.push("          {% elif v // 2048 % 2 %}injection (320){% elif v % 8 %}étage (318) ou température minimale");
    L.push("          {% else %}aucune{% endif %}");
    L.push('  - binary_sensor:');
    L.push(`      - name: ${q('Askoheat limite de température')}`);
    L.push('        unique_id: askoheat_limite_temperature');
    L.push(`        state: ${q("{{ (states('sensor.askoheat_etat') | int(0)) // 16384 % 2 == 1 }}")}`);
    L.push(`      - name: ${q('Askoheat chauffe')}`);
    L.push('        unique_id: askoheat_chauffe');
    L.push('        device_class: heat');
    L.push(`        state: ${q("{{ (states('sensor.askoheat_etat') | int(0)) % 8 > 0 }}")}`);

    // Automations
    L.push('');
    L.push('automation:');
    const trig = () => {
      L.push('    mode: single');
      L.push('    max_exceeded: silent');
      L.push('    triggers:');
      L.push('      - trigger: time_pattern');
      L.push(`        seconds: ${q('/' + C.interval)}`);
    };
    const write = (addr, tpl) => {
      L.push('      - action: modbus.write_register');
      L.push('        data:');
      L.push('          hub: askoheat');
      L.push(`          address: ${addr}`);
      L.push('          value: >-');
      tpl.forEach(t => L.push('            ' + t));
    };
    // Avec le simulateur et un vrai compteur, le compteur ne voit pas la charge simulée : on l'ajoute.
    const simComp = C.target === 'sim' && C.mode !== 'feedin';
    const grid = simComp ? "(states('sensor.askoheat_reseau') | float(0)) + (states('sensor.askoheat_puissance') | float(0))"
      : "states('sensor.askoheat_reseau') | float(0)";

    if (C.mode === 'feedin') {
      L.push('  - id: askoheat_injection');
      L.push(`    alias: ${q('ASKOHEAT – envoyer la mesure du compteur (320)')}`);
      trig();
      L.push('    conditions:');
      L.push('      - condition: state\n        entity_id: input_boolean.askoheat_pv\n        state: "on"');
      L.push(`      - condition: template\n        value_template: ${q("{{ has_value('sensor.askoheat_reseau') }}")}`);
      L.push('    actions:');
      write(320, ["{% set p = states('sensor.askoheat_reseau') | int(0) %}",
                  '{{ ([[-30000, p] | max, 30000] | min) % 65536 }}']);
      L.push('  - id: askoheat_injection_off');
      L.push(`    alias: ${q('ASKOHEAT – arrêt du pilotage PV')}`);
      L.push('    triggers:\n      - trigger: state\n        entity_id: input_boolean.askoheat_pv\n        to: "off"');
      L.push('    actions:');
      write(320, ['0']);
    }
    if (C.mode === 'setpoint' || C.mode === 'analog') {
      const cur = C.mode === 'setpoint' ? "states('sensor.askoheat_puissance') | float(0)"
        : `(state_attr('${C.light}', 'brightness') | int(0)) / 255 * 3500 if is_state('${C.light}', 'on') else 0`;
      L.push('  - id: askoheat_regulation');
      L.push(`    alias: ${q(C.mode === 'setpoint' ? 'ASKOHEAT – consigne sur le surplus (319)' : 'ASKOHEAT – consigne 0-10 V sur le surplus')}`);
      trig();
      L.push('    conditions:');
      L.push('      - condition: state\n        entity_id: input_boolean.askoheat_pv\n        state: "on"');
      L.push(`      - condition: template\n        value_template: ${q("{{ has_value('sensor.askoheat_reseau') }}")}`);
      L.push('    actions:');
      L.push('      - variables:');
      L.push(`          grid: ${q(`{{ ${grid} }}`)}`);
      L.push(`          current: ${q(`{{ ${cur} }}`)}`);
      L.push(`          reserve: ${q("{{ states('input_number.askoheat_reserve') | float(0) }}")}`);
      L.push(`          minimum: ${q("{{ [states('input_number.askoheat_minimum') | float(0), 250] | max }}")}`);
      L.push(`          target: ${q('{{ [[current - grid - reserve, 0] | max, 3500] | min }}')}`);
      if (C.mode === 'setpoint') {
        write(319, ['{{ (target | int) if target >= minimum else 0 }}']);
      } else {
        L.push('      - choose:');
        L.push(`          - conditions: ${q('{{ target < minimum }}')}`);
        L.push('            sequence:');
        L.push('              - action: light.turn_off');
        L.push(`                target:\n                  entity_id: ${C.light}`);
        L.push('        default:');
        L.push('          - action: light.turn_on');
        L.push(`            target:\n              entity_id: ${C.light}`);
        L.push('            data:');
        L.push(`              brightness_pct: ${q('{{ [(target / 3500 * 100) | round(0) | int, 1] | max }}')}`);
      }
      L.push('  - id: askoheat_regulation_off');
      L.push(`    alias: ${q('ASKOHEAT – arrêt du pilotage PV')}`);
      L.push('    triggers:\n      - trigger: state\n        entity_id: input_boolean.askoheat_pv\n        to: "off"');
      L.push('    actions:');
      if (C.mode === 'setpoint') write(319, ['0']);
      else L.push(`      - action: light.turn_off\n        target:\n          entity_id: ${C.light}`);
      if (C.mode === 'analog') {
        L.push('  - id: askoheat_compteur_perdu');
        L.push(`    alias: ${q('ASKOHEAT – arrêt si le compteur ne répond plus')}`);
        L.push('    triggers:\n      - trigger: state\n        entity_id: sensor.askoheat_reseau\n        to: [unavailable, unknown]\n        for:\n          minutes: 1');
        L.push(`    actions:\n      - action: light.turn_off\n        target:\n          entity_id: ${C.light}`);
      }
    }
    if (C.mode === 'step') {
      L.push('  - id: askoheat_etage');
      L.push(`    alias: ${q('ASKOHEAT – étage manuel (318)')}`);
      trig();
      L.push('    conditions:');
      L.push('      - condition: state\n        entity_id: input_boolean.askoheat_pv\n        state: "on"');
      L.push('    actions:');
      write(318, ["{{ states('input_number.askoheat_etage') | int(0) }}"]);
      L.push('  - id: askoheat_etage_off');
      L.push(`    alias: ${q('ASKOHEAT – arrêt du pilotage manuel')}`);
      L.push('    triggers:\n      - trigger: state\n        entity_id: input_boolean.askoheat_pv\n        to: "off"');
      L.push('    actions:');
      write(318, ['0']);
    }
    if (C.writecfg) {
      L.push('  - id: askoheat_configuration');
      L.push(`    alias: ${q('ASKOHEAT – écrire la configuration')}`);
      L.push('    triggers:\n      - trigger: homeassistant\n        event: start');
      L.push('    actions:');
      L.push('      - delay: 30   # laisse le temps à la connexion Modbus de s\'établir');
      const cfg = [[502, r502, `entrées autorisées 0b${r502.toString(2)}`], [503, C.offmin, 'arrêt après N min de chauffe continue'],
                   [504, r504, `arrêt automatique 0b${r504.toString(2)}`]];
      if (C.mintemp) cfg.push([595, C.mintempv, 'température minimale (°C)']);
      cfg.forEach(([a, v, c]) => {
        L.push('      - action: modbus.write_register');
        L.push(`        data:   # ${c}`);
        L.push('          hub: askoheat');
        L.push(`          address: ${a}`);
        L.push(`          value: ${v}`);
      });
    }
    return L.join('\n') + '\n';
  }

  function warnings() {
    const w = [];
    const {r502, r504} = registers();
    if (C.mode !== 'step' && C.mode !== 'analog' && C.watchdog && C.interval >= 60)
      w.push('crit', `Écriture toutes les ${C.interval} s avec le watchdog de 60 s : les commandes seront effacées entre deux écritures. Restez à 10-20 s.`);
    if (C.mode !== 'analog' && !C.watchdog)
      w.push('warn', 'Sans watchdog (504 bit 0), la dernière commande reste active si HA s\'arrête. Le thermostat reste la seule limite.');
    if (C.interval < 2) w.push('warn', 'L\'appareil met ses valeurs à jour chaque seconde ; écrire plus vite charge le réseau sans gain.');
    if (C.target === 'sim' && C.mode === 'feedin')
      w.push('ok', 'Simulateur + vrai compteur : laissez cochée la case « La mesure envoyée n\'inclut pas le corps de chauffe simulé » dans l\'onglet Simulation. Décochée, le simulateur ignore ces écritures et simule lui-même la mesure.');
    if (C.target === 'sim' && C.mode === 'setpoint')
      w.push('ok', 'Simulateur + vrai compteur : le package ajoute la puissance simulée à la mesure (le compteur ne la voit pas). Retirez cet ajout pour l\'appareil réel en choisissant la cible « appareil réel ».');
    if (C.target === 'sim' && C.mode === 'analog')
      w.push('warn', 'Le simulateur n\'a pas de Shelly : son entrée 0-10 V se règle avec le curseur de l\'onglet Simulation. Le package sert ici à tester la logique avec le vrai module.');
    if (C.mintemp) w.push('warn', `Température minimale à ${C.mintempv} °C : l'appareil chauffe aussi sur le réseau (la nuit, en hiver) pour la maintenir.`);
    if (C.writecfg && C.target === 'real')
      w.push('warn', 'Écrire 502/504 modifie la configuration de l\'appareil réel. Notez d\'abord les valeurs actuelles (page /expert ou /getall de l\'ASKOHEAT+). Vérifiez aussi que le firmware connaît la voie choisie (320 / 202 : 4.2.1 ou plus).');
    if (C.mode === 'analog')
      w.push('warn', 'Faites correspondre les seuils de l\'entrée 0-10 V (registres 556-589) à la sortie du module : par exemple 1,4 V par étage pour 0-10 V = 0-3,5 kW.');
    let html = '';
    for (let i = 0; i < w.length; i += 2) html += `<div class="warnbox" style="border-color:var(--${w[i] === 'ok' ? 'series-1' : w[i]})">${w[i + 1]}</div>`;
    $('cfg-warn').innerHTML = html;
    $('cfg-regs').innerHTML = C.writecfg
      ? `Configuration écrite au démarrage : <code>502 = ${r502} (0b${r502.toString(2).padStart(10, '0')})</code> · <code>503 = ${C.offmin}</code> · <code>504 = ${r504} (0b${r504.toString(2).padStart(2, '0')})</code>${C.mintemp ? ` · <code>595 = ${C.mintempv}</code>` : ''}`
      : '';
  }

  function sync() {
    const form = $('cfg-form');
    form.querySelectorAll('[data-c]').forEach(el => {
      const v = C[el.dataset.c];
      if (el.type === 'checkbox') el.checked = !!v; else if (document.activeElement !== el) el.value = v;
    });
    const show = {
      meter: C.mode !== 'step', two: C.meter === 'two', one: C.meter === 'one',
      reg: C.mode === 'setpoint' || C.mode === 'analog', analog: C.mode === 'analog',
      writecfg: C.writecfg, mintemp: C.mintemp,
    };
    form.querySelectorAll('[data-show]').forEach(el => el.hidden = !show[el.dataset.show]);
    form.querySelector('[data-c="host"]').previousElementSibling.hidden = form.querySelector('[data-c="host"]').hidden = C.target !== 'real';
    form.querySelector('[data-c="simhost"]').previousElementSibling.hidden = form.querySelector('[data-c="simhost"]').hidden = C.target !== 'sim';
    if (C.mode !== openedFor) {                      // la voie choisie s'ouvre, les autres se ferment
      OPTIONS.forEach(o => { const el = $('opt-' + o.id); el.open = o.id === C.mode; el.classList.toggle('chosen', o.id === C.mode); });
      openedFor = C.mode;
    }
    $('tab-config').classList.toggle('noyaml', !!C.hideYaml);
    $('cfg-show').hidden = !C.hideYaml;
    $('cfg-yaml').textContent = yaml();
    warnings();
    localStorage.setItem('askoheat-cfg', JSON.stringify(C));
  }

  $('cfg-guide').innerHTML = guideHtml();
  $('cfg-form').innerHTML = formHtml();
  $('cfg-form').addEventListener('input', e => {
    const el = e.target.closest('[data-c]');
    if (!el) return;
    const k = el.dataset.c;
    C[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(+el.min || 0, Math.min(+el.max || 1e9, +el.value || 0)) : el.value.trim();
    sync();
  });
  $('cfg-guide').addEventListener('click', e => {
    const b = e.target.closest('[data-use]');
    if (!b) return;
    C.mode = b.dataset.use; sync();
  });
  $('cfg-reset').onclick = () => { C = {...DEFAULTS, hideYaml: C.hideYaml}; sync(); };
  $('cfg-hide').onclick = () => { C.hideYaml = true; sync(); };
  $('cfg-show').onclick = () => { C.hideYaml = false; sync(); };
  $('cfg-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('cfg-yaml').textContent); $('cfg-copy').textContent = 'Copié'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($('cfg-yaml')); getSelection().removeAllRanges(); getSelection().addRange(r); $('cfg-copy').textContent = 'Sélectionné : Ctrl+C'; }
    setTimeout(() => $('cfg-copy').textContent = 'Copier', 2000);
  };
  sync();
})();
