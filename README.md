# Simulateur ASKOHEAT+ 2.0 (Domotec DWP EHF 3.5 PV F 2.0)

Imite le corps de chauffe en **Modbus TCP**, pour mettre au point Home Assistant
avant l'installation. Une page web montre l'état du chauffe-eau.

- `askoheat_sim.py` : serveur Modbus TCP + modèle thermique + serveur web (Python ≥ 3.10, aucune dépendance)
- `index.html` : interface web
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

## Home Assistant

`home-assistant/askoheat.yaml` est un package HA : capteurs (températures, puissance, état) et automation
qui envoie la puissance réseau du gPlug au registre 202 toutes les 10 s. Pour l'utiliser, le copier dans
les packages de HA. Pour passer au vrai appareil, changer `host` pour l'IP de l'ASKOHEAT+.
Selon la version de HA, la clé de l'unité Modbus s'appelle `slave` ou `device_address` ; l'ASKOHEAT+ l'ignore.

## Ce qui est simulé

| Registre | Rôle | Comportement |
|---|---|---|
| 200 / 318 | étage (bits 0-2) | impose 0 à 7 étages de 500 W |
| 201 / 319 | consigne en W | l'appareil choisit l'étage ≤ consigne |
| 202 / 320 | injection en W (int16) | négatif = surplus, l'appareil adapte son étage |
| 502 | entrées autorisées | bit 4 étage, bit 3 consigne, bit 2 injection |
| 503 | arrêt après N h de chauffe continue | 24 h par défaut (temps simulé) |
| 504 | arrêt automatique | bit 0 : registres 200-202 effacés après 60 s sans écriture |
| 510 | température légionelles | 50-65 °C (stockée, pas de cycle simulé) |
| 100-106, 634-638, 706-715 | sondes | sonde 0 = bride (bas), sonde 1 = haut, 2-4 non branchées |
| 108 / 321 | mode secours | 0 / 255 |
| 109 / 624 | flags d'état | bits 0-2 relais, 3 secours, 4 PAC, 5 thermostat ouvert |
| 110 / 625 | puissance réelle en W | |
| 632 | sondes présentes | 0b00011 |

Priorité : secours > contact PAC > étage (200) > consigne (201) > injection (202).
Le thermostat interne (65 °C, réglable) coupe toujours en dernier.

Codes de fonction : 3 et 4 (lecture, mêmes registres), 6 et 16 (écriture).
8 clients maximum, comme l'appareil.

**Compensation d'injection** (case cochée par défaut) : si HA envoie la mesure d'un *vrai*
compteur, celui-ci ne voit pas la consommation simulée. Le simulateur ajoute alors sa
propre charge à la valeur reçue, sinon il monterait toujours à 3.5 kW.

## Limites (à vérifier sur l'appareil réel)

Le simulateur suit la table publiée par Askoma, mais certains points sont des **hypothèses** :

- la disposition exacte des bits des registres 109 / 624 ;
- l'ordre des mots des float32 (ici big-endian, mot fort en premier, le défaut de HA) ;
- le watchdog : ici il compte depuis la dernière **écriture** de 200-202. Sur l'appareil, il
  dépend peut-être de toute communication. Écrire régulièrement couvre les deux cas ;
- le comportement quand plusieurs entrées (200/201/202) sont actives en même temps ;
- la répartition des résistances (500 / 1000 / 2000 W) ;
- le modèle thermique : deux couches, pertes ~1.5 kWh/24 h. Il sert à voir des tendances, pas à prédire au degré près.

Une fois l'appareil installé, comparez avec `http://askoheat.local/getall` et la page
`http://askoheat.local/modbus`, qui décrit les registres du firmware installé.

Aucune authentification, comme le vrai appareil : gardez le port 502 dans le cluster.
