"""
Blocs de registres « paramètres » (400-455) et « configuration » (500-599) de l'ASKOHEAT+ 2.0.

Disposition : table Modbus Askoma v1.16 et intégration Home Assistant toggm/askoheat (écrite
contre l'appareil réel), qui fait foi pour l'encodage :
  - chaînes : 2 caractères par mot, octet de poids FAIBLE en premier ;
  - uint32 et float32 : mot de poids fort en premier ;
  - heures : deux registres (heure, minute) ;
  - « byte » : valeur 0-255 dans le registre.

Bibliothèque standard uniquement.
"""

import struct

STEP_W = 500


def str_words(text: str, words: int) -> list[int]:
    """Chaîne -> mots Modbus (octet faible en premier), complétée par des zéros."""
    raw = text.encode("ascii", "replace")[:words * 2].ljust(words * 2, b"\0")
    return [raw[i] | raw[i + 1] << 8 for i in range(0, words * 2, 2)]


def f32_words(x: float) -> tuple[int, int]:
    """float32, mot de poids fort en premier"""
    return struct.unpack(">HH", struct.pack(">f", float(x)))


def u32_words(x: int) -> tuple[int, int]:
    x = int(x) & 0xFFFFFFFF
    return x >> 16, x & 0xFFFF


def param_block(serial: str) -> dict[int, int]:
    """Bloc 400-455 (lecture seule) : identité et caractéristiques du corps de chauffe."""
    regs: dict[int, int] = {}

    def put(addr: int, values):
        for i, v in enumerate(values):
            regs[addr + i] = v & 0xFFFF

    put(400, str_words(serial, 16))                 # 400-415 numéro de série
    put(416, [0b0000_0110])                         # type : 7 étages (bit 1), à bride (bit 2)
    put(417, [500, 1000, 2000])                     # puissance des résistances 1-3 (W)
    put(420, str_words("SIM-EHF35", 8))             # 420-427 numéro d'article
    put(428, str_words("ASKOHEAT+ 3.5kW simulateur", 16))   # 428-443 désignation
    put(444, str_words("SIM1.0", 3))                # 444-446 version logicielle
    put(447, str_words("SIM2.0", 3))                # 447-449 version matérielle
    put(450, [0, 0, 0])                             # résistances 4-6 (absentes)
    put(453, [7, 3, 3500])                          # nombre d'étages, de résistances, puissance max
    return regs


def config_defaults(tank_liters: float, household: int) -> dict[int, int]:
    """Bloc 500-599 sans les registres gérés à part par le simulateur (502, 503, 504, 510, 595)."""
    c: dict[int, int] = {a: 0 for a in range(500, 600)}

    def put(addr: int, values):
        for i, v in enumerate(values):
            c[addr + i] = int(v) & 0xFFFF

    put(500, [5])                    # anti-rebond des relais (s)
    put(501, [30])                   # post-circulation de la pompe (s)
    put(505, [0])                    # priorité en cascade
    put(506, [0b0000_0001])          # type de ballon : eau sanitaire
    put(507, [round(tank_liters)])   # volume du ballon (L)
    put(508, [0b0000_0001])          # position du corps de chauffe : en bas
    # 509 légionelles : activé (bit 13), énergie injectée préférée (bit 12), hebdomadaire (bit 9), sonde interne (bit 0)
    put(509, [1 << 13 | 1 << 12 | 1 << 9 | 1])
    put(511, [240])                  # durée max de montée en température (min)
    put(512, [12, 0])                # heure de départ préférée : 12:00
    put(520, [0b0000_0001])          # maison individuelle
    put(521, [household])            # nombre de personnes
    put(522, str_words("Simulateur de demonstration", 16))   # 522-537 texte libre
    put(539, [0])                    # délai d'enclenchement en mode injection (s)
    put(540, [0])                    # niveau d'énergie de base en mode injection (W)
    put(541, [1, 0])                 # fuseau horaire (UTC+1), heure d'été non
    put(546, str_words("19200", 3))   # 546-548 vitesse RTU (texte, valeurs de l'intégration : 1200 … 230400)
    put(550, [1])                    # adresse esclave RTU
    put(551, [0])                    # type de compteur : non installé
    put(552, [22, 0, 6, 0])          # heures creuses 22:00-06:00
    put(556, f32_words(0.2))         # hystérésis de l'entrée 0-10 V (V)
    # 8 seuils 0-10 V : tension, étage, limite de température — répartis de 0 à 10 V, étages 0 à 7
    for k in range(8):
        a = 558 + 4 * k
        put(a, f32_words(round(k * 10 / 7, 2)))
        put(a + 2, [k, 65])
    put(590, [0, 7, 7])              # étage contact PAC ouvert / fermé, étage secours
    put(593, [3])                    # hystérésis de température (°C)
    put(594, [0b0000_0001])          # régulation sur la sonde interne
    put(596, [65, 65, 60, 70])       # limites : étage, consigne/injection, heures creuses, PAC/secours
    return c


def f32_from(c: dict[int, int], addr: int) -> float:
    return struct.unpack(">f", struct.pack(">HH", c[addr] & 0xFFFF, c[addr + 1] & 0xFFFF))[0]
