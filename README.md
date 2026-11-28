# Simulateur ASKOHEAT+ 2.0 (Domotec DWP EHF 3.5 PV F 2.0)

Imite le corps de chauffe en **Modbus TCP**, pour mettre au point Home Assistant
avant l'installation. Une page web montre l'état du chauffe-eau.

- `askoheat_sim.py` : serveur Modbus TCP + modèle thermique + serveur web (Python ≥ 3.10, aucune dépendance)
- `household.py` : profil du ménage (puisages, consommation de la maison, production PV)
- `registers.py` : blocs paramètres (400-455) et configuration (500-599), valeurs par défaut et encodage
- `index.html`, `app.js`, `trace.js`, `config.js` : interface web en trois onglets
- `kustomization.yaml` + `k8s/deployment.yaml` : déploiement sur le cluster (pas d'image à construire)
- `Dockerfile`, `compose.yaml`, `.dockerignore` : image autonome pour un usage hors du cluster (voir « Conteneur Docker »)
- `.github/workflows/docker.yml` : build multi-architecture et publication sur `ghcr.io/get-code-ch/askoheatsim`
- `home-assistant/askoheat.yaml` : package HA (capteurs + automation d'injection)

## Déploiement

Argo CD synchronise ce dépôt (branche `main`, racine) dans le namespace `askoheatsim` du cluster.
Le namespace, l'AppProject, l'Application et les routes de la Gateway sont gérés par Terraform dans
`talos_joran_local/23_askoheatsim`. Un push sur `main` redéploie le simulateur (la ConfigMap change de nom,
le pod redémarre).

- Interface web : https://askoheatsim.k8s.local
- Modbus TCP : `askoheatsim.askoheatsim.svc.cluster.local`, port 502

En local : `python3 askoheat_sim.py`, puis http://localhost:8080/ (Modbus sur le port 5020).

## Conteneur Docker (hors du cluster)

Pour faire tourner le simulateur ailleurs que sur le cluster (poste de travail, Raspberry Pi, NAS, démo sur un portable),
le dépôt fournit une image autonome. Le cluster ne l'utilise pas : aucune image n'est à publier pour Argo CD.

### Image publiée (ghcr.io)

GitHub Actions (`.github/workflows/docker.yml`) construit l'image pour `linux/amd64` et `linux/arm64` et la publie
sur **`ghcr.io/get-code-ch/askoheatsim`** :

| Événement | Étiquettes |
|---|---|
| push sur `main` (code, `Dockerfile`, workflow) | `main`, `sha-<commit>`, `latest` |
| tag `v1.2.3` | `1.2.3`, `1.2`, `1`, `latest` |
| pull request | build seulement, rien n'est publié |
| lancement manuel (onglet Actions) | selon la branche choisie |

```bash
docker run -d --name askoheatsim -p 8080:8080 -p 502:5020 -v askoheatsim-state:/data ghcr.io/get-code-ch/askoheatsim:latest
```

Dans `compose.yaml`, remplacer `build:` par `image: ghcr.io/get-code-ch/askoheatsim:latest` pour utiliser l'image publiée.

Publier une version : `git tag v1.0.0 && git push origin v1.0.0`.

Le paquet est lié au dépôt et hérite de sa visibilité : **public**, téléchargeable sans authentification
(`docker pull` sans `docker login`). Réglage : github.com → profil → *Packages* → `askoheatsim` → *Package settings*.

```bash
docker compose up -d --build        # construit l'image askoheatsim:local et démarre le conteneur
docker compose logs -f              # journal du simulateur
docker compose down                 # arrêt propre (l'état est sauvegardé, le volume est conservé)
```

Sans Compose :

```bash
docker build -t askoheatsim --build-arg VERSION=$(git describe --tags --always) --build-arg REVISION=$(git rev-parse --short HEAD) .
docker run -d --name askoheatsim --restart unless-stopped -p 8080:8080 -p 502:5020 -v askoheatsim-state:/data askoheatsim
```

- Interface web : http://<hôte>:8080/ ; Modbus TCP : port 502 de l'hôte (le conteneur écoute sur 5020, sans privilège).
  Dans l'intégration Askoheat+ de HA, indiquer l'adresse de l'hôte Docker.
- **État** : volume `/data` (`STATE_FILE=/data/state.json`), sauvegardé toutes les 10 s et à `docker stop`.
  Pour repartir des réglages d'usine : bouton de l'interface, ou supprimer le volume (`docker compose down -v`).
  Avec un répertoire de l'hôte à la place du volume nommé, il doit être accessible en écriture à l'UID 65534
  (`chown 65534:65534 <répertoire>`).
- **Variables** : les mêmes que sur le cluster (`TANK_LITERS`, `COMPENSATE`, `INPUT_SETTING`, `TZ_NAME`, `SERIAL`…,
  voir l'en-tête de `askoheat_sim.py`), avec `-e` ou dans `environment:` de `compose.yaml`. Comme l'état est conservé,
  elles ne s'appliquent qu'au premier démarrage et après une remise aux réglages d'usine.
- Image `python:3.13-slim` (~180 Mo), utilisateur `nobody` (65534), compatible avec `--read-only` et `--cap-drop ALL`
  (réglages repris dans `compose.yaml`), `HEALTHCHECK` sur `/healthz`.
- Autre architecture (Raspberry Pi 64 bits, par exemple) :
  `docker buildx build --platform linux/arm64 -t askoheatsim:arm64 --load .`

## Interface web

- **Simulation** : tableau de bord sur un écran — bandeau de chiffres clés (températures, eau à 40 °C, corps de chauffe,
  PV, maison, réseau, vitesse), chauffe-eau, pilotage, graphique combiné températures / puissances, journée simulée
  (puisages, bilan, jours précédents). Les réglages (mesure d'injection, simulation, ménage et PV, entrées de
  l'appareil, écriture de registre) sont dans le tiroir « ⚙ Réglages ».
- **Historique** : plusieurs jours de simulation (2, 7 ou 14 jours, en temps simulé) : chiffres clés de la période
  (énergie du corps de chauffe et part PV, production PV, maison, soutirage, injection, eau puisée, températures),
  courbes des températures haut / bride et des puissances moyennes au quart d'heure (corps de chauffe, PV, maison,
  réseau), énergie du corps de chauffe par jour (depuis le PV / depuis le réseau) et tableau des bilans journaliers.
  Avec la simulation accélérée (×3600 : un jour en 24 s), quatorze jours se remplissent en moins de six minutes.
- **Échanges Modbus** : chaque transaction (requête ▶ en bleu, réponse ◀ en vert, exception en rouge), avec l'en-tête
  MBAP grisé et, à côté des octets bruts, chaque registre interprété (nom, valeur avec unité, flags d'état en clair,
  float32, numéro de série). Détail de la transaction sélectionnée au-dessus du tableau ; registres principaux et
  journal du simulateur en dessous. Filtres, pause, export texte. Les IP des clients ne sont pas
  affichées (« client A », « client B »…), car la page est publique.
- **Configuration Home Assistant** : les voies de pilotage de l'ASKOHEAT+ (320 injection, 319 consigne, 318 étage,
  0-10 V via Shelly) en accordéon, avec avantages et inconvénients (la voie choisie s'ouvre seule), les fonctions
  autonomes de l'appareil, un générateur de package HA (Afficher / Copier / Télécharger) et le YAML dans une colonne masquable.
  Deux connexions au choix : **intégration Askoheat+** (HACS, toggm/askoheat ; le package passe par ses entités `number.*` et
  le générateur liste les `switch.*` / `number.*` à régler, avec un préfixe d'entités modifiable) ou **Modbus YAML** (hub dans le package). Le package utilise le
  bloc gestionnaire d'énergie 300-336 (316 état, 317 puissance, 318-320 commandes, 325-334 sondes en float32).
  Basé sur la table Modbus Askoma v1.16 (13.05.2024).

L'état est unique : un réglage changé par un visiteur l'est pour tous.

## Persistance

Avec `STATE_FILE` (déployé : `/data/state.json` sur le volume Longhorn `askoheatsim-state`, 256 Mi), le simulateur
sauvegarde son état toutes les 10 s et à l'arrêt (SIGTERM : sauvegarde puis sortie propre), et le relit au démarrage :
configuration 502-504, 510, 595 et 500-599, mode piloté / autonome, profil du ménage, réglages de simulation,
températures, compteurs du bloc 600, bilans journaliers et historique (14 jours, un point par quart d'heure, ~200 Ko). Les commandes 318-320 ne sont pas conservées (watchdog).
Les variables d'environnement ne servent alors qu'au premier démarrage et aux **réglages d'usine** : bouton du tiroir
« Entrées de l'appareil » ou écriture du registre **211** (comme sur l'appareil) ; le ménage et l'eau ne changent pas.
Le Deployment utilise la stratégie `Recreate` : le volume RWO est libéré par l'ancien pod avant le démarrage du nouveau.

## Deux modes : piloté par HA ou autonome

Le sélecteur « Piloté par HA / Autonome » (bandeau du tableau de bord et tiroir Réglages) choisit d'où vient la mesure
au compteur :

- **Piloté par HA** (défaut, `COMPENSATE=true`) : le port Modbus est ouvert. Home Assistant écrit la mesure de son
  vrai compteur (gPlug, reçu en MQTT) dans le registre 320 (ou 202) et lit l'état du chauffe-eau. Sur l'appareil réel,
  la boucle est fermée (le compteur voit le corps de chauffe) ; ici, le compteur ne voit pas la charge simulée, donc le
  simulateur l'ajoute à la valeur reçue, sinon il monterait toujours à 3,5 kW. Le simulateur ne fait que lire ce que
  HA lui envoie : les données réelles de consommation dans HA ne sont jamais modifiées. À utiliser en temps réel (×1).
- **Autonome** : le port Modbus est fermé (connexions coupées, nouvelles connexions refusées) ; rien n'est échangé
  avec Home Assistant, dont les entités Askoheat passent « indisponible ». Le simulateur calcule la mesure lui-même :
  maison + corps de chauffe − PV, à partir du profil. Fonctionne à toutes les vitesses (×1 à ×1440).

Les commandes reçues de HA (318-320 / 200-202) sont effacées à chaque changement de mode.

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
`k8s/deployment.yaml`. L'interface web les affiche sans permettre de les modifier, sauf le mode.

| Variable | Défaut | Rôle |
|---|---|---|
| `INPUT_SETTING` | `0x2FC` | registre 502 : bits 2-7 injection, consigne, étage, 0-10 V, contact PAC, secours ; bit 9 température minimale |
| `MIN_TEMP` | `45` | registre 595 : température minimale maintenue |
| `AUTO_OFF` | `0b01` | registre 504 : bit 0 arrêt après 60 s sans écriture, bit 1 redémarrage auto |
| `COMPENSATE` | `true` | mode au démarrage : `true` piloté par HA, `false` autonome (port Modbus fermé) |
| `TANK_LITERS` | `300` | volume du chauffe-eau |
| `START_TEMP` | `45` | température de l'eau au démarrage |
| `TZ_NAME` | `Europe/Zurich` | fuseau de l'horloge simulée |
| `STATE_FILE` | (aucun) | fichier d'état JSON ; déployé : `/data/state.json` |

Home Assistant peut toujours écrire les registres 502, 503, 504, 510 et 500-599 en Modbus, comme sur l'appareil réel.
Avec `STATE_FILE`, ces écritures sont conservées au redémarrage.

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
| 400-455 | paramètres (lecture) | n° de série, type (7 étages, à bride), R1-R3 500 / 1000 / 2000 W, article, versions « SIM », 7 étages, 3 résistances, 3500 W |
| 500-599 | configuration (lecture / écriture) | tout le bloc est stocké ; utilisés par la simulation : 556-589 seuils 0-10 V (tension, étage, limite), 590-592 étages contact PAC ouvert / fermé et secours, 593 hystérésis, 596-599 limites de température par entrée |
| 600-697 | données de fonctionnement | durées (totale, par résistance, par entrée, par étage) et compteurs (commutations, activations) en uint32, 640 limite en vigueur, 641 / 643 comptes à rebours, 697 température max |

### Compatibilité avec l'intégration Home Assistant toggm/askoheat

Le simulateur sert les quatre blocs que l'intégration lit (300 ×37 et 400 ×56 en fonction 4, 500 ×100 en fonction 3,
600 ×98 en fonction 4) et accepte ses écritures (fonction 16) sur tout le bloc 500-599. L'encodage suit l'intégration,
écrite contre l'appareil réel : chaînes à 2 caractères par mot, **octet de poids faible en premier** ; uint32 et float32
mot de poids fort en premier ; heures sur deux registres (heure, minute). La doc Askoma décrit 512-515 comme un texte
(« 12:00 AM ») : à vérifier sur l'appareil.

Écart à connaître : pour « secours actif », l'intégration lit le bit 8 du registre d'état 316 / 624 ; la doc Askoma
place le secours au bit 7 et les légionelles au bit 8. Le simulateur suit la doc.

Priorité (hypothèse, non documentée) : secours > contact PAC > 0-10 V > étage (200) > consigne (201) > injection (202)
> température minimale. Le thermostat interne (65 °C, réglable) coupe toujours en dernier.

En accéléré, le modèle avance par pas de 10 s simulées au plus, pour que douches et nuages restent visibles.

Codes de fonction : 3 et 4 (lecture, mêmes registres), 6 et 16 (écriture).
8 clients maximum, comme l'appareil.

**Compensation d'injection** (mode piloté) : HA envoie la mesure d'un *vrai* compteur, qui ne voit pas la consommation
simulée. Le simulateur ajoute donc sa propre charge à la valeur reçue, sinon il monterait toujours à 3,5 kW.

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
