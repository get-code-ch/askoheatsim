#!/usr/bin/env python3
"""
Simulateur ASKOHEAT+ 2.0 (vendu par Domotec sous la référence DWP EHF 3.5 PV F 2.0)

- Serveur Modbus TCP imitant la table de registres publiée par Askoma
  (http://www.download.askoma.com/askofamily_plus/modbus/askoheat-modbus.html, v1.16)
- Modèle thermique simple d'un chauffe-eau à deux couches (haut / bas)
- Profil de ménage (household.py) : puisages, consommation de la maison, production PV
- Interface web (http://<hôte>:8080/) et API JSON (/api/state, /api/control, /api/frames, /api/grid)

Uniquement la bibliothèque standard Python (>= 3.10). Aucune dépendance.

Variables d'environnement :
  MODBUS_PORT   port Modbus TCP          (défaut 5020 ; mettre 502 si root)
  HTTP_PORT     port de l'interface web  (défaut 8080)
  TANK_LITERS   volume du chauffe-eau    (défaut 300)
  START_TEMP    température initiale °C  (défaut 45)
  INPUT_SETTING registre 502, entrées autorisées (défaut 0x2FC : injection, consigne, étage,
                0-10 V, contact PAC, secours + température minimale)
  MIN_TEMP      registre 595, température minimale maintenue (défaut 45 °C)
  AUTO_OFF      registre 504, arrêt automatique  (défaut 0b01 : arrêt après 60 s sans écriture)
  COMPENSATE    mode au démarrage (défaut true) :
                true  = mode piloté : HA envoie la mesure du vrai compteur (320 / 202), le simulateur
                        y ajoute sa propre charge ; le port Modbus est ouvert
                false = mode autonome : le port Modbus est fermé, rien n'est échangé avec HA ;
                        le simulateur calcule lui-même la mesure au compteur
  TZ_NAME       fuseau de l'horloge simulée (défaut Europe/Zurich)
"""

import asyncio
import json
import logging
import math
import os
import struct
import sys
import time
from collections import deque
from datetime import timezone, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))     # household.py, à côté de ce fichier
from household import Household, tank_flow  # noqa: E402

log = logging.getLogger("askoheatsim")

MODBUS_PORT = int(os.environ.get("MODBUS_PORT", "5020"))
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
TANK_LITERS = float(os.environ.get("TANK_LITERS", "300"))
START_TEMP = float(os.environ.get("START_TEMP", "45"))
# Configuration fixée au déploiement. Accepte le décimal, 0b… ou 0x…
INPUT_SETTING = int(os.environ.get("INPUT_SETTING", "0x2FC"), 0) & 0xFFFF
MIN_TEMP = int(os.environ.get("MIN_TEMP", "45"))
AUTO_OFF = int(os.environ.get("AUTO_OFF", "0b01"), 0) & 0xFF
COMPENSATE = os.environ.get("COMPENSATE", "true").strip().lower() in ("1", "true", "yes", "oui", "on")
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("TZ_NAME", "Europe/Zurich"))
except Exception:                       # pas de base de fuseaux : UTC+1 fixe
    TZ = timezone(timedelta(hours=1))

# 3 résistances, pondération binaire -> 7 étages réguliers de 500 W (3.5 kW)
HEATER_W = (500, 1000, 2000)
STEP_W = 500
MAX_STEP = 7
MAX_CLIENTS = 8                 # le vrai appareil accepte 8 connexions
WATCHDOG_S = 60                 # registres 200-202 effacés après 60 s
THERMOSTAT_HYST = 3.0           # °C
SUBSTEP_S = 10.0                # pas de calcul maximal en temps simulé

# Registres de commande / configuration (écriture autorisée)
REG_STEP, REG_SETPOINT, REG_FEEDIN = 200, 201, 202
REG_EM_STEP, REG_EM_SETPOINT, REG_EM_FEEDIN = 318, 319, 320
REG_INPUT_SETTING, REG_AUTO_OFF_MIN, REG_AUTO_OFF, REG_LEGIO = 502, 503, 504, 510
REG_MIN_TEMP = 595
FEEDIN_REGS = (REG_FEEDIN, REG_EM_FEEDIN)
WRITABLE = {REG_STEP, REG_SETPOINT, REG_FEEDIN, REG_EM_STEP, REG_EM_SETPOINT,
            REG_EM_FEEDIN, REG_INPUT_SETTING, REG_AUTO_OFF_MIN, REG_AUTO_OFF, REG_LEGIO, REG_MIN_TEMP}
REG_SPACE = 1000
SERIAL = os.environ.get("SERIAL", "ASKOHEAT-SIM-0001")[:31]   # registres 0-15 et 300-315 (char[32])

# Bits du registre 502 (doc Askoma) : octet bas = entrées, octet haut bit 1 = température minimale
IN_FEEDIN, IN_SETPOINT, IN_STEP, IN_ANALOG, IN_HP, IN_EMERG = 2, 3, 4, 5, 6, 7
IN_MIN_TEMP = 9
MIN_TEMP_HYST = 3.0

FC_NAMES = {3: "lecture holding", 4: "lecture input", 6: "écriture", 16: "écriture multiple"}
EXC_NAMES = {1: "fonction non supportée", 2: "adresse invalide", 3: "valeur invalide"}


def s16(v: int) -> int:
    """uint16 -> int16"""
    v &= 0xFFFF
    return v - 0x10000 if v & 0x8000 else v


def u16(v: int) -> int:
    """int -> uint16 (complément à deux)"""
    return int(v) & 0xFFFF


def f32_words(x: float) -> tuple[int, int]:
    """float32 big-endian, mot de poids fort en premier (ABCD)"""
    hi, lo = struct.unpack(">HH", struct.pack(">f", float(x)))
    return hi, lo


class Simulator:
    def __init__(self):
        # Commandes (registres 200-202)
        self.cmd_step = 0
        self.cmd_setpoint = 0
        self.cmd_feedin = 0
        self.feedin_active = False       # 202 écrit depuis le dernier effacement
        self.last_cmd_write = None       # temps réel (monotonic)
        self.ha_feedin = None            # dernière valeur 202 reçue de HA (même ignorée)
        # Configuration
        self.input_setting = INPUT_SETTING
        self.auto_off = AUTO_OFF         # 504 : bit0 arrêt après 60 s, bit1 redémarrage
        self.auto_off_min = 1440         # 503 (minutes, 2-10080)
        self.legio_temp = 60             # 510
        self.min_temp = MIN_TEMP         # 595
        self.min_heating = False
        self.thermostat_max = 65.0       # thermostat interne (réglage mécanique)
        # Entrées physiques simulées
        self.emergency_until = None      # temps simulé
        self.hp_request = False
        self.hp_power_w = 3500
        self.analog_v = 0.0              # entrée 0-10 V
        self.compensate = COMPENSATE
        # Modèle thermique
        self.tank_l = TANK_LITERS
        self.t_low = START_TEMP          # sonde 0, dans la bride (bas)
        self.t_up = START_TEMP + 3       # sonde 1, doigt de gant haut (option)
        self.t_cold = 10.0
        self.t_amb = 20.0
        self.manual_lpm = 0.0            # puisage manuel, à 40 °C au robinet
        self.speed = 1.0
        # Ménage
        self.house = Household(TZ)
        self.tap_lpm = 0.0
        self.tank_lpm = 0.0
        self.cold_tap = False
        self.draw_labels: list[str] = []
        self.house_w = 0.0
        self.house_labels: list[str] = []
        self.pv_w = 0.0
        self.grid_w = 0.0
        # État
        self.sim_time = 0.0
        self.step = 0
        self.mode = "arrêt"
        self.source = None               # entrée qui pilote (pour le registre 626)
        self.thermostat_cut = False
        self.on_since = None             # temps simulé
        self.auto_off_active = False
        self.energy_wh = 0.0
        self.days: dict[str, dict] = {}  # bilans journaliers
        self.clients: dict[str, dict] = {}
        self.aliases: dict[str, str] = {}
        self.events = deque(maxlen=80)
        self.history = deque(maxlen=600)
        self.frames = deque(maxlen=2000) # trace Modbus
        self.frame_seq = 0
        self.started = time.time()
        self.event("Simulateur démarré")

    # ------------------------------------------------------------------ utils
    def event(self, msg: str, src: str = "sim"):
        self.events.appendleft({"t": time.strftime("%H:%M:%S"), "src": src, "msg": msg})
        log.info("[%s] %s", src, msg)

    def alias(self, ip: str) -> str:
        """Nom stable d'un client sans exposer son IP (l'interface est publique)."""
        if ip not in self.aliases:
            self.aliases[ip] = "client " + chr(ord("A") + len(self.aliases) % 26)
        return self.aliases[ip]

    def trace(self, entry: dict):
        self.frame_seq += 1
        entry["seq"] = self.frame_seq
        entry["t"] = time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"
        self.frames.append(entry)

    @property
    def load_w(self) -> int:
        return self.step * STEP_W

    def relays(self) -> list[bool]:
        return [bool(self.step & (1 << i)) for i in range(3)]

    def emergency(self) -> bool:
        return self.emergency_until is not None and self.sim_time < self.emergency_until

    def enabled(self, bit: int) -> bool:
        return bool(self.input_setting & (1 << bit))

    def analog_step(self) -> int:
        # Hypothèse : seuils répartis linéairement (0 V = 0, 10 V = 7). Sur l'appareil,
        # les seuils et les étages se règlent dans les registres 556-589.
        return max(0, min(MAX_STEP, math.floor(self.analog_v / 10 * MAX_STEP + 1e-9)))

    def clear_commands(self, why: str):
        self.cmd_step = self.cmd_setpoint = 0
        if self.compensate:
            self.cmd_feedin = 0
            self.feedin_active = False
        self.last_cmd_write = None
        self.event(f"Registres 200-202 effacés ({why})")

    # --------------------------------------------------------------- pilotage
    def decide_step(self) -> tuple[int, str, str | None]:
        # Priorités : hypothèse (la doc n'en donne pas) — secours > PAC > 0-10 V > 200 > 201 > 202
        if self.emergency() and self.enabled(IN_EMERG):
            return MAX_STEP, "secours (100 % pendant 24 h)", "emergency"
        if self.hp_request and self.enabled(IN_HP):
            return min(MAX_STEP, self.hp_power_w // STEP_W), "contact « Heatpump Request »", "hp"
        if self.enabled(IN_ANALOG) and self.analog_v >= 0.5:
            return self.analog_step(), f"entrée 0-10 V ({self.analog_v:.1f} V)", "analog"
        if self.enabled(IN_STEP) and self.cmd_step & 0x7:
            return self.cmd_step & 0x7, "étage imposé (reg. 200)", "step"
        if self.enabled(IN_SETPOINT) and self.cmd_setpoint >= 250:
            sp = max(0, min(self.cmd_setpoint, MAX_STEP * STEP_W))
            return sp // STEP_W, "consigne de puissance (reg. 201)", "setpoint"
        if self.enabled(IN_FEEDIN) and self.feedin_active:
            # Valeur d'injection : négatif = on injecte sur le réseau, positif = arrêt.
            # Case cochée : la mesure (vrai compteur) ne voit pas le corps de chauffe
            # simulé, on ajoute donc sa charge. Case décochée : la mesure est simulée
            # et contient déjà la charge.
            eff = self.cmd_feedin + (self.load_w if self.compensate else 0)
            available = self.load_w - eff
            src = "mesure simulée" if not self.compensate else "HA"
            step = max(0, min(MAX_STEP, math.floor(available / STEP_W)))
            if step or not self.enabled(IN_MIN_TEMP):
                return step, f"injection (reg. 202, {src})", "feedin"
        # Maintien d'une température minimale (sonde de la bride), en dernier recours
        if self.enabled(IN_MIN_TEMP):
            if self.t_low < self.min_temp - MIN_TEMP_HYST:
                self.min_heating = True
            elif self.t_low >= self.min_temp:
                self.min_heating = False
            if self.min_heating:
                return MAX_STEP, f"température minimale {self.min_temp} °C (reg. 595)", "mintemp"
        if self.enabled(IN_FEEDIN) and self.feedin_active:
            return 0, "injection : pas de surplus", "feedin"
        return 0, "arrêt", None

    def tick(self, dt_real: float):
        # Watchdog Modbus (temps réel, comme l'appareil)
        if (self.auto_off & 1 and self.last_cmd_write is not None
                and time.monotonic() - self.last_cmd_write > WATCHDOG_S):
            self.clear_commands("watchdog : 60 s sans écriture")

        dt_total = dt_real * self.speed
        n = max(1, math.ceil(dt_total / SUBSTEP_S))
        for _ in range(n):
            self.substep(dt_total / n)

    def substep(self, dt: float):
        self.sim_time += dt
        now = self.house.now(self.sim_time)

        if self.emergency_until is not None and not self.emergency():
            self.emergency_until = None
            self.event("Fin du mode secours")

        # Ménage : puisages, maison, PV
        self.tap_lpm, self.draw_labels = self.house.tap_lpm(now)
        self.tap_lpm += self.manual_lpm
        if self.manual_lpm:
            self.draw_labels = self.draw_labels + ["puisage manuel"]
        self.house_w, self.house_labels = self.house.house_w(now)
        self.pv_w = self.house.pv_w(now)

        # Case décochée : la mesure au compteur est simulée et « câblée » sur 202
        if not self.compensate:
            self.grid_w = self.house_w + self.load_w - self.pv_w
            self.cmd_feedin = max(-30000, min(30000, round(self.grid_w)))
            self.feedin_active = True

        step, mode, source = self.decide_step()

        # Thermostat interne sur la sonde de la bride
        if self.thermostat_cut and self.t_low < self.thermostat_max - THERMOSTAT_HYST:
            self.thermostat_cut = False
            self.event("Thermostat : réenclenchement")
        if not self.thermostat_cut and self.t_low >= self.thermostat_max:
            self.thermostat_cut = True
            self.event(f"Thermostat : coupure à {self.thermostat_max:.0f} °C")
        if self.thermostat_cut and step:
            step, mode = 0, mode + " — coupé par le thermostat"

        # Arrêt automatique après N minutes de chauffe continue (reg. 503)
        if step and self.on_since is None:
            self.on_since = self.sim_time
        elif not step:
            self.on_since = None
            self.auto_off_active = False
        if self.on_since is not None and self.sim_time - self.on_since >= self.auto_off_min * 60 \
                and not self.emergency():
            self.clear_commands(f"{self.auto_off_min} min de chauffe continue (reg. 503)")
            self.on_since = None
            self.auto_off_active = True
            step, mode = 0, "arrêt (limite de chauffe continue)"

        if step != self.step and self.speed <= 60:
            self.event(f"Étage {self.step} → {step} ({step * STEP_W} W) — {mode}")
        self.step, self.mode, self.source = step, mode, source
        if self.compensate:
            # mesure « vue » par un vrai compteur, pour information
            self.grid_w = self.house_w + self.load_w - self.pv_w

        self.thermal(dt)
        self.account(now, dt)

    def thermal(self, dt: float):
        c = 4186.0
        m = self.tank_l / 2.0                       # kg par couche
        p = self.load_w
        self.t_low += p * dt / (m * c)
        self.energy_wh += p * dt / 3600.0
        # Convection : l'eau chaude du bas monte vite ; sinon conduction lente
        k = 0.02 if self.t_low > self.t_up else 0.0002
        d = (self.t_low - self.t_up) * min(1.0, k * dt) / 2.0
        self.t_low -= d
        self.t_up += d
        # Soutirage : l'eau chaude sort en haut, l'eau froide entre en bas.
        # Le robinet mélange à 40 °C : on ne prend au chauffe-eau que la part chaude.
        self.tank_lpm, self.cold_tap = tank_flow(self.tap_lpm, self.t_up, self.t_cold)
        if self.tank_lpm > 0:
            frac = min(1.0, self.tank_lpm / 60.0 * dt / m)
            self.t_up += frac * (self.t_low - self.t_up)
            self.t_low += frac * (self.t_cold - self.t_low)
        # Pertes statiques (~1.5 kWh/24 h à 60 °C pour 300 L)
        ua = 1.6 * self.tank_l / 300.0 / 2.0         # W/K par couche
        self.t_low -= ua * (self.t_low - self.t_amb) * dt / (m * c)
        self.t_up -= ua * (self.t_up - self.t_amb) * dt / (m * c)

    def account(self, now, dt: float):
        key = now.date().isoformat()
        d = self.days.get(key)
        if d is None:
            d = self.days[key] = {"date": key, "tap_l": 0.0, "tank_l": 0.0, "heater_kwh": 0.0,
                                  "pv_kwh": 0.0, "house_kwh": 0.0, "heater_pv_kwh": 0.0,
                                  "import_kwh": 0.0, "export_kwh": 0.0, "cold_min": 0.0}
            for old in sorted(self.days)[:-8]:
                del self.days[old]
        h = dt / 3600
        d["tap_l"] += self.tap_lpm * dt / 60
        d["tank_l"] += self.tank_lpm * dt / 60
        d["heater_kwh"] += self.load_w * h / 1000
        d["pv_kwh"] += self.pv_w * h / 1000
        d["house_kwh"] += self.house_w * h / 1000
        # part du corps de chauffe couverte par le PV (après la maison)
        d["heater_pv_kwh"] += min(self.load_w, max(0.0, self.pv_w - self.house_w)) * h / 1000
        grid = self.house_w + self.load_w - self.pv_w
        d["import_kwh"] += max(0.0, grid) * h / 1000
        d["export_kwh"] += max(0.0, -grid) * h / 1000
        if self.cold_tap and self.tap_lpm > 0:
            d["cold_min"] += dt / 60

    def litres_40(self) -> float:
        """Eau mitigée à 40 °C disponible (approximation)."""
        m = self.tank_l / 2.0
        tot = 0.0
        for t in (self.t_up, self.t_low):
            if t > 40:
                tot += m * (t - self.t_cold) / (40 - self.t_cold)
        return tot

    # -------------------------------------------------------------- registres
    def status_flags(self) -> int:
        """Registres 109 / 624 (doc Askoma)."""
        r = self.relays()
        lo = (r[0] << 0) | (r[1] << 1) | (r[2] << 2)
        lo |= 1 << 4                                         # carte relais connectée (2.0)
        lo |= (self.step > 0) << 5                           # courant dans les résistances
        lo |= (self.hp_request and self.enabled(IN_HP)) << 6
        lo |= (self.emergency() and self.enabled(IN_EMERG)) << 7
        hi = (self.source == "analog") << 1
        hi |= (self.source == "setpoint") << 2
        hi |= (self.source == "feedin" and self.cmd_feedin < 0) << 3
        hi |= self.auto_off_active << 4
        hi |= self.thermostat_cut << 6
        return (hi << 8) | lo

    def control_input(self) -> int:
        """Registre 626 : entrée qui pilote (octet bas)."""
        bits = {"setpoint": 7, "feedin": 6, "emergency": 5, "hp": 4, "analog": 3, "step": 2, "mintemp": 0}
        return 1 << bits[self.source] if self.source in bits else 0

    def sensors(self) -> list[float | None]:
        """Sondes 0..4 ; None = non branchée."""
        return [self.t_low, self.t_up, None, None, None]

    def read_reg(self, a: int) -> int:
        s = self.sensors()
        sv = [0.0 if v is None else v for v in s]
        if a in (100, 102, 104, 106):                # sondes 1-4, entier °C
            return u16(round(sv[(a - 100) // 2 + 1]))
        if a == 108 or a == 321:
            return 255 if self.emergency() else 0
        if 300 <= a <= 315 or 0 <= a <= 15:          # numéro de série, 2 caractères par mot
            raw = SERIAL.encode("ascii", "replace").ljust(32, b"\0")
            i = (a % 300) * 2
            return raw[i] << 8 | raw[i + 1]
        if a == 316:                                 # bloc EMA : état (= 624)
            return self.status_flags()
        if a == 317:                                 # bloc EMA : puissance (= 625)
            return self.load_w
        if a == 322:
            return 255 if self.hp_request else 0
        if a in (323, 324):
            return f32_words(self.analog_v)[a - 323]
        if a in (109, 624):
            return self.status_flags()
        if a in (110, 625):
            return self.load_w
        if a == 626:
            return self.control_input()
        if a in (REG_STEP, REG_EM_STEP):
            return self.cmd_step
        if a in (REG_SETPOINT, REG_EM_SETPOINT):
            return u16(self.cmd_setpoint)
        if a in FEEDIN_REGS:
            return u16(self.cmd_feedin)
        if 325 <= a <= 334:                          # bloc EMA : sondes 0..4 en float32
            return f32_words(sv[(a - 325) // 2])[(a - 325) % 2]
        if a == REG_INPUT_SETTING:
            return self.input_setting
        if a == REG_AUTO_OFF_MIN:
            return self.auto_off_min
        if a == REG_AUTO_OFF:
            return self.auto_off
        if a == REG_LEGIO:
            return self.legio_temp
        if a == REG_MIN_TEMP:
            return self.min_temp
        if a == 631:
            return 0
        if a == 632:                                 # sondes présentes + limite atteinte
            return sum(1 << i for i, v in enumerate(s) if v is not None) | (self.thermostat_cut << 6)
        if 634 <= a <= 638:                          # sondes 4..0, entier
            return u16(round(sv[4 - (a - 634)]))
        if a == 639:
            return self.analog_step()
        if 706 <= a <= 715:                          # sondes 4..0, float32
            idx = 4 - (a - 706) // 2
            return f32_words(sv[idx])[(a - 706) % 2]
        if a in (716, 717):                          # tension entrée 0-10 V
            return f32_words(self.analog_v)[a - 716]
        return 0

    def write_reg(self, a: int, v: int, src: str) -> tuple[bool, str]:
        """Renvoie (accepté, remarque pour la trace)."""
        if a not in WRITABLE:
            return False, ""
        note = ""
        if a in (REG_STEP, REG_EM_STEP):
            self.cmd_step = v & 0x7
            self.last_cmd_write = time.monotonic()
            self.event(f"Écriture reg. {a} = {v & 0x7} (étage)", src)
        elif a in (REG_SETPOINT, REG_EM_SETPOINT):
            self.cmd_setpoint = s16(v)
            self.last_cmd_write = time.monotonic()
            self.event(f"Écriture reg. {a} = {s16(v)} W (consigne)", src)
        elif a in FEEDIN_REGS:
            self.ha_feedin = s16(v)
            self.last_cmd_write = time.monotonic()
            if self.compensate:
                self.cmd_feedin = s16(v)
                self.feedin_active = True
                self.event(f"Écriture reg. {a} = {s16(v)} W (injection)", src)
            else:
                note = "ignorée : mesure simulée"
        elif a == REG_INPUT_SETTING:
            self.input_setting = v & 0xFFFF
            self.event(f"Écriture reg. 502 = {v:#011b} (entrées autorisées)", src)
        elif a == REG_AUTO_OFF_MIN:
            self.auto_off_min = max(2, min(10080, v))
            self.event(f"Écriture reg. 503 = {self.auto_off_min} min", src)
        elif a == REG_AUTO_OFF:
            self.auto_off = v & 0xFF
            self.event(f"Écriture reg. 504 = {v & 0xFF:#010b} (arrêt auto)", src)
        elif a == REG_LEGIO:
            self.legio_temp = max(50, min(65, v & 0xFF))
            self.event(f"Écriture reg. 510 = {self.legio_temp} °C", src)
        elif a == REG_MIN_TEMP:
            self.min_temp = max(0, min(95, v & 0xFF))
            self.event(f"Écriture reg. 595 = {self.min_temp} °C (température minimale)", src)
        return True, note

    # ------------------------------------------------------------ interface
    def set_compensate(self, on: bool):
        """True = mode piloté par HA, False = mode autonome (port Modbus fermé)."""
        if on == self.compensate:
            return
        self.compensate = on
        # Les commandes de HA ne survivent pas à un changement de mode : on repart de zéro
        self.cmd_step = self.cmd_setpoint = self.cmd_feedin = 0
        self.feedin_active = False
        self.last_cmd_write = None
        self.ha_feedin = None
        if on:
            self.event("Mode piloté : port Modbus ouvert, la mesure d'injection vient de HA", "web")
        else:
            self.event("Mode autonome : port Modbus fermé, le simulateur calcule lui-même la mesure", "web")
        self.trace({"client": "simulateur", "kind": "web", "fc": None, "addr": None, "req": "", "resp": "",
                    "desc": "mode piloté : port Modbus ouvert" if on else "mode autonome : port Modbus fermé, connexions coupées",
                    "note": ""})
        try:
            asyncio.get_running_loop().create_task(modbus_open() if on else modbus_close())
        except RuntimeError:            # hors boucle asyncio (tests)
            pass

    def control(self, d: dict):
        if "draw_lpm" in d:
            self.manual_lpm = max(0.0, min(30.0, float(d["draw_lpm"])))
        if "t_cold" in d:
            self.t_cold = max(2.0, min(25.0, float(d["t_cold"])))
        if "speed" in d:
            self.speed = max(0.1, min(3600.0, float(d["speed"])))
        if "thermostat_max" in d:
            self.thermostat_max = max(40.0, min(85.0, float(d["thermostat_max"])))
        if "compensate" in d:
            self.set_compensate(bool(d["compensate"]))
        if d.get("mode") in ("pilote", "autonome"):
            self.set_compensate(d["mode"] == "pilote")
        if "hp_request" in d:
            self.hp_request = bool(d["hp_request"])
            self.event(f"Contact PAC {'fermé' if self.hp_request else 'ouvert'}", "web")
        if "hp_power_w" in d:
            self.hp_power_w = max(0, min(3500, int(d["hp_power_w"])))
        if "analog_v" in d:
            self.analog_v = max(0.0, min(10.0, float(d["analog_v"])))
            self.event(f"Entrée 0-10 V : {self.analog_v:.1f} V", "web")
        if d.get("emergency") is True:
            self.emergency_until = self.sim_time + 24 * 3600
            self.event("Bouton secours : 100 % pendant 24 h", "web")
        if d.get("emergency") is False:
            self.emergency_until = None
            self.event("Mode secours annulé", "web")
        if "reset_temp" in d:
            t = max(5.0, min(85.0, float(d["reset_temp"])))
            self.t_low = self.t_up = t
            self.event(f"Températures réinitialisées à {t:.0f} °C", "web")
        if "household" in d and isinstance(d["household"], dict):
            changed = self.house.update(d["household"])
            if changed:
                self.event("Profil du ménage modifié : " + ", ".join(changed), "web")
        if "start" in d:
            self.house.set_start(str(d["start"]))
            self.sim_time = 0.0
            self.days.clear()
            self.history.clear()
            self.event(f"Horloge simulée : départ le {self.house.start:%d.%m.%Y %H:%M}", "web")
        if "write" in d:
            # Depuis l'interface web : seulement les commandes 200-202.
            # La configuration (502, 504…) est fixée au déploiement.
            for a, v in d["write"].items():
                a = int(a)
                if a not in (REG_STEP, REG_SETPOINT, REG_FEEDIN):
                    self.event(f"Refus : reg. {a} non modifiable depuis l'interface", "web")
                    continue
                ok, note = self.write_reg(a, u16(int(v)), "web")
                shown = s16(u16(int(v)))
                self.trace({"client": "interface web", "kind": "web", "fc": 6, "addr": a,
                            "desc": f"écriture {a} = {shown}", "note": note, "req": "", "resp": ""})

    def state(self) -> dict:
        wd = None
        if self.auto_off & 1 and self.last_cmd_write is not None:
            wd = max(0.0, WATCHDOG_S - (time.monotonic() - self.last_cmd_write))
        regs = {a: self.read_reg(a) for a in
                (316, 317, 318, 319, 320, 321, 322, 502, 503, 504, 510, 595, 626, 632, 639)}
        now = self.house.now(self.sim_time)
        today = self.days.get(now.date().isoformat())
        return {
            "step": self.step, "load_w": self.load_w, "relays": self.relays(),
            "mode": self.mode, "thermostat_cut": self.thermostat_cut,
            "thermostat_max": self.thermostat_max,
            "t_low": round(self.t_low, 2), "t_up": round(self.t_up, 2),
            "t_cold": self.t_cold, "draw_lpm": self.manual_lpm, "speed": self.speed,
            "tap_lpm": round(self.tap_lpm, 1), "tank_lpm": round(self.tank_lpm, 1),
            "cold_tap": self.cold_tap, "draws": self.draw_labels,
            "house_w": round(self.house_w), "house_loads": self.house_labels,
            "pv_w": round(self.pv_w), "grid_w": round(self.grid_w),
            "tank_l": self.tank_l, "litres_40": round(self.litres_40()),
            "energy_kwh": round(self.energy_wh / 1000, 3),
            "cmd": {"step": self.cmd_step, "setpoint": self.cmd_setpoint,
                    "feedin": self.cmd_feedin, "feedin_active": self.feedin_active,
                    "ha_feedin": self.ha_feedin},
            "watchdog_s": None if wd is None else round(wd, 1),
            "input_setting": self.input_setting, "auto_off": self.auto_off,
            "auto_off_min": self.auto_off_min, "min_temp": self.min_temp,
            "emergency": self.emergency(),
            "emergency_left_h": round((self.emergency_until - self.sim_time) / 3600, 1)
            if self.emergency() else 0,
            "hp_request": self.hp_request, "hp_power_w": self.hp_power_w,
            "analog_v": self.analog_v, "analog_step": self.analog_step(),
            "compensate": self.compensate, "run_mode": "pilote" if self.compensate else "autonome",
            "modbus_open": MODBUS_SERVER is not None,
            "clients": list(self.clients.values()),
            "sim_time_h": round(self.sim_time / 3600, 3),
            "sim_now": now.strftime("%Y-%m-%dT%H:%M"),
            "sim_start": self.house.start.strftime("%Y-%m-%dT%H:%M"),
            "household": self.house.state(),
            "schedule": self.house.schedule(now),
            "today": None if today is None else {k: (round(v, 2) if isinstance(v, float) else v)
                                                 for k, v in today.items()},
            "days": [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}
                     for _, d in sorted(self.days.items())],
            "registers": regs, "events": list(self.events),
            "history": list(self.history),
            "modbus_port": MODBUS_PORT,
        }


SIM = Simulator()


# ======================================================================= Modbus
def exc(fc: int, code: int) -> bytes:
    return bytes([fc | 0x80, code])


def handle_pdu(pdu: bytes, src: str) -> tuple[bytes, str]:
    """Traite une requête ; renvoie (réponse, remarque pour la trace)."""
    if not pdu:
        return exc(0, 1), ""
    fc = pdu[0]
    try:
        if fc in (3, 4):
            addr, count = struct.unpack(">HH", pdu[1:5])
            if not 1 <= count <= 125:
                return exc(fc, 3), ""
            if addr + count > REG_SPACE:
                return exc(fc, 2), ""
            vals = [SIM.read_reg(a) for a in range(addr, addr + count)]
            return bytes([fc, 2 * count]) + struct.pack(f">{count}H", *vals), ""
        if fc == 6:
            addr, val = struct.unpack(">HH", pdu[1:5])
            ok, note = SIM.write_reg(addr, val, src)
            if not ok:
                return exc(fc, 2), ""
            return pdu[:5], note
        if fc == 16:
            addr, count, bc = struct.unpack(">HHB", pdu[1:6])
            if not 1 <= count <= 123 or bc != 2 * count:
                return exc(fc, 3), ""
            if any(a not in WRITABLE for a in range(addr, addr + count)):
                return exc(fc, 2), ""
            vals = struct.unpack(f">{count}H", pdu[6:6 + bc])
            notes = []
            for i, v in enumerate(vals):
                _, note = SIM.write_reg(addr + i, v, src)
                if note:
                    notes.append(f"{addr + i} {note}")
            return bytes([16]) + struct.pack(">HH", addr, count), "; ".join(notes)
    except struct.error:
        return exc(fc, 3), ""
    return exc(fc, 1), ""


def describe(pdu: bytes, resp: bytes) -> dict:
    """Décodage lisible d'une transaction pour la trace."""
    out = {"fc": pdu[0] if pdu else None, "addr": None, "count": None, "values": None,
           "kind": "read", "desc": "", "exc": None}
    fc = out["fc"]
    try:
        if fc in (3, 4):
            addr, count = struct.unpack(">HH", pdu[1:5])
            out.update(addr=addr, count=count)
            if resp and not resp[0] & 0x80:
                out["values"] = list(struct.unpack(f">{count}H", resp[2:2 + 2 * count]))
            out["desc"] = f"{FC_NAMES[fc]} {addr}" + (f" ×{count}" if count > 1 else "")
        elif fc == 6:
            addr, val = struct.unpack(">HH", pdu[1:5])
            out.update(addr=addr, count=1, values=[val], kind="write")
            shown = s16(val) if addr in (201, 202, 319, 320) else val
            out["desc"] = f"écriture {addr} = {shown}"
        elif fc == 16:
            addr, count = struct.unpack(">HH", pdu[1:5])
            vals = list(struct.unpack(f">{count}H", pdu[6:6 + 2 * count]))
            out.update(addr=addr, count=count, values=vals, kind="write")
            out["desc"] = f"écriture multiple {addr}…{addr + count - 1} = {vals}"
        else:
            out["desc"] = f"fonction {fc}"
    except (struct.error, KeyError, TypeError):
        out["desc"] = "trame mal formée"
    if resp and resp[0] & 0x80:
        code = resp[1] if len(resp) > 1 else 0
        out["exc"] = code
        out["kind"] = "exc"
        out["desc"] += f" → exception {code} ({EXC_NAMES.get(code, '?')})"
    return out


MODBUS_SERVER: asyncio.base_events.Server | None = None
WRITERS: dict[str, asyncio.StreamWriter] = {}


async def modbus_open():
    """Mode piloté : écoute sur le port Modbus."""
    global MODBUS_SERVER
    if MODBUS_SERVER is None:
        MODBUS_SERVER = await asyncio.start_server(modbus_conn, "0.0.0.0", MODBUS_PORT)
        log.info("Port Modbus %d ouvert", MODBUS_PORT)


async def modbus_close():
    """Mode autonome : coupe les connexions et n'écoute plus (connexion refusée côté HA)."""
    global MODBUS_SERVER
    srv, MODBUS_SERVER = MODBUS_SERVER, None
    if srv is not None:
        srv.close()
    for w in list(WRITERS.values()):
        w.close()
    log.info("Port Modbus %d fermé", MODBUS_PORT)


async def modbus_conn(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    ip = peer[0] if peer else "?"
    key = f"{SIM.alias(ip)}:{peer[1] if peer else '?'}"
    if not SIM.compensate:              # course entre la fermeture et une connexion entrante
        writer.close()
        return
    if len(SIM.clients) >= MAX_CLIENTS:
        SIM.event(f"Connexion refusée ({MAX_CLIENTS} clients max) : {key}", "modbus")
        writer.close()
        return
    SIM.clients[key] = {"peer": key, "since": time.strftime("%H:%M:%S"), "requests": 0}
    WRITERS[key] = writer
    SIM.event(f"Client connecté : {key}", "modbus")
    try:
        while True:
            hdr = await reader.readexactly(7)
            tid, pid, length, unit = struct.unpack(">HHHB", hdr)
            if pid != 0 or not 2 <= length <= 260:
                break
            pdu = await reader.readexactly(length - 1)
            SIM.clients[key]["requests"] += 1
            resp, note = handle_pdu(pdu, SIM.alias(ip))
            out = struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp
            writer.write(out)
            entry = describe(pdu, resp)
            entry.update(client=key, tid=tid, unit=unit, req=(hdr + pdu).hex(), resp=out.hex(), note=note)
            SIM.trace(entry)
            await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        SIM.clients.pop(key, None)
        WRITERS.pop(key, None)
        SIM.event(f"Client déconnecté : {key}", "modbus")
        writer.close()


# ========================================================================= HTTP
HERE = Path(__file__).parent
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/trace.js": ("trace.js", "text/javascript; charset=utf-8"),
    "/config.js": ("config.js", "text/javascript; charset=utf-8"),
}


def frames_after(seq: int) -> dict:
    if seq > SIM.frame_seq:          # le simulateur a redémarré
        seq = 0
    return {"last": SIM.frame_seq, "frames": [f for f in SIM.frames if f["seq"] > seq]}


async def http_conn(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        line = await asyncio.wait_for(reader.readline(), 10)
        parts = line.decode("latin-1").split()
        if len(parts) < 2:
            return
        method, target = parts[0], parts[1]
        path, _, query = target.partition("?")
        params = dict(p.partition("=")[::2] for p in query.split("&") if p)
        headers = {}
        while True:
            h = await reader.readline()
            if h in (b"\r\n", b"\n", b""):
                break
            k, _, v = h.decode("latin-1").partition(":")
            headers[k.strip().lower()] = v.strip()
        n = min(int(headers.get("content-length", "0") or 0), 65536)
        body = await reader.readexactly(n) if n else b""

        status, ctype, out = "200 OK", "application/json", b""
        if method == "GET" and path in STATIC:
            name, ctype = STATIC[path]
            out = (HERE / name).read_bytes()
        elif method == "GET" and path == "/api/state":
            out = json.dumps(SIM.state()).encode()
        elif method == "GET" and path == "/api/frames":
            try:
                seq = int(params.get("after", "0"))
            except ValueError:
                seq = 0
            out = json.dumps(frames_after(seq)).encode()
        elif method == "GET" and path == "/api/grid":
            out = json.dumps({"grid_w": round(SIM.grid_w), "pv_w": round(SIM.pv_w),
                              "house_w": round(SIM.house_w), "heater_w": SIM.load_w,
                              "simulated": not SIM.compensate}).encode()
        elif method == "POST" and path == "/api/control":
            try:
                SIM.control(json.loads(body or b"{}"))
                out = json.dumps(SIM.state()).encode()
            except (ValueError, TypeError) as e:
                status, out = "400 Bad Request", json.dumps({"error": str(e)}).encode()
        elif path == "/healthz":
            ctype, out = "text/plain", b"ok"
        else:
            status, ctype, out = "404 Not Found", "text/plain", b"not found"
        writer.write(f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n"
                     f"Content-Length: {len(out)}\r\nCache-Control: no-store\r\n"
                     f"Connection: close\r\n\r\n".encode() + out)
        await writer.drain()
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        writer.close()


# ======================================================================== Boucle
async def sim_loop():
    last = time.monotonic()
    n = 0
    while True:
        await asyncio.sleep(0.5)
        now = time.monotonic()
        SIM.tick(now - last)
        last = now
        n += 1
        if n % 2 == 0:                       # un point d'historique par seconde
            SIM.history.append({"t": round(SIM.sim_time / 3600, 4),
                                "up": round(SIM.t_up, 2), "low": round(SIM.t_low, 2),
                                "w": SIM.load_w, "pv": round(SIM.pv_w), "house": round(SIM.house_w),
                                "grid": round(SIM.grid_w), "tap": round(SIM.tap_lpm, 1)})


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if SIM.compensate:
        await modbus_open()
    web = await asyncio.start_server(http_conn, "0.0.0.0", HTTP_PORT)
    log.info("Mode %s, Modbus TCP sur le port %d (%s), interface web sur http://0.0.0.0:%d/",
             "piloté" if SIM.compensate else "autonome", MODBUS_PORT,
             "ouvert" if SIM.compensate else "fermé", HTTP_PORT)
    async with web:
        await asyncio.gather(web.serve_forever(), sim_loop())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
