import sqlite3
db = sqlite3.connect("data/growatt_history.db")
for r in db.execute("SELECT date,count(*),min(time),max(time) FROM interval_data GROUP BY date ORDER BY date").fetchall():
    print(r)
