// ============================================================
// Growatt Nexa 2000 Li – Web Frontend
// ============================================================

let connected = false;
let autoRefreshTimer = null;
let lastChartData = null;   // cached history data for re-rendering
let lastPanelMode = false;  // true when Panel-Details view is active

// Chart.js instances
let mainChart = null;
let consumptionChart = null;

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
// Init
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('selectedDate').value = todayStr();

    // Init Chart.js
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
});

function chartOptions(yLabel, dualAxis) {
    const opts = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { position: 'top', labels: { usePointStyle: true, pointStyle: 'circle' } },
            tooltip: { mode: 'index', intersect: false },
        },
        scales: {
            x: {
                ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
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

    // Auto-load live data + chart
    await fetchLiveStatus();
    await fetchEnergyTotals();
    await fetchDayChart();
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
    const labels = data.timeLabels || [];
    const date = document.getElementById('selectedDate').value || todayStr();

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
        });
    }

    if (showPv && data.pvInputs && data.pvInputs.length > 0) {
        // PV modules individually
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
                });
            }
        }
    } else {
        // PV total
        if (data.ppv) {
            datasets.push({
                label: 'PV-Leistung (W)',
                data: data.ppv,
                borderColor: SERIES_COLORS.ppv,
                backgroundColor: SERIES_COLORS.ppv,
                borderWidth: 1.5,
                pointRadius: 2,
                fill: false,
            });
        }
    }

    // Grid (pac)
    if (data.pac) {
        datasets.push({
            label: 'Netz (W)',
            data: data.pac,
            borderColor: SERIES_COLORS.pac,
            backgroundColor: SERIES_COLORS.pac,
            borderWidth: 1.5,
            pointRadius: 2,
            fill: false,
        });
    }

    // Update main chart
    mainChart.data.labels = labels;
    mainChart.data.datasets = datasets;
    mainChart.options = chartOptions('W', true);
    mainChart.options.plugins.title = {
        display: true,
        text: (showPv ? 'PV-Module' : 'PV') + ` / Netz / SOC - ${date}`,
        font: { size: 14, weight: 'bold' },
    };
    mainChart.update();

    // -- Consumption chart --
    const conDatasets = [];
    if (data.totalHouseholdLoad) {
        conDatasets.push({
            label: 'Verbrauch (W)',
            data: data.totalHouseholdLoad,
            borderColor: SERIES_COLORS.totalHouseholdLoad,
            backgroundColor: SERIES_COLORS.totalHouseholdLoad,
            borderWidth: 1.5,
            pointRadius: 2,
            fill: false,
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
    consumptionChart.update();
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
    const date = document.getElementById('selectedDate').value || todayStr();
    log(`Lade Panel-Details (${date})...`);

    const data = await apiCall(`/api/panel-details?date=${date}`);
    if (!data || data.error || !data.pvInputs || data.pvInputs.length === 0) {
        log('Keine Panel-Detail-Daten.');
        return;
    }
    lastChartData = data;
    buildPanelFilter(data.pvInputs);
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
    const data = lastChartData;
    const date = document.getElementById('selectedDate').value || todayStr();

    const mode = document.querySelector('input[name="panelMode"]:checked')?.value || 'power';
    const activeInputs = [...document.querySelectorAll('.pvChk:checked')].map(c => parseInt(c.value));
    const labels = data.timeLabels || [];

    const datasets = [];

    if (mode === 'power') {
        // Power mode: V * A per PV module
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
        // Voltage / Current mode
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

    mainChart.data.labels = labels;
    mainChart.data.datasets = datasets;
    mainChart.update();

    // Clear consumption chart during panel view
    consumptionChart.data.labels = [];
    consumptionChart.data.datasets = [];
    consumptionChart.update();
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
            if (!lastPanelMode) {
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
