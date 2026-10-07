import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cleanFlight, draftProblem, parseFlightCode, flightCode, partition, daysUntil, returnDraft, groupByTrip, passengersOf, flightStats,
  exportJson, exportCsv, parseImport, mergeFlights, storageKey, localToday, CSV_COLUMNS,
} from '../web/core/flights.js';

const base = { from: 'tpe', to: 'nrt', date: '2026-11-03', airline: 'ci', number: '100' };
const mk = (over = {}) => cleanFlight({ ...base, ...over });

test('cleanFlight normalises a typed flight', () => {
  const f = cleanFlight({
    ...base, depTime: '9:05', arrTime: '13:30', arrDate: '2026-11-03', cabin: 'business', fareClass: 'j', seat: '4a',
    pnr: ' abc 123 ', ticketNo: '297-1234 567890', price: '1234.567', currency: 'twd', passenger: '  Sean ', trip: ' Tokyo ', notes: 'x',
  });
  assert.equal(f.from, 'TPE');
  assert.equal(f.to, 'NRT');
  assert.equal(f.airline, 'CI');
  assert.equal(f.depTime, '09:05');
  assert.equal(f.fareClass, 'J');
  assert.equal(f.seat, '4A');
  assert.equal(f.pnr, 'ABC123');
  assert.equal(f.ticketNo, '297-1234567890');
  assert.equal(f.price, 1234.57);
  assert.equal(f.currency, 'TWD');
  assert.equal(f.passenger, 'Sean');
  assert.equal(f.trip, 'Tokyo');
  assert.equal(f.cancelled, false);
  assert.match(f.id, /^f[a-z0-9]{6,}$/);
});

test('cleanFlight rejects what is not a flight and never throws', () => {
  for (const bad of [null, 'x', 5, {}, mk({ from: 'TP' }), { ...base, to: 'TPE', from: 'TPE' }, { ...base, from: 'T1E' }, { ...base, date: '2026-13-40' }, { ...base, date: '2026-02-30' }, { ...base, date: '' }]) {
    assert.equal(cleanFlight(bad), null, JSON.stringify(bad));
  }
  const f = mk({ depTime: '25:99', arrTime: 'abc', cabin: 'lounge', fareClass: 'JJ', price: -5, currency: 'EURO', arrDate: '2026-11-02', number: 'abc', airline: 'CIA' });
  assert.equal(f.depTime, null);
  assert.equal(f.arrTime, null);
  assert.equal(f.cabin, null);
  assert.equal(f.fareClass, null);
  assert.equal(f.price, null);
  assert.equal(f.currency, null);
  assert.equal(f.arrDate, null, 'arrival before departure is dropped');
  assert.equal(f.number, null);
});

test('flight codes: "CI100", "ci 100", "BR-198A" split into airline and number', () => {
  assert.deepEqual(parseFlightCode('CI100'), { airline: 'CI', number: '100' });
  assert.deepEqual(parseFlightCode(' ci 0100 '), { airline: 'CI', number: '100' });
  assert.deepEqual(parseFlightCode('BR-198A'), { airline: 'BR', number: '198A' });
  assert.deepEqual(parseFlightCode('7C 1101'), { airline: '7C', number: '1101' });
  assert.equal(parseFlightCode('100'), null);
  assert.equal(parseFlightCode('hello'), null);
  const f = cleanFlight({ ...base, airline: '', number: 'BR198' });
  assert.equal(f.airline, 'BR');
  assert.equal(f.number, '198');
  assert.equal(flightCode(f), 'BR 198');
  assert.equal(flightCode({ airline: 'CI', number: null }), 'CI');
});

test('draftProblem names the first thing wrong', () => {
  assert.equal(draftProblem({ from: 'TPE', to: 'TPE', date: '2026-11-03' }), 'route');
  assert.equal(draftProblem({ from: 'TPE', to: 'NRT', date: '' }), 'date');
  assert.equal(draftProblem({ from: 'TPE', to: 'NRT', date: '2026-11-03' }), null);
});

test('upcoming / past split by today; cancelled never counts', () => {
  const list = [
    mk({ id: 'past-a', date: '2026-01-10' }), mk({ id: 'past-b', date: '2026-05-01' }),
    mk({ id: 'today', date: '2026-10-06', depTime: '08:00' }), mk({ id: 'soon', date: '2026-10-09' }), mk({ id: 'later', date: '2027-01-01' }),
    mk({ id: 'gone', date: '2026-12-01', cancelled: true }),
  ];
  const p = partition(list, '2026-10-06');
  assert.deepEqual(p.upcoming.map((f) => f.id), ['today', 'soon', 'later']);
  assert.deepEqual(p.past.map((f) => f.id), ['past-b', 'past-a']);
  assert.deepEqual(p.cancelled.map((f) => f.id), ['gone']);
  assert.equal(daysUntil(p.upcoming[1], '2026-10-06'), 3);
  assert.equal(daysUntil(p.past[0], '2026-10-06'), -158);
});

test('same-day flights sort by departure time', () => {
  const p = partition([mk({ id: 'fb02', depTime: '18:00' }), mk({ id: 'fa01', depTime: '07:30' })], '2026-11-01');
  assert.deepEqual(p.upcoming.map((f) => f.id), ['fa01', 'fb02']);
});

test('returnDraft swaps the airports and keeps the booking, but not the date', () => {
  const d = returnDraft(mk({ pnr: 'XYZ789', trip: 'Tokyo', passenger: 'Blue', cabin: 'business', seat: '4A', depTime: '09:00' }));
  assert.equal(d.from, 'NRT');
  assert.equal(d.to, 'TPE');
  assert.equal(d.date, '');
  assert.equal(d.pnr, 'XYZ789');
  assert.equal(d.trip, 'Tokyo');
  assert.equal(d.passenger, 'Blue');
  assert.equal(d.seat, undefined, 'seat and times belong to the outbound flight');
  assert.equal(d.depTime, undefined);
  assert.equal(draftProblem({ ...d, date: '2026-11-10' }), null);
});

test('trip grouping keeps order and only joins neighbours with the same name', () => {
  const l = [mk({ id: 'fid1', trip: 'A' }), mk({ id: 'fid2', trip: 'A' }), mk({ id: 'fid3' }), mk({ id: 'fid4', trip: 'A' })];
  assert.deepEqual(groupByTrip(l).map((g) => [g.trip, g.flights.map((f) => f.id)]), [['A', ['fid1', 'fid2']], [null, ['fid3']], ['A', ['fid4']]]);
  assert.deepEqual(passengersOf([mk({ passenger: 'Sean' }), mk({ passenger: 'Blue' }), mk({ passenger: 'Sean' }), mk()]), ['Sean', 'Blue']);
});

test('statistics for flights already taken', () => {
  const past = [
    mk({ date: '2025-03-01', price: 10000, currency: 'TWD' }),
    mk({ from: 'NRT', to: 'TPE', date: '2025-03-10', price: 9000, currency: 'TWD' }),
    mk({ from: 'TPE', to: 'LAX', airline: 'BR', date: '2026-02-01', price: 900, currency: 'USD' }),
    mk({ from: 'TPE', to: 'ZZZ', airline: 'BR', date: '2026-03-01' }),
  ];
  const s = flightStats(past);
  assert.equal(s.flights, 4);
  assert.equal(s.unmeasured, 1);
  assert.ok(s.km > 2 * 2100 + 9700 && s.km < 2 * 2300 + 11000, `km ${s.km}`);
  assert.equal(s.farthest.flight.to, 'LAX');
  assert.equal(s.airports, 4);
  assert.deepEqual(s.countries, ['JP', 'TW', 'US']);
  assert.deepEqual(s.airlines, [['BR', 2], ['CI', 2]]);
  assert.deepEqual(s.routes[0], ['NRT–TPE', 2]);
  assert.deepEqual(s.years, [['2026', 2], ['2025', 2]]);
  assert.deepEqual(s.spend, [{ currency: 'TWD', amount: 19000 }, { currency: 'USD', amount: 900 }]);
  assert.equal(flightStats([]).flights, 0);
});

test('JSON backup round-trips and import tolerates junk', () => {
  const flights = [mk({ id: 'one1', pnr: 'ABC123', passenger: 'Sean' }), mk({ id: 'two2', date: '2027-01-01' })];
  const file = JSON.parse(exportJson(flights, 'sean', new Date('2026-10-06T00:00:00Z')));
  assert.equal(file.type, 'aethersky-flights');
  assert.equal(file.exported, '2026-10-06T00:00:00.000Z');
  assert.deepEqual(parseImport(JSON.stringify(file)), flights);
  assert.deepEqual(parseImport(flights), flights, 'a bare array works too');
  const mixed = parseImport({ flights: [flights[0], { from: 'TPE' }, 'x', null, { ...flights[1], hacked: '<script>', pnr: '<b>x</b>' }] });
  assert.equal(mixed.length, 2);
  assert.equal(mixed[1].hacked, undefined);
  assert.equal(mixed[1].pnr, '<B>X</B>'.slice(0, 12), 'free text is kept as text; the screen escapes it');
  assert.throws(() => parseImport('{}'));
  assert.throws(() => parseImport('not json'));
});

test('merging a backup: same id is replaced, others kept, sorted by departure', () => {
  const cur = [mk({ id: 'fa01', date: '2026-12-01', seat: '1A' }), mk({ id: 'fb02', date: '2026-11-01' })];
  const merged = mergeFlights(cur, [mk({ id: 'fa01', date: '2026-12-01', seat: '9Z' }), mk({ id: 'fc03', date: '2026-10-01' })]);
  assert.deepEqual(merged.map((f) => f.id), ['fc03', 'fb02', 'fa01']);
  assert.equal(merged.find((f) => f.id === 'fa01').seat, '9Z');
});

test('CSV: header, quoting, BOM, oldest first', () => {
  const csv = exportCsv([mk({ id: 'fb02', date: '2026-12-01', notes: 'say "hi", ok' }), mk({ id: 'fa01', date: '2026-11-01', passenger: '陳小明' })]);
  assert.ok(csv.startsWith('﻿date,depTime,airline'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.match(lines[1], /^2026-11-01,/);
  assert.match(lines[1], /陳小明/);
  assert.match(lines[2], /"say ""hi"", ok"/);
});

test('each account gets its own storage box', () => {
  assert.equal(storageKey('UserA'), 'aether.flights.v1:usera');
  assert.equal(storageKey('userb'), 'aether.flights.v1:userb');
  assert.notEqual(storageKey('UserA'), storageKey('UserB'));
  assert.equal(storageKey(''), null);
  assert.equal(storageKey(null), null);
  assert.equal(storageKey('a/../b'), 'aether.flights.v1:a_.._b');
});

test('localToday uses the device calendar', () => {
  assert.equal(localToday(new Date(2026, 9, 6, 23, 59)), '2026-10-06');
  assert.equal(localToday(new Date(2026, 0, 2, 0, 1)), '2026-01-02');
});

// ───────────────────────── privacy: nothing leaves the device ─────────────────────────

const src = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the flight log code never touches the network', () => {
  for (const file of ['core/flights.js', 'ui/flights.js']) {
    const code = stripComments(src(file));
    for (const bad of [/\bfetch\s*\(/, /sendBeacon/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /\bimport\s*\(/, /https?:\/\//, /gstatic/, /<img\b/, /\.src\s*=/]) {
      assert.doesNotMatch(code, bad, `${file} must not match ${bad}`);
    }
  }
});

test('flights are never mixed into synced prefs, trackers or the wallet', () => {
  const app = src('app.js');
  assert.doesNotMatch(app, /prefs\.flights|aether\.flights|JSON\.stringify\([^)]*flights/);
  // The only storage the screen writes to is its own per-account key.
  const ui = stripComments(src('ui/flights.js'));
  assert.deepEqual([...ui.matchAll(/localStorage\.(\w+)/g)].map((m) => m[1]).sort(), ['getItem', 'setItem']);
  assert.doesNotMatch(ui, /sessionStorage|document\.cookie|indexedDB|caches\./);
});

test('the screen is wired in: tab, route, offline shell, strings', async () => {
  const html = src('index.html');
  assert.match(html, /id="view-flights"/);
  assert.match(html, /data-tab="flights"/);
  const sw = src('sw.js');
  assert.match(sw, /'core\/flights\.js'/);
  assert.match(sw, /'ui\/flights\.js'/);
  assert.match(src('app.js'), /TABS = \[[^\]]*'flights'/);
  globalThis.document = { documentElement: {} };
  const { STRINGS } = await import('../web/i18n.js');
  for (const lang of ['zh-TW', 'en', 'ko']) for (const k of ['tabFlights', 'flTitle', 'flPrivacy', 'flSaved', 'flCabin_first', 'flErr_route', 'flImported']) assert.ok(STRINGS[lang][k], `${lang}:${k}`);
});
