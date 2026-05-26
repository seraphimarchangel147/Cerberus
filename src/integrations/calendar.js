// Calendar integration via secret ICS feed URL — the auth-light path that
// fits a local-first single-user tool. Google ("Secret address in iCal
// format"), Outlook, and Apple Calendar all expose a private .ics URL, so
// we avoid the OAuth dance entirely: one env var, fetch + parse.
//
//   CALENDAR_ICS_URL   one or more comma-separated secret ICS URLs.
//
// Registers tools the reconciliation + daily-planner passes invoke:
//   calendar_today_events       — events overlapping today
//   calendar_events_between     — events in an explicit [from,to] window
//
// We parse a useful subset of RFC 5545: VEVENT blocks, line unfolding,
// SUMMARY/LOCATION/STATUS, all-day vs timed DTSTART/DTEND, and simple
// DAILY/WEEKLY RRULE expansion (covers standups/syncs). We do NOT attempt
// full RRULE (BYMONTH, BYSETPOS, etc.) — unknown recurrence is treated as
// a single event at its DTSTART so we never silently invent occurrences.

const DEFAULT_TIMEOUT_MS = 20000;

export class CalendarClient {
  constructor(options = {}) {
    const raw = options.icsUrl ?? process.env.CALENDAR_ICS_URL ?? "";
    this.urls = raw.split(",").map((s) => s.trim()).filter(Boolean);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  isConfigured() {
    return this.urls.length > 0;
  }

  async fetchRaw() {
    const texts = [];
    for (const url of this.urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`calendar fetch failed with ${res.status}`);
        texts.push(await res.text());
      } finally {
        clearTimeout(timer);
      }
    }
    return texts;
  }

  /// Return events overlapping [from, to). Each: { summary, start, end,
  /// allDay, location, status }. start/end are ISO strings.
  async eventsBetween(from, to) {
    const fromMs = +new Date(from);
    const toMs = +new Date(to);
    const raw = await this.fetchRaw();
    const all = [];
    for (const text of raw) {
      for (const ev of parseICS(text)) {
        for (const occ of expandOccurrences(ev, fromMs, toMs)) {
          all.push(occ);
        }
      }
    }
    return all.sort((a, b) => (a.start < b.start ? -1 : 1));
  }
}

export function registerCalendarIntegration(runtime, options = {}) {
  const client = options.client ?? new CalendarClient(options);
  if (!client.isConfigured()) return { registered: false, reason: "CALENDAR_ICS_URL not set" };

  runtime.tools.register({
    name: "calendar_today_events",
    description: "List calendar events overlapping today (from the user's secret ICS feed). Useful for reconciling whether a scheduled meeting happened, and for planning the day.",
    source: "integration:calendar",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA timezone for 'today' bounds. Defaults to the host's local day." }
      },
      additionalProperties: false
    },
    handler: async () => {
      const now = new Date();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return client.eventsBetween(start.toISOString(), end.toISOString());
    }
  });

  runtime.tools.register({
    name: "calendar_events_between",
    description: "List calendar events overlapping an explicit [from, to] ISO window from the user's secret ICS feed.",
    source: "integration:calendar",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO 8601 start of window." },
        to: { type: "string", description: "ISO 8601 end of window." }
      },
      required: ["from", "to"],
      additionalProperties: false
    },
    handler: async (args) => client.eventsBetween(args.from, args.to)
  });

  return { registered: true, tools: ["calendar_today_events", "calendar_events_between"], feeds: client.urls.length };
}

// ─── ICS parsing (no external deps) ──────────────────────────────────────

// Unfold RFC 5545 folded lines (continuation lines begin with space/tab).
function unfold(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

export function parseICS(text) {
  const lines = unfold(text).split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(";");
    const params = {};
    for (const p of paramParts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    const key = name.toUpperCase();
    if (key === "SUMMARY") cur.summary = unescapeText(value);
    else if (key === "LOCATION") cur.location = unescapeText(value);
    else if (key === "STATUS") cur.status = value.toLowerCase();
    else if (key === "DTSTART") cur.dtstart = parseDate(value, params);
    else if (key === "DTEND") cur.dtend = parseDate(value, params);
    else if (key === "RRULE") cur.rrule = parseRRule(value);
    else if (key === "UID") cur.uid = value;
  }
  return events;
}

function unescapeText(v) {
  return v.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}

// Parse an ICS date/date-time into { ms, allDay }. Supports:
//   YYYYMMDD                  (VALUE=DATE, all-day)
//   YYYYMMDDTHHMMSSZ          (UTC)
//   YYYYMMDDTHHMMSS           (floating/local — treated as UTC-ish local)
function parseDate(value, params = {}) {
  const allDay = params.VALUE === "DATE" || /^\d{8}$/.test(value);
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return { ms: NaN, allDay };
  const [, y, mo, d, hh = "00", mm = "00", ss = "00", z] = m;
  if (allDay && !m[4]) {
    return { ms: Date.UTC(+y, +mo - 1, +d, 0, 0, 0), allDay: true };
  }
  if (z === "Z") {
    return { ms: Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss), allDay: false };
  }
  // No Z and a TZID we don't resolve: treat as local time on the host.
  return { ms: new Date(+y, +mo - 1, +d, +hh, +mm, +ss).getTime(), allDay: false };
}

function parseRRule(value) {
  const out = {};
  for (const part of value.split(";")) {
    const [k, v] = part.split("=");
    if (k && v) out[k.toUpperCase()] = v;
  }
  return out; // e.g. { FREQ:"WEEKLY", BYDAY:"MO,WE", UNTIL:"...", COUNT:"10", INTERVAL:"1" }
}

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Expand an event into concrete occurrences overlapping [fromMs, toMs).
// Non-recurring events yield 0 or 1. DAILY/WEEKLY RRULEs are expanded;
// other FREQs degrade to the single base occurrence.
function expandOccurrences(ev, fromMs, toMs) {
  if (!ev.dtstart || Number.isNaN(ev.dtstart.ms)) return [];
  const durMs = ev.dtend && !Number.isNaN(ev.dtend.ms)
    ? Math.max(0, ev.dtend.ms - ev.dtstart.ms)
    : (ev.dtstart.allDay ? 86_400_000 : 3_600_000);

  const emit = (startMs) => {
    const endMs = startMs + durMs;
    if (endMs <= fromMs || startMs >= toMs) return null; // no overlap
    return {
      summary: ev.summary ?? "(untitled)",
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      allDay: ev.dtstart.allDay,
      location: ev.location ?? null,
      status: ev.status ?? "confirmed",
      recurring: Boolean(ev.rrule)
    };
  };

  const rr = ev.rrule;
  if (!rr || (rr.FREQ !== "DAILY" && rr.FREQ !== "WEEKLY")) {
    const one = emit(ev.dtstart.ms);
    return one ? [one] : [];
  }

  const interval = Math.max(1, parseInt(rr.INTERVAL ?? "1", 10) || 1);
  const untilMs = rr.UNTIL ? parseDate(rr.UNTIL, {}).ms : Infinity;
  const maxCount = rr.COUNT ? parseInt(rr.COUNT, 10) : Infinity;
  const hardCap = toMs + 86_400_000; // never iterate past the query window
  const out = [];
  let emitted = 0;

  if (rr.FREQ === "DAILY") {
    const stepMs = interval * 86_400_000;
    for (let t = ev.dtstart.ms; t <= Math.min(untilMs, hardCap) && emitted < maxCount; t += stepMs) {
      emitted += 1; // count toward COUNT even if outside the overlap window
      const occ = emit(t);
      if (occ) out.push(occ);
    }
    return out;
  }

  // WEEKLY: expand each requested weekday within each interval-week.
  const days = (rr.BYDAY ? rr.BYDAY.split(",") : [])
    .map((d) => WEEKDAY[d.replace(/^[+-]?\d+/, "")])
    .filter((n) => n !== undefined);
  const base = new Date(ev.dtstart.ms);
  const baseDow = base.getUTCDay();
  const targetDows = days.length ? days : [baseDow];
  const weekMs = 7 * 86_400_000 * interval;
  // Start from the Sunday of the DTSTART week.
  const weekStart0 = ev.dtstart.ms - baseDow * 86_400_000;
  const timeOfDay = ev.dtstart.ms - Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());

  for (let wk = weekStart0; wk <= Math.min(untilMs, hardCap) && emitted < maxCount; wk += weekMs) {
    for (const dow of targetDows.slice().sort((a, b) => a - b)) {
      const dayMidnight = wk + dow * 86_400_000;
      const startMs = dayMidnight + timeOfDay;
      if (startMs < ev.dtstart.ms) continue; // before the series began
      if (startMs > Math.min(untilMs, hardCap)) continue;
      if (emitted >= maxCount) break;
      emitted += 1;
      const occ = emit(startMs);
      if (occ) out.push(occ);
    }
  }
  return out;
}
