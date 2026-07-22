#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
╔══════════════════════════════════════════════════════════════╗
║   TUUCH QUALITY — AquaMonitor Simulator                      ║
║   Simula escenarios de calidad del agua con animaciones      ║
║   reales (ease-in-out) y micro-fluctuaciones naturales       ║
╠══════════════════════════════════════════════════════════════╣
║  Uso:                                                        ║
║    pip install flask flask-cors                              ║
║    python thonny_aquamonitor.py                              ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /estado              → valores actuales              ║
║    GET  /escenario/<nombre>  → cambia escenario              ║
║    GET  /escenarios          → lista todos los escenarios    ║
╚══════════════════════════════════════════════════════════════╝
"""

from flask import Flask, jsonify
from flask_cors import CORS
import threading
import time
import math
import random

app = Flask(__name__)
CORS(app)   # Permite peticiones desde el dashboard

# ══════════════════════════════════════════════════════════════
#  ESCENARIOS  (valores objetivo para cada parámetro)
# ══════════════════════════════════════════════════════════════
ESCENARIOS = {
    "limpia": {
        "nombre":      "Agua Limpia",
        "descripcion": "Agua potable de alta calidad · dentro de normas",
        "ph":            7.20,
        "temperatura":  20.00,
        "orp":          310.00,
        "conductividad":350.00,
        "turbidez":      0.50,
        "oxigeno":       9.20,
    },
    "contaminada": {
        "nombre":      "Agua Contaminada",
        "descripcion": "Presencia de contaminantes orgánicos · peligrosa",
        "ph":            5.80,
        "temperatura":  24.00,
        "orp":           50.00,
        "conductividad":1100.00,
        "turbidez":     12.00,
        "oxigeno":       3.50,
    },
    "eutro": {
        "nombre":      "Eutrofización",
        "descripcion": "Exceso de nutrientes · bloom de algas",
        "ph":            9.20,
        "temperatura":  26.00,
        "orp":          -50.00,
        "conductividad": 620.00,
        "turbidez":      8.50,
        "oxigeno":       1.80,
    },
    "tratada": {
        "nombre":      "Agua Tratada",
        "descripcion": "Post-tratamiento · apta para consumo humano",
        "ph":            7.50,
        "temperatura":  19.00,
        "orp":          330.00,
        "conductividad": 280.00,
        "turbidez":      0.15,
        "oxigeno":       9.80,
    },
    "lluvia": {
        "nombre":      "Escorrentía de Lluvia",
        "descripcion": "Arrastre de sólidos post-lluvia · turbidez alta",
        "ph":            6.20,
        "temperatura":  16.00,
        "orp":          185.00,
        "conductividad": 120.00,
        "turbidez":      6.20,
        "oxigeno":       8.50,
    },
    "industrial": {
        "nombre":      "Descarga Industrial",
        "descripcion": "Contaminación severa · efluentes industriales",
        "ph":            4.50,
        "temperatura":  32.00,
        "orp":         -200.00,
        "conductividad":1400.00,
        "turbidez":     18.00,
        "oxigeno":       1.20,
    },
}

PARAMS = ["ph", "temperatura", "orp", "conductividad", "turbidez", "oxigeno"]

ANIM_DURATION = 8.0   # segundos de transición ease-in-out

# ══════════════════════════════════════════════════════════════
#  ESTADO INTERNO
# ══════════════════════════════════════════════════════════════
lock = threading.Lock()

_escenario_actual = "limpia"
_animando         = False
_descripcion      = ESCENARIOS["limpia"]["descripcion"]
_current   = {p: ESCENARIOS["limpia"][p] for p in PARAMS}
_start     = {p: ESCENARIOS["limpia"][p] for p in PARAMS}
_target    = {p: ESCENARIOS["limpia"][p] for p in PARAMS}
_anim_t0   = None


# ══════════════════════════════════════════════════════════════
#  FUNCIONES DE ANIMACIÓN
# ══════════════════════════════════════════════════════════════

def ease_in_out_cubic(t: float) -> float:
    """Curva cúbica ease-in-out: t ∈ [0,1] → [0,1]"""
    t = max(0.0, min(1.0, t))
    return t * t * (3.0 - 2.0 * t)


def micro_noise(valor: float, pct: float = 0.004) -> float:
    """Añade ±pct% de ruido aleatorio para simular sensor real."""
    return valor * (1.0 + random.uniform(-pct, pct))


def animation_loop():
    """Hilo de fondo: actualiza _current cada 100 ms."""
    global _animando, _anim_t0

    while True:
        time.sleep(0.1)

        with lock:
            if _animando:
                elapsed  = time.time() - _anim_t0
                progress = elapsed / ANIM_DURATION

                if progress >= 1.0:
                    # Animación terminada → estabilizar
                    _animando = False
                    for p in PARAMS:
                        _current[p] = micro_noise(_target[p], 0.003)
                        _target[p]  = ESCENARIOS[_escenario_actual][p]
                else:
                    t = ease_in_out_cubic(progress)
                    for p in PARAMS:
                        interp      = _start[p] + (_target[p] - _start[p]) * t
                        _current[p] = micro_noise(interp, 0.002)

            else:
                # Estabilizado: micro-fluctuaciones naturales ±0.3%
                for p in PARAMS:
                    _current[p] = micro_noise(_target[p], 0.003)


# ══════════════════════════════════════════════════════════════
#  ENDPOINTS
# ══════════════════════════════════════════════════════════════

@app.route("/estado")
def estado():
    """Devuelve los valores actuales (animados o estabilizados)."""
    with lock:
        return jsonify({
            "escenario":   _escenario_actual,
            "animando":    _animando,
            "descripcion": _descripcion,
            **{p: round(_current[p], 3) for p in PARAMS},
        })


@app.route("/escenario/<nombre>")
def cambiar_escenario(nombre):
    """Inicia una transición ease-in-out hacia el escenario indicado."""
    global _escenario_actual, _animando, _anim_t0, _descripcion

    if nombre not in ESCENARIOS:
        return jsonify({"ok": False, "error": f"Escenario '{nombre}' no existe"}), 404

    with lock:
        esc = ESCENARIOS[nombre]

        # Capturar valores actuales como punto de inicio
        for p in PARAMS:
            _start[p]  = _current[p]
            _target[p] = esc[p]

        _escenario_actual = nombre
        _descripcion      = esc["descripcion"]
        _animando         = True
        _anim_t0          = time.time()

    print(f"\n[→] Escenario: {esc['nombre']} · animando {ANIM_DURATION}s…")
    return jsonify({"ok": True, "escenario": nombre, "nombre": esc["nombre"]})


@app.route("/escenarios")
def listar_escenarios():
    """Lista todos los escenarios disponibles."""
    return jsonify({k: v["nombre"] for k, v in ESCENARIOS.items()})


# ══════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    # Iniciar hilo de animación
    t = threading.Thread(target=animation_loop, daemon=True)
    t.start()

    print("\n" + "=" * 62)
    print("  TUUCH QUALITY — AquaMonitor Simulator")
    print("=" * 62)
    print("\n[OK]  Servidor de simulación iniciado")
    print("[URL] http://localhost:5050\n")
    print("[ESCENARIOS]:")
    for k, v in ESCENARIOS.items():
        print(f"   GET /escenario/{k:<14} → {v['nombre']}")
    print("\n[NOTAS]:")
    print("  • Abre el dashboard en http://localhost:5000")
    print("  • Toca 3 veces la esquina inferior derecha")
    print("  • En el panel oculto → sección SIMULADOR → Conectar")
    print("  • Luego pulsa cualquier escenario ← animación 8 s")
    print("\n" + "=" * 62 + "\n")

    app.run(host="0.0.0.0", port=5050, debug=False, threaded=True)
