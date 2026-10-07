// 我的航班 — the data model of the personal flight log: cleaning, upcoming / past split, statistics, backup files.
// Pure functions only (no DOM, no network, no storage). Everything here works on data that lives on this device;
// the booking reference, ticket number and member links must never leave it, so nothing in this module (or in
// ui/flights.js) may call fetch / sendBeacon / XMLHttpRequest — test/flights.test.mjs enforces that.
import { AIRPORTS, distanceKm } from './airports.js';

export const CABINS = ['economy', 'premium', 'business', 'first'];
export const FILE_TYPE = 'aethersky-flights';
export const MAX_FLIGHTS = 2000;
export const EARTH_KM = 40075;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86400000;

const isoOk = (s) => ISO_DATE.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const clock = (s) => {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
};
const text = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Whole days from a to b (ISO dates); negative when b is earlier. */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Today on this device's calendar (flight dates are the dates printed on the ticket, i.e. local to the airport). */
export function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** "CI 100", "ci100", "BR-198A" → { airline: 'CI', number: '100' }; anything else → null. */
export function parseFlightCode(s) {
  const m = /^\s*([A-Za-z][A-Za-z0-9]|[0-9][A-Za-z])\s*[- ]?\s*(\d{1,4}[A-Za-z]?)\s*$/.exec(String(s || ''));
  return m ? { airline: m[1].toUpperCase(), number: m[2].toUpperCase().replace(/^0+(?=\d)/, '') } : null;
}

export const flightCode = (f) => (f.airline ? `${f.airline}${f.number ? ` ${f.number}` : ''}` : f.number || '');

const code3 = (v) => {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
};

function newId() {
  const r = globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) ?? Math.random().toString(36).slice(2, 14);
  return `f${r}`;
}

/**
 * One flight as typed in the form or read from a backup → the stored shape, or null when it is not a flight
 * (needs two different 3-letter airports and a real date). Never throws; unknown fields are dropped.
 */
export function cleanFlight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = code3(raw.from);
  const to = code3(raw.to);
  if (!from || !to || from === to || !isoOk(raw.date)) return null;
  // "CI100" typed into the number box is split; an explicit airline wins.
  const combined = parseFlightCode(raw.number);
  const given = String(raw.airline ?? '').trim().toUpperCase();
  const airline = /^[A-Z0-9]{2}$/.test(given) ? given : combined?.airline || null;
  const numberRaw = (combined && combined.airline === airline ? combined.number : String(raw.number ?? '').trim().toUpperCase()).replace(/^0+(?=\d)/, '');
  const number = /^\d{1,4}[A-Z]?$/.test(numberRaw) ? numberRaw : null;
  const price = raw.price === '' || raw.price == null ? null : Number(raw.price);
  const currency = String(raw.currency || '').trim().toUpperCase();
  const arrDate = isoOk(raw.arrDate) && raw.arrDate >= raw.date ? raw.arrDate : null;
  return {
    id: /^[A-Za-z0-9_-]{4,40}$/.test(String(raw.id || '')) ? String(raw.id) : newId(),
    passenger: text(raw.passenger, 40),
    airline,
    number,
    from,
    to,
    date: raw.date,
    depTime: clock(raw.depTime),
    arrDate,
    arrTime: clock(raw.arrTime),
    cabin: CABINS.includes(raw.cabin) ? raw.cabin : null,
    fareClass: /^[A-Za-z]$/.test(String(raw.fareClass || '').trim()) ? String(raw.fareClass).trim().toUpperCase() : null,
    seat: text(raw.seat, 8)?.toUpperCase() ?? null,
    pnr: text(String(raw.pnr ?? '').replace(/\s+/g, ''), 12)?.toUpperCase() ?? null,
    ticketNo: text(String(raw.ticketNo ?? '').replace(/[^0-9-]/g, ''), 20),
    memberId: /^[A-Za-z0-9_-]{4,40}$/.test(String(raw.memberId || '')) ? String(raw.memberId) : null,
    price: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : null,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
    trip: text(raw.trip, 40),
    notes: text(raw.notes, 300),
    cancelled: raw.cancelled === true,
  };
}

/** Why a form draft cannot be saved: 'route' | 'date' | null. */
export function draftProblem(raw) {
  const from = code3(raw?.from);
  const to = code3(raw?.to);
  if (!from || !to || from === to) return 'route';
  if (!isoOk(raw?.date)) return 'date';
  return null;
}

const when = (f) => `${f.date}T${f.depTime || '00:00'}`;
export const byDeparture = (a, b) => when(a).localeCompare(when(b)) || a.id.localeCompare(b.id);

/**
 * Upcoming = today or later and not cancelled (soonest first). Past = earlier days (latest first) — cancelled
 * bookings are kept in their own list so they never count as flights taken.
 */
export function partition(flights, today) {
  const upcoming = [];
  const past = [];
  const cancelled = [];
  for (const f of flights) {
    if (f.cancelled) cancelled.push(f);
    else if (f.date >= today) upcoming.push(f);
    else past.push(f);
  }
  upcoming.sort(byDeparture);
  past.sort((a, b) => byDeparture(b, a));
  cancelled.sort((a, b) => byDeparture(b, a));
  return { upcoming, past, cancelled };
}

/** Days until departure (0 = today, negative = already flown). */
export const daysUntil = (f, today) => daysBetween(today, f.date);

/** The reverse trip of a flight, as an unsaved draft (same booking, passenger and trip name, date left to fill in). */
export function returnDraft(f) {
  return {
    passenger: f.passenger, airline: f.airline, from: f.to, to: f.from, date: '', cabin: f.cabin, fareClass: f.fareClass,
    pnr: f.pnr, ticketNo: f.ticketNo, memberId: f.memberId, trip: f.trip, currency: f.currency,
  };
}

/** The people who appear in a list of flights, in the order first seen. */
export const passengersOf = (flights) => [...new Set(flights.map((f) => f.passenger).filter(Boolean))];

/** Group consecutive flights with the same trip name under one heading; flights without one stand alone. */
export function groupByTrip(flights) {
  const groups = [];
  for (const f of flights) {
    const last = groups[groups.length - 1];
    if (f.trip && last && last.trip === f.trip) last.flights.push(f);
    else groups.push({ trip: f.trip || null, flights: [f] });
  }
  return groups;
}

// ───────────────────────── statistics ─────────────────────────

const topOf = (counts, n = 5) => [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

/** Flight log numbers for the flights already taken. Distance is the great-circle estimate between airports. */
export function flightStats(past) {
  const airlines = new Map();
  const routes = new Map();
  const years = new Map();
  const airports = new Set();
  const countries = new Set();
  const spend = new Map();
  let km = 0;
  let unmeasured = 0;
  let farthest = null;
  for (const f of past) {
    const d = distanceKm(f.from, f.to);
    if (d == null) unmeasured += 1;
    else {
      km += d;
      if (!farthest || d > farthest.km) farthest = { km: d, flight: f };
    }
    airports.add(f.from);
    airports.add(f.to);
    for (const a of [f.from, f.to]) if (AIRPORTS[a]?.country) countries.add(AIRPORTS[a].country);
    if (f.airline) airlines.set(f.airline, (airlines.get(f.airline) || 0) + 1);
    const pair = [f.from, f.to].sort().join('–');
    routes.set(pair, (routes.get(pair) || 0) + 1);
    const y = f.date.slice(0, 4);
    years.set(y, (years.get(y) || 0) + 1);
    if (f.price != null && f.currency) spend.set(f.currency, (spend.get(f.currency) || 0) + f.price);
  }
  return {
    flights: past.length,
    km,
    unmeasured,
    earthLaps: Math.round((km / EARTH_KM) * 10) / 10,
    airports: airports.size,
    countries: [...countries].sort(),
    airlines: topOf(airlines, 8),
    airlineCount: airlines.size,
    routes: topOf(routes, 5),
    years: [...years.entries()].sort((a, b) => b[0].localeCompare(a[0])),
    spend: [...spend.entries()].sort((a, b) => b[1] - a[1]).map(([currency, amount]) => ({ currency, amount: Math.round(amount) })),
    farthest,
  };
}

// ───────────────────────── backup files ─────────────────────────

/** The JSON backup. `owner` is only a label so a file is recognisable; importing never trusts it. */
export function exportJson(flights, owner, now = new Date()) {
  return JSON.stringify({ type: FILE_TYPE, version: 1, exported: now.toISOString(), owner: owner || null, flights }, null, 2);
}

/** Read a backup (a bare array or { flights: [...] }) → cleaned flights. Throws when nothing in it is a flight. */
export function parseImport(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const list = (Array.isArray(data) ? data : data?.flights || []).slice(0, MAX_FLIGHTS).map(cleanFlight).filter(Boolean);
  if (!list.length) throw new Error('no flights');
  return list;
}

/** New flights win over old ones with the same id. */
export function mergeFlights(current, incoming) {
  const byId = new Map(current.map((f) => [f.id, f]));
  for (const f of incoming) byId.set(f.id, f);
  return [...byId.values()].sort(byDeparture).slice(-MAX_FLIGHTS);
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const CSV_COLUMNS = ['date', 'depTime', 'airline', 'number', 'from', 'to', 'arrDate', 'arrTime', 'passenger', 'cabin', 'fareClass', 'seat', 'pnr', 'ticketNo', 'price', 'currency', 'trip', 'cancelled', 'notes'];

/** Spreadsheet-friendly export, oldest first. A leading BOM keeps Excel from garbling 中文 / 한국어. */
export function exportCsv(flights) {
  const rows = [...flights].sort(byDeparture).map((f) => CSV_COLUMNS.map((c) => csvCell(f[c])).join(','));
  return `﻿${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

// ───────────────────────── per-account storage key ─────────────────────────

/** Each signed-in person gets their own box on the device, so two people sharing a phone never see each other's trips. */
export function storageKey(user) {
  const name = String(user || '').trim().toLowerCase().replace(/[^a-z0-9_.@-]/g, '_').slice(0, 60);
  return name ? `aether.flights.v1:${name}` : null;
}
