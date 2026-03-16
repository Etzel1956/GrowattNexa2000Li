import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .growatt_api import GrowattApi

load_dotenv()

api = GrowattApi()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await api.disconnect()


app = FastAPI(title="Growatt Nexa 2000 Li", lifespan=lifespan)

BASE_DIR = Path(__file__).resolve().parent
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


# ------------------------------------------------------------------
# Pages
# ------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "default_user": os.getenv("GROWATT_USERNAME", ""),
        "default_pass": os.getenv("GROWATT_PASSWORD", ""),
    })


# ------------------------------------------------------------------
# API endpoints
# ------------------------------------------------------------------

@app.post("/api/connect")
async def connect(data: dict):
    username = data.get("username", "").strip()
    password = data.get("password", "")
    if not username or not password:
        return {"success": False, "error": "Benutzername und Passwort erforderlich"}
    result = await api.connect(username, password)
    return result


@app.post("/api/disconnect")
async def disconnect():
    await api.disconnect()
    return {"success": True}


@app.get("/api/live-status")
async def live_status():
    if not api.storage_sn:
        return {"error": "Nicht verbunden"}
    return await api.fetch_live_status()


@app.get("/api/energy-totals")
async def energy_totals():
    if not api.storage_sn:
        return {"error": "Nicht verbunden"}
    return await api.fetch_energy_totals()


@app.get("/api/day-chart")
async def day_chart(date: str):
    if not api.storage_sn:
        return {"error": "Nicht verbunden"}
    return await api.fetch_day_chart(date)


@app.get("/api/panel-details")
async def panel_details(date: str):
    if not api.storage_sn:
        return {"error": "Nicht verbunden"}
    return await api.fetch_panel_details(date)


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8080")),
        reload=True,
    )
