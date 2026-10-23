const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0
});

const STORAGE_KEY = 'parkwise-demo-data-v1';
const state = { lots: [], selectedLot: '', apiReady: false, mode: 'connecting', demoStore: null };
const byId = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Parking API not found. Start the backend and open the dashboard at http://localhost:8080.');
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function seededDemoStore() {
  const lots = [
    { id: 1, name: 'Central Plaza', address: '100 Main Street' },
    { id: 2, name: 'Riverside Market', address: '25 River Road' }
  ];
  const types = [
    'regular', 'regular', 'compact', 'regular', 'accessible', 'regular', 'electric', 'regular',
    'regular', 'compact', 'regular', 'regular', 'regular', 'electric', 'regular', 'accessible'
  ];
  const slots = lots.flatMap((lot) =>
    types.map((slotType, index) => ({
      id: (lot.id - 1) * 16 + index + 1,
      lot_id: lot.id,
      slot_number: `${lot.id === 1 ? (index < 8 ? 'A' : 'B') : (index < 8 ? 'C' : 'D')}-${String(index % 8 + 1).padStart(2, '0')}`,
      slot_type: slotType,
      status: 'available'
    }))
  );
  const sessions = [
    { slot_id: 1, vehicle_number: 'MH02AB1234', started_at: new Date(Date.now() - 45 * 60000).toISOString(), exited_at: null, fee: null },
    { slot_id: 11, vehicle_number: 'DL8CAF4321', started_at: new Date(Date.now() - 2 * 3600000).toISOString(), exited_at: null, fee: null },
    { slot_id: 20, vehicle_number: 'KA03MN9876', started_at: new Date(Date.now() - 90 * 60000).toISOString(), exited_at: null, fee: null },
    { slot_id: 9, vehicle_number: 'GJ01XY2468', started_at: new Date(Date.now() - 4 * 3600000).toISOString(), exited_at: new Date(Date.now() - 2 * 3600000).toISOString(), fee: 40 }
  ].map((session, index) => ({ id: index + 1, ...session }));
  sessions.filter((session) => !session.exited_at).forEach((session) => {
    slots.find((slot) => slot.id === session.slot_id).status = 'occupied';
  });
  return { lots, slots, sessions };
}

function saveDemoStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  state.demoStore = store;
}

function loadDemoStore() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) {
    const store = seededDemoStore();
    saveDemoStore(store);
    return store;
  }
  const store = JSON.parse(saved);
  if (!Array.isArray(store.lots) || !Array.isArray(store.slots) || !Array.isArray(store.sessions)) {
    throw new Error('Saved browser demo data is invalid. Clear this site’s local storage to reset the demo.');
  }
  state.demoStore = store;
  return store;
}

function localDateTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localSummary(store) {
  const today = new Date().toDateString();
  const completedToday = store.sessions.filter((session) =>
    session.exited_at && new Date(session.exited_at).toDateString() === today
  );
  const average = completedToday.length
    ? completedToday.reduce((sum, session) => sum + (new Date(session.exited_at) - new Date(session.started_at)) / 3600000, 0) / completedToday.length
    : 0;
  return {
    vehicles_parked: store.sessions.filter((session) => !session.exited_at).length,
    revenue_today: completedToday.reduce((sum, session) => sum + Number(session.fee || 0), 0),
    average_stay_hours: average,
    total_slots: store.slots.length
  };
}

function localLots(store) {
  return store.lots.map((lot) => {
    const slots = store.slots.filter((slot) => slot.lot_id === lot.id);
    return {
      ...lot,
      total_slots: slots.length,
      occupied_slots: slots.filter((slot) => slot.status === 'occupied').length
    };
  });
}

function localUtilization(store, lotId) {
  const now = Date.now();
  const currentHour = new Date();
  currentHour.setMinutes(0, 0, 0);
  const slots = store.slots.filter((slot) => slot.lot_id === Number(lotId));
  if (!slots.length) return [];
  return Array.from({ length: 24 }, (_, index) => {
    const start = currentHour.getTime() - (23 - index) * 3600000;
    const end = Math.min(now, start + 3600000);
    const occupiedMilliseconds = store.sessions.reduce((sum, session) => {
      if (!slots.some((slot) => slot.id === session.slot_id)) return sum;
      const sessionStart = new Date(session.started_at).getTime();
      const sessionEnd = session.exited_at ? new Date(session.exited_at).getTime() : now;
      return sum + Math.max(0, Math.min(end, sessionEnd) - Math.max(start, sessionStart));
    }, 0);
    return {
      hour: localDateTime(start),
      utilization_percent: Math.round(occupiedMilliseconds / (slots.length * 3600000) * 1000) / 10
    };
  });
}

function localAction(path, formData) {
  const store = JSON.parse(JSON.stringify(state.demoStore));
  const values = Object.fromEntries(formData.entries());
  const vehicle = String(values.vehicle_number || '').trim().toUpperCase();
  if (!vehicle || vehicle.length > 20 || !/^[A-Z0-9 -]+$/.test(vehicle)) {
    throw new Error('Enter a vehicle number using up to 20 letters, numbers, spaces, or hyphens.');
  }

  if (path === '/api/entry') {
    const lotId = Number(values.lot_id);
    const slot = store.slots.find((item) =>
      item.lot_id === lotId && item.slot_type === values.slot_type && item.status === 'available'
    );
    if (!slot) throw new Error('No available space of this type in the selected lot.');
    if (store.sessions.some((session) =>
      session.vehicle_number.toUpperCase() === vehicle && !session.exited_at
    )) throw new Error('This vehicle already has an active parking session.');
    slot.status = 'occupied';
    store.sessions.push({
      id: Math.max(0, ...store.sessions.map((session) => session.id)) + 1,
      slot_id: slot.id,
      vehicle_number: vehicle,
      started_at: new Date().toISOString(),
      exited_at: null,
      fee: null
    });
    saveDemoStore(store);
    return { slot_number: slot.slot_number };
  }

  if (path === '/api/exit') {
    const session = store.sessions.find((item) =>
      item.vehicle_number.toUpperCase() === vehicle && !item.exited_at
    );
    if (!session) throw new Error('No active parking session found for this vehicle.');
    const now = new Date();
    const hours = Math.max(1, Math.ceil((now.getTime() - new Date(session.started_at).getTime()) / 3600000));
    const fee = hours * 20;
    session.exited_at = now.toISOString();
    session.fee = fee;
    const slot = store.slots.find((item) => item.id === session.slot_id);
    if (!slot) throw new Error('The assigned space could not be found in saved demo data.');
    slot.status = 'available';
    saveDemoStore(store);
    return { billable_hours: hours, fee };
  }
  throw new Error('Unsupported parking action.');
}

function setApiReady(ready) {
  state.apiReady = ready;
  byId('entry-form').querySelector('button[type="submit"]').disabled = !ready || !state.lots.length;
  byId('exit-form').querySelector('button[type="submit"]').disabled = !ready;
}

function setMessage(message, isError = false) {
  const element = byId('action-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function occupancyPercent(lot) {
  return lot.total_slots ? Math.round((lot.occupied_slots / lot.total_slots) * 100) : 0;
}

function renderLots() {
  const list = byId('lot-list');
  byId('lot-count').textContent = `${state.lots.length} ${state.lots.length === 1 ? 'location' : 'locations'}`;
  if (!state.lots.length) {
    list.innerHTML = '<p class="loading-message">No parking lots found. Load sample data in MySQL to get started.</p>';
    return;
  }

  list.innerHTML = state.lots.map((lot) => {
    const total = Number(lot.total_slots);
    const occupied = Number(lot.occupied_slots);
    const percent = occupancyPercent({ total_slots: total, occupied_slots: occupied });
    return `<article class="lot-card${String(lot.id) === state.selectedLot ? ' selected' : ''}" data-lot-id="${Number(lot.id)}" tabindex="0" aria-label="View utilization for ${escapeHtml(lot.name)}">
      <div class="lot-top"><div><p class="lot-name">${escapeHtml(lot.name)}</p><p class="lot-address">${escapeHtml(lot.address)}</p></div><span class="occupancy-label">${percent}% full</span></div>
      <div class="occupancy"><strong>${occupied}</strong> / ${total} spaces occupied</div>
      <div class="progress-track"><div class="progress-value" style="width:${percent}%"></div></div>
    </article>`;
  }).join('');

  list.querySelectorAll('.lot-card').forEach((card) => {
    const select = () => selectLot(card.dataset.lotId);
    card.addEventListener('click', select);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function renderLotOptions() {
  const options = state.lots.map((lot) =>
    `<option value="${Number(lot.id)}">${escapeHtml(lot.name)}</option>`
  ).join('');
  byId('entry-lot').innerHTML = options;
  byId('utilization-lot').innerHTML = options;
  if (state.lots.length) {
    const stillExists = state.lots.some((lot) => String(lot.id) === state.selectedLot);
    if (!stillExists) state.selectedLot = String(state.lots[0].id);
    byId('entry-lot').value = state.selectedLot;
    byId('utilization-lot').value = state.selectedLot;
  }
}

function renderDashboard(lots, summary, utilization) {
  state.lots = lots;
  renderLots();
  renderLotOptions();
  renderSummary(summary, lots);
  drawChart(utilization);
}

function renderSummary(summary, lots) {
  const available = lots.reduce((sum, lot) => sum + Number(lot.total_slots) - Number(lot.occupied_slots), 0);
  byId('vehicles-parked').textContent = summary.vehicles_parked;
  byId('revenue-today').textContent = money.format(Number(summary.revenue_today));
  byId('average-stay').textContent = Number(summary.average_stay_hours).toFixed(1);
  byId('available-spaces').textContent = available;
  byId('space-caption').textContent = `Of ${summary.total_slots} total spaces`;
}

function drawChart(data) {
  const canvas = byId('utilization-chart');
  const empty = byId('chart-empty');
  empty.textContent = 'No utilization data available.';
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const bounds = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(bounds.width * ratio));
  canvas.height = Math.max(1, Math.round(bounds.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width;
  const height = bounds.height;
  context.clearRect(0, 0, width, height);
  if (!data.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const left = 32;
  const right = 7;
  const top = 12;
  const bottom = 25;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = 100;
  context.font = '9px DM Sans, sans-serif';
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  [0, 50, 100].forEach((value) => {
    const y = top + plotHeight * (1 - value / max);
    context.strokeStyle = '#edf0f5';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(width - right, y);
    context.stroke();
    context.fillStyle = '#9aa4b2';
    context.fillText(`${value}%`, left - 7, y);
  });

  const slot = plotWidth / data.length;
  const barWidth = Math.max(2, Math.min(11, slot * 0.55));
  data.forEach((point, index) => {
    const value = Math.max(0, Math.min(100, Number(point.utilization_percent)));
    const barHeight = plotHeight * value / max;
    const x = left + slot * index + (slot - barWidth) / 2;
    const y = top + plotHeight - barHeight;
    context.fillStyle = '#6e86ec';
    context.beginPath();
    context.roundRect(x, y, barWidth, Math.max(2, barHeight), [3, 3, 0, 0]);
    context.fill();
  });

  [0, 6, 12, 18, 23].forEach((index) => {
    if (index >= data.length) return;
    const date = new Date(data[index].hour.replace(' ', 'T'));
    const label = date.toLocaleTimeString([], { hour: 'numeric', hour12: true }).toLowerCase();
    const x = left + slot * index + slot / 2;
    context.fillStyle = '#9aa4b2';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(label, x, height - bottom + 8);
  });
}

async function selectLot(lotId) {
  state.selectedLot = String(lotId);
  byId('utilization-lot').value = state.selectedLot;
  byId('entry-lot').value = state.selectedLot;
  renderLots();
  if (state.mode === 'local') {
    drawChart(localUtilization(state.demoStore, state.selectedLot));
    return;
  }
  try {
    const data = await api(`/api/utilization/hourly?lot_id=${encodeURIComponent(state.selectedLot)}`);
    drawChart(data);
  } catch (error) {
    setMessage(error.message, true);
  }
}

async function refreshDashboard() {
  try {
    if (window.location.protocol === 'file:') throw new Error('Dashboard opened directly from a file.');
    const [lots, summary] = await Promise.all([api('/api/lots'), api('/api/summary')]);
    if (!Array.isArray(lots)) throw new Error('Parking API returned invalid lot data.');
    state.lots = lots;
    renderLotOptions();
    const utilization = state.selectedLot
      ? await api(`/api/utilization/hourly?lot_id=${encodeURIComponent(state.selectedLot)}`)
      : [];
    state.mode = 'remote';
    byId('connection-badge').textContent = 'Live database';
    byId('connection-badge').classList.remove('demo-mode');
    renderDashboard(lots, summary, utilization);
    setApiReady(true);
  } catch (error) {
    if (state.mode === 'remote') {
      setApiReady(false);
      setMessage(`Live database connection was lost: ${error.message}`, true);
      return;
    }
    try {
      state.mode = 'local';
      byId('connection-badge').textContent = 'Local demo · browser only';
      byId('connection-badge').classList.add('demo-mode');
      const store = loadDemoStore();
      const lots = localLots(store);
      if (!state.selectedLot && lots.length) state.selectedLot = String(lots[0].id);
      renderDashboard(lots, localSummary(store), state.selectedLot
        ? localUtilization(store, state.selectedLot)
        : []);
      setApiReady(true);
      setMessage('Demo mode: changes are saved in this browser only, not to MySQL.', true);
    } catch (storageError) {
      state.mode = 'unavailable';
      setApiReady(false);
      byId('lot-list').innerHTML = `<p class="loading-message">${escapeHtml(storageError.message)}</p>`;
      byId('lot-count').textContent = 'Unavailable';
      setMessage(storageError.message, true);
    }
  }
}

async function submitForm(form, endpoint, successMessage, successHandler) {
  setMessage('');
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const formData = new FormData(form);
    const result = state.mode === 'local'
      ? localAction(endpoint, formData)
      : await api(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData)
      });
    const resultMessage = successHandler ? successHandler(result) : successMessage;
    const selectedEntryLot = form.id === 'entry-form' ? formData.get('lot_id') : null;
    form.reset();
    if (selectedEntryLot) byId('entry-lot').value = selectedEntryLot;
    if (state.mode === 'local') {
      const store = state.demoStore;
      renderDashboard(localLots(store), localSummary(store), localUtilization(store, state.selectedLot));
    } else {
      await refreshDashboard();
    }
    setMessage(resultMessage);
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    submit.disabled = !state.apiReady || (form.id === 'entry-form' && !state.lots.length);
  }
}

byId('entry-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, '/api/entry', '', (result) =>
    `Vehicle checked in · assigned space ${result.slot_number}.`);
});
byId('exit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submitForm(event.currentTarget, '/api/exit', '', (result) =>
    `Checked out · ${result.billable_hours} hr${result.billable_hours === 1 ? '' : 's'} · ${money.format(Number(result.fee))}`);
});
byId('utilization-lot').addEventListener('change', (event) => selectLot(event.target.value));
byId('refresh-button').addEventListener('click', refreshDashboard);
window.addEventListener('resize', () => {
  if (state.selectedLot) selectLot(state.selectedLot);
});

refreshDashboard();
