import sys
import os

# ══════════════════════════════════════════════════════════
#  TUUCH QUALITY — WSGI para PythonAnywhere
#  Edita SOLO la variable PROJECT_PATH con la ruta correcta
# ══════════════════════════════════════════════════════════

# ▼▼▼ CAMBIA ESTA RUTA a donde está tu app.py en PythonAnywhere ▼▼▼
PROJECT_PATH = '/home/tuuchqualitymonitoreo/tuuch_dashboard'
# ▲▲▲ Ejemplos:
#   '/home/tuuchqualitymonitoreo/tuuch_dashboard'
#   '/home/tuuchqualitymonitoreo/mysite'
#   (es la carpeta que CONTIENE app.py)

# Agregar el path al Python path
if PROJECT_PATH not in sys.path:
    sys.path.insert(0, PROJECT_PATH)

# Importar la app Flask
from app import app as application
