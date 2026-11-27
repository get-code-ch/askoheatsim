# Simulateur ASKOHEAT+ 2.0 (Domotec DWP EHF 3.5 PV F 2.0)

Imite le corps de chauffe en **Modbus TCP**, pour mettre au point Home Assistant
avant l'installation. Une page web montre l'état du chauffe-eau.

- `askoheat_sim.py` : serveur Modbus TCP + modèle thermique + serveur web (Python ≥ 3.10, aucune dépendance)
- `household.py` : profil du ménage (puisages, consommation de la maison, production PV)
- `index.html`, `app.js`, `trace.js`, `config.js` : interface web en trois onglets
- `kustomization.yaml` + `k8s/deployment.yaml` : déploiement sur le cluster (pas d'image à construire)
- `Dockerfile` : si vous préférez une image
- `home-assistant/askoheat.yaml` : package HA (capteurs + automation d'injection)

## Déploiement

Argo CD synchronise ce dépôt (branche `main`, racine) dans le namespace `askoheatsim` du cluster.
Le namespace, l'AppProject, l'Application et les routes de la Gateway sont gérés par Terraform dans
`talos_joran_local/23_askoheatsim`. Un push sur `main` redéploie le simulateur (la ConfigMap change de nom,
le pod redémarre).

- Interface web : https://askoheatsim.k8s.local
- Modbus TCP : `askoheatsim.askoheatsim.svc.cluster.local`, port 502

En local : `python3 askoheat_sim.py`, puis http://localhost:8080/ (Modbus sur le port 5020).

## Interface web

- **Simulation** : tableau de bord sur un écran — bandeau de chiffres clés (températures, eau à 40 °C, corps de chauffe,
  PV, maison, réseau, vitesse), chauffe-eau, pilotage, graphique combiné températures / puissances, journée simulée
  (puisages, bilan, jours précédents). Les réglages (mesure d'injection, simulation, ménage et PV, entrées de
  l'appareil, écriture de registre) sont dans le tiroir « ⚙ Réglages ».
- **Échanges Modbus** : chaque transaction (requête ▶ en bleu, réponse ◀ en vert, exception en rouge), avec l'en-tête
  MBAP grisé et, à côté des octets bruts, chaque registre interprété (nom, valeur avec unité, flags d'état en clair,
  float32, numéro de série). Détail de la transaction sélectionnée au-dessus du tableau ; registres principaux et
  journal du simulateur en dessous. Filtres, pause, export texte. Les IP des clients ne sont pas
  affichées (« client A », « client B »…), car la page est publique.
- **Configuration Home Assistant** : les voies de pilotage de l'ASKOHEAT+ (320 injection, 319 consigne, 318 étage,
  0-10 V via Shelly) en accordéon, avec avantages et inconvénients (la voie choisie s'ouvre seule), les fonctions
  autonomes de l'appareil, un générateur de package HA (Afficher / Copier / Télécharger) et le YAML dans une colonne masquable. Le package utilise le
  bloc gestionnaire d'énergie 300-336 (316 état, 317 puissance, 318-320 commandes, 325-334 sondes en float32).
  Basé sur la table Modbus Askoma v1.16 (13.05.2024).

L'état est unique et en mémoire : un réglage changé par un visiteur l'est pour tous, et tout est perdu au redémarrage du pod.

## Mesure d'injection : la case de compensation

Sur l'appareil réel, la boucle est fermée : quand le corps de chauffe consomme, le compteur le voit et le surplus envoyé
dans le registre 202 diminue. Avec le simulateur, la case « La mesure envoyée n'inclut pas le corps de chauffe simulé »
choisit d'où vient la mesure :

- **cochée** (défaut, `COMPENSATE=true`) : Home Assistant écrit la mesure du vrai compteur (gPlug, reçu en MQTT).
  Ce compteur ne voit pas la charge simulée : le simulateur l'ajoute à la valeur reçue, sinon il monterait toujours
  à 3,5 kW. À utiliser en temps réel (×1), car HA écrit toutes les 10 s réelles.
- **décochée** : les écritures de HA dans 202 sont ignorées (tracées « ignorée » dans l'onglet Échanges Modbus) et le
  simulateur calcule la mesure lui-même : maison + corps de chauffe − PV, à partir du profil. Fonctionne à toutes les
  vitesses (×1 à ×1440). Les registres 200 et 201 restent pris en compte.

`GET /api/grid` renvoie la mesure simulée (PV, maison, corps de chauffe, réseau).

## Profil du ménage

Préréglages (couple, famille de 3, famille de 5, retraités) et réglages fins : adultes, enfants, type et durée de douche,
bains par semaine, douches le soir, mode de vie (heure du lever, week-end), télétravail, lave-vaisselle / lave-linge
raccordés à l'eau chaude, vacances, PV (kWc, orientation, météo) et consommation de base.

Les puisages sont tirés au hasard avec une graine fixe : un même jour simulé donne les mêmes puisages, quelle que soit
la vitesse. Le débit est demandé à 40 °C au robinet ; le chauffe-eau ne fournit que la part chaude du mélange. Quand
l'eau du haut descend sous 40 °C, la page compte des « minutes sans eau à 40 °C ». La date de départ de l'horloge
simulée fixe la saison du PV (latitude du Plateau suisse).

## Configuration

Les réglages de l'appareil sont fixés au déploiement, par les variables d'environnement de
`k8s/deployment.yaml`. L'interface web les affiche sans permettre de les modifier, sauf la case de compensation.

| Variable | Défaut | Rôle |
|---|---|---|
| `INPUT_SETTING` | `0x2FC` | registre 502 : bits 2-7 injection, consigne, étage, 0-10 V, contact PAC, secours ; bit 9 température minimale |
| `MIN_TEMP` | `45` | registre 595 : température minimale maintenue |
| `AUTO_OFF` | `0b01` | registre 504 : bit 0 arrêt après 60 s sans écriture, bit 1 redémarrage auto |
| `COMPENSATE` | `true` | état de départ de la case de compensation |
| `TANK_LITERS` | `300` | volume du chauffe-eau |
| `START_TEMP` | `45` | température de l'eau au démarrage |
| `TZ_NAME` | `Europe/Zurich` | fuseau de l'horloge simulée |

Home Assistant peut toujours écrire les registres 502, 503, 504, 510 et 595 en Modbus, comme sur l'appareil réel.
Ces écritures sont perdues au redémarrage du pod.

## Home Assistant

`home-assistant/askoheat.yaml` est un package HA : capteurs (températures, puissance, état) et automation
qui envoie la puissance réseau du gPlug (`sensor.gplug_puissance_soutiree` / `_injectee`, en W) au registre 202 toutes les 10 s. Pour l'utiliser, le copier dans
les packages de HA. Pour passer au vrai appareil, changer `host` pour l'IP de l'ASKOHEAT+.
L'identifiant d'unité Modbus est omis : l'ASKOHEAT+ l'ignore.

## Ce qui est simulé

| Registre | Rôle | Comportement |
|---|---|---|
| 200 / 318 | étage (bits 0-2) | impose 0 à 7 étages de 500 W |
| 201 / 319 | consigne en W | l'appareil choisit l'étage ≤ consigne (250 W minimum) |
| 202 / 320 | injection en W (int16) | négatif = surplus, l'appareil adapte son étage ; positif = arrêt |
| 502 | entrées autorisées | bits 2 injection, 3 consigne, 4 étage, 5 0-10 V, 6 contact PAC, 7 secours, 9 température minimale |
| 503 | arrêt après N min de chauffe continue | 1440 min par défaut (temps simulé), 2-10080 |
| 504 | arrêt automatique | bit 0 : registres 200-202 effacés après 60 s sans écriture |
| 510 | température légionelles | 50-65 °C (stockée, pas de cycle simulé) |
| 595 | température minimale | chauffe à pleine puissance sous la valeur − 3 °C (sonde de la bride) |
| 100-106, 634-638, 706-715 | sondes | sonde 0 = bride (bas), sonde 1 = haut, 2-4 non branchées |
| 108 / 321 | mode secours | 0 / 255 |
| 300-315 / 0-15 | numéro de série (char[32]) | `SERIAL`, défaut `ASKOHEAT-SIM-0001` |
| 316 / 317 | état / puissance (bloc EMA) | identiques à 624 / 625 |
| 322, 323-324, 716-717 | contact PAC, tension 0-10 V | |
| 325-334 | sondes 0 à 4 en float32 (bloc EMA) | sonde 0 = bride, sonde 1 = haut |
| 109 / 624 | flags d'état | octet bas : bits 0-2 relais, 4 carte relais, 5 courant, 6 PAC, 7 secours ; octet haut : 1 0-10 V, 2 consigne, 3 injection, 4 arrêt auto, 6 limite de température |
| 110 / 625 | puissance réelle en W | |
| 626 | entrée qui pilote | bits 7 consigne, 6 injection, 5 secours, 4 PAC, 3 0-10 V, 2 étage, 0 température minimale |
| 632 | état des sondes | bits 0-4 sondes présentes, bit 6 limite atteinte |
| 639 | étage demandé par le 0-10 V | |

Priorité (hypothèse, non documentée) : secours > contact PAC > 0-10 V > étage (200) > consigne (201) > injection (202)
> température minimale. Le thermostat interne (65 °C, réglable) coupe toujours en dernier.

En accéléré, le modèle avance par pas de 10 s simulées au plus, pour que douches et nuages restent visibles.

Codes de fonction : 3 et 4 (lecture, mêmes registres), 6 et 16 (écriture).
8 clients maximum, comme l'appareil.

**Compensation d'injection** (case cochée par défaut) : si HA envoie la mesure d'un *vrai*
compteur, celui-ci ne voit pas la consommation simulée. Le simulateur ajoute alors sa
propre charge à la valeur reçue, sinon il monterait toujours à 3.5 kW.

## Limites (à vérifier sur l'appareil réel)

Le simulateur suit la table publiée par Askoma, mais certains points sont des **hypothèses** :

- les bits des registres 109 / 624 suivent la doc v1.16, mais le bit 5 (« courant ») y est ambigu ;
- la conversion tension → étage de l'entrée 0-10 V (ici linéaire ; sur l'appareil, seuils 556-589) ;
- la température minimale : sonde et hystérésis (593-594) supposées ;
- l'ordre des mots des float32 (ici big-endian, mot fort en premier, le défaut de HA) ;
- le watchdog : ici il compte depuis la dernière **écriture** de 200-202. Sur l'appareil, il
  dépend peut-être de toute communication. Écrire régulièrement couvre les deux cas ;
- le comportement quand plusieurs entrées (200/201/202) sont actives en même temps ;
- la répartition des résistances (500 / 1000 / 2000 W) ;
- le modèle thermique : deux couches, pertes ~1.5 kWh/24 h. Il sert à voir des tendances, pas à prédire au degré près.

Une fois l'appareil installé, comparez avec `http://askoheat.local/getall` et la page
`http://askoheat.local/modbus`, qui décrit les registres du firmware installé.

Aucune authentification, comme le vrai appareil : gardez le port 502 dans le cluster.
