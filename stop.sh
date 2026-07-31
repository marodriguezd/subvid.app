#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
#  Subvid.app — Stop Script
# ═══════════════════════════════════════════════════════════════════════
#
#  Mata cualquier proceso residual del backend Canary y frontend Astro.
#  Útil si start.sh no limpió bien al cerrar o si algo quedó colgado.
#
#  Uso:
#    chmod +x stop.sh
#    ./stop.sh

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

KILLED=0

# ── Matar por puerto ───────────────────────────────────────────────────

kill_port() {
  local port="$1"
  local name="$2"
  local pids

  # Buscar PIDs escuchando en el puerto
  pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)

  if [ -n "$pids" ]; then
    echo -e "${YELLOW}🔪 Matando ${name} (puerto ${port})...${NC}"
    for pid in $pids; do
      kill "$pid" 2>/dev/null && echo -e "   PID ${pid} terminado" || true
      KILLED=$((KILLED + 1))
    done
    # Esperar un momento y forzar con -9 si sigue vivo
    sleep 0.5
    pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      for pid in $pids; do
        kill -9 "$pid" 2>/dev/null && echo -e "   PID ${pid} forzado con -9" || true
      done
    fi
  else
    echo -e "${GREEN}   ✓ ${name} (puerto ${port}) ya estaba parado${NC}"
  fi
}

# ── Matar por nombre de proceso ────────────────────────────────────────

kill_proc() {
  local pattern="$1"
  local name="$2"
  local pids

  pids=$(pgrep -f "$pattern" 2>/dev/null || true)

  if [ -n "$pids" ]; then
    echo -e "${YELLOW}🔪 Matando ${name}...${NC}"
    for pid in $pids; do
      kill "$pid" 2>/dev/null && echo -e "   PID ${pid} terminado" || true
      KILLED=$((KILLED + 1))
    done
    sleep 0.5
    pids=$(pgrep -f "$pattern" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      for pid in $pids; do
        kill -9 "$pid" 2>/dev/null && echo -e "   PID ${pid} forzado con -9" || true
      done
    fi
  else
    echo -e "${GREEN}   ✓ ${name} ya estaba parado${NC}"
  fi
}

# ── Ejecutar ───────────────────────────────────────────────────────────

echo -e "${YELLOW}🧹 Limpiando procesos de Subvid.app...${NC}"
echo ""

# Backend Canary (puerto 8000 + proceso python main.py)
kill_port 8000 "Backend Canary"
kill_proc "backend/main.py" "Backend Canary (proceso)"

# Frontend Astro (puerto 4321 + proceso astro dev)
kill_port 4321 "Frontend Astro"
kill_proc "astro dev" "Frontend Astro (proceso)"

# Limpiar archivos temporales
echo ""
echo -e "${YELLOW}🧹 Limpiando archivos temporales...${NC}"

TMP_PATTERN="$PROJECT_DIR/backend/tmp*"
if ls $TMP_PATTERN 2>/dev/null | head -1 >/dev/null 2>&1; then
  rm -rf $TMP_PATTERN 2>/dev/null || true
  echo -e "   ✓ Temporales del backend eliminados"
else
  echo -e "${GREEN}   ✓ Sin temporales que limpiar${NC}"
fi

# ── Resumen ────────────────────────────────────────────────────────────

echo ""
if [ "$KILLED" -gt 0 ]; then
  echo -e "${GREEN}✅ ${KILLED} proceso(s) terminado(s). Todo limpio.${NC}"
else
  echo -e "${GREEN}✅ No había nada corriendo. Todo en orden.${NC}"
fi
