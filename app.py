#!/usr/bin/env python3
"""
TUUCH QUALITY - Water Monitoring Dashboard
LOCALHOST + ESP32 + DETECCIÓN DE DESCONEXIÓN
"""

from flask import Flask, render_template, jsonify, send_file, request, abort
from datetime import datetime
import io
import csv
import json
import os

app = Flask(__name__)

# ══════════════════════════════════════════════════════════
#  CORS
# ══════════════════════════════════════════════════════════
@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', '*')
    response.headers.add('Access-Control-Allow-Methods', '*')
    return response


# ══════════════════════════════════════════════════════════
#  ALMACENAMIENTO EN MEMORIA
# ══════════════════════════════════════════════════════════
mediciones = []
dispositivos = {}
contador_id = 0

# ── OVERRIDE: valores inyectados desde el panel oculto ────
# Se persiste en un archivo JSON para que todos los workers
# de PythonAnywhere compartan el mismo estado.
OVERRIDE_FILE = os.path.join(os.path.dirname(__file__), "override_state.json")


def _load_override():
    """Lee el estado del override desde el archivo. Devuelve (active, data)."""
    try:
        if os.path.exists(OVERRIDE_FILE):
            with open(OVERRIDE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                return state.get("active", False), state.get("data", {})
    except Exception:
        pass
    return False, {}


def _save_override(active, data):
    """Escribe el estado del override al archivo."""
    try:
        with open(OVERRIDE_FILE, "w", encoding="utf-8") as f:
            json.dump({"active": active, "data": data}, f)
    except Exception as e:
        print(f"⚠️  No se pudo guardar override: {e}")


# Compatibilidad con código legado (ya no se usan como fuente de verdad)
override_active = False
override_data   = {}


# ══════════════════════════════════════════════════════════
#  API KEY
# ══════════════════════════════════════════════════════════
API_KEY = "MI_API_KEY_123"


def check_api_key():

    key = request.headers.get("x-api-key", "")

    print(f"\n🔑 API KEY RECIBIDA: {key}")

    if key != API_KEY:
        print("❌ API KEY INVALIDA")
        abort(401, "API key inválida")

    print("✅ API KEY CORRECTA")


# ══════════════════════════════════════════════════════════
#  LIMITES
# ══════════════════════════════════════════════════════════
LIMITS = {
    "ph":            {"min": 6.5,  "max": 8.5,   "unit": ""},
    "temperatura":   {"min": 10.0, "max": 30.0,  "unit": "°C"},
    "orp":           {"min": 150,  "max": 350,   "unit": "mV"},
    "conductividad": {"min": 200,  "max": 800,   "unit": "µS/cm"},
    "turbidez":      {"min": 0.0,  "max": 4.0,   "unit": "NTU"},
    "oxigeno":       {"min": 0.0,  "max": 100.0, "unit": "%"},
}

PARAMS = [
    "ph",
    "temperatura",
    "orp",
    "conductividad",
    "turbidez",
    "oxigeno"
]


# ══════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════
def ahora():
    n = datetime.now()
    return n.strftime("%H:%M:%S"), n.strftime("%Y-%m-%d")


def estado_sensor(valor, param):

    if valor is None:
        return "sin_datos"

    lim = LIMITS.get(param, {})

    mn = lim.get("min", 0)
    mx = lim.get("max", 9999)

    if valor < mn or valor > mx:
        return "error"

    return "ok"


# ══════════════════════════════════════════════════════════
#  HOME
# ══════════════════════════════════════════════════════════
@app.route("/")
def index():
    return render_template("index.html")


# ══════════════════════════════════════════════════════════
#  RECIBIR DATOS ESP32
# ══════════════════════════════════════════════════════════
@app.route("/api/datos", methods=["POST"])
def recibir_datos():

    print("\n" + "=" * 60)
    print("📥 NUEVA PETICION ESP32")
    print("=" * 60)

    check_api_key()

    data = request.get_json(silent=True)

    print(f"📦 JSON RECIBIDO:\n{data}")

    if not data:
        print("❌ JSON INVALIDO")
        abort(400, "JSON inválido")

    global contador_id

    hora, fecha = ahora()

    id_disp = data.get("id_dispositivo", "ESP32")

    valores = {}

    for p in PARAMS:

        v = data.get(p)

        try:
            v = round(float(v), 3)
        except:
            v = 0.0

        valores[p] = v

    contador_id += 1

    registro = {
        "id": contador_id,
        "id_dispositivo": id_disp,
        "fecha": fecha,
        "hora": hora,
        **valores
    }

    mediciones.append(registro)

    # ─────────────────────────────────────────────
    # GUARDAR DISPOSITIVO
    # ─────────────────────────────────────────────
    if id_disp not in dispositivos:

        dispositivos[id_disp] = {
            "primera_vez": f"{fecha} {hora}",
            "ultima_vez": f"{fecha} {hora}",
            "lecturas": 1
        }

    else:

        dispositivos[id_disp]["ultima_vez"] = f"{fecha} {hora}"
        dispositivos[id_disp]["lecturas"] += 1

    print("\n✅ DATOS GUARDADOS:")
    print(registro)

    print("\n📊 TOTAL MEDICIONES:", len(mediciones))

    return jsonify({
        "ok": True,
        "mensaje": "Datos recibidos correctamente",
        "registro": registro
    }), 200


# ══════════════════════════════════════════════════════════
#  DATOS EN TIEMPO REAL + DETECCIÓN ESP32
# ══════════════════════════════════════════════════════════
@app.route("/api/live")
def api_live():

    # ─────────────────────────────────────────────
    # Leer override desde archivo (compartido entre workers)
    # ─────────────────────────────────────────────
    ov_active, ov_data = _load_override()

    hora_actual, fecha_actual = ahora()

    # ─────────────────────────────────────────────
    # OVERRIDE ACTIVO: devolver valores del panel oculto
    # funciona aunque no haya datos del ESP32 todavía
    # ─────────────────────────────────────────────
    if ov_active and ov_data:
        ultima = mediciones[-1] if mediciones else {}
        data_resp = {
            "id_dispositivo": ultima.get("id_dispositivo", "PANEL"),
            "fecha": fecha_actual,
            "hora": hora_actual,
            **ov_data
        }
        return jsonify({
            "ok":      True,
            "conexion": True,
            "override": True,
            "ultima_actualizacion_seg": 0,
            "data": data_resp
        })

    # ─────────────────────────────────────────────
    # SIN DATOS del ESP32 y sin override
    # ─────────────────────────────────────────────
    if not mediciones:
        return jsonify({
            "ok": False,
            "mensaje": "Sin datos",
            "conexion": False
        })

    ultima = mediciones[-1]

    # ─────────────────────────────────────────────
    # DETECTAR DESCONEXIÓN
    # ─────────────────────────────────────────────
    try:

        fecha_hora = f"{ultima['fecha']} {ultima['hora']}"

        ultima_fecha = datetime.strptime(
            fecha_hora,
            "%Y-%m-%d %H:%M:%S"
        )

        ahora_actual = datetime.now()

        diferencia = (
            ahora_actual - ultima_fecha
        ).total_seconds()

        # 15 segundos sin datos = desconectado
        conectado = diferencia <= 15

    except Exception as e:

        print("❌ ERROR conexión:", e)

        conectado = False
        diferencia = 999

    return jsonify({
        "ok": True,
        "conexion": conectado,
        "ultima_actualizacion_seg": round(diferencia, 1),
        "data": ultima
    })


# ══════════════════════════════════════════════════════════
#  OVERRIDE — panel oculto empuja valores al servidor
# ══════════════════════════════════════════════════════════
@app.route("/api/override", methods=["POST"])
def api_override():

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    # Cargar el estado previo y hacer MERGE con los nuevos valores
    # para que mover un slider no borre los otros parámetros ya configurados.
    _, prev_data = _load_override()
    valores = dict(prev_data)  # empieza con lo que ya había

    for p in PARAMS:
        v = data.get(p)
        if v is not None:
            try:
                valores[p] = round(float(v), 3)
            except:
                pass

    _save_override(True, valores)

    print(f"\n🎛  OVERRIDE ACTIVADO: {valores}")

    return jsonify({"ok": True, "override": True, "data": valores})


@app.route("/api/override/clear", methods=["POST", "GET"])
def api_override_clear():
    _save_override(False, {})
    print("\n🔄 OVERRIDE DESACTIVADO — volviendo a datos del ESP32")
    return jsonify({"ok": True, "override": False})


# ══════════════════════════════════════════════════════════
#  HISTORIAL
# ══════════════════════════════════════════════════════════
@app.route("/api/history")
def api_history():
    return jsonify(mediciones[::-1])


# ══════════════════════════════════════════════════════════
#  DISPOSITIVOS
# ══════════════════════════════════════════════════════════
@app.route("/api/devices")
def api_devices():
    return jsonify(dispositivos)


# ══════════════════════════════════════════════════════════
#  LIMITES
# ══════════════════════════════════════════════════════════
@app.route("/api/limits")
def api_limits():
    return jsonify(LIMITS)


# ══════════════════════════════════════════════════════════
#  LIMPIAR DATOS
# ══════════════════════════════════════════════════════════
@app.route("/api/clear")
def api_clear():

    global mediciones
    global dispositivos
    global contador_id

    mediciones = []
    dispositivos = {}
    contador_id = 0

    print("\n🗑️ MEMORIA LIMPIADA")

    return jsonify({
        "ok": True,
        "mensaje": "Datos eliminados"
    })


# ══════════════════════════════════════════════════════════
#  STATS
# ══════════════════════════════════════════════════════════
@app.route("/api/stats")
def api_stats():

    return jsonify({
        "total_registros": len(mediciones),
        "dispositivos": len(dispositivos)
    })


# ══════════════════════════════════════════════════════════
#  DESCARGA CSV
# ══════════════════════════════════════════════════════════
@app.route("/api/download")
def api_download():

    campos = [
        "id",
        "hora",
        "fecha",
        "id_dispositivo"
    ] + PARAMS

    si = io.StringIO()

    w = csv.DictWriter(
        si,
        fieldnames=campos,
        extrasaction="ignore"
    )

    w.writeheader()
    w.writerows(mediciones)

    output = io.BytesIO(
        si.getvalue().encode("utf-8")
    )

    return send_file(
        output,
        mimetype="text/csv",
        as_attachment=True,
        download_name="TUUCH_DATA.csv"
    )


# ══════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════
if __name__ == "__main__":

    import socket, sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        LOCAL_IP = s.getsockname()[0]
        s.close()
    except Exception:
        LOCAL_IP = "127.0.0.1"

    print("\n" + "=" * 60)
    print(" TUUCH QUALITY DASHBOARD LOCALHOST")
    print("=" * 60)
    print("\n[OK] Flask iniciado correctamente")

    print("\n[WEB] URLs del Dashboard:")
    print(f"   Local  -> http://127.0.0.1:5000")
    print(f"   Red    -> http://{LOCAL_IP}:5000")

    print("\n" + "-" * 60)
    print(" >> CONFIGURA THONNY CON ESTA URL:")
    print(f"\n   http://{LOCAL_IP}:5000/api/datos\n")
    print("-" * 60)

    print("\n[POST] Endpoint ESP32:")
    print(f"   http://{LOCAL_IP}:5000/api/datos")

    print("\n[GET]  API tiempo real:")
    print(f"   http://{LOCAL_IP}:5000/api/live")

    print("\n[GET]  Limpiar memoria:")
    print(f"   http://{LOCAL_IP}:5000/api/clear")

    print("\n[KEY]  API KEY:")
    print(f"   {API_KEY}")

    print("\n" + "=" * 60 + "\n")

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=True,
        threaded=True
    )