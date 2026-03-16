#!/bin/bash
# Growatt Nexa 2000 Li - Update & Start Script
# Nutzung: ./update-and-run.sh

cd "$(dirname "$0")" || exit 1

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

# Laufende Instanz stoppen falls vorhanden
if [ -f ".pid" ]; then
    OLD_PID=$(cat .pid)
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Alte Instanz stoppen (PID $OLD_PID)..."
        kill "$OLD_PID"
        sleep 2
    fi
    rm -f .pid
fi

# App starten
echo "App starten..."
python run.py &
echo $! > .pid
echo "Laeuft! PID: $(cat .pid)"
echo "Erreichbar unter: http://$(hostname -I | awk '{print $1}'):8080"
