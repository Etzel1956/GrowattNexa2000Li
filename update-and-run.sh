#!/bin/bash
# Growatt Nexa 2000 Li - Update & Start Script
# Nutzung: ./update-and-run.sh

cd "$(dirname "$0")" || exit 1

PORT=${PORT:-8080}

echo "=== Growatt Nexa 2000 Li ==="

# Git Update
echo "Code aktualisieren..."
git pull

# Virtual Environment aktivieren (einmalig anlegen falls noetig)
if [ ! -d "venv" ]; then
    echo "Virtual Environment erstellen..."
    python3 -m venv venv
fi
source venv/bin/activate

# Pakete installieren/aktualisieren
echo "Pakete pruefen..."
pip install -q -r requirements.txt

# .env pruefen
if [ ! -f ".env" ]; then
    echo "WARNUNG: .env nicht gefunden! Erstelle aus Vorlage..."
    cp .env.example .env
    echo "Bitte .env editieren: nano .env"
    exit 1
fi

# Port aus .env lesen falls vorhanden
if grep -q "^PORT=" .env 2>/dev/null; then
    PORT=$(grep "^PORT=" .env | cut -d= -f2 | tr -d '[:space:]')
fi

# === Alte Instanz komplett stoppen ===
echo "Alte Instanz stoppen..."

# 1. Per PID-Datei (Prozessgruppe beenden)
if [ -f ".pid" ]; then
    OLD_PID=$(cat .pid)
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "  Stoppe Prozessgruppe (PID $OLD_PID)..."
        kill -- -"$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null
        sleep 1
    fi
    rm -f .pid
fi

# 2. Alles auf dem Port beenden (fuer den Fall, dass PID-Datei veraltet ist)
if command -v fuser &>/dev/null; then
    PIDS_ON_PORT=$(fuser ${PORT}/tcp 2>/dev/null)
    if [ -n "$PIDS_ON_PORT" ]; then
        echo "  Beende Prozesse auf Port $PORT: $PIDS_ON_PORT"
        fuser -k ${PORT}/tcp 2>/dev/null
        sleep 1
    fi
elif command -v lsof &>/dev/null; then
    PIDS_ON_PORT=$(lsof -ti :${PORT} 2>/dev/null)
    if [ -n "$PIDS_ON_PORT" ]; then
        echo "  Beende Prozesse auf Port $PORT: $PIDS_ON_PORT"
        echo "$PIDS_ON_PORT" | xargs kill 2>/dev/null
        sleep 1
    fi
fi

# 3. Warten bis Port frei ist
for i in 1 2 3 4 5; do
    if ! ss -tlnp 2>/dev/null | grep -q ":${PORT} " && \
       ! netstat -tlnp 2>/dev/null | grep -q ":${PORT} "; then
        break
    fi
    echo "  Warte auf Port $PORT... ($i/5)"
    sleep 1
done

# === App starten ===
echo "App starten..."
python run.py > app.log 2>&1 &
APP_PID=$!
echo $APP_PID > .pid

# Pruefen ob Start erfolgreich war
sleep 2
if kill -0 "$APP_PID" 2>/dev/null; then
    IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "Laeuft! PID: $APP_PID"
    echo "Erreichbar unter: http://${IP:-localhost}:${PORT}"
    echo "Logdatei: app.log"
else
    echo "FEHLER: App konnte nicht gestartet werden!"
    echo "Letzte Log-Ausgabe:"
    tail -20 app.log 2>/dev/null
    rm -f .pid
    exit 1
fi
