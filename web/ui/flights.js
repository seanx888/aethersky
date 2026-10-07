// 我的航班 — a private flight log: future bookings with a countdown, past flights as a travel record.
//
// PRIVACY CONTRACT: everything here (booking reference, ticket number, member links, prices, notes) stays in this
// browser's localStorage, in a box per signed-in account. This file never calls the network, never uses the airline
// logo images (loading one would tell a third party which airline you are looking at), and never puts a booking
// reference into a link. Signing in only unlocks the screen; it is not encryption — see the notice on the page.
import { t, getLang, countryName } from '../i18n.js';
import { icon } from '../icons.js';
import { AIRPORTS, airportCity, distanceKm } from '../core/airports.js';
import { AIRLINES, airlineName } from '../core/airlines.js';
import { airlineUrl } from '../core/links.js';
import { programName } from '../core/programs.js';
import {
  CABINS, MAX_FLIGHTS, cleanFlight, draftProblem, partition, daysUntil, returnDraft, passengersOf, groupByTrip, flightStats, flightCode,
  exportJson, exportCsv, parseImport, mergeFlights, storageKey, localToday, byDeparture,
} from '../core/flights.js';
import { esc, segmented, chip, tag, notice } from './kit.js';
import { fmtDate, localMoney, locale } from './fmt.js';
import { onClick, onField } from './registry.js';

const host = {
  today: () => localToday(),
  user: () => null, // signed-in account name, or null
  authState: () => 'signin', // 'off' (no sign-in service) | 'pending' | 'signin' | 'ready'
  requireSignIn: () => {},
  members: () => [],
  capName: (n) => n,
  go: () => {},
  toast: () => {},
  refresh: () => {},
};
/** @param {Partial<typeof host>} h */
export const bindFlights = (h) => Object.assign(host, h);

const VIEWS = ['upcoming', 'past', 'stats'];
const F = { key: null, list: [], view: 'upcoming', form: null, err: null, reveal: new Set(), who: 'all', year: 'all', cancelledOpen: false };

export const flightsView = () => F.view;
export function setFlightsView(v) {
  F.view = VIEWS.includes(v) ? v : 'upcoming';
}

// ───────────────────────── storage (this device, one box per account) ─────────────────────────
function readBox(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return (Array.isArray(v) ? v : []).map(cleanFlight).filter(Boolean);
  } catch {
    return [];
  }
}
function save() {
  if (!F.key) return false;
  try {
    localStorage.setItem(F.key, JSON.stringify(F.list));
    return true;
  } catch {
    host.toast(t('flSaveFail'), 6000);
    return false;
  }
}
/** Load the signed-in account's box; switching accounts drops everything the screen held about the previous one. */
function sync() {
  const key = host.authState() === 'ready' ? storageKey(host.user()) : null;
  if (key === F.key) return;
  F.key = key;
  F.list = key ? readBox(key) : [];
  F.form = null;
  F.err = null;
  F.reveal = new Set();
  F.who = 'all';
  F.year = 'all';
}

// ───────────────────────── small view helpers ─────────────────────────
const lang = () => getLang();
const cityOf = (code) => airportCity(code, lang());
const maskDots = (s) => '•'.repeat(Math.min(String(s).length, 8));
const maskTail = (s) => {
  const v = String(s).replace(/[\s-]+/g, '');
  return v.length <= 4 ? '••••' : `•••• ${v.slice(-4)}`;
};
const memberOf = (f) => (f.memberId ? host.members().find((m) => m.id === f.memberId) || null : null);
const carrierBadge = (code) => (code ? `<span class="logo-wrap"><span class="logo-code">${esc(code)}</span></span>` : '');

function when(f) {
  const nextDay = f.arrDate && f.arrDate > f.date ? ` <sup>+${Math.round((Date.parse(f.arrDate) - Date.parse(f.date)) / 86400000)}</sup>` : '';
  return { dep: f.depTime ? esc(f.depTime) : '', arr: f.arrTime ? `${esc(f.arrTime)}${nextDay}` : '' };
}

function countdown(f, today) {
  if (f.cancelled) return tag(t('flCancelled'), '');
  const n = daysUntil(f, today);
  if (n === 0) return tag(t('flToday'), 'warn-soft', 'clock');
  if (n === 1) return tag(t('flTomorrow'), 'warn-soft', 'clock');
  if (n > 1) return tag(t('flInDays', { n }), n <= 7 ? 'warn-soft' : '', 'clock');
  return tag(t('flDaysAgo', { n: -n }), '');
}

function flightCard(f, { today, next = false }) {
  const km = distanceKm(f.from, f.to);
  const times = when(f);
  const shown = F.reveal.has(f.id);
  const member = memberOf(f);
  const days = daysUntil(f, today);
  const site = f.airline && AIRLINES[f.airline] ? airlineUrl(f.airline) : null;
  const meta = [
    f.cabin ? esc(t(`flCabin_${f.cabin}`)) + (f.fareClass ? ` (${esc(f.fareClass)})` : '') : f.fareClass ? esc(f.fareClass) : '',
    f.seat ? `${icon('seat', { size: 14 })} ${esc(f.seat)}` : '',
    f.price != null && f.currency ? esc(localMoney(f.price, f.currency)) : '',
    f.passenger ? esc(host.capName(f.passenger)) : '',
  ].filter(Boolean);
  const priv = [];
  if (f.pnr) priv.push(`<span class="fl-priv"><span class="fl-k">${esc(t('flPnr'))}</span><span class="num">${esc(shown ? f.pnr : maskDots(f.pnr))}</span><button class="icon-btn" data-act="fl-copy" data-id="${esc(f.id)}" data-what="pnr" aria-label="${esc(t('copy'))} ${esc(t('flPnr'))}">${icon('copy', { size: 18 })}</button></span>`);
  if (f.ticketNo) priv.push(`<span class="fl-priv"><span class="fl-k">${esc(t('flTicket'))}</span><span class="num">${esc(shown ? f.ticketNo : maskTail(f.ticketNo))}</span><button class="icon-btn" data-act="fl-copy" data-id="${esc(f.id)}" data-what="ticketNo" aria-label="${esc(t('copy'))} ${esc(t('flTicket'))}">${icon('copy', { size: 18 })}</button></span>`);
  if (member) priv.push(`<span class="fl-priv"><span class="fl-k">${esc(programName(member.program, lang(), member.programName))}</span><span class="num">${esc(shown ? String(member.number) : maskTail(member.number))}</span><button class="icon-btn" data-act="fl-copy" data-id="${esc(f.id)}" data-what="member" aria-label="${esc(t('copy'))} ${esc(programName(member.program, lang(), member.programName))}">${icon('copy', { size: 18 })}</button></span>`);
  const reveal = priv.length
    ? `<button class="icon-btn" data-act="fl-reveal" data-id="${esc(f.id)}" aria-label="${esc(t(shown ? 'memHide' : 'memShow'))}" aria-pressed="${shown}">${icon(shown ? 'eye-slash' : 'eye', { size: 20 })}</button>`
    : '';
  return `
  <article class="fl${next ? ' next' : ''}${f.cancelled ? ' dim' : ''}" id="fl-${esc(f.id)}">
    <div class="fl-head">
      <span class="carrier">${carrierBadge(f.airline)}<b>${esc(flightCode(f) || t('flNoCode'))}</b>${f.airline ? `<span class="muted small">${esc(airlineName(f.airline, lang()))}</span>` : ''}</span>
      ${countdown(f, today)}
    </div>
    <div class="fl-route">
      <div><b>${esc(f.from)}</b><small>${esc(cityOf(f.from))}</small>${times.dep ? `<span class="num">${times.dep}</span>` : ''}</div>
      <div class="fl-mid" aria-hidden="true">${icon('airplane-takeoff', { size: 20 })}${km ? `<small>${km.toLocaleString(locale())} km</small>` : ''}</div>
      <div class="r"><b>${esc(f.to)}</b><small>${esc(cityOf(f.to))}</small>${times.arr ? `<span class="num">${times.arr}</span>` : ''}</div>
    </div>
    <div class="fl-meta"><span>${icon('calendar-blank', { size: 14 })} ${esc(fmtDate(f.date))}</span>${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    ${f.trip ? `<div class="fl-trip">${tag(f.trip, '', 'path')}</div>` : ''}
    ${priv.length ? `<div class="fl-privs">${priv.join('')}${reveal}</div>` : ''}
    ${f.notes ? `<p class="small muted fl-notes">${esc(f.notes)}</p>` : ''}
    ${next && !f.cancelled && days <= 2 ? `<p class="small fl-hint">${icon('info', { size: 14 })} ${esc(t('flCheckinHint'))}</p>` : ''}
    <div class="trk-actions">
      <button class="btn quiet" data-act="fl-edit" data-id="${esc(f.id)}">${icon('pencil-simple', { size: 16 })}${esc(t('edit'))}</button>
      <button class="btn quiet" data-act="fl-return" data-id="${esc(f.id)}">${icon('arrows-left-right', { size: 16 })}${esc(t('flReturn'))}</button>
      ${site && !f.cancelled && days >= 0 ? `<a class="btn quiet" href="${esc(site)}" target="_blank" rel="noopener noreferrer">${icon('arrow-square-out', { size: 16 })}${esc(t('flManage'))}</a>` : ''}
      <button class="btn quiet danger" data-act="fl-del" data-id="${esc(f.id)}">${icon('trash', { size: 16 })}${esc(t('del'))}</button>
    </div>
  </article>`;
}

// ───────────────────────── form ─────────────────────────
const airportOptions = () => Object.entries(AIRPORTS).map(([c, a]) => `<option value="${c}">${esc(cityOf(c))}${a.country ? ` · ${a.country}` : ''}</option>`).join('');
const airlineOptions = () => Object.keys(AIRLINES).sort().map((c) => `<option value="${esc(c)}">${esc(airlineName(c, lang()))}</option>`).join('');

function formHtml(f) {
  const members = host.members();
  const pax = [...new Set([...passengersOf(F.list), ...members.map((m) => m.owner).filter(Boolean), host.capName(host.user() || '')].filter(Boolean))];
  const field = (key, label, attrs = '', extra = '') => `<div class="field"><label for="ff-${key}">${esc(label)}</label><input id="ff-${key}" data-ff="${key}" value="${esc(f[key] ?? '')}" ${attrs}>${extra}</div>`;
  return `
  <section class="panel fl-form" id="fl-form">
    <h3>${esc(t(f.id ? 'flEdit' : 'flAdd'))}</h3>
    <datalist id="ff-ap">${airportOptions()}</datalist>
    <datalist id="ff-al">${airlineOptions()}</datalist>
    <datalist id="ff-pax">${pax.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
    <div class="grid2">
      ${field('passenger', t('flPassenger'), 'type="text" list="ff-pax" maxlength="40" autocomplete="off" spellcheck="false"')}
      ${field('trip', t('flTrip'), 'type="text" maxlength="40" autocomplete="off" spellcheck="false"', `<span class="help small muted">${esc(t('flTripHelp'))}</span>`)}
    </div>
    <div class="grid2 form-row">
      ${field('airline', t('flAirline'), 'type="text" list="ff-al" maxlength="2" autocapitalize="characters" autocomplete="off" spellcheck="false"')}
      ${field('number', t('flNumber'), 'type="text" inputmode="numeric" maxlength="6" autocomplete="off"')}
    </div>
    <div class="grid2 form-row">
      ${field('from', t('flFrom'), 'type="text" list="ff-ap" maxlength="3" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="TPE"', `<span class="help small muted" data-ff-city="from">${esc(f.from ? cityOf(String(f.from).toUpperCase()) : '')}</span>`)}
      ${field('to', t('flTo'), 'type="text" list="ff-ap" maxlength="3" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="NRT"', `<span class="help small muted" data-ff-city="to">${esc(f.to ? cityOf(String(f.to).toUpperCase()) : '')}</span>`)}
    </div>
    <div class="grid2 form-row">
      ${field('date', t('flDate'), 'type="date"')}
      ${field('depTime', t('flDepTime'), 'type="time"')}
      ${field('arrDate', t('flArrDate'), 'type="date"')}
      ${field('arrTime', t('flArrTime'), 'type="time"')}
    </div>
    <div class="grid2 form-row">
      <div class="field"><label for="ff-cabin">${esc(t('flCabin'))}</label>
        <select id="ff-cabin" data-ff="cabin"><option value="">—</option>${CABINS.map((c) => `<option value="${c}" ${f.cabin === c ? 'selected' : ''}>${esc(t(`flCabin_${c}`))}</option>`).join('')}</select></div>
      ${field('fareClass', t('flFare'), 'type="text" maxlength="1" autocapitalize="characters" autocomplete="off"')}
      ${field('seat', t('flSeat'), 'type="text" maxlength="8" autocapitalize="characters" autocomplete="off"')}
    </div>
    <div class="group-title" style="margin:18px 0 6px">${icon('shield-check', { size: 14 })} ${esc(t('flPrivateGroup'))}</div>
    <div class="grid2">
      ${field('pnr', t('flPnr'), 'type="text" maxlength="12" autocapitalize="characters" autocomplete="off" spellcheck="false"')}
      ${field('ticketNo', t('flTicket'), 'type="text" inputmode="numeric" maxlength="20" autocomplete="off"')}
    </div>
    <div class="field form-row"><label for="ff-memberId">${esc(t('flMember'))}</label>
      <select id="ff-memberId" data-ff="memberId"><option value="">—</option>${members.map((m) => `<option value="${esc(m.id)}" ${f.memberId === m.id ? 'selected' : ''}>${esc(programName(m.program, lang(), m.programName))}${m.owner ? ` · ${esc(host.capName(m.owner))}` : ''} · ${esc(maskTail(m.number))}</option>`).join('')}</select>
      ${members.length ? '' : `<span class="help small muted">${esc(t('flMemberNone'))}</span>`}</div>
    <div class="grid2 form-row">
      ${field('price', t('flPrice'), 'type="number" inputmode="decimal" min="0" step="any"')}
      ${field('currency', t('flCurrency'), 'type="text" maxlength="3" autocapitalize="characters" autocomplete="off" placeholder="TWD"')}
    </div>
    <div class="field form-row"><label for="ff-notes">${esc(t('flNotes'))}</label><textarea id="ff-notes" data-ff="notes" rows="2" maxlength="300">${esc(f.notes || '')}</textarea></div>
    <label class="check"><input type="checkbox" data-ff="cancelled" ${f.cancelled ? 'checked' : ''}> <span>${esc(t('flCancelledBox'))}</span></label>
    ${F.err ? notice(t(`flErr_${F.err}`), true) : ''}
    <div class="form-actions">
      <button class="btn primary" data-act="fl-save">${icon('check', { size: 16 })}${esc(t('flSave'))}</button>
      <button class="btn quiet" data-act="fl-cancel">${esc(t('cancel'))}</button>
    </div>
  </section>`;
}

// ───────────────────────── lists ─────────────────────────
function listHtml(flights, opts) {
  return groupByTrip(flights).map((g) => `
    ${g.trip && g.flights.length > 1 ? `<div class="fl-group">${icon('path', { size: 14 })} ${esc(g.trip)}</div>` : ''}
    ${g.flights.map((f) => flightCard(f, { today: opts.today, next: f.id === opts.nextId })).join('')}`).join('');
}

function statsHtml(past) {
  const s = flightStats(past);
  if (!s.flights) return `<div class="empty">${esc(t('flStatsNone'))}</div>`;
  const tile = (value, label) => `<div class="fl-tile"><b class="num">${value}</b><span>${esc(label)}</span></div>`;
  const maxOf = (rows) => Math.max(1, ...rows.map((r) => r[1]));
  const bars = (title, rows, label) => rows.length
    ? `<section class="panel"><h3>${esc(title)}</h3><div class="fl-bars">${rows.map(([k, n]) => `<div class="fl-bar"><span class="who">${label(k)}</span><span class="track"><span style="width:${Math.max(4, Math.round((n / maxOf(rows)) * 100))}%"></span></span><b class="num">${n}</b></div>`).join('')}</div></section>`
    : '';
  const far = s.farthest;
  return `
    <div class="fl-tiles">
      ${tile(s.flights.toLocaleString(locale()), t('flSFlights'))}
      ${tile(s.km.toLocaleString(locale()), t('flSKm'))}
      ${tile(s.airports, t('flSAirports'))}
      ${tile(s.countries.length, t('flSCountries'))}
      ${tile(s.airlineCount, t('flSAirlines'))}
      ${tile(s.earthLaps, t('flSEarth'))}
    </div>
    <p class="small muted">${esc(t('flSKmNote'))}${s.unmeasured ? ` ${esc(t('flSUnmeasured', { n: s.unmeasured }))}` : ''}</p>
    ${far ? `<section class="panel"><h3>${esc(t('flSFarthest'))}</h3><p><b>${esc(far.flight.from)} → ${esc(far.flight.to)}</b> · ${far.km.toLocaleString(locale())} km<br><span class="small muted">${esc(cityOf(far.flight.from))} → ${esc(cityOf(far.flight.to))} · ${esc(fmtDate(far.flight.date))}</span></p></section>` : ''}
    ${bars(t('flSByYear'), s.years, (y) => esc(y))}
    ${bars(t('flSTopAirline'), s.airlines, (a) => `${carrierBadge(a)} ${esc(airlineName(a, lang()))}`)}
    ${bars(t('flSTopRoute'), s.routes, (r) => esc(r.split('–').map((c) => `${c} ${cityOf(c)}`).join(' ⇄ ')))}
    ${s.countries.length ? `<section class="panel"><h3>${esc(t('flSCountries'))}</h3><div class="tags">${s.countries.map((c) => tag(countryName(c))).join('')}</div></section>` : ''}
    ${s.spend.length ? `<section class="panel"><h3>${esc(t('flSSpend'))}</h3><div class="kv">${s.spend.map((x) => `<span>${esc(x.currency)}</span><span class="num">${x.amount.toLocaleString(locale())}</span>`).join('')}</div></section>` : ''}`;
}

// ───────────────────────── the screen ─────────────────────────
export function flightsHtml() {
  sync();
  const head = `
    <h2>${esc(t('flTitle'))}</h2>
    <p class="intro">${esc(t('flIntro'))}</p>
    <div class="notice">${icon('shield-check')}<span>${esc(t('flPrivacy'))}</span></div>`;
  const auth = host.authState();
  if (auth !== 'ready') {
    const body = auth === 'off' ? notice(t('flOff'), true) : auth === 'pending' ? `<p class="muted">${esc(t('flChecking'))}</p>` : `<p>${esc(t('flSignin'))}</p><button class="btn primary block" data-act="fl-signin">${icon('cloud-check')}${esc(t('flSigninBtn'))}</button>`;
    return `${head}<section class="panel fl-lock">${body}</section>`;
  }

  const today = host.today();
  const all = F.list;
  const people = passengersOf(all);
  if (F.who !== 'all' && !people.includes(F.who)) F.who = 'all';
  const mine = F.who === 'all' ? all : all.filter((f) => f.passenger === F.who);
  const { upcoming, past, cancelled } = partition(mine, today);
  const years = [...new Set(past.map((f) => f.date.slice(0, 4)))].sort().reverse();
  if (F.year !== 'all' && !years.includes(F.year)) F.year = 'all';
  const pastShown = F.year === 'all' ? past : past.filter((f) => f.date.startsWith(F.year));

  let body;
  if (F.view === 'past') {
    body = `${years.length > 1 ? `<div class="chips" style="margin-top:12px">${chip('fl-year', 'all', esc(t('memAll')), F.year === 'all')}${years.map((y) => chip('fl-year', y, esc(y), F.year === y)).join('')}</div>` : ''}
      <div class="list fl-list">${pastShown.length ? listHtml(pastShown, { today }) : `<div class="empty">${esc(t('flEmptyPast'))}</div>`}</div>`;
  } else if (F.view === 'stats') {
    body = statsHtml(past);
  } else {
    body = `<div class="list fl-list">${upcoming.length ? listHtml(upcoming, { today, nextId: upcoming[0].id }) : `<div class="empty">${esc(t('flEmptyUp'))}</div>`}</div>`;
  }
  const cancelledBlock = cancelled.length && F.view !== 'stats'
    ? `<details class="caveats fl-cancelled" ${F.cancelledOpen ? 'open' : ''}><summary>${esc(t('flCancelledList', { n: cancelled.length }))}</summary><div class="list">${cancelled.map((f) => flightCard(f, { today })).join('')}</div></details>`
    : '';

  return `${head}
    ${segmented('fl-view', [['upcoming', `${t('flUpcoming')} ${upcoming.length}`], ['past', `${t('flPast')} ${past.length}`], ['stats', t('flStats')]], F.view, t('flTitle'))}
    ${people.length > 1 ? `<div class="chips" style="margin-top:12px">${chip('fl-who', 'all', esc(t('memAll')), F.who === 'all')}${people.map((p) => chip('fl-who', p, esc(host.capName(p)), F.who === p)).join('')}</div>` : ''}
    ${F.form ? formHtml(F.form) : `<button class="btn primary block new-btn" data-act="fl-new">${icon('plus', { size: 18 })}${esc(t('flAdd'))}</button>`}
    ${body}
    ${cancelledBlock}
    <div class="links mem-io">
      <button class="btn" data-act="fl-export" ${all.length ? '' : 'disabled'}>${icon('download-simple')}${esc(t('flExport'))}</button>
      <button class="btn" data-act="fl-csv" ${all.length ? '' : 'disabled'}>${icon('receipt')}${esc(t('flCsv'))}</button>
      <label class="btn">${icon('upload-simple')}${esc(t('flImport'))}<input type="file" accept="application/json,.json" data-fl-import hidden></label>
    </div>
    <p class="small muted" style="margin-top:8px">${esc(t('flExportWarn'))}</p>
    <p class="small muted">${esc(t('flLockNote'))}</p>
    ${all.length ? `<button class="btn quiet danger" data-act="fl-clear">${icon('trash', { size: 16 })}${esc(t('flClear'))}</button>` : ''}`;
}

// ───────────────────────── actions ─────────────────────────
function download(name, mime, body) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: mime }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const openForm = (draft) => {
  F.form = draft;
  F.err = null;
  host.refresh();
  const el = document.getElementById('fl-form');
  el?.scrollIntoView({ block: 'start' });
  document.getElementById(draft.from && !draft.date ? 'ff-date' : draft.id ? 'ff-airline' : 'ff-passenger')?.focus({ preventScroll: true });
};

function saveForm() {
  const draft = F.form;
  const problem = draftProblem(draft);
  if (problem) {
    F.err = problem;
    host.refresh();
    return;
  }
  const flight = cleanFlight(draft);
  if (!flight) {
    F.err = 'route';
    host.refresh();
    return;
  }
  if (!draft.id && F.list.length >= MAX_FLIGHTS) {
    F.err = 'full';
    host.refresh();
    return;
  }
  const next = F.list.some((x) => x.id === flight.id) ? F.list.map((x) => (x.id === flight.id ? flight : x)) : [...F.list, flight];
  F.list = next.sort(byDeparture);
  if (!save()) return;
  F.form = null;
  F.err = null;
  const goesTo = flight.cancelled ? F.view : flight.date >= host.today() ? 'upcoming' : 'past';
  if (flight.cancelled) F.cancelledOpen = true;
  host.toast(t('flSaved'));
  F.view = goesTo;
  host.go(`#flights${goesTo === 'upcoming' ? '' : `/${goesTo}`}`);
}

const find = (el) => F.list.find((x) => x.id === el.dataset.id);

onClick({
  'fl-signin': () => host.requireSignIn(),
  'fl-view': (el) => host.go(`#flights${el.dataset.v === 'upcoming' ? '' : `/${el.dataset.v}`}`),
  'fl-new': () => openForm({ passenger: F.who !== 'all' ? F.who : host.capName(host.user() || ''), cabin: 'economy', currency: '' }),
  'fl-cancel': () => {
    F.form = null;
    F.err = null;
    host.refresh();
  },
  'fl-save': saveForm,
  'fl-edit': (el) => {
    const f = find(el);
    if (f) openForm({ ...f });
  },
  'fl-return': (el) => {
    const f = find(el);
    if (f) openForm(returnDraft(f));
  },
  'fl-del': (el) => {
    if (!find(el) || !confirm(t('flDeleteQ'))) return;
    F.list = F.list.filter((x) => x.id !== el.dataset.id);
    save();
    host.refresh();
  },
  'fl-reveal': (el) => {
    if (F.reveal.has(el.dataset.id)) F.reveal.delete(el.dataset.id);
    else F.reveal.add(el.dataset.id);
    host.refresh();
  },
  'fl-copy': async (el) => {
    const f = find(el);
    if (!f) return;
    const value = el.dataset.what === 'member' ? memberOf(f)?.number : f[el.dataset.what];
    if (!value) return;
    try {
      await navigator.clipboard.writeText(String(value).replace(/\s+/g, ''));
      host.toast(t('flCopied'));
    } catch {
      F.reveal.add(f.id);
      host.refresh();
    }
  },
  'fl-who': (el) => {
    F.who = el.dataset.v;
    host.refresh();
  },
  'fl-year': (el) => {
    F.year = el.dataset.v;
    host.refresh();
  },
  'fl-export': () => download(`aethersky-flights-${host.today()}.json`, 'application/json', exportJson(F.list, host.user())),
  'fl-csv': () => download(`aethersky-flights-${host.today()}.csv`, 'text/csv;charset=utf-8', exportCsv(F.list)),
  'fl-clear': () => {
    if (!confirm(t('flClearQ'))) return;
    F.list = [];
    F.form = null;
    save();
    host.toast(t('flCleared'));
    host.refresh();
  },
});

onField((el, kind) => {
  if (el.dataset.flImport !== undefined) {
    if (kind === 'change' && el.files?.[0]) {
      const file = el.files[0];
      el.value = '';
      file.text().then((raw) => {
        const list = parseImport(raw);
        F.list = mergeFlights(F.list, list);
        if (save()) host.toast(t('flImported', { n: list.length }));
      }).catch(() => host.toast(t('flImportFail'))).finally(() => host.refresh());
    }
    return true;
  }
  const key = el.dataset.ff;
  if (!key || !F.form) return false;
  if (el.type === 'checkbox') F.form[key] = el.checked;
  else F.form[key] = el.value;
  if (key === 'from' || key === 'to') {
    const code = el.value.trim().toUpperCase();
    const out = document.querySelector(`[data-ff-city="${key}"]`);
    if (out) out.textContent = code.length === 3 ? cityOf(code) : '';
  }
  return true;
});
