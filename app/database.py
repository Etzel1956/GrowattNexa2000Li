"""SQLite database layer for historical solar data (aiosqlite)."""

import os
from datetime import datetime
from typing import Optional

import aiosqlite

DB_PATH = os.environ.get("DB_PATH", "./data/growatt_history.db")


async def init_db() -> None:
    """Create tables if they don't exist and enable WAL mode."""
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("PRAGMA journal_mode=WAL")
        await db.execute("""
            CREATE TABLE IF NOT EXISTS daily_summary (
                date       TEXT PRIMARY KEY,
                e_today    REAL,
                peak_power REAL,
                peak_load  REAL,
                min_soc    REAL,
                max_soc    REAL,
                fetched_at TEXT
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS interval_data (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                date       TEXT NOT NULL,
                time       TEXT NOT NULL,
                ppv        REAL,
                pac        REAL,
                soc        REAL,
                load_power REAL,
                UNIQUE(date, time)
            )
        """)
        await db.commit()


async def save_daily_summary(
    day: str,
    e_today: float,
    peak_power: float,
    peak_load: float,
    min_soc: float,
    max_soc: float,
) -> None:
    """Insert or replace a daily summary row."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT OR REPLACE INTO daily_summary
                (date, e_today, peak_power, peak_load, min_soc, max_soc, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (day, e_today, peak_power, peak_load, min_soc, max_soc,
             datetime.now().isoformat()),
        )
        await db.commit()


async def save_interval_data(day: str, rows: list[dict]) -> None:
    """Bulk-insert interval rows for a given day (upsert on date+time)."""
    if not rows:
        return
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executemany(
            """
            INSERT OR REPLACE INTO interval_data
                (date, time, ppv, pac, soc, load_power)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (day, r["time"], r.get("ppv"), r.get("pac"),
                 r.get("soc"), r.get("load_power"))
                for r in rows
            ],
        )
        await db.commit()


async def get_daily_summaries(start: str, end: str) -> list[dict]:
    """Return daily summaries between start and end (inclusive)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date",
            (start, end),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_monthly_summaries(year: int) -> list[dict]:
    """Return aggregated monthly data for a given year."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT
                substr(date, 1, 7) AS month,
                SUM(e_today)       AS total_kwh,
                MAX(peak_power)    AS max_power,
                MAX(peak_load)     AS max_load,
                COUNT(*)           AS days_recorded,
                AVG(e_today)       AS avg_daily_kwh
            FROM daily_summary
            WHERE date >= ? AND date < ?
            GROUP BY substr(date, 1, 7)
            ORDER BY month
            """,
            (f"{year}-01-01", f"{year + 1}-01-01"),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_statistics() -> dict:
    """Return overall statistics (records, best day, max power, etc.)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        cur = await db.execute(
            "SELECT date, e_today FROM daily_summary ORDER BY e_today DESC LIMIT 1"
        )
        best_day_row = await cur.fetchone()

        cur = await db.execute(
            "SELECT date, peak_power FROM daily_summary ORDER BY peak_power DESC LIMIT 1"
        )
        max_power_row = await cur.fetchone()

        cur = await db.execute(
            """
            SELECT
                COUNT(*) AS days_recorded,
                MIN(date) AS oldest_date,
                MAX(date) AS newest_date,
                SUM(e_today) AS total_kwh,
                AVG(e_today) AS avg_daily_kwh
            FROM daily_summary
            """
        )
        totals = await cur.fetchone()

        return {
            "best_day": {
                "date": best_day_row["date"] if best_day_row else None,
                "kwh": best_day_row["e_today"] if best_day_row else 0,
            },
            "max_power": {
                "date": max_power_row["date"] if max_power_row else None,
                "watts": max_power_row["peak_power"] if max_power_row else 0,
            },
            "total_kwh": totals["total_kwh"] or 0,
            "avg_daily_kwh": round(totals["avg_daily_kwh"] or 0, 2),
            "days_recorded": totals["days_recorded"] or 0,
            "oldest_date": totals["oldest_date"],
            "newest_date": totals["newest_date"],
        }


async def get_db_status() -> dict:
    """Return DB info for the status endpoint."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            """
            SELECT
                COUNT(*) AS days_recorded,
                MIN(date) AS oldest_date,
                MAX(date) AS newest_date,
                MAX(fetched_at) AS last_fetched
            FROM daily_summary
            """
        )
        row = await cur.fetchone()
        return {
            "days_recorded": row["days_recorded"] or 0,
            "oldest_date": row["oldest_date"],
            "newest_date": row["newest_date"],
            "last_fetched": row["last_fetched"],
            "db_path": os.path.abspath(DB_PATH),
        }


async def get_last_recorded_date() -> Optional[str]:
    """Return the most recent date in daily_summary, or None."""
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute("SELECT MAX(date) AS d FROM daily_summary")
        row = await cur.fetchone()
        return row[0] if row and row[0] else None


# ------------------------------------------------------------------
# Export helpers (CSV)
# ------------------------------------------------------------------

# Sampling interval of the interval_data table in minutes. The Growatt
# day chart returns one point every 5 minutes (12/h, 288/day). Used to
# convert average watts → Wh per bucket.
_SAMPLE_MINUTES = 5


async def get_export_daily(start: str, end: str) -> list[dict]:
    """Return one row per day for export.

    Combines daily_summary (PV production, peaks, SOC) with consumption
    aggregated from interval_data (Wh = avg(load) * 5min per sample).
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"""
            SELECT
                ds.date                                 AS date,
                ds.e_today                              AS pv_kwh,
                ds.peak_power                           AS pv_peak_w,
                ds.peak_load                            AS load_peak_w,
                ds.min_soc                              AS soc_min_pct,
                ds.max_soc                              AS soc_max_pct,
                (SELECT ROUND(AVG(soc), 1)
                   FROM interval_data WHERE date = ds.date) AS soc_avg_pct,
                (SELECT ROUND(SUM(load_power) * {_SAMPLE_MINUTES} / 60000.0, 3)
                   FROM interval_data WHERE date = ds.date) AS load_kwh,
                (SELECT ROUND(SUM(pac)        * {_SAMPLE_MINUTES} / 60000.0, 3)
                   FROM interval_data WHERE date = ds.date) AS ac_kwh
            FROM daily_summary ds
            WHERE ds.date >= ? AND ds.date <= ?
            ORDER BY ds.date
            """,
            (start, end),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_export_hourly(start: str, end: str) -> list[dict]:
    """Return one row per hour aggregated from 5-min interval_data."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(
            f"""
            SELECT
                date                                                   AS date,
                substr(time, 1, 2)                                     AS hour,
                ROUND(AVG(ppv), 1)                                     AS pv_avg_w,
                ROUND(AVG(pac), 1)                                     AS ac_avg_w,
                ROUND(AVG(load_power), 1)                              AS load_avg_w,
                ROUND(AVG(soc), 1)                                     AS soc_avg_pct,
                MIN(soc)                                               AS soc_min_pct,
                MAX(soc)                                               AS soc_max_pct,
                ROUND(SUM(pac)        * {_SAMPLE_MINUTES} / 60.0, 1)   AS ac_wh,
                ROUND(SUM(load_power) * {_SAMPLE_MINUTES} / 60.0, 1)   AS load_wh,
                COUNT(*)                                               AS samples
            FROM interval_data
            WHERE date >= ? AND date <= ?
            GROUP BY date, substr(time, 1, 2)
            ORDER BY date, hour
            """,
            (start, end),
        )
        rows = await cur.fetchall()
        return [dict(r) for r in rows]
