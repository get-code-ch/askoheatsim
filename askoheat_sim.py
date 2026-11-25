#!/usr/bin/env python3
"""
Simulateur ASKOHEAT+ 2.0 (vendu par Domotec sous la référence DWP EHF 3.5 PV F 2.0)

- Serveur Modbus TCP imitant la table de registres publiée par Askoma
  (http://www.download.askoma.com/askofamily_plus/modbus/askoheat-modbus.html)
- Modèle thermique simple d'un chauffe-eau à deux couches (haut / bas)
- Interface web (http://<hôte>:8080/) et API JSON (/api/state, /api/control)

Uniquement la bibliothèque standard Python (>= 3.10). Aucune dépendance.

Variables d'environnement :
  MODBUS_PORT   port Modbus TCP          (défaut 5020 ; mettre 502 si root)
  HTTP_PORT     port de l'interface web  (défaut 8080)
  TANK_LITERS   volume du chauffe-eau    (défaut 300)
  START_TEMP    température initiale °C  (défaut 45)
"""

import asyncio
import json
import logging
import math
import os
import struct
import time
from collections import deque
from pathlib import Path

log = logging.getLogger("askoheatsim")

MODBUS_PORT = int(os.environ.get("MODBUS_PORT", "5020"))
HTTP_PORT = int(os.environ.get("HTTP_PORT", "8080"))
TANK_LITERS = float(os.environ.get("TANK_LITERS", "300"))
START_TEMP = float(os.environ.get("START_TEMP", "45"))

# 3 résistances, pondération binaire -> 7 étages réguliers de 500 W (3.5 kW)
HEATER_W = (500, 1000, 2000)
STEP_W = 500
MAX_STEP = 7
MAX_CLIENTS = 8                 # le vrai appareil accepte 8 connexions
WATCHDOG_S = 60                 # registres 200-202 effacés après 60 s
CONTINUOUS_LIMIT_S = 24 * 3600  # arrêt après 24 h de chauffe continue (temps simulé)
THERMOSTAT_HYST = 3.0           # °C

# Registres de commande / configuration (écriture autorisée)
REG_STEP, REG_SETPOINT, REG_FEEDIN = 200, 201, 202
REG_EM_STEP, REG_EM_SETPOINT, REG_EM_FEEDIN = 318, 319, 320
REG_INPUT_SETTING, REG_AUTO_OFF_24H, REG_AUTO_OFF, REG_LEGIO = 502, 503, 504, 510
WRITABLE = {REG_STEP, REG_SETPOINT, REG_FEEDIN, REG_EM_STEP, REG_EM_SETPOINT,
            REG_EM_FEEDIN, REG_INPUT_SETTING, REG_AUTO_OFF_24H, REG_AUTO_OFF, REG_LEGIO}
REG_SPACE = 1000


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
        # Configuration
        self.input_setting = 0b11100     # 502 : bit2 injection, bit3 consigne, bit4 étage
        self.auto_off = 0b01             # 504 : bit0 arrêt après 60 s, bit1 redémarrage
        self.auto_off_24h = 24           # 503 (heures, 0 = désactivé)
        self.legio_temp = 60             # 510
        self.thermostat_max = 65.0       # thermostat interne (réglage mécanique)
        # Entrées physiques simulées
        self.emergency_until = None      # temps simulé
        self.hp_request = False
        self.hp_power_w = 3500
        self.compensate = True           # ajoute la charge simulée à la valeur d'injection
        # Modèle thermique
        self.tank_l = TANK_LITERS
        self.t_low = START_TEMP          # sonde 0, dans la bride (bas)
        self.t_up = START_TEMP + 3       # sonde 1, doigt de gant haut (option)
        self.t_cold = 10.0
        self.t_amb = 20.0
        self.draw_lpm = 0.0
        self.speed = 1.0
        # État
        self.sim_time = 0.0
        self.step = 0
        self.mode = "arrêt"
        self.thermostat_cut = False
        self.on_since = None             # temps simulé
        self.energy_wh = 0.0
        self.clients: dict[str, dict] = {}
        self.events = deque(maxlen=60)
        self.history = deque(maxlen=600)
        self.started = time.time()
        self.event("Simulateur démarré")

    # ------------------------------------------------------------------ utils
    def event(self, msg: str, src: str = "sim"):
        self.events.appendleft({"t": time.strftime("%H:%M:%S"), "src": src, "msg": msg})
        log.info("[%s] %s", src, msg)

    @property
    def load_w(self) -> int:
        return self.step * STEP_W

    def relays(self) -> list[bool]:
        return [bool(self.step & (1 << i)) for i in range(3)]

    def emergency(self) -> bool:
        return self.emergency_until is not None and self.sim_time < self.emergency_until

    def clear_commands(self, why: str):
        self.cmd_step = self.cmd_setpoint = self.cmd_feedin = 0
        self.feedin_active = False
        self.last_cmd_write = None
        self.event(f"Registres 200-202 effacés ({why})")

    # --------------------------------------------------------------- pilotage
    def decide_step(self) -> tuple[int, str]:
        if self.emergency():
            return MAX_STEP, "secours (100 % pendant 24 h)"
        if self.hp_request:
            return min(MAX_STEP, self.hp_power_w // STEP_W), "contact « Heatpump Request »"
        if self.input_setting & (1 << 4) and self.cmd_step & 0x7:
            return self.cmd_step & 0x7, "étage imposé (reg. 200)"
        if self.input_setting & (1 << 3) and self.cmd_setpoint > 0:
            sp = max(0, min(self.cmd_setpoint, MAX_STEP * STEP_W))
            return sp // STEP_W, "consigne de puissance (reg. 201)"
        if self.input_setting & (1 << 2) and self.feedin_active:
            # Valeur d'injection : négatif = on injecte sur le réseau.
            # Si la mesure envoyée ne contient pas le corps de chauffe simulé
            # (cas d'un vrai compteur pendant un test), on l'ajoute.
            eff = self.cmd_feedin + (self.load_w if self.compensate else 0)
            available = self.load_w - eff
            return max(0, min(MAX_STEP, math.floor(available / STEP_W))), "injection (reg. 202)"
        return 0, "arrêt"

    def tick(self, dt_real: float):
        dt = dt_real * self.speed
        self.sim_time += dt

        # Watchdog Modbus (temps réel, comme l'appareil)
        if (self.auto_off & 1 and self.last_cmd_write is not None
                and time.monotonic() - self.last_cmd_write > WATCHDOG_S):
            self.clear_commands("watchdog : 60 s sans écriture")

        if self.emergency_until is not None and not self.emergency():
            self.emergency_until = None
            self.event("Fin du mode secours")

        step, mode = self.decide_step()

        # Thermostat interne sur la sonde de la bride
        if self.thermostat_cut and self.t_low < self.thermostat_max - THERMOSTAT_HYST:
            self.thermostat_cut = False
            self.event("Thermostat : réenclenchement")
        if not self.thermostat_cut and self.t_low >= self.thermostat_max:
            self.thermostat_cut = True
            self.event(f"Thermostat : coupure à {self.thermostat_max:.0f} °C")
        if self.thermostat_cut and step:
            step, mode = 0, mode + " — coupé par le thermostat"

        # Arrêt automatique après 24 h de chauffe continue (reg. 503)
        if step and self.on_since is None:
            self.on_since = self.sim_time
        elif not step:
            self.on_since = None
        limit = self.auto_off_24h * 3600 if self.auto_off_24h else None
        if limit and self.on_since is not None and self.sim_time - self.on_since >= limit \
                and not self.emergency():
            self.clear_commands(f"{self.auto_off_24h} h de chauffe continue")
            self.on_since = None
            step, mode = 0, "arrêt (limite de chauffe continue)"

        if step != self.step:
            self.event(f"Étage {self.step} → {step} ({step * STEP_W} W) — {mode}")
        self.step, self.mode = step, mode

        self.thermal(dt)

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
        # Soutirage : l'eau chaude sort en haut, l'eau froide entre en bas
        if self.draw_lpm > 0:
            frac = min(1.0, self.draw_lpm / 60.0 * dt / m)
            self.t_up += frac * (self.t_low - self.t_up)
            self.t_low += frac * (self.t_cold - self.t_low)
        # Pertes statiques (~1.5 kWh/24 h à 60 °C pour 300 L)
        ua = 1.6 * self.tank_l / 300.0 / 2.0         # W/K par couche
        self.t_low -= ua * (self.t_low - self.t_amb) * dt / (m * c)
        self.t_up -= ua * (self.t_up - self.t_amb) * dt / (m * c)

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
        r = self.relays()
        flags = (r[0] << 0) | (r[1] << 1) | (r[2] << 2)
        flags |= (self.emergency() << 3) | (self.hp_request << 4)
        flags |= (self.thermostat_cut << 5)
        return flags

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
        if a in (109, 624):
            return self.status_flags()
        if a in (110, 625):
            return self.load_w
        if a in (REG_STEP, REG_EM_STEP):
            return self.cmd_step
        if a in (REG_SETPOINT, REG_EM_SETPOINT):
            return u16(self.cmd_setpoint)
        if a in (REG_FEEDIN, REG_EM_FEEDIN):
            return u16(self.cmd_feedin)
        if a == 325 or a == 326:                     # sonde 0 en float32
            return f32_words(sv[0])[a - 325]
        if a == REG_INPUT_SETTING:
            return self.input_setting
        if a == REG_AUTO_OFF_24H:
            return self.auto_off_24h
        if a == REG_AUTO_OFF:
            return self.auto_off
        if a == REG_LEGIO:
            return self.legio_temp
        if a == 631:
            return 0
        if a == 632:                                 # sondes présentes
            return sum(1 << i for i, v in enumerate(s) if v is not None)
        if 634 <= a <= 638:                          # sondes 4..0, entier
            return u16(round(sv[4 - (a - 634)]))
        if 706 <= a <= 715:                          # sondes 4..0, float32
            idx = 4 - (a - 706) // 2
            return f32_words(sv[idx])[(a - 706) % 2]
        if a in (716, 717):                          # tension entrée 0-10 V
            return f32_words(0.0)[a - 716]
        return 0

    def write_reg(self, a: int, v: int, src: str) -> bool:
        if a not in WRITABLE:
            return False
        if a in (REG_STEP, REG_EM_STEP):
            self.cmd_step = v & 0x7
            self.last_cmd_write = time.monotonic()
            self.event(f"Écriture reg. {a} = {v & 0x7} (étage)", src)
        elif a in (REG_SETPOINT, REG_EM_SETPOINT):
            self.cmd_setpoint = s16(v)
            self.last_cmd_write = time.monotonic()
            self.event(f"Écriture reg. {a} = {s16(v)} W (consigne)", src)
        elif a in (REG_FEEDIN, REG_EM_FEEDIN):
            self.cmd_feedin = s16(v)
            self.feedin_active = True
            self.last_cmd_write = time.monotonic()
            self.event(f"Écriture reg. {a} = {s16(v)} W (injection)", src)
        elif a == REG_INPUT_SETTING:
            self.input_setting = v & 0xFFFF
            self.event(f"Écriture reg. 502 = {v:#07b} (entrées autorisées)", src)
        elif a == REG_AUTO_OFF_24H:
            self.auto_off_24h = v & 0xFF
            self.event(f"Écriture reg. 503 = {v & 0xFF} h", src)
        elif a == REG_AUTO_OFF:
            self.auto_off = v & 0x3
            self.event(f"Écriture reg. 504 = {v & 0x3:#04b} (arrêt auto)", src)
        elif a == REG_LEGIO:
            self.legio_temp = max(50, min(65, v & 0xFF))
            self.event(f"Écriture reg. 510 = {self.legio_temp} °C", src)
        return True

    # ------------------------------------------------------------ interface
    def control(self, d: dict):
        if "draw_lpm" in d:
            self.draw_lpm = max(0.0, min(30.0, float(d["draw_lpm"])))
        if "t_cold" in d:
            self.t_cold = max(2.0, min(25.0, float(d["t_cold"])))
        if "speed" in d:
            self.speed = max(0.1, min(3600.0, float(d["speed"])))
        if "compensate" in d:
            self.compensate = bool(d["compensate"])
        if "thermostat_max" in d:
            self.thermostat_max = max(40.0, min(85.0, float(d["thermostat_max"])))
        if "hp_request" in d:
            self.hp_request = bool(d["hp_request"])
            self.event(f"Contact PAC {'fermé' if self.hp_request else 'ouvert'}", "web")
        if "hp_power_w" in d:
            self.hp_power_w = max(0, min(3500, int(d["hp_power_w"])))
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
        if "write" in d:
            for a, v in d["write"].items():
                if not self.write_reg(int(a), u16(int(v)), "web"):
                    self.event(f"Refus : reg. {a} non inscriptible", "web")

    def state(self) -> dict:
        wd = None
        if self.auto_off & 1 and self.last_cmd_write is not None:
            wd = max(0.0, WATCHDOG_S - (time.monotonic() - self.last_cmd_write))
        regs = {a: self.read_reg(a) for a in
                (100, 102, 108, 109, 110, 200, 201, 202, 502, 503, 504, 510, 632)}
        return {
            "step": self.step, "load_w": self.load_w, "relays": self.relays(),
            "mode": self.mode, "thermostat_cut": self.thermostat_cut,
            "thermostat_max": self.thermostat_max,
            "t_low": round(self.t_low, 2), "t_up": round(self.t_up, 2),
            "t_cold": self.t_cold, "draw_lpm": self.draw_lpm, "speed": self.speed,
            "tank_l": self.tank_l, "litres_40": round(self.litres_40()),
            "energy_kwh": round(self.energy_wh / 1000, 3),
            "cmd": {"step": self.cmd_step, "setpoint": self.cmd_setpoint,
                    "feedin": self.cmd_feedin, "feedin_active": self.feedin_active},
            "watchdog_s": None if wd is None else round(wd, 1),
            "input_setting": self.input_setting, "auto_off": self.auto_off,
            "emergency": self.emergency(),
            "emergency_left_h": round((self.emergency_until - self.sim_time) / 3600, 1)
            if self.emergency() else 0,
            "hp_request": self.hp_request, "hp_power_w": self.hp_power_w,
            "compensate": self.compensate,
            "clients": list(self.clients.values()),
            "sim_time_h": round(self.sim_time / 3600, 3),
            "registers": regs, "events": list(self.events),
            "history": list(self.history),
            "modbus_port": MODBUS_PORT,
        }


SIM = Simulator()


# ======================================================================= Modbus
def exc(fc: int, code: int) -> bytes:
    return bytes([fc | 0x80, code])


def handle_pdu(pdu: bytes, src: str) -> bytes:
    if not pdu:
        return exc(0, 1)
    fc = pdu[0]
    try:
        if fc in (3, 4):
            addr, count = struct.unpack(">HH", pdu[1:5])
            if not 1 <= count <= 125:
                return exc(fc, 3)
            if addr + count > REG_SPACE:
                return exc(fc, 2)
            vals = [SIM.read_reg(a) for a in range(addr, addr + count)]
            return bytes([fc, 2 * count]) + struct.pack(f">{count}H", *vals)
        if fc == 6:
            addr, val = struct.unpack(">HH", pdu[1:5])
            if not SIM.write_reg(addr, val, src):
                return exc(fc, 2)
            return pdu[:5]
        if fc == 16:
            addr, count, bc = struct.unpack(">HHB", pdu[1:6])
            if not 1 <= count <= 123 or bc != 2 * count:
                return exc(fc, 3)
            if any(a not in WRITABLE for a in range(addr, addr + count)):
                return exc(fc, 2)
            vals = struct.unpack(f">{count}H", pdu[6:6 + bc])
            for i, v in enumerate(vals):
                SIM.write_reg(addr + i, v, src)
            return bytes([16]) + struct.pack(">HH", addr, count)
    except struct.error:
        return exc(fc, 3)
    return exc(fc, 1)


async def modbus_conn(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    peer = writer.get_extra_info("peername")
    key = f"{peer[0]}:{peer[1]}" if peer else "?"
    if len(SIM.clients) >= MAX_CLIENTS:
        SIM.event(f"Connexion refusée ({MAX_CLIENTS} clients max) : {key}", "modbus")
        writer.close()
        return
    SIM.clients[key] = {"peer": key, "since": time.strftime("%H:%M:%S"), "requests": 0}
    SIM.event(f"Client connecté : {key}", "modbus")
    try:
        while True:
            hdr = await reader.readexactly(7)
            tid, pid, length, unit = struct.unpack(">HHHB", hdr)
            if pid != 0 or not 2 <= length <= 260:
                break
            pdu = await reader.readexactly(length - 1)
            SIM.clients[key]["requests"] += 1
            resp = handle_pdu(pdu, key.split(":")[0])
            writer.write(struct.pack(">HHHB", tid, 0, len(resp) + 1, unit) + resp)
            await writer.drain()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        SIM.clients.pop(key, None)
        SIM.event(f"Client déconnecté : {key}", "modbus")
        writer.close()


# ========================================================================= HTTP
INDEX = Path(__file__).with_name("index.html")


async def http_conn(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        line = await asyncio.wait_for(reader.readline(), 10)
        parts = line.decode("latin-1").split()
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1].split("?")[0]
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
        if method == "GET" and path in ("/", "/index.html"):
            ctype, out = "text/html; charset=utf-8", INDEX.read_bytes()
        elif method == "GET" and path == "/api/state":
            out = json.dumps(SIM.state()).encode()
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
                                "w": SIM.load_w})


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    mb = await asyncio.start_server(modbus_conn, "0.0.0.0", MODBUS_PORT)
    web = await asyncio.start_server(http_conn, "0.0.0.0", HTTP_PORT)
    log.info("Modbus TCP sur le port %d, interface web sur http://0.0.0.0:%d/",
             MODBUS_PORT, HTTP_PORT)
    async with mb, web:
        await asyncio.gather(mb.serve_forever(), web.serve_forever(), sim_loop())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
