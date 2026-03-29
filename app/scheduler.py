"""Automatic data collection scheduler (APScheduler)."""

import asyncio
import logging
import os
from datetime import date, datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.database import (
    get_last_recorded_date,
    save_daily_summary,
    save_interval_data,
)
from app.growatt_api import GrowattApi

logger = logging.getLogger(__name__)

BACKFILL_DAYS = int(os.environ.get("BACKFILL_DAYS", "90"))

scheduler = AsyncIOScheduler()
_api: GrowattApi | None = None
_scheduler_status: dict = {"state": "idle", "last_run": None, "backfill_progress": None}


def get_scheduler_status() -> dict:
    return {**_scheduler_status, "running": scheduler.running}


async def start_scheduler(api: GrowattApi) -> None:
    """Start the scheduler with the given authenticated API client."""
    global _api
    _api = api

    scheduler.add_job(
        _collect_today,
        IntervalTrigger(minutes=15),
        id="collect_today",
        replace_existing=True,
    )

    scheduler.add_job(
        _collect_today,
        CronTrigger(hour=23, minute=55),
        id="final_daily",
        replace_existing=True,
    )

    scheduler.start()
    logger.info("Scheduler started")

    asyncio.create_task(_backfill())


async def stop_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")


async def _collect_today() -> None:
    """Fetch and store today's data."""
    if not _api:
        return
    today = date.today().isoformat()
    await _collect_day(today)
    _scheduler_status["last_run"] = datetime.now().isoformat()


async def _collect_day(day: str) -> bool:
    """Fetch and store data for a single day. Returns True on success."""
    if not _api:
        return False

    try:
        summary = await _api.fetch_day_summary(day)
        if not summary:
            logger.debug("No data for %s", day)
            return False

        await save_daily_summary(
            day,
            summary["e_today"],
            summary["peak_power"],
            summary["peak_load"],
            summary["min_soc"],
            summary["max_soc"],
        )

        # Also save interval data
        records = await _api.fetch_day_intervals(day)
        if records:
            await save_interval_data(day, records)

        logger.info("Collected data for %s: %.2f kWh", day, summary["e_today"])
        return True
    except Exception as exc:
        logger.error("Failed to collect %s: %s", day, exc)
        return False


async def _backfill() -> None:
    """Fill missing days since last recorded date (up to BACKFILL_DAYS)."""
    _scheduler_status["state"] = "backfilling"

    last_date_str = await get_last_recorded_date()
    if last_date_str:
        last_date = date.fromisoformat(last_date_str)
    else:
        last_date = date.today() - timedelta(days=BACKFILL_DAYS)

    today = date.today()
    days_to_fill = []
    current = last_date
    while current <= today:
        days_to_fill.append(current.isoformat())
        current += timedelta(days=1)

    total = len(days_to_fill)
    logger.info("Backfill: %d days to process", total)

    for i, day in enumerate(days_to_fill):
        _scheduler_status["backfill_progress"] = f"{i + 1}/{total}"
        await _collect_day(day)
        if i < total - 1:
            await asyncio.sleep(2)

    _scheduler_status["state"] = "running"
    _scheduler_status["backfill_progress"] = None
    logger.info("Backfill complete")


async def rebackfill_all() -> None:
    """Re-fetch and recalculate ALL days in the database (e.g. after a formula fix)."""
    if not _api:
        return
    _scheduler_status["state"] = "rebackfill"

    today = date.today()
    start = today - timedelta(days=BACKFILL_DAYS)
    days_to_fill = []
    current = start
    while current <= today:
        days_to_fill.append(current.isoformat())
        current += timedelta(days=1)

    total = len(days_to_fill)
    logger.info("Re-backfill: %d days to recalculate", total)

    for i, day in enumerate(days_to_fill):
        _scheduler_status["backfill_progress"] = f"{i + 1}/{total}"
        await _collect_day(day)
        if i < total - 1:
            await asyncio.sleep(2)

    _scheduler_status["state"] = "running"
    _scheduler_status["backfill_progress"] = None
    logger.info("Re-backfill complete")
