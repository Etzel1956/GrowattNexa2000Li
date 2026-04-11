// ============================================================
// Growatt Nexa 2000 Li – Web Frontend v2.0
// ============================================================

let connected = false;
let autoRefreshTimer = null;
let lastChartData = null;   // cached history data for re-rendering
let lastPanelMode = false;  // true when Panel-Details view is active

// Chart.js instances
let mainChart = null;
let consumptionChart = null;
let historyChart = null;

// Shared zoom/pan view state – both charts show the same time window.
// Timestamps in ms since epoch. xMin/xMax = current visible window,
// dataXMin/dataXMax = range where actual (non-null) data exists.
const chartView = { xMin: null, xMax: null, date: null, dataXMin: null, dataXMax: null };

// Sync guard to prevent infinite zoom-callback loops between the two charts
let _syncingZoom = false;

// ------------------------------------------------------------------
// State persistence (survives F5 / browser refresh)
// ------------------------------------------------------------------

function saveViewState() {
    try {
        sessionStorage.setItem('growatt_viewState', JSON.stringify({
            chartView: {
                xMin: chartView.xMin, xMax: chartView.xMax, date: chartView.date,
                dataXMin: chartView.dataXMin, dataXMax: chartView.dataXMax,
            },
            lastPanelMode,
            panelMode: document.querySelector('input[name="panelMode"]:checked')?.value || 'power',
            selectedDate: document.getElementById('selectedDate')?.value || '',
        }));
    } catch (e) { /* ignore storage errors */ }
}

function loadViewState() {
    try {
        const raw = sessionStorage.getItem('growatt_viewState');
        if (!raw) return false;
        const s = JSON.parse(raw);
        // Only adopt state from the new (timestamp-based) schema.
        // Pre-refactor state used {start,end,total} indices and is incompatible.
        if (s.chartView && 'xMin' in s.chartView && 'xMax' in s.chartView) {
            chartView.xMin     = s.chartView.xMin;
            chartView.xMax     = s.chartView.xMax;
            chartView.date     = s.chartView.date;
            chartView.dataXMin = s.chartView.dataXMin;
            chartView.dataXMax = s.chartView.dataXMax;
        }
        if (s.lastPanelMode != null) lastPanelMode = s.lastPanelMode;
        if (s.panelMode) {
            const radio = document.querySelector(`input[name="panelMode"][value="${s.panelMode}"]`);
            if (radio) radio.checked = true;
        }
        if (s.selectedDate) {
            const el = document.getElementById('selectedDate');
            if (el) el.value = s.selectedDate;
        }
        return true;
    } catch (e) { return false; }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function log(msg) {
    const el = document.getElementById('logArea');
    const ts = new Date().toLocaleTimeString('de-DE');
    el.textContent += `[${ts}] ${msg}\n`;
    el.scrollTop = el.scrollHeight;
}

async function apiCall(url, options = {}) {
    try {
        const r = await fetch(url, options);
        return await r.json();
    } catch (e) {
        log(`Fehler: ${e.message}`);
        return null;
    }
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

// Color map matching the VB.NET original
const SERIES_COLORS = {
    ppv:   '#ffc800',
    pac:   '#fd7e14',
    totalHouseholdLoad: '#007bff',
    soc:   '#28a745',
    pv1:   '#dc3232',
    pv2:   '#3232dc',
    pv3:   '#32b432',
    pv4:   '#c87800',
};

function pvColor(num) {
    return SERIES_COLORS[`pv${num}`] || '#888';
}

// ------------------------------------------------------------------
// Tab switching
// ------------------------------------------------------------------

function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === name);
    });
    document.querySelectorAll('.tab-content').forEach(sec => {
        sec.classList.toggle('active', sec.id === 'tab-' + name);
    });

    if (name === 'history') {
        fetchMonthlyHistory();
    } else if (name === 'statistics') {
        fetchStatistics();
    }
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    // Restore persisted state first (selected date, zoom, panel mode)
    const hasState = loadViewState();
    if (!hasState) {
        document.getElementById('selectedDate').value = todayStr();
    }

    // Init Chart.js – Live charts
    mainChart = new Chart(document.getElementById('chartMain'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: chartOptions('W', false),
    });
    consumptionChart = new Chart(document.getElementById('chartConsumption'), {
        type: 'line',
        data: { labels: [], datasets: [] },
        options: chartOptions('W', false),
    });

    // Mouse wheel zoom, pinch, pan, and touch-drag are all handled by
    // chartjs-plugin-zoom (see chartOptions). No manual listeners needed.

    // Init year/month selectors
    initHistorySelectors();

    // Load DB status
    fetchDbStatus();
    setInterval(fetchDbStatus, 30000);
});

function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function chartOptions(yLabel, dualAxis) {
    const opts = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle' } },
            tooltip: {
                mode: 'index',
                intersect: false,
                callbacks: {
                    title: (items) => {
                        if (!items.length) return '';
                        const d = new Date(items[0].parsed.x);
                        return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
                    },
                },
            },
            zoom: {
                pan: {
                    enabled: true,
                    mode: 'x',
                    onPanComplete: onZoomOrPanComplete,
                },
                zoom: {
                    wheel: { enabled: true, speed: 0.1 },
                    pinch: { enabled: true },
                    mode: 'x',
                    onZoomComplete: onZoomOrPanComplete,
                },
            },
        },
        scales: {
            x: {
                type: 'time',
                time: {
                    unit: 'hour',
                    stepSize: 2,
                    displayFormats: { hour: 'HH:mm', minute: 'HH:mm' },
                    tooltipFormat: 'HH:mm',
                },
                ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 18 },
                grid: { color: '#eee' },
            },
            y: {
                title: { display: true, text: yLabel },
                grid: { color: '#eee' },
            },
        },
    };
    if (dualAxis) {
        opts.scales.y2 = {
            position: 'right',
            title: { display: true, text: 'SOC %' },
            min: 0, max: 100,
            grid: { drawOnChartArea: false },
            ticks: { color: '#28a745' },
        };
    }
    return opts;
}

// ------------------------------------------------------------------
// Synchronized zoom / pan – both charts share one time window.
// Driven by chartjs-plugin-zoom: we only keep the current {xMin,xMax}
// in chartView, mirror it to the other chart, and persist it.
// ------------------------------------------------------------------

// Callback bound into the plugin options for both charts
function onZoomOrPanComplete({ chart }) {
    if (_syncingZoom) return;
    const xScale = chart.scales.x;
    if (!xScale) return;
    chartView.xMin = xScale.min;
    chartView.xMax = xScale.max;
    saveViewState();
    mirrorZoomToOther(chart);
}

// Apply the current chartView window to a single chart (used after data reload)
function applyViewToChart(chart) {
    if (!chart || chartView.xMin == null || chartView.xMax == null) return;
    _syncingZoom = true;
    try {
        chart.zoomScale('x', { min: chartView.xMin, max: chartView.xMax }, 'none');
    } finally {
        _syncingZoom = false;
    }
}

// Mirror the source chart's x-window onto the other chart
function mirrorZoomToOther(sourceChart) {
    const other = sourceChart === mainChart ? consumptionChart : mainChart;
    if (!other || !other.data || !other.data.datasets || other.data.datasets.length === 0) return;
    _syncingZoom = true;
    try {
        other.zoomScale('x', { min: chartView.xMin, max: chartView.xMax }, 'none');
    } finally {
        _syncingZoom = false;
    }
}

// Toggle: fit to data  <->  full 24h
function resetChartZoom() {
    if (chartView.dataXMin == null || chartView.dataXMax == null) return;
    // Build "fit to data" window with a small margin (~10 min)
    const marginMs = 10 * 60 * 1000;
    const fitMin = chartView.dataXMin - marginMs;
    const fitMax = chartView.dataXMax + marginMs;
    const atFit = (Math.abs(chartView.xMin - fitMin) < 1000 &&
                   Math.abs(chartView.xMax - fitMax) < 1000);
    if (atFit) {
        // Show full 24h by resetting zoom on both charts
        [mainChart, consumptionChart].forEach(c => {
            if (c && c.data.datasets.length) c.resetZoom('none');
        });
        const xScale = mainChart && mainChart.scales.x;
        if (xScale) { chartView.xMin = xScale.min; chartView.xMax = xScale.max; }
    } else {
        chartView.xMin = fitMin;
        chartView.xMax = fitMax;
        [mainChart, consumptionChart].forEach(applyViewToChart);
    }
    saveViewState();
}

// Called after new data is loaded. Preserves window on same-date refresh,
// fits to data range on a new date / first load.
function onNewChartData(date, dataXMin, dataXMax) {
    if (dataXMin != null) chartView.dataXMin = dataXMin;
    if (dataXMax != null) chartView.dataXMax = dataXMax;
    const sameDate = (chartView.date === date);
    if (!sameDate) {
        chartView.date = date;
        const marginMs = 10 * 60 * 1000;
        if (dataXMin != null && dataXMax != null) {
            chartView.xMin = dataXMin - marginMs;
            chartView.xMax = dataXMax + marginMs;
        } else {
            chartView.xMin = null;
            chartView.xMax = null;
        }
    }
    saveViewState();
}

// ------------------------------------------------------------------
// Fullscreen chart mode (especially useful on mobile)
// ------------------------------------------------------------------

function toggleFullscreen(cardId) {
    const card = document.getElementById(cardId);
    const isFullscreen = card.classList.toggle('fullscreen');

    // Find the chart instance for this card
    const canvas = card.querySelector('canvas');
    const chart = canvas.id === 'chartMain' ? mainChart : consumptionChart;

    // Resize charts after layout change
    setTimeout(() => {
        mainChart.resize();
        consumptionChart.resize();
    }, 50);
}

// ESC or back to close fullscreen chart
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const fs = document.querySelector('.chart-card.fullscreen');
        if (fs) toggleFullscreen(fs.id);
    }
});

// ------------------------------------------------------------------
// Pad chart data to full 24 h – keeps original labels, adds
// empty markers before/after so the x-axis spans 00:00 – 23:55
// ------------------------------------------------------------------

function padDataTo24h(data, dateStr) {
    const srcLabels = data.timeLabels || [];
    if (srcLabels.length === 0) return data;

    // Detect interval from data (default 5 min)
    let intervalMin = 5;
    if (srcLabels.length >= 2) {
        const t0 = timeToMinutes(srcLabels[0]);
        const t1 = timeToMinutes(srcLabels[1]);
        if (t1 > t0) intervalMin = t1 - t0;
    }

    // Build padding labels BEFORE first data point
    const firstMin = timeToMinutes(srcLabels[0]);
    const lastMin  = timeToMinutes(srcLabels[srcLabels.length - 1]);
    const before = [];
    for (let m = 0; m < firstMin; m += intervalMin) {
        before.push(minutesToTime(m));
    }
    // Build padding labels AFTER last data point
    const after = [];
    for (let m = lastMin + intervalMin; m < 1440; m += intervalMin) {
        after.push(minutesToTime(m));
    }

    // Combine: [before nulls] + [original data] + [after nulls]
    const fullLabels = [...before, ...srcLabels, ...after];

    // Data keys to pad (all arrays with same length as timeLabels)
    const arrayKeys = Object.keys(data).filter(
        k => k !== 'timeLabels' && k !== 'pvInputs' && Array.isArray(data[k]) && data[k].length === srcLabels.length
    );

    const padded = { timeLabels: fullLabels, pvInputs: data.pvInputs };
    const nullsBefore = new Array(before.length).fill(null);
    const nullsAfter  = new Array(after.length).fill(null);
    for (const key of arrayKeys) {
        padded[key] = [...nullsBefore, ...data[key], ...nullsAfter];
    }
    // Build Date-object labels for Chart.js time scale.
    // Use the chart's selected date; fall back to today if missing.
    const baseDate = dateStr || todayStr();
    padded.dateLabels = fullLabels.map(hhmm => new Date(`${baseDate}T${hhmm}:00`));
    // Timestamps (ms) of the first and last real (non-padded) data point
    padded.dataXMin = padded.dateLabels[before.length].getTime();
    padded.dataXMax = padded.dateLabels[before.length + srcLabels.length - 1].getTime();
    return padded;
}

function timeToMinutes(hhmm) {
    const parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function minutesToTime(m) {
    const hh = String(Math.floor(m / 60)).padStart(2, '0');
    const mm = String(m % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}

// ------------------------------------------------------------------
// Connect / Disconnect
// ------------------------------------------------------------------

async function toggleConnect() {
    if (connected) {
        await apiCall('/api/disconnect', { method: 'POST' });
        connected = false;
        updateConnectionUI();
        log('Verbindung getrennt.');
        return;
    }

    const btn = document.getElementById('btnConnect');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Verbinde...';
    log('Verbinde mit Growatt...');

    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const result = await apiCall('/api/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });

    btn.disabled = false;

    if (!result || !result.success) {
        btn.textContent = 'Verbinden';
        log(`Login fehlgeschlagen: ${result?.error || 'Unbekannter Fehler'}`);
        return;
    }

    connected = true;
    if (result.logs) result.logs.forEach(l => log(l));
    updateConnectionUI();

    // Auto-load live data + restore previous view mode
    await fetchLiveStatus();
    await fetchEnergyTotals();
    if (lastPanelMode) {
        await fetchPanelDetails();
    } else {
        await fetchDayChart();
    }
}

function updateConnectionUI() {
    const btn = document.getElementById('btnConnect');
    const status = document.getElementById('connectionStatus');
    const actions = document.getElementById('actionsCard');
    const statusCard = document.getElementById('statusCard');

    if (connected) {
        btn.textContent = 'Trennen';
        btn.classList.add('connected');
        status.textContent = 'Verbunden';
        actions.style.display = '';
        statusCard.style.display = '';
    } else {
        btn.textContent = 'Verbinden';
        btn.classList.remove('connected');
        status.textContent = 'Nicht verbunden';
        actions.style.display = 'none';
        statusCard.style.display = 'none';
        stopAutoRefresh();
    }
}

// ------------------------------------------------------------------
// Live Status
// ------------------------------------------------------------------

async function fetchLiveStatus() {
    if (!connected) return;
    log('Lade Live-Status...');
    const data = await apiCall('/api/live-status');
    if (!data || data.error) {
        log('Live-Status fehlgeschlagen.');
        return;
    }
    document.getElementById('valPvPower').textContent = data.pvPower || '-- W';
    document.getElementById('valBatSoc').textContent = data.batSoc || '-- %';
    document.getElementById('valBatPower').textContent = data.batPower || '-- W';
    document.getElementById('valLoadPower').textContent = data.loadPower || '-- W';
    document.getElementById('valGridPower').textContent = data.gridPower || '-- W';
    document.getElementById('valPvToday').textContent = data.pvToday || '-- kWh';
    document.getElementById('valPvTotal').textContent = data.pvTotal || '-- kWh';
    log('Live-Status aktualisiert.');
}

// ------------------------------------------------------------------
// Energy Totals
// ------------------------------------------------------------------

async function fetchEnergyTotals() {
    if (!connected) return;
    log('Lade Energie-Gesamtdaten...');
    const data = await apiCall('/api/energy-totals');
    if (!data || data.error) return;
    if (data.pvToday) document.getElementById('valPvToday').textContent = data.pvToday;
    if (data.pvTotal) document.getElementById('valPvTotal').textContent = data.pvTotal;
    if (data.chargeToday) document.getElementById('valChargeToday').textContent = data.chargeToday;
    log('Energie-Gesamtdaten aktualisiert.');
}

// ------------------------------------------------------------------
// Day Chart
// ------------------------------------------------------------------

async function fetchDayChart() {
    if (!connected) return;
    hidePanelFilter();
    lastPanelMode = false;
    saveViewState();
    const date = document.getElementById('selectedDate').value || todayStr();
    log(`Lade Tages-Chart (${date})...`);

    const data = await apiCall(`/api/day-chart?date=${date}`);
    if (!data || data.error || !data.timeLabels) {
        log('Keine Chart-Daten.');
        return;
    }
    lastChartData = data;
    renderEnergyCharts(data);
    log('Chart aktualisiert.');
}

function renderEnergyCharts(data) {
    const showPv = document.getElementById('chkShowPvModules').checked;
    const date = document.getElementById('selectedDate').value || todayStr();
    const padded = padDataTo24h(data, date);
    const labels = padded.dateLabels || [];
    // Use padded data for all series lookups
    data = padded;

    // -- Main chart datasets --
    const datasets = [];

    // SOC as filled area (background)
    if (data.soc) {
        datasets.push({
            label: 'SOC (%)',
            data: data.soc,
            borderColor: 'rgba(40,167,69,0.5)',
            backgroundColor: 'rgba(40,167,69,0.08)',
            fill: true,
            yAxisID: 'y2',
            borderWidth: 1,
            pointRadius: 0,
            order: 10,
            spanGaps: false,
        });
    }

    if (showPv && data.pvInputs && data.pvInputs.length > 0) {
        for (const pvNum of data.pvInputs) {
            const key = `pvModule${pvNum}`;
            if (data[key]) {
                datasets.push({
                    label: `PV${pvNum} (W)`,
                    data: data[key],
                    borderColor: pvColor(pvNum),
                    backgroundColor: pvColor(pvNum),
                    borderWidth: 1.5,
                    pointRadius: 2,
                    fill: false,
                    spanGaps: false,
                });
            }
        }
    } else {
        if (data.ppv) {
            datasets.push({
                label: 'PV-Leistung (W)',
                data: data.ppv,
                borderColor: SERIES_COLORS.ppv,
                backgroundColor: SERIES_COLORS.ppv,
                borderWidth: 1.5,
                pointRadius: 2,
                fill: false,
                spanGaps: false,
            });
        }
    }

    if (data.pac) {
        datasets.push({
            label: 'Netz (W)',
            data: data.pac,
            borderColor: SERIES_COLORS.pac,
            backgroundColor: SERIES_COLORS.pac,
            borderWidth: 1.5,
            pointRadius: 2,
            fill: false,
            spanGaps: false,
        });
    }

    // Update zoom state (resets only on date change, zooms to data range)
    onNewChartData(date, padded.dataXMin, padded.dataXMax);

    // -- Main chart --
    mainChart.data.labels = labels;
    mainChart.data.datasets = datasets;
    mainChart.options = chartOptions('W', true);
    mainChart.options.plugins.title = {
        display: true,
        text: (showPv ? 'PV-Module' : 'PV') + ` / Netz / SOC - ${date}`,
        font: { size: 14, weight: 'bold' },
    };
    mainChart.update('none');
    applyViewToChart(mainChart);

    // -- Consumption chart --
    const conDatasets = [];
    if (padded.totalHouseholdLoad) {
        conDatasets.push({
            label: 'Verbrauch (W)',
            data: padded.totalHouseholdLoad,
            borderColor: SERIES_COLORS.totalHouseholdLoad,
            backgroundColor: SERIES_COLORS.totalHouseholdLoad,
            borderWidth: 1.5,
            pointRadius: 2,
            fill: false,
            spanGaps: false,
        });
    }
    consumptionChart.data.labels = labels;
    consumptionChart.data.datasets = conDatasets;
    consumptionChart.options = chartOptions('W', false);
    consumptionChart.options.plugins.title = {
        display: true,
        text: `Verbrauch im Haus - ${date}`,
        font: { size: 14, weight: 'bold' },
    };
    consumptionChart.update('none');
    applyViewToChart(consumptionChart);
}

function onPvModulesToggle() {
    if (lastChartData && !lastPanelMode) {
        renderEnergyCharts(lastChartData);
    }
}

// ------------------------------------------------------------------
// Panel Details
// ------------------------------------------------------------------

async function fetchPanelDetails() {
    if (!connected) return;
    lastPanelMode = true;
    saveViewState();
    const date = document.getElementById('selectedDate').value || todayStr();
    log(`Lade Panel-Details (${date})...`);

    // Remember current checkbox state before rebuilding
    const prevChecked = [...document.querySelectorAll('.pvChk')].map(c => ({
        value: parseInt(c.value), checked: c.checked
    }));

    const data = await apiCall(`/api/panel-details?date=${date}`);
    if (!data || data.error || !data.pvInputs || data.pvInputs.length === 0) {
        log('Keine Panel-Detail-Daten.');
        return;
    }
    lastChartData = data;
    buildPanelFilter(data.pvInputs);

    // Restore previous checkbox state if same inputs exist
    if (prevChecked.length > 0) {
        document.querySelectorAll('.pvChk').forEach(chk => {
            const prev = prevChecked.find(p => p.value === parseInt(chk.value));
            if (prev) chk.checked = prev.checked;
        });
    }

    showPanelFilter();
    refreshPanelChart();
    log('Panel-Details geladen.');
}

function buildPanelFilter(pvInputs) {
    const container = document.getElementById('pvCheckboxes');
    container.innerHTML = '';
    const colors = ['Rot', 'Blau', 'Gruen', 'Orange'];
    for (const num of pvInputs) {
        const lbl = document.createElement('label');
        lbl.innerHTML = `<input type="checkbox" class="pvChk" value="${num}" checked onchange="refreshPanelChart()"> PV${num} (${colors[num-1]})`;
        container.appendChild(lbl);
    }
}

function showPanelFilter() {
    document.getElementById('panelFilterCard').classList.add('active');
}

function hidePanelFilter() {
    document.getElementById('panelFilterCard').classList.remove('active');
}

function refreshPanelChart() {
    if (!lastChartData || !lastPanelMode) return;
    const date = document.getElementById('selectedDate').value || todayStr();
    const data = padDataTo24h(lastChartData, date);

    const mode = document.querySelector('input[name="panelMode"]:checked')?.value || 'power';
    const activeInputs = [...document.querySelectorAll('.pvChk:checked')].map(c => parseInt(c.value));
    const labels = data.dateLabels || [];

    const datasets = [];

    if (mode === 'power') {
        for (const pvNum of activeInputs) {
            const key = `pvModule${pvNum}`;
            if (data[key]) {
                datasets.push({
                    label: `PV${pvNum} (W)`,
                    data: data[key],
                    borderColor: pvColor(pvNum),
                    backgroundColor: pvColor(pvNum),
                    borderWidth: 1.5,
                    pointRadius: 2,
                    tension: 0.3,
                    fill: false,
                });
            }
        }
        mainChart.options = chartOptions('Leistung (W)', false);
        mainChart.options.plugins.title = {
            display: true,
            text: `Panel-Leistung (W) - ${date}`,
            font: { size: 14, weight: 'bold' },
        };
    } else {
        for (const pvNum of activeInputs) {
            const vKey = `pv${pvNum}Voltage`;
            const iKey = `pv${pvNum}Current`;
            const color = pvColor(pvNum);
            if (data[vKey]) {
                datasets.push({
                    label: `PV${pvNum} Spannung (V)`,
                    data: data[vKey],
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 1.5,
                    pointRadius: 2,
                    tension: 0.3,
                    yAxisID: 'y',
                    fill: false,
                });
            }
            if (data[iKey]) {
                datasets.push({
                    label: `PV${pvNum} Strom (A)`,
                    data: data[iKey],
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 1.5,
                    borderDash: [5, 3],
                    pointRadius: 2,
                    tension: 0.3,
                    yAxisID: 'y2',
                    fill: false,
                });
            }
        }
        mainChart.options = chartOptions('Spannung (V)', false);
        mainChart.options.scales.y2 = {
            position: 'right',
            title: { display: true, text: 'Strom (A)' },
            grid: { drawOnChartArea: false },
        };
        mainChart.options.plugins.title = {
            display: true,
            text: `Panel-Details (V / A) - ${date}`,
            font: { size: 14, weight: 'bold' },
        };
    }

    onNewChartData(date, data.dataXMin, data.dataXMax);
    mainChart.data.labels = labels;
    mainChart.data.datasets = datasets;
    mainChart.update('none');
    applyViewToChart(mainChart);

    consumptionChart.data.labels = [];
    consumptionChart.data.datasets = [];
    consumptionChart.update('none');
}

// Refresh panel data without resetting filter checkboxes / mode
async function refreshPanelDataKeepState() {
    if (!connected) return;
    const date = document.getElementById('selectedDate').value || todayStr();
    const data = await apiCall(`/api/panel-details?date=${date}`);
    if (!data || data.error || !data.pvInputs || data.pvInputs.length === 0) return;
    lastChartData = data;
    refreshPanelChart();
}

// ------------------------------------------------------------------
// Auto-Refresh
// ------------------------------------------------------------------

function toggleAutoRefresh() {
    if (document.getElementById('chkAutoRefresh').checked) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
}

function startAutoRefresh() {
    stopAutoRefresh();
    document.getElementById('chkAutoRefresh').checked = true;
    autoRefreshTimer = setInterval(async () => {
        if (connected) {
            await fetchLiveStatus();
            await fetchEnergyTotals();
            if (lastPanelMode) {
                await refreshPanelDataKeepState();
            } else {
                await fetchDayChart();
            }
        }
    }, 30000);
    document.getElementById('refreshIndicator').classList.add('active');
    log('Auto-Refresh aktiviert (30s)');
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
    document.getElementById('refreshIndicator').classList.remove('active');
    document.getElementById('chkAutoRefresh').checked = false;
}

// ==================================================================
// History Tab
// ==================================================================

function initHistorySelectors() {
    const yearSel = document.getElementById('historyYear');
    const currentYear = new Date().getFullYear();
    for (let y = currentYear; y >= currentYear - 5; y--) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = y;
        yearSel.appendChild(opt);
    }

    const monthSel = document.getElementById('historyMonth');
    const monthNames = ['Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
                        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    monthNames.forEach((name, i) => {
        const opt = document.createElement('option');
        opt.value = i + 1;
        opt.textContent = name;
        monthSel.appendChild(opt);
    });
}

async function fetchMonthlyHistory(year) {
    if (!year) {
        year = document.getElementById('historyYear').value;
    }
    document.getElementById('historyMonth').value = '';

    try {
        const resp = await fetch(`/api/history/monthly?year=${year}`);
        const json = await resp.json();
        renderMonthlyChart(json.data, year);
    } catch (err) {
        console.error('fetchMonthlyHistory failed:', err);
    }
}

function renderMonthlyChart(data, year) {
    const ctx = document.getElementById('historyChart').getContext('2d');
    if (historyChart) historyChart.destroy();

    const monthNames = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

    const values = new Array(12).fill(0);
    data.forEach(row => {
        const m = parseInt(row.month.split('-')[1], 10) - 1;
        values[m] = Math.round(row.total_kwh * 100) / 100;
    });

    historyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: monthNames,
            datasets: [{
                label: `kWh/Monat (${year})`,
                data: values,
                backgroundColor: 'rgba(255, 165, 0, 0.7)',
                borderColor: 'rgba(255, 140, 0, 1)',
                borderWidth: 1,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (evt, elements) => {
                if (elements.length > 0) {
                    const monthIdx = elements[0].index;
                    drillDownToMonth(year, monthIdx + 1);
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        afterLabel: (ctx) => {
                            const row = data.find(r => parseInt(r.month.split('-')[1], 10) - 1 === ctx.dataIndex);
                            if (row) {
                                return `Tage: ${row.days_recorded} | Ø ${(row.avg_daily_kwh || 0).toFixed(1)} kWh/Tag`;
                            }
                            return '';
                        }
                    }
                },
                legend: { display: true },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'kWh' },
                },
            },
        },
    });
}

// -- Daily drill-down --

function drillDownToMonth(year, month) {
    document.getElementById('historyMonth').value = String(month);
    fetchDailyHistory(year, month);
}

function onHistoryMonthSelect() {
    const month = document.getElementById('historyMonth').value;
    const year = document.getElementById('historyYear').value;
    if (month) {
        fetchDailyHistory(year, parseInt(month, 10));
    } else {
        fetchMonthlyHistory(year);
    }
}

async function fetchDailyHistory(year, month) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    try {
        const resp = await fetch(`/api/history/daily?start=${start}&end=${end}`);
        const json = await resp.json();
        renderDailyChart(json.data, year, month);
    } catch (err) {
        console.error('fetchDailyHistory failed:', err);
    }
}

function renderDailyChart(data, year, month) {
    const ctx = document.getElementById('historyChart').getContext('2d');
    if (historyChart) historyChart.destroy();

    const monthNames = ['Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
                        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

    const lastDay = new Date(year, month, 0).getDate();
    const labels = [];
    const values = [];
    for (let d = 1; d <= lastDay; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        labels.push(String(d));
        const row = data.find(r => r.date === dateStr);
        values.push(row ? Math.round(row.e_today * 100) / 100 : 0);
    }

    historyChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: `kWh/Tag — ${monthNames[month - 1]} ${year}`,
                data: values,
                backgroundColor: 'rgba(54, 162, 235, 0.7)',
                borderColor: 'rgba(54, 162, 235, 1)',
                borderWidth: 1,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        afterLabel: (ctx) => {
                            const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(ctx.dataIndex + 1).padStart(2, '0')}`;
                            const row = data.find(r => r.date === dateStr);
                            if (row) {
                                return `Peak: ${row.peak_power || 0} W | SOC: ${row.min_soc || 0}–${row.max_soc || 0}%`;
                            }
                            return '';
                        }
                    }
                },
                legend: { display: true },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'kWh' },
                },
            },
        },
    });
}

// ==================================================================
// Statistics Tab
// ==================================================================

async function fetchStatistics() {
    try {
        const resp = await fetch('/api/history/statistics');
        const stats = await resp.json();

        document.getElementById('statBestDay').textContent =
            stats.best_day.kwh ? `${stats.best_day.kwh.toFixed(2)} kWh` : '—';
        document.getElementById('statBestDayDate').textContent =
            stats.best_day.date || '';

        document.getElementById('statMaxPower').textContent =
            stats.max_power.watts ? `${stats.max_power.watts.toFixed(0)} W` : '—';
        document.getElementById('statMaxPowerDate').textContent =
            stats.max_power.date || '';

        document.getElementById('statTotalKwh').textContent =
            stats.total_kwh ? `${stats.total_kwh.toFixed(1)} kWh` : '—';
        document.getElementById('statTotalDays').textContent =
            stats.days_recorded ? `${stats.days_recorded} Tage erfasst` : '';

        document.getElementById('statAvgDaily').textContent =
            stats.avg_daily_kwh ? `${stats.avg_daily_kwh.toFixed(2)}` : '—';
    } catch (err) {
        console.error('fetchStatistics failed:', err);
    }
}

// ==================================================================
// DB Status
// ==================================================================

async function fetchDbStatus() {
    try {
        const resp = await fetch('/api/db-status');
        const info = await resp.json();

        document.getElementById('dbDaysRecorded').textContent = info.days_recorded || 0;

        const range = (info.oldest_date && info.newest_date)
            ? `${info.oldest_date} — ${info.newest_date}`
            : '—';
        document.getElementById('dbDateRange').textContent = range;

        document.getElementById('dbLastFetched').textContent =
            info.last_fetched ? new Date(info.last_fetched).toLocaleString('de-DE') : '—';

        const sched = info.scheduler || {};
        let stateText = sched.running ? 'Aktiv' : 'Gestoppt';
        if (sched.state === 'backfilling' && sched.backfill_progress) {
            stateText = `Backfill ${sched.backfill_progress}`;
        }
        document.getElementById('schedulerState').textContent = stateText;
    } catch (err) {
        console.error('fetchDbStatus failed:', err);
    }
}
