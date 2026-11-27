"""
Profil de ménage pour le simulateur ASKOHEAT+ : puisages d'eau chaude, consommation
électrique de la maison et production photovoltaïque, en fonction de l'heure simulée.

Tout est déterministe pour une graine et un jour donnés : le même jour simulé produit
les mêmes puisages, quelle que soit la vitesse de simulation.

Bibliothèque standard uniquement.
"""

import math
import random
from datetime import datetime, timedelta

T_TAP = 40.0          # température d'usage au robinet (°C)
LAT = 46.8            # latitude (Plateau suisse)

# Débits à 40 °C au robinet (L/min)
SHOWER_LPM = {"eco": 6.0, "standard": 9.0, "pluie": 12.0}
# Heure du lever selon le mode de vie (h), décalée le week-end si demandé
WAKE = {"tot": 6.0, "standard": 7.0, "tard": 8.5}

PRESETS = {
    "couple": {"adults": 2, "children": 0, "shower": "standard", "shower_min": 7,
               "baths_week": 0, "lifestyle": "standard", "homeoffice": False},
    "famille3": {"adults": 2, "children": 1, "shower": "standard", "shower_min": 7,
                 "baths_week": 2, "lifestyle": "standard", "homeoffice": False},
    "famille5": {"adults": 2, "children": 3, "shower": "standard", "shower_min": 6,
                 "baths_week": 4, "lifestyle": "tot", "homeoffice": False},
    "senior": {"adults": 2, "children": 0, "shower": "eco", "shower_min": 6,
               "baths_week": 1, "lifestyle": "standard", "homeoffice": True},
}

DEFAULT_PROFILE = {
    "preset": "famille3",
    "enabled": True,          # génère les puisages
    "adults": 2,
    "children": 1,
    "shower": "standard",     # eco / standard / pluie
    "shower_min": 7,          # durée d'une douche d'adulte (min)
    "evening_share": 0.3,     # part des douches prises le soir
    "baths_week": 2,
    "dishwasher_hot": False,  # lave-vaisselle raccordé à l'eau chaude
    "washer_hot": False,      # lave-linge raccordé à l'eau chaude
    "lifestyle": "standard",  # tot / standard / tard
    "homeoffice": False,      # présence en journée (repas de midi, consommation)
    "weekend_late": True,     # lever 1 h 30 plus tard le week-end
    "away": False,            # vacances : plus de puisages, consommation de veille
    "garden": "aucun",        # aucun / arrosage / piscine
    # Variante maison + PV (utilisée quand le simulateur fournit lui-même la valeur d'injection)
    "pv_kwp": 10.0,
    "pv_orientation": "sud",  # sud / est-ouest
    "weather": "variable",    # soleil / variable / couvert
    "base_w": 250,            # veille, frigo, réseau…
    "seed": 42,
}

INT_KEYS = {"adults": (0, 8), "children": (0, 8), "shower_min": (2, 30), "baths_week": (0, 14),
            "base_w": (0, 3000), "seed": (0, 999999)}
FLOAT_KEYS = {"evening_share": (0.0, 1.0), "pv_kwp": (0.0, 30.0)}
BOOL_KEYS = {"enabled", "dishwasher_hot", "washer_hot", "homeoffice", "weekend_late", "away"}
CHOICES = {"shower": set(SHOWER_LPM), "lifestyle": set(WAKE), "garden": {"aucun", "arrosage", "piscine"},
           "pv_orientation": {"sud", "est-ouest"}, "weather": {"soleil", "variable", "couvert"},
           "preset": set(PRESETS) | {"perso"}}


class Household:
    def __init__(self, tz):
        self.tz = tz
        self.p = dict(DEFAULT_PROFILE)
        self.start = datetime.now(tz).replace(second=0, microsecond=0)
        self._days: dict[int, dict] = {}

    # -------------------------------------------------------------- réglages
    def update(self, d: dict) -> list[str]:
        """Applique des réglages (validés). Renvoie la liste des clés modifiées."""
        changed = []
        if d.get("preset") in PRESETS:
            self.p.update(PRESETS[d["preset"]])
            self.p["preset"] = d["preset"]
            changed.append("preset")
        for k, v in d.items():
            if k == "preset":
                continue
            if k in INT_KEYS:
                lo, hi = INT_KEYS[k]
                v = max(lo, min(hi, int(v)))
            elif k in FLOAT_KEYS:
                lo, hi = FLOAT_KEYS[k]
                v = max(lo, min(hi, float(v)))
            elif k in BOOL_KEYS:
                v = bool(v)
            elif k in CHOICES:
                if v not in CHOICES[k]:
                    continue
            else:
                continue
            if self.p.get(k) != v:
                self.p[k] = v
                changed.append(k)
                if k in PRESETS["couple"]:          # une valeur d'un préréglage modifiée à la main
                    self.p["preset"] = "perso"
        if changed:
            self._days.clear()
        return changed

    def set_start(self, iso: str):
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=self.tz)
        self.start = dt
        self._days.clear()

    # -------------------------------------------------------------- horloge
    def now(self, sim_time: float) -> datetime:
        return self.start + timedelta(seconds=sim_time)

    def _day_index(self, dt: datetime) -> int:
        return (dt.date() - self.start.date()).days

    # -------------------------------------------------------------- programme du jour
    def _day(self, dt: datetime) -> dict:
        """Puisages et appareils d'une journée (cache par jour simulé)."""
        idx = self._day_index(dt)
        if idx in self._days:
            return self._days[idx]
        if len(self._days) > 8:
            self._days.clear()
        p = self.p
        rnd = random.Random(f"{p['seed']}-{dt.date().isoformat()}")
        weekend = dt.weekday() >= 5
        home_day = p["homeoffice"] or weekend
        wake = WAKE[p["lifestyle"]] + (1.5 if weekend and p["weekend_late"] else 0.0)
        draws = []    # (début s, durée s, L/min à 40 °C, libellé)
        loads = []    # (début s, durée s, W, libellé)

        def add_draw(h, minutes, lpm, label):
            draws.append((max(0.0, h * 3600), max(30.0, minutes * 60), lpm, label))

        def add_load(h, minutes, w, label):
            loads.append((max(0.0, h * 3600), minutes * 60, w, label))

        if not p["away"]:
            flow = SHOWER_LPM[p["shower"]]
            persons = [("adulte", p["shower_min"]) for _ in range(p["adults"])] + \
                      [("enfant", max(3, p["shower_min"] - 2)) for _ in range(p["children"])]
            morning_slot = wake + 0.1
            for who, dur in persons:
                # Un adulte se douche presque tous les jours, un enfant un jour sur deux environ
                if rnd.random() > (0.95 if who == "adulte" else 0.55):
                    continue
                dur = dur * rnd.uniform(0.8, 1.25)
                if rnd.random() < p["evening_share"]:
                    add_draw(rnd.uniform(19.5, 22.0), dur, flow, f"douche ({who})")
                else:
                    add_draw(morning_slot, dur, flow, f"douche ({who})")
                    morning_slot += dur / 60 + rnd.uniform(0.05, 0.3)
            # Bains : répartis sur la semaine, plutôt le soir
            if p["baths_week"] and rnd.random() < p["baths_week"] / 7:
                add_draw(rnd.uniform(18.5, 20.5), 12, 12.0, "bain (140 L)")
            # Lavabo : quelques petits puisages par personne
            n = p["adults"] + p["children"]
            for _ in range(n * 2):
                h = rnd.choice([wake + rnd.uniform(0, 1), rnd.uniform(12, 13.5) if home_day else wake + 0.5,
                                rnd.uniform(18, 22.5)])
                add_draw(h, rnd.uniform(0.3, 1.0), 4.0, "lavabo")
            # Cuisine : vaisselle à la main, cuisson
            for h in ([12.2] if home_day else []) + [19.3]:
                add_draw(h + rnd.uniform(0, 0.4), rnd.uniform(1, 3), 5.0, "évier")
                add_load(h - 0.6 + rnd.uniform(-0.1, 0.1), rnd.uniform(25, 45), 2200, "cuisson")
            add_load(wake + 0.2, 10, 1500, "petit-déjeuner")
            # Lave-vaisselle : tous les jours dès 3 personnes, sinon un jour sur deux
            if n >= 3 or rnd.random() < 0.5:
                h = rnd.uniform(20.5, 21.5)
                if p["dishwasher_hot"]:
                    add_draw(h, 4, 3.0, "lave-vaisselle (eau chaude)")
                    add_load(h, 60, 500, "lave-vaisselle")
                else:
                    add_load(h, 60, 1300, "lave-vaisselle")
            # Lave-linge : environ une machine par personne et par semaine
            if rnd.random() < min(1.0, n / 7 * 1.3):
                h = rnd.uniform(9, 11) if home_day else rnd.uniform(18, 19)
                if p["washer_hot"]:
                    add_draw(h, 5, 3.0, "lave-linge (eau chaude)")
                    add_load(h, 90, 600, "lave-linge")
                else:
                    add_load(h, 90, 1200, "lave-linge")
            # Présence le soir (éclairage, TV…) et en journée si télétravail
            add_load(17.5, 330, 250, "soirée")
            if home_day:
                add_load(8.5, 540, 150, "présence en journée")
        # Jardin : l'arrosage est fait à l'eau froide, seule la pompe consomme de l'électricité
        summer = dt.month in (5, 6, 7, 8, 9)
        if p["garden"] == "piscine" and summer:
            add_load(10, 480, 750, "pompe de piscine")
        if p["garden"] == "arrosage" and summer and not p["away"]:
            add_load(20.5, 45, 600, "pompe d'arrosage")

        # Nuages : un facteur toutes les 10 min, interpolé
        clouds = [rnd.random() for _ in range(24 * 6 + 1)]
        day = {"draws": sorted(draws), "loads": loads, "clouds": clouds}
        self._days[idx] = day
        return day

    # -------------------------------------------------------------- valeurs instantanées
    def tap_lpm(self, dt: datetime) -> tuple[float, list[str]]:
        """Débit demandé à 40 °C au robinet et libellés des puisages en cours."""
        if not self.p["enabled"]:
            return 0.0, []
        s = dt.hour * 3600 + dt.minute * 60 + dt.second
        q, labels = 0.0, []
        for start, dur, lpm, label in self._day(dt)["draws"]:
            if start <= s < start + dur:
                q += lpm
                labels.append(label)
        return q, labels

    def house_w(self, dt: datetime) -> tuple[float, list[str]]:
        s = dt.hour * 3600 + dt.minute * 60 + dt.second
        w = self.p["base_w"] * (0.6 if self.p["away"] else 1.0)
        labels = []
        for start, dur, pw, label in self._day(dt)["loads"]:
            if start <= s < start + dur:
                w += pw
                labels.append(label)
        return w, labels

    def pv_w(self, dt: datetime) -> float:
        """Production PV : position du soleil + orientation + météo (modèle simple)."""
        if self.p["pv_kwp"] <= 0:
            return 0.0
        doy = dt.timetuple().tm_yday
        decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + doy) / 365)
        # heure solaire ≈ heure légale − décalage UTC − 0.5 h (longitude ~7.5° E)
        off = dt.utcoffset().total_seconds() / 3600 if dt.utcoffset() else 1.0
        solar_h = dt.hour + dt.minute / 60 + dt.second / 3600 - off + 0.5
        ha = math.radians(15 * (solar_h - 12))
        lat = math.radians(LAT)
        sin_el = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)
        if sin_el <= 0.02:
            return 0.0
        # Irradiance en ciel clair ~ sin(élévation) avec atténuation atmosphérique
        clear = 1000 * sin_el * 0.75 ** (1 / max(sin_el, 0.05) ** 0.678) / 0.75
        clear = min(clear, 1000)
        if self.p["pv_orientation"] == "sud":
            # plan incliné à ~30° plein sud : gain en mi-saison, cos de l'angle d'incidence simplifié
            gain = 1.0 + 0.25 * math.cos(ha) * (1 - sin_el)
        else:
            # est-ouest : courbe plus large, pic plus bas
            gain = 0.85 + 0.2 * abs(math.sin(ha))
        cloud = self._cloud(dt)
        return max(0.0, self.p["pv_kwp"] * clear * gain * cloud * 0.8)   # 0.85 : pertes onduleur, câbles, température

    def _cloud(self, dt: datetime) -> float:
        weather = self.p["weather"]
        if weather == "soleil":
            return 1.0
        c = self._day(dt)["clouds"]
        x = (dt.hour * 60 + dt.minute + dt.second / 60) / 10
        i = int(x)
        r = c[i] + (c[min(i + 1, len(c) - 1)] - c[i]) * (x - i)
        if weather == "couvert":
            return 0.12 + 0.18 * r
        return 0.25 + 0.75 * (r ** 0.6)        # variable : passages nuageux

    def schedule(self, dt: datetime) -> list[dict]:
        """Puisages du jour (pour l'interface)."""
        out = []
        for start, dur, lpm, label in self._day(dt)["draws"]:
            h = int(start // 3600)
            m = int(start % 3600 // 60)
            out.append({"h": f"{h:02d}:{m:02d}", "label": label, "min": round(dur / 60, 1),
                        "litres": round(lpm * dur / 60)})
        return out

    def state(self) -> dict:
        return dict(self.p)


def tank_flow(tap_lpm: float, t_hot: float, t_cold: float) -> tuple[float, bool]:
    """Débit tiré au chauffe-eau pour fournir tap_lpm à 40 °C.
    Renvoie (débit, eau trop froide). Si l'eau du haut est sous 40 °C, tout le débit
    vient du chauffe-eau et l'usager a froid."""
    if tap_lpm <= 0:
        return 0.0, False
    if t_hot <= T_TAP + 0.5:
        return tap_lpm, True
    return tap_lpm * (T_TAP - t_cold) / (t_hot - t_cold), False
