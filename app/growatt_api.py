import hashlib
from typing import Any

import httpx

SERVER_URL = "https://server.growatt.com"


class GrowattApi:
    """Client for the Growatt server API – mirrors the VB.NET logic."""

    def __init__(self) -> None:
        self.client: httpx.AsyncClient | None = None
        self.plant_id: str = ""
        self.storage_sn: str = ""
        self.plant_name: str = ""

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _get(self, endpoint: str) -> str:
        assert self.client is not None
        r = await self.client.get(SERVER_URL + endpoint)
        return r.text

    async def _post(self, endpoint: str, data: dict[str, str]) -> str:
        assert self.client is not None
        r = await self.client.post(SERVER_URL + endpoint, data=data)
        return r.text

    @staticmethod
    def _md5(text: str) -> str:
        return hashlib.md5(text.encode("utf-8")).hexdigest()

    # ------------------------------------------------------------------
    # JSON helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_response_obj(raw: dict | list | None) -> Any:
        if isinstance(raw, dict) and "obj" in raw:
            return raw["obj"]
        return raw

    @staticmethod
    def _find_value(data: Any, names: list[str]) -> str:
        """Recursively search for first matching key in a JSON structure."""
        if isinstance(data, dict):
            for n in names:
                if n in data and data[n] not in (None, ""):
                    return str(data[n])
            if "datas" in data and isinstance(data["datas"], list) and data["datas"]:
                result = GrowattApi._find_value(data["datas"][0], names)
                if result:
                    return result
            for v in data.values():
                if isinstance(v, dict):
                    result = GrowattApi._find_value(v, names)
                    if result:
                        return result
                elif isinstance(v, list) and v:
                    result = GrowattApi._find_value(v[0], names)
                    if result:
                        return result
        elif isinstance(data, list) and data:
            return GrowattApi._find_value(data[0], names)
        return ""

    @staticmethod
    def _dict_flat(obj: Any, prefix: str = "") -> dict[str, str]:
        result: dict[str, str] = {}
        if not isinstance(obj, dict):
            return result
        for k, v in obj.items():
            key = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (str, int, float, bool)):
                result[key] = str(v)
            elif isinstance(v, dict) and not prefix:
                result.update(GrowattApi._dict_flat(v, k))
        return result

    # ------------------------------------------------------------------
    # Login & connect
    # ------------------------------------------------------------------

    async def connect(self, username: str, password: str) -> dict[str, Any]:
        """Login, discover plant & device. Returns status dict."""
        logs: list[str] = []

        self.client = httpx.AsyncClient(
            headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"},
            follow_redirects=True,
            timeout=30.0,
        )

        # --- Login ---
        password_hash = self._md5(password)
        logged_in = False

        login_methods = [
            {"account": username, "password": "", "validateCode": "",
             "isReadPact": "0", "passwordCrc": password_hash},
            {"account": username, "password": password_hash,
             "validateCode": "", "isReadPact": "0"},
            {"account": username, "password": password,
             "validateCode": "", "isReadPact": "0"},
        ]

        for i, params in enumerate(login_methods, 1):
            try:
                logs.append(f"Login Methode {i}...")
                raw = await self._post("/login", params)
                import json
                data = json.loads(raw)
                if self._check_login(data):
                    logged_in = True
                    logs.append("Login erfolgreich!")
                    break
            except Exception as ex:
                logs.append(f"  Fehler: {ex}")

        if not logged_in:
            return {"success": False, "logs": logs, "error": "Login fehlgeschlagen"}

        # --- Plant ---
        plant_json: Any = None
        plant_endpoints_get = [
            "/index/getPlantListTitle",
            "/panel/getPlantList",
            "/index/getPlantListTitle_498",
        ]
        import json

        for ep in plant_endpoints_get:
            try:
                raw = await self._get(ep)
                plant_json = json.loads(raw)
                if self._find_value(plant_json, ["plantId", "id"]):
                    break
            except Exception:
                pass

        if not self._find_value(plant_json or {}, ["plantId", "id"]):
            try:
                raw = await self._post("/panel/getPlantList", {"currPage": "1"})
                plant_json = json.loads(raw)
            except Exception:
                pass

        plant_obj = self._get_response_obj(plant_json)
        self.plant_id = self._find_value(plant_obj, ["plantId", "id"])
        self.plant_name = self._find_value(plant_obj, ["plantName"])

        if not self.plant_id:
            return {"success": False, "logs": logs, "error": "Keine Plant ID gefunden"}

        logs.append(f"Plant ID: {self.plant_id}")
        if self.plant_name:
            logs.append(f"Plant Name: {self.plant_name}")

        # --- Device ---
        try:
            raw = await self._post("/panel/getDevicesByPlantList",
                                   {"plantId": self.plant_id, "currPage": "1"})
            device_json = json.loads(raw)
        except Exception as ex:
            return {"success": False, "logs": logs, "error": f"Geräteliste: {ex}"}

        device_obj = self._get_response_obj(device_json)
        self.storage_sn = self._find_value(
            device_obj, ["deviceSn", "sn", "serialNum", "serialNumber", "deviceAilas", "alias"]
        )
        if not self.storage_sn:
            return {"success": False, "logs": logs, "error": "Keine Seriennummer gefunden"}

        logs.append(f"Geräte SN: {self.storage_sn}")

        # Initial values from device list
        props = self._dict_flat(device_obj)
        initial = {
            "pac": self._val(props, ["pac"]),
            "eToday": self._val(props, ["eToday"]),
            "eMonth": self._val(props, ["eMonth"]),
            "eTotal": self._val(props, ["eTotal"]),
        }

        return {"success": True, "logs": logs, "initial": initial,
                "plantId": self.plant_id, "storageSn": self.storage_sn,
                "plantName": self.plant_name}

    @staticmethod
    def _check_login(data: Any) -> bool:
        if not isinstance(data, dict):
            return False
        r = data.get("result")
        if r in (1, "1"):
            return True
        if data.get("success") is True:
            return True
        return False

    @staticmethod
    def _val(props: dict[str, str], names: list[str]) -> str:
        for n in names:
            for k, v in props.items():
                if k.lower() == n.lower() and v:
                    return v
        return ""

    # ------------------------------------------------------------------
    # Live status
    # ------------------------------------------------------------------

    async def fetch_live_status(self) -> dict[str, Any]:
        import json
        endpoints = [
            f"/panel/noah/getNoahStatusData?plantId={self.plant_id}",
            "/noahDeviceApi/nexa/getSystemStatus",
            "/noahDeviceApi/noah/getSystemStatus",
        ]

        for ep in endpoints:
            try:
                raw = await self._post(ep, {"deviceSn": self.storage_sn})
                if '"result":-1' in raw or '"result": -1' in raw:
                    continue
                data = json.loads(raw)
                obj = self._get_response_obj(data)
                props = self._dict_flat(obj)
                if len(props) > 2:
                    return self._extract_status(props)
            except Exception:
                continue
        return {}

    def _extract_status(self, props: dict[str, str]) -> dict[str, str]:
        return {
            "pvPower": self._val_unit(props, ["ppv", "panelPower", "pvPower", "solarPower"], "W"),
            "batSoc": self._val_unit(props, ["totalBatteryPackSoc", "soc", "capacity", "batSoc"], "%"),
            "batPower": self._val_unit(props, ["totalBatteryPackChargingPower", "chargePower", "batPower", "disChargePower"], "W"),
            "loadPower": self._val_unit(props, ["totalHouseholdLoad", "householdLoadApartFromGroplug", "loadPower", "ctSelfPower"], "W"),
            "gridPower": self._val_unit(props, ["pac", "gridPower", "otherPower"], "W"),
            "pvToday": self._val_unit(props, ["eacToday", "epvToday", "eToday"], "kWh"),
            "pvTotal": self._val_unit(props, ["eacTotal", "epvTotal", "eTotal", "MTotal"], "kWh"),
        }

    def _val_unit(self, props: dict[str, str], names: list[str], unit: str) -> str:
        v = self._val(props, names)
        if v:
            return f"{self._format_val(v)} {unit}"
        return f"-- {unit}"

    @staticmethod
    def _format_val(val: str) -> str:
        try:
            n = float(val)
            if abs(n) >= 1000:
                return f"{n:,.1f}"
            return f"{n:.2f}"
        except ValueError:
            return val

    # ------------------------------------------------------------------
    # Energy totals
    # ------------------------------------------------------------------

    async def fetch_energy_totals(self) -> dict[str, str]:
        import json
        from datetime import date

        endpoints = [
            f"/panel/noah/getNoahTotalData?plantId={self.plant_id}",
            "/noahDeviceApi/nexa/getDataChart",
            "/noahDeviceApi/noah/getDataChart",
        ]

        for ep in endpoints:
            try:
                params: dict[str, str] = {"deviceSn": self.storage_sn}
                if "getDataChart" in ep:
                    params["dateTime"] = date.today().strftime("%Y-%m-01")
                    params["dateType"] = "1"

                raw = await self._post(ep, params)
                if '"result":-1' in raw or '"result": -1' in raw:
                    continue

                data = json.loads(raw)
                obj = self._get_response_obj(data)
                props = self._dict_flat(obj)
                if len(props) > 1:
                    result: dict[str, str] = {}
                    pv_today = self._val(props, ["eacToday", "epvToday", "eToday"])
                    if pv_today:
                        result["pvToday"] = f"{self._format_val(pv_today)} kWh"
                    pv_total = self._val(props, ["eacTotal", "epvTotal", "eTotal", "MTotal"])
                    if pv_total:
                        result["pvTotal"] = f"{self._format_val(pv_total)} kWh"
                    money_today = self._val(props, ["mToday", "moneyToday"])
                    money_unit = self._val(props, ["mUnitText"]) or "€"
                    if money_today:
                        result["chargeToday"] = f"{self._format_val(money_today)} {money_unit}"
                    return result
            except Exception:
                continue
        return {}

    # ------------------------------------------------------------------
    # Monthly energy from Growatt server (pre-calculated daily kWh)
    # ------------------------------------------------------------------

    async def fetch_month_energy(self, year: int, month: int) -> dict[str, float]:
        """Fetch daily kWh values for a month directly from Growatt server.

        Returns dict mapping day strings ('2026-03-01') to kWh values.
        """
        import json

        date_str = f"{year}-{month:02d}-01"
        endpoints = [
            "/noahDeviceApi/nexa/getDataChart",
            "/noahDeviceApi/noah/getDataChart",
        ]

        for ep in endpoints:
            try:
                raw = await self._post(ep, {
                    "deviceSn": self.storage_sn,
                    "dateTime": date_str,
                    "dateType": "1",  # 1 = monthly view (daily breakdown)
                })
                if '"result":-1' in raw or len(raw) < 50:
                    continue

                data = json.loads(raw)
                obj = self._get_response_obj(data)

                # Try to find the daily energy chart data
                if not isinstance(obj, dict):
                    continue

                daily_kwh: dict[str, float] = {}

                # Look for chart arrays with daily values
                for key in ["pvs", "charts", "datas", "chartData"]:
                    candidate = obj.get(key)
                    if isinstance(candidate, dict):
                        # Dict keyed by date or day number
                        for k, v in candidate.items():
                            val = self._num(v)
                            if val is not None and val >= 0:
                                try:
                                    day_num = int(k)
                                    day_key = f"{year}-{month:02d}-{day_num:02d}"
                                    daily_kwh[day_key] = val
                                except ValueError:
                                    daily_kwh[k] = val
                    elif isinstance(candidate, list):
                        for i, v in enumerate(candidate):
                            val = self._num(v) if not isinstance(v, dict) else None
                            if val is not None and val >= 0:
                                day_key = f"{year}-{month:02d}-{i + 1:02d}"
                                daily_kwh[day_key] = val

                if daily_kwh:
                    return daily_kwh

                # Return raw obj for debugging if no known structure found
                self._last_month_raw = obj

            except Exception:
                continue

        return {}

    async def debug_month_raw(self, year: int, month: int) -> Any:
        """Return raw API response for monthly chart data (for debugging)."""
        import json
        date_str = f"{year}-{month:02d}-01"
        endpoints = [
            "/noahDeviceApi/nexa/getDataChart",
            "/noahDeviceApi/noah/getDataChart",
        ]
        for ep in endpoints:
            try:
                raw = await self._post(ep, {
                    "deviceSn": self.storage_sn,
                    "dateTime": date_str,
                    "dateType": "1",
                })
                if '"result":-1' in raw or len(raw) < 50:
                    continue
                return {"endpoint": ep, "data": json.loads(raw)}
            except Exception:
                continue
        return {"error": "no data from any endpoint"}

    async def debug_day_raw(self, day: str) -> Any:
        """Return raw API response for a single day (first record only)."""
        import json
        try:
            raw = await self._post("/device/getNoahHistory", {
                "deviceSn": self.storage_sn, "start": "0",
                "startDate": day, "endDate": day,
            })
            data = json.loads(raw)
            obj = self._get_response_obj(data)
            # Return top-level keys and first record for inspection
            result: dict[str, Any] = {"top_keys": list(data.keys()) if isinstance(data, dict) else "not_dict"}
            if isinstance(obj, dict):
                result["obj_keys"] = list(obj.keys())
                datas = obj.get("datas", [])
                if isinstance(datas, list) and datas:
                    result["num_records"] = len(datas)
                    result["first_record"] = datas[0]
                    result["last_record"] = datas[-1]
                # Check for any energy summary fields at top level
                for key in ["eToday", "epvToday", "eacToday", "energy", "totalEnergy", "pvEnergy", "eDay"]:
                    if key in obj:
                        result[f"obj.{key}"] = obj[key]
                    if key in data:
                        result[f"root.{key}"] = data[key]
            return result
        except Exception as e:
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # Day chart (history)
    # ------------------------------------------------------------------

    async def fetch_day_chart(self, selected_date: str) -> dict[str, Any]:
        import json

        # Method 1: getNoahHistory
        try:
            raw = await self._post("/device/getNoahHistory", {
                "deviceSn": self.storage_sn, "start": "0",
                "startDate": selected_date, "endDate": selected_date,
            })
            if '"result":-1' not in raw and len(raw) > 50:
                data = json.loads(raw)
                obj = self._get_response_obj(data)
                if isinstance(obj, dict):
                    chart_data = self._parse_noah_history(obj)
                    if chart_data:
                        return chart_data
        except Exception:
            pass

        # Method 2: Chart endpoints (date +1 API quirk)
        from datetime import datetime, timedelta
        try:
            dt = datetime.strptime(selected_date, "%Y-%m-%d")
            chart_date = (dt + timedelta(days=1)).strftime("%Y-%m-%d")
        except ValueError:
            chart_date = selected_date

        endpoints = [
            "/noahDeviceApi/nexa/getNexaChartData",
            "/noahDeviceApi/noah/getNoahChartData",
        ]
        for ep in endpoints:
            try:
                raw = await self._post(ep, {"deviceSn": self.storage_sn, "date": chart_date})
                if '"result":-1' in raw or len(raw) < 50:
                    continue
                data = json.loads(raw)
                obj = self._get_response_obj(data)
                return self._parse_generic_chart(obj)
            except Exception:
                continue

        return {}

    def _parse_noah_history(self, data: dict) -> dict[str, Any]:
        datas = data.get("datas", data if isinstance(data, list) else None)
        if not isinstance(datas, list) or not datas:
            return {}

        records = [r for r in datas if isinstance(r, dict)]
        if not records:
            return {}

        time_labels: list[str] = []
        for rec in records:
            time_str = rec.get("time", rec.get("dataTime", rec.get("calendar", "")))
            label = str(time_str)[11:16] if len(str(time_str)) > 11 else str(time_str)
            time_labels.append(label)

        # Ensure chronological order
        if len(time_labels) >= 2 and time_labels[0] > time_labels[-1]:
            records.reverse()
            time_labels.reverse()

        # Detect PV inputs
        pv_inputs = []
        for pv_num in range(1, 5):
            if f"pv{pv_num}Voltage" in records[0]:
                pv_inputs.append(pv_num)

        # Extract series data
        ppv_data: list[float | None] = []
        pac_data: list[float | None] = []
        load_data: list[float | None] = []
        soc_data: list[float | None] = []
        pv_module_data: dict[int, list[float]] = {n: [] for n in pv_inputs}

        soc_fields = ["soc", "totalBatteryPackSoc", "capacity", "batSoc"]

        for rec in records:
            ppv_data.append(self._num(rec.get("ppv")))
            pac_data.append(self._num(rec.get("pac")))
            load_data.append(self._num(rec.get("totalHouseholdLoad")))

            soc_val = None
            for sf in soc_fields:
                if sf in rec:
                    soc_val = self._num(rec[sf])
                    if soc_val is not None:
                        break
            soc_data.append(soc_val)

            for pv_num in pv_inputs:
                v = self._num(rec.get(f"pv{pv_num}Voltage")) or 0
                a = self._num(rec.get(f"pv{pv_num}Current")) or 0
                pv_module_data[pv_num].append(v * a)

        result: dict[str, Any] = {
            "timeLabels": time_labels,
            "ppv": ppv_data,
            "pac": pac_data,
            "totalHouseholdLoad": load_data,
            "soc": soc_data,
            "pvInputs": pv_inputs,
        }

        for pv_num in pv_inputs:
            result[f"pvModule{pv_num}"] = pv_module_data[pv_num]
            # Also provide raw V/A data for panel details
            v_data: list[float | None] = []
            a_data: list[float | None] = []
            for rec in records:
                v_data.append(self._num(rec.get(f"pv{pv_num}Voltage")))
                a_data.append(self._num(rec.get(f"pv{pv_num}Current")))
            result[f"pv{pv_num}Voltage"] = v_data
            result[f"pv{pv_num}Current"] = a_data

        return result

    def _parse_generic_chart(self, data: Any) -> dict[str, Any]:
        if not isinstance(data, dict):
            return {}

        charts = data.get("charts", data)
        if not isinstance(charts, dict):
            return {}

        # Check if noah time format (keys are times like "08:00")
        is_time_format = False
        for key, val in charts.items():
            if ":" in key and isinstance(val, dict):
                is_time_format = True
            break

        if is_time_format:
            time_labels = list(charts.keys())
            series: dict[str, list[float | None]] = {}
            for time_key, values in charts.items():
                if not isinstance(values, dict):
                    continue
                for name, val in values.items():
                    if name not in series:
                        series[name] = []
                    series[name].append(self._num(val))
            return {"timeLabels": time_labels, **series, "pvInputs": []}

        # Array-based format
        result: dict[str, Any] = {"pvInputs": []}
        for key, val in charts.items():
            if isinstance(val, list):
                result[key] = [self._num(v) for v in val]
        return result

    @staticmethod
    def _num(val: Any) -> float | None:
        if val is None:
            return None
        if isinstance(val, (int, float)):
            return float(val)
        try:
            return float(str(val).replace(",", "."))
        except (ValueError, TypeError):
            return None

    # ------------------------------------------------------------------
    # Panel details
    # ------------------------------------------------------------------

    async def fetch_panel_details(self, selected_date: str) -> dict[str, Any]:
        """Returns same data structure as day chart – the JS side filters for panel fields."""
        return await self.fetch_day_chart(selected_date)

    # ------------------------------------------------------------------
    # History helpers (for scheduler / DB)
    # ------------------------------------------------------------------

    async def fetch_day_intervals(self, day: str) -> list[dict] | None:
        """Fetch intraday records for DB storage. Returns list of dicts.

        Handles API pagination by incrementing the 'start' offset until
        no more data is returned.
        """
        import json

        soc_fields = ["soc", "totalBatteryPackSoc", "capacity", "batSoc"]
        load_fields = ["totalHouseholdLoad", "householdLoadApartFromGroplug",
                       "loadPower", "ctSelfPower"]

        all_records = []
        page_start = 0
        max_pages = 20  # Safety limit

        try:
            for _ in range(max_pages):
                raw = await self._post("/device/getNoahHistory", {
                    "deviceSn": self.storage_sn, "start": str(page_start),
                    "startDate": day, "endDate": day,
                })
                if '"result":-1' in raw or len(raw) < 50:
                    break
                data = json.loads(raw)
                obj = self._get_response_obj(data)
                datas = obj.get("datas", obj) if isinstance(obj, dict) else obj
                if not isinstance(datas, list) or len(datas) == 0:
                    break

                for r in datas:
                    if not isinstance(r, dict):
                        continue
                    time_val = str(r.get("time", r.get("dataTime", r.get("calendar", ""))))
                    if len(time_val) > 11:
                        time_val = time_val[11:16]

                    soc_val = None
                    for sf in soc_fields:
                        if sf in r:
                            soc_val = self._num(r[sf])
                            if soc_val is not None:
                                break

                    load_val = None
                    for lf in load_fields:
                        if lf in r:
                            load_val = self._num(r[lf])
                            if load_val is not None:
                                break

                    all_records.append({
                        "time": time_val,
                        "ppv": self._num(r.get("ppv")),
                        "pac": self._num(r.get("pac")),
                        "soc": soc_val,
                        "load_power": load_val,
                    })

                page_start += len(datas)

            return all_records if all_records else None
        except Exception:
            return None

    async def fetch_day_summary(self, day: str) -> dict | None:
        """Compute a daily summary from intraday records.

        Returns: {e_today, peak_power, peak_load, min_soc, max_soc}
        """
        records = await self.fetch_day_intervals(day)
        if not records:
            return None

        ppv_values = [r["ppv"] for r in records if r["ppv"] is not None]
        load_values = [r["load_power"] for r in records if r["load_power"] is not None]
        soc_values = [r["soc"] for r in records if r["soc"] is not None]

        if not ppv_values:
            return None

        # Trapezoidal integration using actual timestamps for accurate kWh
        e_today = self._integrate_energy(records)

        return {
            "e_today": round(e_today, 2),
            "peak_power": max(ppv_values) if ppv_values else 0,
            "peak_load": max(load_values) if load_values else 0,
            "min_soc": min(soc_values) if soc_values else 0,
            "max_soc": max(soc_values) if soc_values else 0,
        }

    @staticmethod
    def _parse_time_minutes(time_str: str) -> float | None:
        """Parse 'HH:MM' string to minutes since midnight."""
        try:
            parts = time_str.strip().split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except (ValueError, IndexError):
            return None

    def _integrate_energy(self, records: list[dict]) -> float:
        """Trapezoidal integration of ppv (W) over actual time intervals.

        Returns energy in kWh.
        """
        # Build list of (minutes_since_midnight, ppv_watts) with valid entries
        points = []
        for r in records:
            if r["ppv"] is None:
                continue
            t = self._parse_time_minutes(r.get("time", ""))
            if t is not None:
                points.append((t, r["ppv"]))

        if len(points) < 2:
            return 0.0

        # Sort by time
        points.sort(key=lambda p: p[0])

        # Trapezoidal rule: sum((ppv[i] + ppv[i+1]) / 2 * dt_hours)
        energy_wh = 0.0
        for i in range(len(points) - 1):
            dt_minutes = points[i + 1][0] - points[i][0]
            if dt_minutes <= 0 or dt_minutes > 30:
                # Skip gaps > 30 min (night, outages) or duplicate timestamps
                continue
            dt_hours = dt_minutes / 60.0
            avg_power = (points[i][1] + points[i + 1][1]) / 2.0
            energy_wh += avg_power * dt_hours

        return energy_wh / 1000.0  # Convert Wh to kWh

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    async def disconnect(self) -> None:
        if self.client:
            await self.client.aclose()
            self.client = None
        self.plant_id = ""
        self.storage_sn = ""
