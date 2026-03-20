import logging
import os
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .growatt_api import GrowattApi
from .database import (
    get_daily_summaries,
    get_db_status,
    get_monthly_summaries,
    get_statistics,
    init_db,
)
from .scheduler import get_scheduler_status, start_scheduler, stop_scheduler

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

APP_VERSION = "2.0.0"
APP_BUILD = datetime.now().strftime("%Y-%m-%d %H:%M")

api = GrowattApi()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Init DB
    await init_db()
    logger.info("Database initialized")

    # Auto-login and start scheduler if credentials are available
    username = os.getenv("GROWATT_USERNAME", "")
    password = os.getenv("GROWATT_PASSWORD", "")

    if username and password:
        result = await api.connect(username, password)
        if result.get("success"):
            logger.info("Growatt auto-login successful, starting scheduler")
            await start_scheduler(api)
        else:
            logger.warning("Growatt auto-login failed: %s", result.get("error"))

    yield

    await stop_scheduler()
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
        "version": APP_VERSION,
        "build": APP_BUILD,
    })


# ------------------------------------------------------------------
# API endpoints (existing)
# ------------------------------------------------------------------

@app.post("/api/connect")
async def connect(data: dict):
    username = data.get("username", "").strip()
    password = data.get("password", "")
    if not username or not password:
        return {"success": False, "error": "Benutzername und Passwort erforderlich"}
    result = await api.connect(username, password)

    # Start scheduler on successful manual connect too
    if result.get("success") and not get_scheduler_status()["running"]:
        await start_scheduler(api)

    return result


@app.post("/api/disconnect")
async def disconnect():
    await stop_scheduler()
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
# API endpoints (history)
# ------------------------------------------------------------------

@app.get("/api/history/daily")
async def api_daily_history(
    start: str = Query(default=None),
    end: str = Query(default=None),
):
    if not start:
        start = date.today().replace(day=1).isoformat()
    if not end:
        end = date.today().isoformat()
    rows = await get_daily_summaries(start, end)
    return {"data": rows}


@app.get("/api/history/monthly")
async def api_monthly_history(
    year: int = Query(default=None),
):
    if year is None:
        year = date.today().year
    rows = await get_monthly_summaries(year)
    return {"data": rows, "year": year}


@app.get("/api/history/statistics")
async def api_statistics():
    return await get_statistics()


@app.get("/api/db-status")
async def api_db_status():
    db_info = await get_db_status()
    sched_info = get_scheduler_status()
    return {**db_info, "scheduler": sched_info}


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
