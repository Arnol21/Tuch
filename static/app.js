// ═══════════════════════════════════════════════════════════
//  TUUCH QUALITY – Dashboard JS  (con control START / STOP)
// ═══════════════════════════════════════════════════════════

const LIMITS = {
  ph:           { min: 6.5, max: 8.5,  label: 'pH',               unit: '' },
  temperatura:  { min: 10,  max: 30,   label: 'Temperatura',      unit: '°C' },
  orp:          { min: 150, max: 350,  label: 'ORP',              unit: ' mV' },
  conductividad:{ min: 200, max: 800,  label: 'Conductividad',    unit: ' µS/cm' },
  turbidez:     { min: 0,   max: 4.0,  label: 'Turbidez',         unit: ' NTU' },
  oxigeno:      { min: 6.0, max: 14.0, label: 'Oxígeno Disuelto', unit: ' mg/L' },
};

const COLORS = {
  ph: '#40a9ff', temperatura: '#36cfc9', orp: '#9254de',
  conductividad: '#1890ff', turbidez: '#ffa940', oxigeno: '#13c2c2'
};

const PARAMS = Object.keys(LIMITS);

let currentValues = { ph: null, temperatura: null, orp: null, conductividad: null, turbidez: null, oxigeno: null };
// Timestamps de cambios locales por parámetro (ms desde epoch).
// Cuando el usuario mueve un slider registramos el timestamp y evitamos
// que fetchLive() sobrescriba ese parámetro durante unos segundos.
let lastLocalChange = { ph: 0, temperatura: 0, orp: 0, conductividad: 0, turbidez: 0, oxigeno: 0 };
let history      = [];
let visible      = { ph: true, temperatura: true, orp: true, conductividad: true, turbidez: true, oxigeno: true };
let sparkCharts  = {};
let mainChartRef = null;
const MAX_PTS    = 30;
let chartData    = { labels: [], datasets: [] };
let connected    = false;

// ── CONTROL DE ESTADO (START / STOP) ──────────────────────
let isRunning  = true;   // arranca activo
let tickTimer  = null;

function setRunning(run) {
  isRunning = run;
  const btn = document.getElementById('btnStartStop');
  if (!btn) return;

  if (run) {
    btn.innerHTML = `
      <span class="ss-dot ss-dot-run"></span>
      <span class="ss-label">STOP</span>`;
    btn.classList.remove('ss-stopped');
    btn.classList.add('ss-running');
    startTicking();
  } else {
    btn.innerHTML = `
      <span class="ss-dot ss-dot-stop"></span>
      <span class="ss-label">START</span>`;
    btn.classList.remove('ss-running');
    btn.classList.add('ss-stopped');
    stopTicking();
    showFrozenOverlay(true);
  }
}

function toggleStartStop() {
  setRunning(!isRunning);
}

function startTicking() {
  showFrozenOverlay(false);
  if (tickTimer) clearInterval(tickTimer);
  tick();
  tickTimer = setInterval(tick, 3000);
}

function stopTicking() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

function showFrozenOverlay(show) {
  let ov = document.getElementById('frozenOverlay');
  if (!ov) return;
  if (show) {
    ov.style.display = 'flex';
    // animación de entrada
    requestAnimationFrame(() => { ov.style.opacity = '1'; });
  } else {
    ov.style.opacity = '0';
    setTimeout(() => { ov.style.display = 'none'; }, 400);
  }
}

// ── FETCH DATOS REALES DEL ESP32 ─────────────────────────
async function fetchLive() {
  try {
    const res = await fetch('/api/live');
    if (res.status === 204) return false;
    if (!res.ok) return false;
    const json = await res.json();
    if (!json.ok || !json.data) return false;
    const d = json.data;

    // Si hay un borrador activo en el panel, NO sobreescribimos currentValues
    // para que el editor vea su preview local en lugar del último valor publicado.
    if (!devDraftActive) {
      // Si el servidor tiene un override activo, sus datos son la fuente de verdad
      // para TODOS los clientes (panel abierto o no). No bloqueamos ningún parámetro.
      const esOverride = json.override === true;

      if (esOverride) {
        // Override activo: aceptar todos los valores del servidor sin restricción
        PARAMS.forEach(p => {
          if (d[p] !== undefined && d[p] !== null) currentValues[p] = +d[p];
        });
      } else {
        // Sin override: respetar el bloqueo local solo cuando el usuario está
        // arrastrando un slider en este mismo dispositivo.
        const LOCAL_HOLD_MS = 3000;
        const now = Date.now();
        PARAMS.forEach(p => {
          if (d[p] === undefined || d[p] === null) return;
          if (lastLocalChange[p] && (now - lastLocalChange[p]) < LOCAL_HOLD_MS) return;
          currentValues[p] = +d[p];
        });
      }
    }

    document.getElementById('lastUpdate').textContent = d.hora || new Date().toLocaleTimeString('es-MX');
    connected = json.conexion ?? true;
    renderCurrentValues(); // Refresca los valores numéricos y badges al recibir datos nuevos
    return true;
  } catch(e) {
    connected = false;
    return false;
  }
}


// ── INICIALIZAR SPARKS ───────────────────────────────────
function initSparks() {
  PARAMS.forEach(p => {
    const ctx = document.getElementById('spark-' + p);
    if (!ctx) return;
    sparkCharts[p] = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array.from({ length: 15 }, (_, i) => i),
        datasets: [{ data: Array(15).fill(null), borderColor: COLORS[p], borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: COLORS[p] + '15', tension: .4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { display: false } },
        animation: false
      }
    });
  });
}

// ── INICIALIZAR GRÁFICO PRINCIPAL ────────────────────────
function initMainChart() {
  const ctx = document.getElementById('mainChart').getContext('2d');
  chartData.labels = [];
  
  // Crear escalas dinámicas para cada parámetro para evitar que las líneas
  // se aplanen debido a los diferentes rangos (ej. pH 7 vs Conductividad 800)
  const scales = {
    x: { ticks: { color: '#5a8fa8', font: { size: 10 }, maxTicksLimit: 6 }, grid: { color: 'rgba(64,169,255,0.08)' } }
  };
  
  PARAMS.forEach(p => {
    const rango = LIMITS[p].max - LIMITS[p].min;
    scales['y_' + p] = {
      type: 'linear',
      display: false, // Ocultar los múltiples ejes Y para no saturar la vista
      suggestedMin: LIMITS[p].min - (rango * 0.2),
      suggestedMax: LIMITS[p].max + (rango * 0.2)
    };
  });
  // Eje Y genérico para mantener la cuadrícula (grid) de fondo
  scales['y_grid'] = {
    type: 'linear',
    display: true,
    position: 'left',
    ticks: { display: false },
    grid: { color: 'rgba(64,169,255,0.08)' }
  };

  chartData.datasets = PARAMS.map(p => ({
    label: LIMITS[p].label,
    data: [],
    borderColor: COLORS[p], pointRadius: 0, borderWidth: 1.5, tension: .4, fill: false, hidden: false,
    yAxisID: 'y_' + p
  }));
  
  mainChartRef = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: scales,
      animation: { duration: 300 }
    }
  });

  // Leyenda
  const legend = document.getElementById('legend');
  legend.innerHTML = ''; // Limpiar por si acaso
  PARAMS.forEach(p => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${COLORS[p]}"></div>${LIMITS[p].label}`;
    legend.appendChild(item);
  });
}

function renderCurrentValues() {
  const sinDatos = PARAMS.every(p => currentValues[p] === null);

  PARAMS.forEach(p => {
    const el    = document.getElementById('val-' + p);
    const badge = document.getElementById('badge-' + p);
    if (!el) return;

    if (currentValues[p] === null) {
      el.textContent    = '--';
      badge.textContent = 'SIN DATOS';
      badge.className   = 'param-badge badge-warn';
      return;
    }

    const v = currentValues[p], lim = LIMITS[p];
    el.textContent = v.toFixed(p === 'orp' || p === 'conductividad' ? 0 : 2);

    if (v < lim.min || v > lim.max) {
      badge.textContent = 'ALERTA';     badge.className = 'param-badge badge-err';
    } else if (v < lim.min + (lim.max - lim.min) * 0.05 || v > lim.max - (lim.max - lim.min) * 0.05) {
      badge.textContent = 'PRECAUCIÓN'; badge.className = 'param-badge badge-warn';
    } else {
      badge.textContent = 'ÓPTIMO';     badge.className = 'param-badge badge-opt';
    }
  });

  const anyBad  = PARAMS.some(p => currentValues[p] !== null && (currentValues[p] < LIMITS[p].min || currentValues[p] > LIMITS[p].max));
  const anyWarn = PARAMS.some(p => {
    if (currentValues[p] === null) return false;
    const l = LIMITS[p], rango = l.max - l.min;
    return currentValues[p] < l.min + rango * 0.05 || currentValues[p] > l.max - rango * 0.05;
  });
  const ql = document.getElementById('qualityLabel');
  if (sinDatos)       { ql.textContent = 'SIN DATOS';  ql.style.color = 'var(--dim)'; }
  else if (anyBad)    { ql.textContent = 'ALERTA';     ql.style.color = 'var(--red)'; }
  else if (anyWarn)   { ql.textContent = 'PRECAUCIÓN'; ql.style.color = 'var(--orange)'; }
  else                { ql.textContent = 'EXCELENTE';  ql.style.color = 'var(--green)'; }

  const dot   = document.querySelector('.status-dot');
  const badge = document.querySelector('.status-badge');
  const txtNode = badge ? badge.lastChild : null;
  if (connected) {
    dot.style.background = 'var(--green)';
    dot.style.boxShadow  = '0 0 8px var(--green)';
    dot.style.animation  = 'pulse 2s infinite';
    if (txtNode && txtNode.nodeType === 3) txtNode.textContent = ' ESP32 Conectado';
  } else {
    dot.style.background = 'var(--dim)';
    dot.style.boxShadow  = 'none';
    dot.style.animation  = 'none';
    if (txtNode && txtNode.nodeType === 3) txtNode.textContent = ' Sin señal';
  }

  updateSideAlerts();
  return sinDatos;
}

// ── ACTUALIZAR UI CON DATOS REALES ───────────────────────
// pushToChart=true  → acumula un punto nuevo en el gráfico principal (comportamiento normal)
// pushToChart=false → solo refresca los valores/badges sin añadir punto (modo borrador o primer render)
function updateUI(pushToChart = true) {
  const sinDatos = renderCurrentValues();

  // En modo borrador (pushToChart=false) solo refrescamos los valores numéricos
  // y los badges — sin tocar sparks, gráfico principal ni historial local.
  if (!pushToChart) {
    if (mainChartRef) mainChartRef.update();
    return;
  }

  PARAMS.forEach(p => {
    if (currentValues[p] !== null && sparkCharts[p]) {
      const d = sparkCharts[p].data.datasets[0].data;
      d.push(currentValues[p]);
      if (d.length > 20) d.shift();
      sparkCharts[p].update();
    }
  });

  if (mainChartRef && !sinDatos) {
    const lbl = new Date().toLocaleTimeString('es-MX');
    chartData.labels.push(lbl);
    if (chartData.labels.length > MAX_PTS) chartData.labels.shift();
    PARAMS.forEach((p, i) => {
      if (currentValues[p] !== null) {
        chartData.datasets[i].data.push(+currentValues[p].toFixed(2));
        if (chartData.datasets[i].data.length > MAX_PTS) chartData.datasets[i].data.shift();
      }
    });
    mainChartRef.update();
  } else if (mainChartRef) {
    mainChartRef.update();
  }

  if (!sinDatos) {
    history.unshift({
      hora:  new Date().toLocaleTimeString('es-MX'),
      fecha: new Date().toLocaleDateString('es-MX'),
      ...Object.fromEntries(PARAMS.map(p => [p, currentValues[p] !== null ? +currentValues[p].toFixed(2) : null]))
    });
    if (history.length > 200) history.pop();
  }
}


// ── ALERTAS ──────────────────────────────────────────────
function updateSideAlerts() {
  const el = document.getElementById('sideAlerts');
  const alerts = getAlerts();
  if (!alerts.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--dim);text-align:center;padding:10px">✅ Sin alertas activas</div>';
    return;
  }
  el.innerHTML = alerts.slice(0, 3).map(a => `
    <div class="alert-item">
      <span class="alert-ico">${a.ico}</span>
      <div class="alert-msg">${a.msg}<div class="alert-val">${a.val}</div></div>
      <span class="alert-time">${a.hora}</span>
    </div>`).join('');
}

function getAlerts() {
  const alerts = [];
  const hora = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  PARAMS.forEach(p => {
    const v = currentValues[p];
    if (v === null) return;
    const l = LIMITS[p];
    if      (v > l.max) alerts.push({ ico: '🔴', msg: `${l.label} alta`,             val: `${v.toFixed(2)}${l.unit} (máx ${l.max})`, hora, type: 'error' });
    else if (v < l.min) alerts.push({ ico: '🔴', msg: `${l.label} baja`,             val: `${v.toFixed(2)}${l.unit} (mín ${l.min})`, hora, type: 'error' });
    else {
      const rango = l.max - l.min;
      if (v > l.max - rango * 0.08) alerts.push({ ico: '⚠️', msg: `${l.label} cerca del límite`, val: `${v.toFixed(2)}${l.unit}`, hora, type: 'warn' });
    }
  });
  return alerts;
}

// ── MODALES ───────────────────────────────────────────────
function openModal(id) {
  document.getElementById('modal-' + id).classList.add('open');
  if (id === 'historial')     buildHistorial();
  if (id === 'alertas')       buildAlertas();
  if (id === 'configuracion') buildSettings();
  if (id === 'reportes') document.getElementById('reportDate').value = new Date().toISOString().split('T')[0];
}
function closeModal(id) { document.getElementById('modal-' + id).classList.remove('open'); }

document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

function buildHistorial() {
  document.getElementById('hist-total').textContent = history.length;
  const today = new Date().toLocaleDateString('es-MX');
  const hoy = history.filter(h => h.fecha === today).length;
  const alertsHoy = history.filter(h => h.fecha === today && PARAMS.some(p => h[p] !== null && (h[p] < LIMITS[p].min || h[p] > LIMITS[p].max))).length;
  document.getElementById('hist-hoy').textContent    = hoy;
  document.getElementById('hist-alertas').textContent = alertsHoy;
  document.getElementById('histBody').innerHTML = history.slice(0, 50).map((r, i) => `
    <tr>
      <td style="color:var(--dim)">${i + 1}</td>
      <td style="font-family:'Orbitron',monospace;font-size:11px">${r.hora}</td>
      <td style="color:var(--ph)">${r.ph ?? '--'}</td>
      <td style="color:var(--temp)">${r.temperatura ?? '--'}</td>
      <td style="color:var(--orp)">${r.orp ?? '--'}</td>
      <td style="color:var(--cond)">${r.conductividad ?? '--'}</td>
      <td style="color:var(--turb)">${r.turbidez ?? '--'}</td>
      <td style="color:var(--oxy)">${r.oxigeno ?? '--'}</td>
    </tr>`).join('');
}

function buildAlertas() {
  const el = document.getElementById('alertBody');
  const alerts = getAlerts();
  if (!alerts.length) {
    el.innerHTML = '<div class="alert-card ok"><div class="ico">✅</div><div class="info"><h4>Todo en orden</h4><p>Todos los parámetros están dentro de los rangos normativos.</p></div></div>';
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div class="alert-card ${a.type}">
      <div class="ico">${a.ico}</div>
      <div class="info"><h4>${a.msg}</h4><p>Valor actual: <strong>${a.val}</strong> · ${a.hora}</p></div>
    </div>`).join('') +
  `<div style="margin-top:18px;font-size:11px;color:var(--dim)">
    Límites normativos (NOM-127-SSA1-2021 / OMS):
    ${PARAMS.map(p => `<br>• ${LIMITS[p].label}: ${LIMITS[p].min} – ${LIMITS[p].max}${LIMITS[p].unit}`).join('')}
  </div>`;
}

function downloadReport() {
  const date = document.getElementById('reportDate').value;
  const fmt  = document.getElementById('reportFormat').value;
  if (!date) { document.getElementById('reportMsg').textContent = '⚠ Selecciona una fecha.'; return; }
  const records = history.filter(h => h.fecha === new Date(date + 'T12:00:00').toLocaleDateString('es-MX'));
  let content, filename, mime;
  if (fmt === 'csv') {
    const header = '#,Hora,pH,Temperatura_°C,ORP_mV,Conductividad_µSm,Turbidez_NTU,Oxigeno_mgL\n';
    const rows = records.map((r, i) => `${i+1},${r.hora},${r.ph},${r.temperatura},${r.orp},${r.conductividad},${r.turbidez},${r.oxigeno}`).join('\n');
    content = header + (rows || 'Sin datos para esta fecha');
    filename = `TUUCH_${date}.csv`; mime = 'text/csv';
  } else {
    content = `TUUCH QUALITY - Reporte de Mediciones\nFecha: ${date}\nTotal registros: ${records.length}\n${'─'.repeat(60)}\n` +
      records.map((r, i) => `[${i+1}] ${r.hora} | pH:${r.ph} T:${r.temperatura}°C ORP:${r.orp}mV C:${r.conductividad}µS Turb:${r.turbidez}NTU O₂:${r.oxigeno}mg/L`).join('\n');
    filename = `TUUCH_${date}.txt`; mime = 'text/plain';
  }
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  document.getElementById('reportMsg').textContent = `✅ Descargado: ${filename} (${records.length} registros)`;
}

const PARAM_LABELS = { ph: 'pH', temperatura: 'Temperatura', orp: 'ORP', conductividad: 'Conductividad', turbidez: 'Turbidez', oxigeno: 'Oxígeno Disuelto' };
const PARAM_DESC   = { ph: 'Potencial de Hidrógeno', temperatura: 'Temperatura del agua', orp: 'Potencial de Oxidación-Reducción', conductividad: 'Conductividad eléctrica', turbidez: 'Turbidez del agua', oxigeno: 'Oxígeno disuelto en agua' };

function buildSettings() {
  document.getElementById('settingsToggles').innerHTML = PARAMS.map(p => `
    <div class="toggle-row">
      <div class="toggle-info"><h4>${PARAM_LABELS[p]}</h4><p>${PARAM_DESC[p]}</p></div>
      <label class="toggle">
        <input type="checkbox" ${visible[p] ? 'checked' : ''} onchange="toggleParam('${p}', this.checked)">
        <span class="toggle-slider"></span>
      </label>
    </div>`).join('');
}

function toggleParam(p, show) {
  visible[p] = show;
  const card = document.getElementById('card-' + p);
  if (card) card.style.display = show ? '' : 'none';
  if (mainChartRef) {
    const idx = PARAMS.indexOf(p);
    if (idx >= 0) { mainChartRef.data.datasets[idx].hidden = !show; mainChartRef.update(); }
  }
}

function changeTimeRange(v) { /* placeholder */ }

// ── ARRANQUE ─────────────────────────────────────────────
initSparks();
initMainChart();
updateSideAlerts();

// ════════════════════════════════════════════════════════════
//  MODO DEMO — datos simulados sin ESP32 ni servidor
// ════════════════════════════════════════════════════════════

let demoActive  = false;
let demoTimer   = null;
let demoTargets = { ph:7.2, temperatura:22, orp:280, conductividad:450, turbidez:1.0, oxigeno:9.5 };

const DEMO_PRESETS = {
  optimo:     { ph:7.2, temperatura:22, orp:280, conductividad:450, turbidez:1.0,  oxigeno:9.5  },
  precaucion: { ph:6.6, temperatura:28.5, orp:160, conductividad:750, turbidez:3.6, oxigeno:6.2 },
  alerta:     { ph:5.5, temperatura:35,  orp:80,  conductividad:1200,turbidez:8.5, oxigeno:3.0  }
};

function toggleDemo() {
  demoActive = !demoActive;
  const btn = document.getElementById('demoDashBtn');
  const lbl = document.getElementById('demoBtnLabel');

  if (demoActive) {
    // Bloquear el fetch real mientras el demo está activo
    devApiLocked = true;
    if (btn) btn.classList.add('demo-on');
    if (lbl) lbl.textContent = 'DEMO ON';
    startDemo();
  } else {
    devApiLocked = false;
    if (btn) btn.classList.remove('demo-on');
    if (lbl) lbl.textContent = 'DEMO';
    clearInterval(demoTimer); demoTimer = null;
  }
}

function startDemo() {
  clearInterval(demoTimer);
  tickDemo();
  demoTimer = setInterval(tickDemo, 2500);
}

function tickDemo() {
  if (!demoActive) return;
  PARAMS.forEach(p => {
    // Interpolación suave hacia el target + ruido pequeño
    const noise = (Math.random() - 0.5) * 0.04 * (LIMITS[p].max - LIMITS[p].min);
    currentValues[p] = parseFloat(
      (currentValues[p] !== null
        ? currentValues[p] * 0.8 + demoTargets[p] * 0.2 + noise
        : demoTargets[p]
      ).toFixed(2)
    );
  });
  updateUI(true);  // acumula punto en el gráfico
}

function demoSetScenario(nombre) {
  if (nombre === 'random') {
    PARAMS.forEach(p => {
      const l = LIMITS[p];
      demoTargets[p] = parseFloat((l.min - (l.max-l.min)*0.1 + Math.random() * (l.max-l.min)*1.2).toFixed(2));
    });
  } else {
    demoTargets = { ...DEMO_PRESETS[nombre] };
  }
  if (!demoActive) toggleDemo(); // activa si no estaba
}

async function tick() {
  if (!isRunning) return;
  // Solo bloqueamos la lectura cuando la API está deliberadamente bloqueada.
  // En todos los demás casos debemos leer /api/live para que todos los
  // dispositivos muestren la misma información en tiempo real.
  if (!devApiLocked) {
    await fetchLive();
  }
  updateUI();
  syncSlidersFromServer();
}

// ── Sincroniza sliders del panel con los valores recibidos del servidor ──
// Solo actúa si el panel está abierto para no hacer trabajo innecesario.
function syncSlidersFromServer() {
  if (!devPanelOpen) return;
  PARAMS.forEach(p => {
    const sl  = document.getElementById('dev-' + p);
    const lbl = document.getElementById('dev-' + p + '-val');
    if (sl && lbl && currentValues[p] !== null) {
      // Solo actualiza si el valor cambió (evita mover el slider mientras el
      // usuario lo está arrastrando con una diferencia mínima de 0.01)
      const diff = Math.abs(parseFloat(sl.value) - currentValues[p]);
      if (diff > 0.01) {
        sl.value        = currentValues[p];
        lbl.textContent = formatDevVal(p, currentValues[p]);
      }
    }
  });
}

// Arrancar en modo RUNNING
startTicking();

// ════════════════════════════════════════════════════════════
//  GHOST BUTTON  —  Panel de control oculto
//  Activación: 3 toques rápidos (≤500 ms entre cada uno)
//  en la esquina inferior derecha (div#ghostBtn, 60×60 px)
// ════════════════════════════════════════════════════════════

(function initGhostBtn() {
  const ghost = document.getElementById('ghostBtn');
  if (!ghost) return;

  let tapCount   = 0;
  let tapTimer   = null;
  const TAP_GAP  = 500; // ms máx entre toques

  function handleTap() {
    tapCount++;
    clearTimeout(tapTimer);
    if (tapCount >= 3) {
      tapCount = 0;
      openDevPanel();
    } else {
      tapTimer = setTimeout(() => { tapCount = 0; }, TAP_GAP);
    }
  }

  // Soporte táctil + clic
  ghost.addEventListener('click',      handleTap);
  ghost.addEventListener('touchstart', e => { e.preventDefault(); handleTap(); }, { passive: false });
})();

// ── Estado del panel dev ──────────────────────────────────
let devPanelOpen = false;
let devManual    = false;   // true = los sliders controlan; false = API
let devApiLocked = false;   // true = fetchLive() bloqueado

// Borrador: valores locales mientras el usuario edita en el panel.
// NO se envían al servidor hasta que presione «Publicar».
let devDraft = {};  // { ph: 7.2, temperatura: 22, ... }
let devDraftActive = false;  // true mientras el panel tenga cambios sin publicar

function openDevPanel() {
  const inner = document.getElementById('devPanelInner');
  if (!inner) return;
  devPanelOpen = true;
  inner.classList.add('dev-open');
  // Sincronizar sliders con valores actuales
  PARAMS.forEach(p => {
    const sl  = document.getElementById('dev-' + p);
    const lbl = document.getElementById('dev-' + p + '-val');
    if (!sl || !lbl) return;
    if (currentValues[p] !== null) {
      sl.value   = currentValues[p];
      lbl.textContent = formatDevVal(p, currentValues[p]);
    }
  });
}

function closeDevPanel() {
  const inner = document.getElementById('devPanelInner');
  if (!inner) return;
  devPanelOpen = false;
  inner.classList.remove('dev-open');
}

// ── Formato de valor para la etiqueta del slider ─────────
function formatDevVal(p, v) {
  v = parseFloat(v);
  if (p === 'orp' || p === 'conductividad') return Math.round(v).toString();
  if (p === 'temperatura') return v.toFixed(1);
  return v.toFixed(2);
}

// ── Slider → borrador LOCAL (no toca el servidor hasta publicar) ────────
function devSetValue(p, rawVal) {
  const v   = parseFloat(rawVal);
  const lbl = document.getElementById('dev-' + p + '-val');
  if (lbl) lbl.textContent = formatDevVal(p, v);

  // Activar modo manual solo localmente
  devManual = true;
  document.getElementById('devModeLabel').textContent = 'BORRADOR';
  document.getElementById('devModeLabel').style.color = '#ffa940';

  // Guardar en borrador — NO se envía al servidor todavía
  devDraft[p] = v;
  devDraftActive = true;

  // Actualizar el indicador del botón Publicar
  _updatePublishBtn();

  // Preview LOCAL solo para quien tiene el panel abierto
  currentValues[p] = v;
  updateUI(false);  // false = no agrega punto al historial del gráfico
}

// ── Actualiza el aspecto del botón Publicar ─────────────────────────────
function _updatePublishBtn() {
  const btn = document.getElementById('devPublishBtn');
  if (!btn) return;
  if (devDraftActive) {
    btn.classList.add('dev-publish-pending');
    btn.textContent = '📤 PUBLICAR CAMBIOS';
  } else {
    btn.classList.remove('dev-publish-pending');
    btn.textContent = '✅ PUBLICADO';
  }
}

// ── PUBLICAR: envía el borrador al servidor → todos los visitantes lo ven ──
async function devPublish() {
  if (!devDraftActive && Object.keys(devDraft).length === 0) return;

  const btn = document.getElementById('devPublishBtn');
  if (btn) { btn.textContent = '⏳ Enviando...'; btn.disabled = true; }

  try {
    // Mezclar borrador con currentValues para enviar todos los parámetros
    const payload = {};
    PARAMS.forEach(p => {
      const val = devDraft[p] !== undefined ? devDraft[p] : currentValues[p];
      if (val !== null && val !== undefined) payload[p] = val;
    });

    await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // Una vez publicado, marcamos que no hay borrador pendiente
    devDraft = {};
    devDraftActive = false;
    document.getElementById('devModeLabel').textContent = 'PUBLICADO';
    document.getElementById('devModeLabel').style.color = '#52c41a';

    if (btn) {
      btn.textContent = '✅ PUBLICADO';
      btn.classList.remove('dev-publish-pending');
      btn.disabled = false;
      // Volver a estado normal tras 2 segundos
      setTimeout(() => _updatePublishBtn(), 2000);
    }
  } catch(e) {
    console.warn('[DevPanel] No se pudo publicar:', e);
    if (btn) { btn.textContent = '❌ Error al publicar'; btn.disabled = false; }
  }
}

// ── Envía currentValues al servidor (solo llamado al Publicar o Restaurar) ──
async function devPushOverride() {
  try {
    const payload = {};
    PARAMS.forEach(p => {
      if (currentValues[p] !== null && currentValues[p] !== undefined) {
        payload[p] = currentValues[p];
      }
    });
    await fetch('/api/override', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch(e) {
    console.warn('[DevPanel] No se pudo enviar override al servidor:', e);
  }
}

// ── Escenarios rápidos ────────────────────────────────────
const DEV_PRESETS = {
  optimo: {
    ph: 7.2, temperatura: 22, orp: 280, conductividad: 450, turbidez: 1.0, oxigeno: 9.5
  },
  precaucion: {
    ph: 6.6, temperatura: 28.5, orp: 160, conductividad: 750, turbidez: 3.6, oxigeno: 6.2
  },
  alerta: {
    ph: 5.5, temperatura: 35, orp: 80, conductividad: 1200, turbidez: 8.5, oxigeno: 3.0
  },
  sinDatos: {
    ph: null, temperatura: null, orp: null, conductividad: null, turbidez: null, oxigeno: null
  }
};

function devPreset(nombre) {
  if (nombre === 'random') {
    PARAMS.forEach(p => {
      const l = LIMITS[p];
      const span  = (l.max - l.min) * 1.3;
      const base  = l.min - (l.max - l.min) * 0.15;
      const val   = parseFloat((base + Math.random() * span).toFixed(2));
      currentValues[p] = val;
      devDraft[p]      = val;
    });
  } else {
    const preset = DEV_PRESETS[nombre];
    if (!preset) return;
    PARAMS.forEach(p => {
      currentValues[p] = preset[p];
      devDraft[p]      = preset[p];
    });
  }

  devManual = true;
  devDraftActive = true;
  document.getElementById('devModeLabel').textContent = 'BORRADOR';
  document.getElementById('devModeLabel').style.color = '#ffa940';

  // Sincronizar sliders
  PARAMS.forEach(p => {
    const sl  = document.getElementById('dev-' + p);
    const lbl = document.getElementById('dev-' + p + '-val');
    if (!sl || !lbl) return;
    if (currentValues[p] !== null) {
      sl.value        = currentValues[p];
      lbl.textContent = formatDevVal(p, currentValues[p]);
    }
  });

  // Preview LOCAL — no envía al servidor todavía
  updateUI(false);
  _updatePublishBtn();
}

// ── Bloqueo / desbloqueo de la API ───────────────────────
function devToggleLock() {
  devApiLocked = !devApiLocked;
  const lockLbl = document.getElementById('devLockLabel');
  const apiLbl  = document.getElementById('devApiLabel');
  if (devApiLocked) {
    lockLbl.textContent       = 'Desbloquear API';
    apiLbl.textContent        = 'SÍ';
    apiLbl.style.color        = '#ff4d4f';
  } else {
    lockLbl.textContent       = 'Bloquear API';
    apiLbl.textContent        = 'NO';
    apiLbl.style.color        = '#36cfc9';
  }
}

// ── Reset: vuelve al modo automático ─────────────────────────
async function devReset() {
  devManual      = false;
  devApiLocked   = false;
  devDraft       = {};
  devDraftActive = false;

  document.getElementById('devModeLabel').textContent = 'AUTOMÁTICO';
  document.getElementById('devModeLabel').style.color = '#36cfc9';
  document.getElementById('devApiLabel').textContent  = 'NO';
  document.getElementById('devApiLabel').style.color  = '#36cfc9';
  document.getElementById('devLockLabel').textContent = 'Bloquear API';
  _updatePublishBtn();

  // Limpiar override en el servidor — todos los dispositivos vuelven a datos reales
  try {
    await fetch('/api/override/clear', { method: 'POST' });
  } catch(e) {
    console.warn('[DevPanel] No se pudo limpiar override:', e);
  }

  // Si el simulador estaba activo, también desconectarlo
  devSimDisconnect(false);
}

// ════════════════════════════════════════════════════════════
//  AQUAMONITOR SIMULATOR
//  Polling cada 500 ms a http://localhost:5050
//  Activa/desactiva desde el botón "Conectar" del panel oculto
// ════════════════════════════════════════════════════════════

const SIM_API   = 'http://localhost:5050';
let devSimMode  = false;
let devSimTimer = null;

// Nombres legibles de escenarios
const SIM_NOMBRES = {
  limpia:       '💧 Agua Limpia',
  contaminada:  '☠️ Contaminada',
  eutro:        '🌿 Eutrofización',
  tratada:      '✨ Agua Tratada',
  lluvia:       '🌧️ Lluvia',
  industrial:   '🏭 Descarga Industrial'
};

// Fallback estático si el simulador no está corriendo
const SIM_FALLBACK = {
  limpia:       'optimo',
  tratada:      'optimo',
  contaminada:  'alerta',
  industrial:   'alerta',
  eutro:        'alerta',
  lluvia:       'precaucion'
};

// ── Toggle conectar / desconectar ────────────────────────
async function devToggleSim() {
  if (devSimMode) {
    devSimDisconnect(true);
  } else {
    await devSimConnect();
  }
}

// ── Conectar: prueba y arranca el polling ─────────────────
async function devSimConnect() {
  updateSimUI(null);  // estado "intentando"
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 2000);
    const r    = await fetch(`${SIM_API}/estado`, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('not ok');
    const d = await r.json();

    devSimMode   = true;
    devManual    = true;    // bloquear el ESP32
    devApiLocked = true;

    // Actualizar etiquetas de estado
    document.getElementById('devModeLabel').textContent = 'SIMULADOR';
    document.getElementById('devModeLabel').style.color = '#9254de';
    document.getElementById('devApiLabel').textContent  = 'SÍ';
    document.getElementById('devApiLabel').style.color  = '#ffa940';

    updateSimUI(d);

    // Primer tick inmediato + polling cada 500 ms
    devSimPoll();
    devSimTimer = setInterval(devSimPoll, 500);

  } catch(e) {
    updateSimUI(null, '⚠ No se puede conectar · ¿corrió thonny_aquamonitor.py?');
  }
}

// ── Desconectar ───────────────────────────────────────────
function devSimDisconnect(resetAuto = true) {
  devSimMode = false;
  if (devSimTimer) { clearInterval(devSimTimer); devSimTimer = null; }
  updateSimUI(null);
  if (resetAuto) devReset();
}

// ── Polling: lee el estado y actualiza la UI ──────────────
async function devSimPoll() {
  if (!devSimMode) return;
  try {
    const r = await fetch(`${SIM_API}/estado`);
    const d = await r.json();

    // Inyectar valores en currentValues
    currentValues.ph           = d.ph;
    currentValues.temperatura  = d.temperatura;
    currentValues.orp          = d.orp;
    currentValues.conductividad = d.conductividad;
    currentValues.turbidez     = d.turbidez;
    currentValues.oxigeno      = d.oxigeno;

    updateUI();
    updateSimUI(d);

    // Sincronizar sliders con los valores actuales
    PARAMS.forEach(p => {
      const sl  = document.getElementById('dev-' + p);
      const lbl = document.getElementById('dev-' + p + '-val');
      if (sl && lbl && currentValues[p] !== null) {
        sl.value        = currentValues[p];
        lbl.textContent = formatDevVal(p, currentValues[p]);
      }
    });

    // Enviar al servidor para que todos los dispositivos lo vean
    devPushOverride();

  } catch(e) {
    updateSimUI(null, '⚠ Conexión perdida');
    devSimDisconnect(false);
  }
}

// ── Cambiar escenario: llama al simulador o usa preset ────
async function cambiarEscenario(nombre) {
  if (devSimMode) {
    // Simulador conectado → llamar al endpoint
    try {
      await fetch(`${SIM_API}/escenario/${nombre}`);
    } catch(e) {
      console.warn('[AquaMonitor] No se pudo cambiar escenario:', e);
    }
  } else {
    // Sin simulador → preset estático como fallback inmediato
    devPreset(SIM_FALLBACK[nombre] || 'optimo');
  }
}

// ── Actualizar UI del panel simulador ─────────────────────
function updateSimUI(data, errorMsg) {
  const dot      = document.getElementById('devSimDot');
  const statusTx = document.getElementById('devSimStatusText');
  const toggleBt = document.getElementById('devSimToggleBtn');
  const simInfo  = document.getElementById('devSimInfo');
  const simScen  = document.getElementById('devSimScenario');
  const simDesc  = document.getElementById('devSimDesc');
  const animBar  = document.getElementById('devSimAnimBar');
  if (!dot) return;

  if (data) {
    // Conectado y con datos
    dot.classList.add('sim-on');
    statusTx.textContent = '● Conectado · puerto 5050';
    statusTx.style.color = '#36cfc9';
    toggleBt.textContent = 'Desconectar';
    toggleBt.classList.add('connected');
    simInfo.style.display = 'block';

    simScen.textContent = SIM_NOMBRES[data.escenario] || data.escenario;
    simDesc.textContent = data.descripcion || '';

    // Barra de animación
    if (animBar) {
      if (data.animando) {
        animBar.style.width = '65%';
        animBar.classList.add('animating');
        animBar.title = 'Midiendo…';
      } else {
        animBar.style.width = '100%';
        animBar.classList.remove('animating');
        animBar.title = 'Estabilizado';
      }
    }

    // Etiqueta de modo
    const ml = document.getElementById('devModeLabel');
    if (ml) {
      ml.textContent = data.animando ? 'MIDIENDO…' : 'SIMULADOR';
      ml.style.color = data.animando ? '#ffa940'  : '#9254de';
    }

  } else {
    // Desconectado o error
    dot.classList.remove('sim-on');
    statusTx.textContent = errorMsg || 'Desconectado · puerto 5050';
    statusTx.style.color = errorMsg ? '#ffa940' : '#5a8fa8';
    toggleBt.textContent = 'Conectar';
    toggleBt.classList.remove('connected');
    simInfo.style.display = 'none';
    if (animBar) { animBar.style.width = '0%'; animBar.classList.remove('animating'); }
  }
}