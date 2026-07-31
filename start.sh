#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
#  Subvid.app — Start Script (Canary 180M + Astro frontend)
# ═══════════════════════════════════════════════════════════════════════
#
#  Levanta el backend Canary (Python) y el frontend Astro,
#  luego abre el navegador automáticamente.
#
#  Requisitos:
#    - Python 3.10–3.12 con venv (para el backend)
#    - Node.js 22+
#    - pnpm
#    - ffmpeg, libsndfile (sistema)
#    - GPU NVIDIA (opcional — funciona en CPU, más lento)
#
#  Uso:
#    chmod +x start.sh
#    ./start.sh                 # Backend Canary + frontend
#    ./start.sh --frontend-only  # Solo frontend (Whisper en navegador)
#
#  Ctrl+C para parar ambos servicios.

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"

# Inicializar pyenv si está disponible (para usar Python 3.10–3.12 en vez del sistema)
if [ -d "$HOME/.pyenv" ]; then
  export PYENV_ROOT="$HOME/.pyenv"
  export PATH="$PYENV_ROOT/bin:$PATH"
  if command -v pyenv >/dev/null 2>&1; then
    eval "$(pyenv init -)" 2>/dev/null || true
  fi
fi

CANARY_PORT="${CANARY_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-4321}"
CANARY_URL="http://localhost:${CANARY_PORT}"

# Colores (definidos antes de usarlos)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse flags
FRONTEND_ONLY=false
if [ "${1:-}" = "--frontend-only" ]; then
  FRONTEND_ONLY=true
  echo -e "${YELLOW}⚠ Modo solo frontend (usará Whisper en navegador, sin Canary)${NC}"
  echo ""
fi

cleanup() {
  echo ""
  echo -e "${YELLOW}🛑  Apagando servicios...${NC}"
  if [ -n "${BACKEND_PID:-}" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    echo -e "${GREEN}   ✓ Backend detenido${NC}"
  fi
  if [ -n "${FRONTEND_PID:-}" ]; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
    echo -e "${GREEN}   ✓ Frontend detenido${NC}"
  fi
  echo -e "${GREEN}✅ Todo limpio. ¡Hasta luego!${NC}"
  exit 0
}

trap cleanup SIGINT SIGTERM

# ── 1. Verificar dependencias ──────────────────────────────────────────

echo -e "${CYAN}🔍 Verificando dependencias del sistema...${NC}"

command -v python3 >/dev/null 2>&1 || { echo -e "${RED}❌ python3 no encontrado${NC}"; exit 1; }
command -v node >/dev/null 2>&1    || { echo -e "${RED}❌ node no encontrado${NC}"; exit 1; }
command -v pnpm >/dev/null 2>&1    || { echo -e "${RED}❌ pnpm no encontrado. Instálalo: npm i -g pnpm${NC}"; exit 1; }
command -v ffmpeg >/dev/null 2>&1  || { echo -e "${RED}❌ ffmpeg no encontrado. Instálalo: sudo apt install ffmpeg${NC}"; exit 1; }

PYTHON_VERSION=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo -e "${GREEN}   ✓ python3 ${PYTHON_VERSION}${NC}"

# NeMo requiere Python 3.10–3.12
PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
if [ "$PYTHON_MAJOR" -ne 3 ] || [ "$PYTHON_MINOR" -gt 12 ] || [ "$PYTHON_MINOR" -lt 10 ]; then
  if [ "$FRONTEND_ONLY" = true ]; then
    echo -e "${YELLOW}   ⚠ Python ${PYTHON_VERSION} no compatible con NeMo — backend omitido${NC}"
    echo -e "${YELLOW}   ⚠ El frontend usará Whisper en el navegador${NC}"
    SKIP_BACKEND=true
  else
    echo -e "${RED}❌ Python ${PYTHON_VERSION} no es compatible con NeMo Canary.${NC}"
    echo -e "${RED}   NeMo requiere Python 3.10, 3.11 o 3.12.${NC}"
    echo -e "${RED}   Usa pyenv/conda: ${CYAN}pyenv install 3.12 && pyenv local 3.12${NC}"
    echo -e "${YELLOW}   O arranca sin backend: ${CYAN}./start.sh --frontend-only${NC}"
    exit 1
  fi
else
  SKIP_BACKEND=false
fi
echo -e "${GREEN}   ✓ node $(node --version)${NC}"
echo -e "${GREEN}   ✓ pnpm $(pnpm --version)${NC}"
echo -e "${GREEN}   ✓ ffmpeg listo${NC}"

# ── 2. Backend Python ──────────────────────────────────────────────────

if [ "$SKIP_BACKEND" != true ]; then

echo ""
echo -e "${CYAN}🐍 Configurando backend Python...${NC}"

cd "$BACKEND_DIR"

# Crear venv si no existe
if [ ! -d "$VENV_DIR" ]; then
  echo -e "${YELLOW}   Creando entorno virtual...${NC}"
  python3 -m venv "$VENV_DIR"
fi

# Activar venv
source "$VENV_DIR/bin/activate"

# Instalar dependencias
echo -e "${YELLOW}   Instalando dependencias Python...${NC}"
pip install -q --upgrade pip

# Pre-instalar versiones compatibles de protobuf y wheel (evita fallos de compilación)
pip install -q "protobuf>=3.20,<5" "wheel" "setuptools>=65" "packaging"

# Intentar instalar con wheels precompilados primero; si falla, compilar desde fuente
pip install -q --prefer-binary -r requirements.txt 2>&1 || {
  echo -e "${YELLOW}   ⚠ Falló con wheels, intentando compilación desde fuente...${NC}"
  pip install -q -r requirements.txt 2>&1 || {
    echo ""
    echo -e "${RED}❌ No se pudieron instalar las dependencias Python.${NC}"
    echo -e "${RED}   Causa probable: Python $(python3 --version 2>&1) es muy reciente para NeMo.${NC}"
    echo -e "${RED}   NeMo requiere Python 3.10–3.12. Usa pyenv o conda para cambiar de versión.${NC}"
    exit 1
  }
}

echo -e "${GREEN}   ✓ Backend listo${NC}"

# Detectar GPU (usar el python del venv para asegurar que torch está disponible)
if "$VENV_DIR/bin/python" -c "import torch; print(torch.cuda.is_available())" 2>/dev/null | grep -q "True"; then
  echo -e "${GREEN}   ✓ GPU NVIDIA detectada${NC}"
else
  echo -e "${YELLOW}   ⚠ Sin GPU — Canary usará CPU (más lento)${NC}"
fi

fi  # SKIP_BACKEND

# ── 3. Frontend Astro ──────────────────────────────────────────────────

echo ""
echo -e "${CYAN}🌐 Configurando frontend Astro...${NC}"

cd "$PROJECT_DIR"

# Instalar dependencias Node
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}   Instalando dependencias Node...${NC}"
  pnpm install >/dev/null 2>&1
fi

# Crear .env con la URL del backend Canary
if [ "$SKIP_BACKEND" = true ]; then
  # Sin backend: .env vacío → el frontend usará Whisper en navegador
  cat > "$PROJECT_DIR/.env" <<EOF
# Auto-generado por start.sh (--frontend-only)
# Sin backend Canary — el frontend usará Whisper en el navegador
PUBLIC_CANARY_API_URL=
EOF
  echo -e "${GREEN}   ✓ .env configurado: usando Whisper en navegador${NC}"
else
  cat > "$PROJECT_DIR/.env" <<EOF
# Auto-generado por start.sh
PUBLIC_CANARY_API_URL=${CANARY_URL}
EOF
  echo -e "${GREEN}   ✓ .env configurado: PUBLIC_CANARY_API_URL=${CANARY_URL}${NC}"
fi
echo -e "${GREEN}   ✓ Frontend listo${NC}"

# ── 4. Arrancar servicios ──────────────────────────────────────────────

echo ""
echo -e "${CYAN}🚀 Arrancando servicios...${NC}"

# Backend en segundo plano
if [ "$SKIP_BACKEND" != true ]; then
cd "$BACKEND_DIR"
source "$VENV_DIR/bin/activate"
echo -e "${YELLOW}   Arrancando backend Canary en ${CANARY_URL}...${NC}"
PORT="$CANARY_PORT" python3 main.py &
BACKEND_PID=$!
fi

# Frontend en segundo plano
cd "$PROJECT_DIR"
echo -e "${YELLOW}   Arrancando frontend Astro en http://localhost:${FRONTEND_PORT}...${NC}"
pnpm dev -- --port "$FRONTEND_PORT" &
FRONTEND_PID=$!

# ── 5. Esperar a que el backend esté listo ────────────────────────────

if [ "$SKIP_BACKEND" != true ]; then
echo ""
echo -e "${YELLOW}⏳ Esperando a que el backend Canary esté listo...${NC}"

MAX_WAIT=180  # máximo 3 minutos (la primera carga del modelo tarda)
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  HEALTH=$(curl -s "${CANARY_URL}/health" 2>/dev/null || echo '{"model_loaded":false,"status":"down"}')
  if echo "$HEALTH" | grep -q '"status":"ok"'; then
    if echo "$HEALTH" | grep -q '"model_loaded":true'; then
      echo -e "${GREEN}   ✓ Backend listo (modelo Canary cargado) tras ${WAITED}s${NC}"
      break
    elif echo "$HEALTH" | grep -q '"model_loaded":false'; then
      echo -ne "\r   ⏳ Backend online, esperando a que el modelo termine de cargar... [${WAITED}s]"
    fi
  else
    echo -ne "\r   ⏳ Esperando backend... [${WAITED}s]"
  fi
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  echo ""
  echo -e "${RED}   ⚠ Timeout esperando al backend. El frontend arrancará igual.${NC}"
  echo -e "${RED}   ⚠ La primera transcripción cargará el modelo Canary (~30-60s).${NC}"
fi
fi  # SKIP_BACKEND

# ── 6. Abrir navegador ─────────────────────────────────────────────────

echo ""
echo -e "${CYAN}🌍 Abriendo navegador...${NC}"

FRONTEND_URL="http://localhost:${FRONTEND_PORT}"

# Esperar a que el frontend esté listo
for i in $(seq 1 20); do
  if curl -s "$FRONTEND_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Abrir navegador (Linux)
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$FRONTEND_URL" 2>/dev/null &
elif command -v open >/dev/null 2>&1; then
  open "$FRONTEND_URL" 2>/dev/null &
elif command -v sensible-browser >/dev/null 2>&1; then
  sensible-browser "$FRONTEND_URL" 2>/dev/null &
fi

# ── 7. Mostrar resumen ─────────────────────────────────────────────────

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
if [ "$SKIP_BACKEND" = true ]; then
  echo -e "${GREEN}  ✅  Subvid.app funcionando (Whisper en navegador)       ${NC}"
else
  echo -e "${GREEN}  ✅  Subvid.app funcionando con Canary 180M              ${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Frontend:${NC}  ${FRONTEND_URL}"
if [ "$SKIP_BACKEND" != true ]; then
  echo -e "  ${CYAN}Backend:${NC}   ${CANARY_URL}"
  echo -e "  ${CYAN}Health:${NC}    ${CANARY_URL}/health"
fi
echo ""
echo -e "  ${YELLOW}Presiona Ctrl+C para detener ambos servicios${NC}"
echo ""

# Mantener el script corriendo hasta Ctrl+C
wait
