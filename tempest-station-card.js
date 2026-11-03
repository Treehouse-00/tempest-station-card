/*
 * Tempest weather station card for Home Assistant.
 *
 * Dependency-free. Live values come from the local WeatherFlow integration's
 * entities, history from the recorder's 5-minute, daily and monthly
 * statistics, and what comes next from a weather entity's forecast.
 *
 * Layout: on a laptop or wider, one screen with no scrolling, cut to the
 * window's height. The Now column holds the reading, what it means and six
 * scales that place it. The time column holds wind and sun over a meteogram:
 * every measure stacked on one time axis (the last 24 hours and the next 12,
 * 14 days and the forecast's 5, the last 12 months, or year by year) and read
 * through one crosshair. Narrower screens stack the same parts and scroll.
 *
 * Scales and their sources:
 *   Beaufort force            WMO, m/s thresholds
 *   pressure tendency         Met Office glossary, hPa change in 3 h
 *   rain intensity            AMS Glossary, mm/h
 *   dew point comfort         NWS La Crosse summer comfort levels, °F
 *   UV index                  WHO categories and colours
 *   lightning distance        NWS: within 10 mi is within striking distance
 *   Tempest power modes       WeatherFlow help, downshift voltages
 *   clear-sky irradiance      Haurwitz (1945) model
 *
 * Type follows Home Assistant's tokens: Roboto 400 and 500 at 64 (the one
 * hero figure; 48 on a short screen), 32 (headlines), 24, 16, 14 and 12 px.
 * Figures are tabular.
 *
 * Motion: the needle glides between samples; a change of range, or of a
 * figure, crossfades over 220 ms; nothing moves the layout. All of it is
 * off under prefers-reduced-motion.
 *
 * Config:
 *   type: custom:tempest-station-card
 *   station: st_00012345          # entity slug; auto-detected when omitted
 *   forecast: weather.forecast_home
 *   name: Backyard                # optional place name; heads the Now column in place of "Now"
 *   range: days                   # hours | days | months | years; the viewer's last choice wins
 *   entities: { temperature: sensor.x }   # per-key overrides
 */
(() => {
  "use strict";
  const TAG = "tempest-station-card";
  const VERSION = "1.3.0";
  if (customElements.get(TAG)) return;

  /* ---------- units ---------- */

  const HPA = { hPa: 1, mbar: 1, mb: 1, Pa: 0.01, kPa: 10, bar: 1000, cbar: 10, inHg: 33.8639, mmHg: 1.333224, psi: 68.9476 };
  // A pressure span given in hPa, in the barometer's own unit. A barograph's scale is fixed for a reason: zoomed
  // to fit, a steady day draws as a fall, so each range keeps at least a weather-sized span.
  const hpaIn = (hpa, unit) => hpa / (HPA[unit] ?? 1);
  // Decimals that give a pressure unit about 0.1 hPa of resolution: 1007.9 hPa, 29.76 inHg, 101.32 kPa.
  const presDp = (unit) => ((HPA[unit] ?? 1) >= 10 ? 2 : 1);
  const MS = { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, kn: 0.514444, "ft/s": 0.3048 };
  const MM = { mm: 1, cm: 10, in: 25.4, "mm/h": 1, "in/h": 25.4 };
  const KM = { km: 1, m: 0.001, mi: 1.609344, ft: 0.0003048, yd: 0.0009144 };
  const conv = (table) => ({ to: (v, u) => v * (table[u] ?? 1), from: (v, u) => v / (table[u] ?? 1) });
  const PRES = conv(HPA), SPEED = conv(MS), DEPTH = conv(MM), DIST = conv(KM);
  const toC = (v, u) => (u === "°F" ? ((v - 32) * 5) / 9 : u === "K" ? v - 273.15 : v);
  const fromC = (c, u) => (u === "°F" ? (c * 9) / 5 + 32 : u === "K" ? c + 273.15 : c);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  /* ---------- scales ---------- */
  // Each scale returns its verdict and where the reading sits: band i, fraction f into it.

  // WMO Beaufort: lower bound in m/s of forces 1..12.
  const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const BEAUFORT_NAMES = ["Calm", "Light air", "Light breeze", "Gentle breeze", "Moderate breeze", "Fresh breeze",
    "Strong breeze", "Near gale", "Gale", "Strong gale", "Storm", "Violent storm", "Hurricane"];
  function beaufort(ms) {
    const i = BEAUFORT.filter((b) => ms >= b).length;
    const lo = i ? BEAUFORT[i - 1] : 0, hi = BEAUFORT[i] ?? 40;
    return { i, f: clamp01((ms - lo) / (hi - lo)), word: BEAUFORT_NAMES[i] };
  }

  const CARD16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  // In running text the points are words: figures say SW, sentences say southwest.
  const CARD16_WORDS = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast",
    "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"].map((w) => w.replace("-", "\u2011"));
  const DEPTH_WORDS = { in: ["inch", "inches"], mm: ["millimeter", "millimeters"] };
  const RING = 72; // segments in the dial's recent-wind ring, 5° each
  const norm360 = (d) => ((d % 360) + 360) % 360;
  const sector16 = (deg) => Math.round(norm360(deg) / 22.5) % 16;

  // Met Office: pressure change over the preceding 3 h, in hPa. Nine bands, steady in the middle.
  // The bands stay in hPa; the change is shown in the unit the barometer reads in.
  const PRESSURE_WORDS = { hPa: "hectopascals", mbar: "millibars", mb: "millibars", kPa: "kilopascals", inHg: "inches of mercury", mmHg: "millimeters of mercury" };
  // A change past "steady" never prints as zero: inHg gains a third decimal below 0.01.
  const tendIn = (f, dHpa, pu) => {
    const k = HPA[pu] ? HPA[pu] : 1, unit = HPA[pu] ? pu : "hPa", v = dHpa / k;
    const dp = k >= 10 ? (Math.abs(dHpa) >= 0.1 && Math.abs(v) < 0.01 ? 3 : 2) : k >= 1 ? 1 : 0;
    return { text: `${f.signed(v, dp)}${NB}${unit}`, words: PRESSURE_WORDS[unit] ?? unit };
  };
  function tendency(d) {
    const a = Math.abs(d);
    const s = a < 0.1 ? 0 : a < 1.6 ? 1 : a < 3.6 ? 2 : a <= 6 ? 3 : 4;
    const lo = [0, 0.1, 1.6, 3.6, 6][s], hi = [0.1, 1.6, 3.6, 6, 10][s];
    const frac = clamp01((a - lo) / (hi - lo));
    if (s === 0) return { i: 4, f: clamp01(0.5 + d / 0.2), word: "Steady" };
    const adv = ["", " slowly", "", " quickly", " very rapidly"][s];
    return d > 0 ? { i: 4 + s, f: frac, word: `Rising${adv}` } : { i: 4 - s, f: 1 - frac, word: `Falling${adv}` };
  }

  // AMS Glossary rain intensity, mm/h.
  function rainRate(mmh) {
    if (!(mmh > 0)) return { i: 0, f: 0.5, word: "None" };
    if (mmh < 2.5) return { i: 1, f: mmh / 2.5, word: "Light" };
    if (mmh < 7.6) return { i: 2, f: (mmh - 2.5) / 5.1, word: "Moderate" };
    return { i: 3, f: clamp01((mmh - 7.6) / 12.4), word: "Heavy" };
  }

  // NWS La Crosse summer comfort by dew point, °F.
  const DEW_EDGES = [35, 55, 65, 80];
  const DEW_WORDS = ["Dry and comfortable", "Sticky", "Oppressive"];
  function comfort(f) {
    const i = f <= 55 ? 0 : f < 65 ? 1 : 2;
    const c = Math.max(DEW_EDGES[0], Math.min(DEW_EDGES[3], f));
    return { i, f: clamp01((c - DEW_EDGES[i]) / (DEW_EDGES[i + 1] - DEW_EDGES[i])), word: DEW_WORDS[i] };
  }

  // WHO UV index categories (by the rounded index) and their published colours.
  const UV_EDGES = [0, 2.5, 5.5, 7.5, 10.5, 14];
  const UV_BANDS = [
    { label: "Low", color: "#289500" }, { label: "Moderate", color: "#f7e400" }, { label: "High", color: "#f85900" },
    { label: "Very high", color: "#d8001d" }, { label: "Extreme", color: "#6b49c8" },
  ];
  function uvScale(uv) {
    const r = Math.round(uv);
    const i = r <= 2 ? 0 : r <= 5 ? 1 : r <= 7 ? 2 : r <= 10 ? 3 : 4;
    const c = Math.max(UV_EDGES[i], Math.min(UV_EDGES[i + 1], uv));
    return { i, f: clamp01((c - UV_EDGES[i]) / (UV_EDGES[i + 1] - UV_EDGES[i])), word: UV_BANDS[i].label };
  }

  // Tempest power modes, downshift voltages. Between two thresholds the mode
  // depends on direction (hysteresis), so a reading there is approximate.
  const POWER = [
    { v: 2.455, label: "full rate", detail: "wind every 3 s" },
    { v: 2.415, label: "power save 1", detail: "wind every 6 s" },
    { v: 2.39, label: "power save 2", detail: "wind every minute" },
    { v: 2.355, label: "power save 3", detail: "wind every 5 min, rain off" },
  ];
  // The mode a battery voltage puts the station in; between full rate and the first save it may be either (0.5).
  const powerMode = (v) => (v >= POWER[0].v ? 0 : v > POWER[1].v ? 0.5 : v > POWER[2].v ? 1 : v > POWER[3].v ? 2 : 3);

  const STRIKE_MI = 10; // NWS striking distance

  // The longest sentence the Now column can write, every clause in its longest words: the sentence's box is always this
  // tall at the current width, so no change of wording, however big, can move what sits below it.
  const LEDE_LONGEST = "Very hot and oppressive this afternoon, warming 10.5° an hour. Moderate breeze from the north\u2011northwest. Pressure falling very rapidly. Heavy rain and hail now.";
  const tempWord = (f) => (f <= 32 ? "Freezing" : f < 50 ? "Cold" : f < 60 ? "Cool" : f < 70 ? "Mild" : f < 80 ? "Warm" : f < 90 ? "Hot" : "Very hot");

  /* ---------- sun ---------- */

  const RAD = Math.PI / 180;
  // Solar elevation in degrees (USNO low-precision algorithm, ~1°).
  function sunElevation(t, lat, lon) {
    const d = t / 864e5 - 10957.5;
    const g = (357.529 + 0.98560028 * d) * RAD;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
    const e = (23.439 - 3.6e-7 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = 18.697374558 + 24.06570982441908 * d;
    const ha = (gmst * 15 + lon) * RAD - ra;
    const la = lat * RAD;
    return Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha)) / RAD;
  }
  // Haurwitz clear-sky global horizontal irradiance, W/m².
  const clearSky = (el) => (el > 0 ? 1098 * Math.sin(el * RAD) * Math.exp(-0.057 / Math.sin(el * RAD)) : 0);
  const HORIZON = -0.833;

  function sunTimes(day0, lat, lon) {
    const out = { rise: null, set: null };
    let prev = sunElevation(day0, lat, lon);
    for (let t = day0 + 120e3; t <= day0 + 864e5; t += 120e3) {
      const el = sunElevation(t, lat, lon);
      if ((prev < HORIZON) !== (el < HORIZON)) {
        const x = t - 120e3 + (120e3 * (HORIZON - prev)) / (el - prev);
        if (el > prev) out.rise = out.rise ?? x;
        else out.set = out.set ?? x;
      }
      prev = el;
    }
    return out;
  }

  function nightSpans(x0, x1, lat, lon) {
    const spans = [];
    let start = null;
    for (let t = x0; t <= x1; t += 300e3) {
      const dark = sunElevation(t, lat, lon) < HORIZON;
      if (dark && start === null) start = t;
      if (!dark && start !== null) { spans.push([start, t]); start = null; }
    }
    if (start !== null) spans.push([start, x1]);
    return spans;
  }

  /* ---------- formatting ---------- */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const MINUS = "−";
  const NB = " ";

  class Fmt {
    // clock: Home Assistant's time format, "12" or "24" to override the language's own clock.
    // numbers: Home Assistant's number format, "language" or an explicit style.
    constructor(lang, tz, clock, numbers) {
      this.lang = lang || "en";
      this.tz = tz;
      this.clock = clock;
      this.numbers = numbers;
      this._numLang = { comma_decimal: "en-US", decimal_comma: "de-DE", space_comma: "fr-FR", none: "en-US" }[numbers] ?? this.lang;
      this._numOpts = numbers === "none" ? { useGrouping: false } : { useGrouping: "min2" };
      this._nf = new Map();
      const o = { timeZone: tz }, h = clock === "12" ? { hour12: true } : clock === "24" ? { hourCycle: "h23" } : {};
      this._time = new Intl.DateTimeFormat(this.lang, { ...o, ...h, hour: "numeric", minute: "2-digit" });
      this._hour = new Intl.DateTimeFormat(this.lang, { ...o, ...h, hour: "numeric" });
      this._date = new Intl.DateTimeFormat(this.lang, { ...o, month: "short", day: "numeric" });
      this._wd = new Intl.DateTimeFormat(this.lang, { ...o, weekday: "short" });
      this._parts = new Intl.DateTimeFormat("en-US", { ...o, hourCycle: "h23", year: "numeric", month: "numeric",
        day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    }
    num(v, dp = 0) {
      if (v === null || v === undefined || !Number.isFinite(v)) return "—";
      let f = this._nf.get(dp);
      if (!f) this._nf.set(dp, (f = new Intl.NumberFormat(this._numLang, { minimumFractionDigits: dp, maximumFractionDigits: dp, ...this._numOpts })));
      return f.format(v).replace("-", MINUS);
    }
    signed(v, dp = 0) {
      if (!Number.isFinite(v)) return "—";
      const s = this.num(Math.abs(v), dp);
      return Math.abs(v) < 0.5 * 10 ** -dp ? s : (v > 0 ? "+" : MINUS) + s;
    }
    // The start of the local hour holding t, in any time zone, including the :30 and :45 ones.
    startOfHour(t) { const p = this.parts(t); return t - p.minute * 60e3 - p.second * 1000 - (t % 1000); }
    time(t) { return this._time.format(t); }
    hour(t) { return this._hour.format(t); }
    weekday(t) { return this._wd.format(t); }
    // "3:05 PM", "3:05 PM yesterday", "3:05 PM tomorrow"; further off, the weekday leads.
    when(t, now) {
      const d = Math.round((this.startOfDay(t) - this.startOfDay(now)) / 864e5);
      return d === 0 ? this.time(t) : d === -1 ? `${this.time(t)} yesterday` : d === 1 ? `${this.time(t)} tomorrow` : `${this.weekday(t)} ${this.time(t)}`;
    }
    dayLabel(t) { return `${this.weekday(t)} ${this.parts(t).day}`; }
    date(t) { return this._date.format(t); }
    parts(t) {
      const o = {};
      for (const p of this._parts.formatToParts(t)) if (p.type !== "literal") o[p.type] = Number(p.value);
      return o;
    }
    startOfDay(t) {
      const p = this.parts(t);
      let s = t - ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 - (t % 1000);
      const h = this.parts(s).hour;
      if (h !== 0) s -= (h > 12 ? h - 24 : h) * 3600e3;
      return s;
    }
    // Numbers and their units never break apart: the space between them is non-breaking.
    ago(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s}${NB}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}${NB}min ago`;
      return `${Math.floor(s / 3600)}${NB}h ${Math.floor((s % 3600) / 60)}${NB}min ago`;
    }
    dur(ms) {
      const m = Math.round(ms / 60e3);
      return m < 60 ? `${m}${NB}min` : `${Math.floor(m / 60)}${NB}h ${m % 60}${NB}min`;
    }
  }

  /* ---------- chart geometry ---------- */

  function niceTicks(lo, hi, count) {
    if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
    // From the step at or below lo to the step at or above hi, so the ticks always cover the data.
    const ticks = [];
    const last = Math.ceil(hi / step - 1e-9) * step;
    for (let v = Math.floor(lo / step + 1e-9) * step; v <= last + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
    return { ticks, step, lo: ticks[0], hi: ticks[ticks.length - 1] };
  }

  // Rounded data-end (4 px) on top, square at the baseline.
  function barPath(x, y, w, h) {
    if (h <= 0) return "";
    const r = Math.min(4, w / 2, h);
    const b = y + h;
    return `M${x},${b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${b}Z`;
  }

  function runs(pts, gapMs) {
    const out = [];
    let run = [];
    for (const p of pts) {
      if (run.length && p.t - run[run.length - 1].t > gapMs) { out.push(run); run = []; }
      run.push(p);
    }
    if (run.length) out.push(run);
    return out;
  }
  const xy = (sx, sy, t, v) => `${sx(t).toFixed(1)},${sy(v).toFixed(1)}`;
  const linePath = (pts, sx, sy, gap) => runs(pts, gap).map((r) => `M${r.map((p) => xy(sx, sy, p.t, p.v)).join("L")}`).join("");
  const areaPath = (pts, sx, sy, base, gap) => runs(pts, gap).filter((r) => r.length > 1).map((r) =>
    `M${sx(r[0].t).toFixed(1)},${base}L${r.map((p) => xy(sx, sy, p.t, p.v)).join("L")}L${sx(r[r.length - 1].t).toFixed(1)},${base}Z`).join("");
  const bandPath = (pts, sx, sy, gap) => runs(pts, gap).filter((r) => r.length > 1).map((r) =>
    `M${r.map((p) => xy(sx, sy, p.t, p.hi)).join("L")}L${r.slice().reverse().map((p) => xy(sx, sy, p.t, p.lo)).join("L")}Z`).join("");

  function nearest(pts, t, tol) {
    let lo = 0, hi = pts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t < t) lo = mid + 1; else hi = mid;
    }
    let best = pts[lo];
    if (lo > 0 && Math.abs(pts[lo - 1].t - t) < Math.abs(best.t - t)) best = pts[lo - 1];
    return Math.abs(best.t - t) <= tol ? best : null;
  }

  // A strip's readout: headline or value under the crosshair, its unit, what it is, and companion lines.
  const readout = (value, unit = "", caption = "", lines = []) => ({ value, unit, caption, lines });
  // A tile's lines in reading order, cut to n: keys to drawn series keep their place first, then the caption, then the rest.
  const fitLines = (v, n) => {
    const all = (v.caption ? [{ text: v.caption, cap: true }] : []).concat(v.lines ?? []);
    if (all.length <= n) return all;
    const rank = (l) => (l.color && !l.cap ? 0 : l.cap ? 1 : 2);
    const keep = new Set(all.map((_, i) => i).sort((a, b) => rank(all[a]) - rank(all[b]) || a - b).slice(0, n));
    return all.filter((_, i) => keep.has(i));
  };
  const span2 = (a, b) => (a === b ? a : `${a}–${b}`);
  // The highest (sign 1) or lowest (sign -1) point in a series.
  const extreme = (pts, sign) => pts.reduce((a, p) => (!a || sign * (p.v - a.v) > 0 ? p : a), null);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  /* ---------- the card ---------- */

  const KEYS = ["temperature", "feels_like", "dew_point", "humidity", "air_pressure", "wind_speed", "wind_direction",
    "wind_speed_average", "wind_direction_average", "wind_gust", "wind_lull", "irradiance", "illuminance", "uv_index",
    "precipitation", "precipitation_intensity", "precipitation_type", "lightning_count", "lightning_last_distance",
    "lightning_last_strike", "battery_voltage", "wet_bulb_temperature", "vapor_pressure", "air_density"];
  const STAT_KEYS = ["temperature", "feels_like", "dew_point", "wet_bulb_temperature", "humidity", "vapor_pressure", "air_pressure",
    "air_density", "wind_speed", "wind_direction", "wind_speed_average", "wind_gust", "wind_lull", "irradiance", "illuminance",
    "uv_index", "precipitation", "precipitation_intensity", "lightning_count", "battery_voltage"];
  const LONG_KEYS = ["temperature", "wind_speed_average", "wind_gust", "wind_lull", "air_pressure", "humidity",
    "irradiance", "precipitation", "lightning_count"];
  const FIVE_MIN = 300e3;
  const HOUR = 3600e3;
  const DAY = 864e5;
  const REFRESH_MS = 300e3;
  const PAST = 24 * HOUR, AHEAD = 12 * HOUR;
  const PAST_DAYS = 14, AHEAD_DAYS = 5;
  const RANGES = ["hours", "days", "months", "years"];
  // The WeatherFlow integration names a station's entities sensor.st_<serial>_<measure>.
  const findStation = (states) => { const id = Object.keys(states).find((e) => /^sensor\.st_[0-9a-z]+_temperature$/.test(e)); return id ? id.slice(7, -12) : null; };
  const RANGE_KEY = "tempest-station-card:range";
  const HINT_KEY = "tempest-station-card:hinted";
  const CSV_BTN = `<button class="tbtn" data-csv title="Download these rows as CSV">CSV</button>`;

  const STYLE = `
:host {
  display: block;
  --wx-temp: #eb6834; --wx-dew: #1baf7a; --wx-rain: #2a78d6; --wx-sun: #eda100;
  --wx-temp-2: #c44513; --wx-downwind: #d03b3b; --wx-wetbulb: #a68600;
  --wx-wind: #008300; --wx-pres: #6250d6; --wx-bolt: #e87ba4; --wx-muted: #898781;
  --wx-grid: #e1e0d9; --wx-axis: #c3c2b7; --wx-wash: rgba(11,11,11,0.035);
  --wx-good: #0ca30c; --wx-warn: #fab219; --wx-critical: #d03b3b;
  --wx-surface: var(--ha-card-background, var(--card-background-color, #fff));
  --wx-ink: var(--primary-text-color, #0b0b0b);
  --wx-ink2: var(--secondary-text-color, #52514e);
  --wx-fs-hero: 64px;
  --wx-fs-read: var(--ha-font-size-2xl, 24px);
  --wx-fs-stat: var(--ha-font-size-4xl, 32px);
  --wx-fs-title: var(--ha-font-size-l, 16px);
  --wx-fs-body: var(--ha-font-size-m, 14px);
  --wx-fs-small: var(--ha-font-size-s, 12px);
  --wx-w-regular: var(--ha-font-weight-normal, 400);
  --wx-w-medium: var(--ha-font-weight-medium, 500);
  --wx-gap: var(--ha-space-4, 16px);
  --wx-pad: var(--ha-space-5, 20px);
  --wx-well: color-mix(in srgb, var(--wx-ink) 3%, var(--wx-surface));
  font-family: var(--ha-font-family-body, Roboto, Noto, sans-serif);
  font-size: var(--wx-fs-body); line-height: 20px; font-weight: var(--wx-w-regular);
  color: var(--wx-ink);
  -webkit-font-smoothing: antialiased;
}
:host(.dark) {
  --wx-temp: #d95926; --wx-dew: #199e70; --wx-rain: #3987e5; --wx-sun: #c98500;
  --wx-pres: #9085e9; --wx-bolt: #d55181;
  --wx-temp-2: #e2825c; --wx-downwind: #f06a5f; --wx-wind: #00a400; --wx-wetbulb: #f2d23b;
  --wx-grid: #34342f; --wx-axis: #4a4a43; --wx-wash: rgba(255,255,255,0.045);
}
* { box-sizing: border-box; }

/* One screen on a laptop: the Now column and the time column, both cut to the window's height. */
.wrap { margin: 0 auto; padding: var(--wx-gap); display: grid; gap: var(--wx-gap); max-width: 1680px; --wx-tile: 184px; }
/* Wide: both cards share two rows (subgrid), so the reading band and the detail band meet on one rule across the page. */
.wrap.wide { grid-template-columns: clamp(300px, 27%, 380px) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); row-gap: 0; height: var(--wx-h, auto); }
.card {
  background: var(--wx-surface);
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none);
  padding: var(--wx-pad); min-width: 0;
}
.wide .card { grid-row: span 2; display: grid; grid-template-rows: subgrid; grid-template-columns: minmax(0, 1fr); min-height: 0; overflow: hidden; }
/* A grid item is as wide as its widest content unless told otherwise; the table must scroll inside its card instead. */
.wide .card > * { min-width: 0; }
.wide .card > .top, .wide .card > .figs2 { grid-row: 1; }
.wide .card > .body, .wide .card > .hist { grid-row: 2; min-height: 0; display: flex; flex-direction: column; }
.top { padding-bottom: 16px; border-bottom: 1px solid var(--wx-grid); }
.top .scale { margin-top: 16px; }
.body { padding-top: 16px; }
.col-now .head { flex-wrap: nowrap; }
.col-now .head h2 { flex: none; }
.col-now .head .meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.narrow .card { padding: var(--wx-gap); }
h2 { font-size: var(--wx-fs-title); line-height: 24px; font-weight: var(--wx-w-medium); margin: 0; }
.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; min-height: 24px; }
.meta { font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.small { font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); }
.unit { font-size: var(--wx-fs-body); color: var(--wx-ink2); margin-left: 2px; font-weight: var(--wx-w-regular); }
.unit.pct { margin-left: 0; }
.status { margin-left: auto; display: inline-flex; align-items: baseline; gap: 6px; font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); }
.status i { width: 8px; height: 8px; border-radius: 50%; background: var(--wx-muted); flex: none; transform: translateY(-1px); }
.status.good i { background: var(--wx-good); }
.status.warn i { background: var(--wx-warn); }

/* The Now column: the reading, what it means, and the scales that place it. */
.hero-row { display: flex; align-items: last baseline; gap: 20px; margin-top: 12px; }
.hero { display: flex; align-items: flex-start; font-size: var(--wx-fs-hero); line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.hero .u { font-size: var(--wx-fs-read); line-height: 24px; letter-spacing: 0; color: var(--wx-ink2); margin: 6px 0 0 4px; }
.feels { color: var(--wx-ink2); }
.feels b { color: var(--wx-ink); font-weight: var(--wx-w-medium); }
.lede { font-size: var(--wx-fs-title); line-height: 24px; margin: 12px 0 0; text-wrap: pretty; min-height: 72px; }
.tight { --wx-gap: var(--ha-space-3, 12px); --wx-pad: var(--ha-space-4, 16px); --wx-tile: 168px; }
.tight .hero-row { margin-top: 8px; }
.tight .hero { font-size: 48px; }
.tight .hero .u { margin-top: 3px; }
.tight .lede { font-size: var(--wx-fs-body); line-height: 20px; min-height: 60px; }
.tight .top { padding-bottom: 12px; }
.tight .body { padding-top: 12px; }
.tight .sc-track { margin-top: 6px; }
.tight .sc-labels { margin-top: 4px; }
.tight .figs2 { padding-bottom: 12px; margin-bottom: 8px; }
.wide .figs2 { margin-bottom: 0; }
.wide .hist { padding-top: 12px; }
.tight .hist { padding-top: 8px; }
.tight .mg-head { margin-bottom: 8px; }
.dense .sc-labels { display: none; }
.scales { display: grid; gap: 16px; margin-top: 16px; }
.wide .scales { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: space-between; gap: 8px; }
.body .lede, .tight .body .lede { margin-top: 0; }
.mid .scales { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; }
.alerts { display: grid; gap: 8px; margin-bottom: 16px; }
.alerts:empty { display: none; }
.alert { display: flex; gap: 10px; align-items: baseline; }
.alert i { width: 8px; height: 8px; border-radius: 50%; flex: none; transform: translateY(-1px); }

/* Scale: a labelled reading over a track of bands; the band in force takes the measure's colour. */
.scale { min-width: 0; }
.sc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.sc-head .small { white-space: nowrap; }
.sc-read { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-read b { font-weight: var(--wx-w-medium); }
.sc-read span { color: var(--wx-ink2); font-variant-numeric: tabular-nums; }
.sc-track { position: relative; height: 6px; margin-top: 8px; border-radius: 3px; background: var(--wx-grid); }
.sc-on { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
.sc-notch { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--wx-surface); }
.sc-mark { position: absolute; top: -5px; width: 3px; height: 16px; margin-left: -1.5px; border-radius: 1.5px; background: var(--wx-ink); box-shadow: 0 0 0 2px var(--wx-surface); transition: left .6s ease; }
.sc-labels { display: flex; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); }

/* The time column: wind and sun over the meteogram. */
.figs2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; padding-bottom: 16px; margin-bottom: 12px; border-bottom: 1px solid var(--wx-grid); }
.narrow .figs2 { grid-template-columns: minmax(0, 1fr); gap: 28px; }
.zone { min-width: 0; }
.inst { display: flex; gap: 20px; align-items: flex-start; }
.inst .txt { display: grid; gap: 6px; align-content: start; min-width: 0; }
.inst .txt h2 { margin-bottom: 2px; }
.inst b { font-weight: var(--wx-w-regular); }
.wide .inst.wind, .mid .inst.wind { display: grid; grid-template-columns: var(--wx-tile) minmax(0, 1fr); gap: 0; }
.inst.sun { align-items: stretch; }
.inst.sun .txt { align-self: start; }
.inst.sun .sunfig { flex: 1 1 auto; min-width: 0; min-height: 96px; }
.narrow .inst.sun .sunfig { height: 168px; flex: none; }
.inst.sun .txt { flex: 0 0 auto; width: 168px; }
.inst.sun .txt > * { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.narrow .inst.sun { flex-direction: column; }
.narrow .inst.sun .sunfig { width: 100%; }
.narrow .inst.sun .txt { width: auto; }
.dial { flex: none; position: relative; }
.dial .needle { transition: transform 3s cubic-bezier(.45,.05,.55,.95), opacity 1s; }
.dial .needle.calm { opacity: 0.35; }
.dial [data-ring] { transition: stroke-opacity 3s linear; }
@media print { .seg, .tbtn { display: none; } .card { break-inside: avoid; box-shadow: none; } }
/* High contrast: the charts, the dial and the scales keep their own colours, since colour is what they say. */
@media (forced-colors: active) {
  .mg-p, .sunfig, .dial, .sc-track, .status i, .alert i, .tile .k, .mg-key i { forced-color-adjust: none; }
  .sunfig, .dial { background: var(--wx-surface); border-radius: 8px; }
  .seg button[aria-pressed="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
}
@media (prefers-contrast: more) {
  :host { --wx-ink2: color-mix(in srgb, var(--wx-ink) 82%, var(--wx-surface)); --wx-grid: color-mix(in srgb, var(--wx-ink) 22%, var(--wx-surface)); --wx-axis: color-mix(in srgb, var(--wx-ink) 40%, var(--wx-surface)); }
}
@media (prefers-reduced-motion: reduce) { .dial .needle, .dial [data-ring], .sc-mark { transition: none; } }
.read { font-size: var(--wx-fs-read); line-height: 28px; white-space: nowrap; font-weight: var(--wx-w-medium); font-variant-numeric: tabular-nums; }
.read .unit { font-weight: var(--wx-w-regular); }
.cap { margin-top: 6px; line-height: 18px; }
.sunfig svg { display: block; overflow: visible; }
.mg-head { margin-bottom: 12px; }
.head-r { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-left: auto; }
.narrow .head-r { margin-left: 0; width: 100%; }
.narrow [data-csv] { display: none; }
.mg-body { position: relative; }
.wide .mg-body { flex: 1 1 auto; min-height: 0; }
.seg { display: inline-flex; border: 1px solid var(--wx-grid); border-radius: 6px; overflow: hidden; }
.seg button, .tbtn { font: inherit; font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); background: none; border: 0; padding: 3px 10px; cursor: pointer; }
.tbtn { border: 1px solid var(--wx-grid); border-radius: 6px; }
.seg button + button { border-left: 1px solid var(--wx-grid); }
.seg button[aria-pressed="true"] { background: var(--wx-wash); color: var(--wx-ink); font-weight: var(--wx-w-medium); }
.seg button:hover, .tbtn:hover { color: var(--wx-ink); }
.seg button:focus-visible, .tbtn:focus-visible { outline: 2px solid var(--primary-color, #2a78d6); outline-offset: 2px; }

/* Meteogram: one time axis for every measure. Each chart sits in its own well, led by a headline tile. */
.mg { display: grid; grid-template-columns: var(--wx-tile, 184px) minmax(0, 1fr); position: relative; outline: none; }
.mg:focus-visible { outline: 2px solid var(--primary-color, #2a78d6); outline-offset: 4px; border-radius: 4px; }
/* A finger reads the chart as a mouse does: a drag along it scrubs; a drag up or down still scrolls the page. */
.mg { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
.mg-p, .mg-axis { touch-action: pan-y; }
.tile { min-width: 0; overflow: hidden; padding: 4px 16px 0 0; }
/* The squint test: the name and the number are the only dark, heavy things in a tile. */
.tile .tn { font-size: var(--wx-fs-small); line-height: 16px; color: var(--wx-ink2); font-weight: var(--wx-w-regular); }
.tile .tv { font-size: var(--wx-fs-stat); line-height: 36px; font-weight: var(--wx-w-medium); letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; font-variant-numeric: tabular-nums; }
.tile .tv .unit { font-size: var(--wx-fs-body); font-weight: var(--wx-w-regular); letter-spacing: 0; line-height: 1; }
.tile .tl, .tile .tn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .tl { min-height: 18px; line-height: 18px; }
.tile .k { display: inline-block; width: 12px; height: 0; border-top: 2px solid; vertical-align: middle; margin: -2px 6px 0 0; }
.tile .k.dash { border-top-style: dashed; }
.tile .k.dot { border-top-style: dotted; border-top-width: 2.5px; }
.mg-p { min-width: 0; position: relative; border-radius: 8px; background: var(--wx-well); overflow: hidden; }
@keyframes wx-arrive { from { opacity: 0; } to { opacity: 1; } }
.arrive .mg-p svg, .arrive .sunfig svg, .arrive .dial svg, .arrive .tile .tv { animation: wx-arrive 360ms ease-out both; }
@media (prefers-reduced-motion: reduce) { .arrive .mg-p svg, .arrive .sunfig svg, .arrive .dial svg, .arrive .tile .tv { animation: none; } }
/* A change of range, or of the history behind the chart, is a crossfade: the old chart fades out over the new one. */
.mg-ghost { position: absolute; inset: 0; overflow: hidden; pointer-events: none; animation: wx-fade 220ms ease-out both; }
.mg-ghost * { animation: none !important; }
.swap > .mg, .swap > .table-wrap { animation: wx-arrive 220ms ease-out both; }
@keyframes wx-fade { to { opacity: 0; } }
/* A figure that changes crossfades too: the new digits darken while the old, held in a ghost, fade. */
.xf { position: relative; animation: wx-ink 220ms ease-out both; }
.xf::after { content: attr(data-old); position: absolute; left: 0; top: 0; color: var(--wx-ink); white-space: nowrap; pointer-events: none; animation: wx-fade 220ms ease-out both; }
@keyframes wx-ink { from { color: transparent; } }
@media (prefers-reduced-motion: reduce) { .mg-ghost { display: none; } .swap > .mg, .swap > .table-wrap, .xf { animation: none; } .xf::after { content: none; } }
.mg-p svg, .mg-axis svg { display: block; overflow: visible; }
.mg-axis { grid-column: 2; }
.mg-key { grid-column: 1; padding: 6px 16px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mg-key i { display: inline-block; vertical-align: middle; margin: -2px 6px 0 0; }
.mg-key .kd { width: 14px; border-top: 1.5px dashed var(--wx-muted); }
.mg-key .kb { width: 8px; height: 8px; border-radius: 2px; background: var(--wx-muted); opacity: .5; }
.narrow .mg-key { order: 2; padding: 4px 0 0; }
.tile.m .tv { font-size: var(--wx-fs-read); line-height: 26px; }
.tile.s { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-top: 8px; }
.tile.s .tv { font-size: var(--wx-fs-body); line-height: 20px; font-weight: var(--wx-w-medium); }
.tile.s [data-tq] { display: none; }
.narrow .mg { grid-template-columns: minmax(0, 1fr); }
.narrow .tile { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; column-gap: 12px; row-gap: 2px; padding: 10px 2px 4px; }
.narrow .tile .tls { grid-column: 1 / -1; display: flex; flex-wrap: wrap; column-gap: 16px; }
.narrow .mg-axis { grid-column: 1; }
.mg-none { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; }
.tick { font-size: var(--wx-fs-small); fill: var(--wx-ink2); font-variant-numeric: tabular-nums; }
.tick.halo { paint-order: stroke; stroke: var(--wx-well); stroke-width: 4px; stroke-linejoin: round; }
.tick.day { fill: var(--wx-ink); }
.tick.now { font-weight: var(--wx-w-medium); }
.tick.hint { fill: var(--wx-ink2); }
.yearlabel { font-size: var(--wx-fs-small); font-weight: var(--wx-w-medium); fill: var(--wx-ink); font-variant-numeric: tabular-nums;
  paint-order: stroke; stroke: var(--wx-surface); stroke-width: 4px; stroke-linejoin: round; }
.table-wrap { overflow: auto; border-top: 1px solid var(--wx-grid); }
.wide .table-wrap { height: 100%; }
.mid .table-wrap, .narrow .table-wrap { max-height: 480px; }
table { border-collapse: collapse; width: 100%; font-size: var(--wx-fs-small); line-height: 16px; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 12px; text-align: right; border-bottom: 1px solid var(--wx-grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
thead th { position: sticky; top: 0; background: var(--wx-surface); font-weight: var(--wx-w-medium); color: var(--wx-ink2); }
/* The first column stays put when the table scrolls sideways, so every row keeps its time. */
th:first-child, td:first-child { position: sticky; left: 0; z-index: 1; background: var(--wx-surface); padding-right: 16px; box-shadow: inset -1px 0 0 var(--wx-grid); }
thead th:first-child { z-index: 2; }
tr.fc td { color: var(--wx-ink2); }
`;

  class TempestStationCard extends HTMLElement {
    static getStubConfig(hass) {
      const slug = findStation(hass?.states ?? {});
      return slug ? { station: slug } : {};
    }

    static getConfigForm() {
      const labels = { station: "Station", forecast: "Forecast", name: "Place name", range: "Opens on" };
      const helpers = {
        station: "The entity slug, such as st_00012345 from sensor.st_00012345_temperature. Found automatically when left empty.",
        forecast: "A weather entity whose forecast draws the dashed lines and bars.",
        name: "Heads the left column in place of \u201cNow\u201d.",
        range: "Each viewer's last choice is remembered in their browser.",
      };
      return {
        schema: [
          { name: "station", selector: { text: {} } },
          { name: "forecast", selector: { entity: { domain: "weather" } } },
          { name: "name", selector: { text: {} } },
          { name: "range", selector: { select: { mode: "dropdown", options: RANGES.map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) })) } } },
        ],
        computeLabel: (sch) => labels[sch.name],
        computeHelper: (sch) => helpers[sch.name],
      };
    }

    setConfig(config) {
      if (!config || typeof config !== "object") throw new Error("tempest-station-card: invalid configuration");
      const before = this._config;
      this._config = { forecast: "weather.forecast_home", ...config };
      this._ents = null;
      if (before && (before.station !== this._config.station || before.forecast !== this._config.forecast || JSON.stringify(before.entities ?? null) !== JSON.stringify(this._config.entities ?? null))) {
        // Another station or forecast: nothing fetched for the old one may be shown for the new one.
        this._stats = {}; this._daily = {}; this._long = {}; this._rapid = []; this._fc = { hourly: [], daily: [] }; this._hassKey = null;
        const u = this._unsubFc; this._unsubFc = null;
        if (u) Promise.resolve(u).then((fn) => typeof fn === "function" && fn()).catch(() => {});
        if (this._hass) { this._resolve(); if (this._ents) { this._refresh(); this._subscribeForecast(); } }
      }
      if (!this._range) {
        // The viewer's last choice wins over the dashboard's default; storage can be unavailable.
        let stored = null;
        try { stored = window.localStorage.getItem(`${RANGE_KEY}:${this._config.station ?? ""}`); } catch (e) { stored = null; }
        this._range = RANGES.includes(stored) ? stored : RANGES.includes(config.range) ? config.range : "hours";
      }
      if (this._hass) { this._resolve(); this._renderAll(); }
    }

    // Home Assistant hands every card a new hass on any state change in the house. The card answers only to its
    // own entities, the forecast entity and the theme, so an unrelated light switch costs it nothing.
    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (!this._ents && (!this._resolvedAt || Date.now() - this._resolvedAt > 10e3)) { this._resolvedAt = Date.now(); this._resolve(); }
      const dark = !!hass.themes?.darkMode;
      this.classList.toggle("dark", dark);
      if (!this._ents) { if (!this._missing) { this._missing = true; this._renderMissing(); } return; }
      this._missing = false;
      if (!this.isConnected) return;
      const key = `${dark}|${Object.values(this._ents).map((id) => hass.states[id]?.last_reported ?? hass.states[id]?.last_updated ?? "").join("|")}|${hass.states[this._config.forecast]?.last_updated ?? ""}`;
      if (!first && this._mounted && key === this._hassKey) return;
      this._hassKey = key;
      this._ingestRapid();
      if (!this._unsubFc) this._subscribeForecast();
      if (first || !this._mounted) {
        this._mount();
        this._refresh();
        this._subscribeForecast();
      } else if (!this._livePending) {
        this._livePending = true;
        requestAnimationFrame(() => { this._livePending = false; this._applyLive(); });
      }
    }

    getCardSize() { return 12; }
    getGridOptions() { return { columns: "full", rows: "auto" }; }

    connectedCallback() {
      this._timer = setInterval(() => this._refresh(), REFRESH_MS);
      this._tick = setInterval(() => this._applyLive(), 5000);
      this._onResize = this._onResize ?? (() => this._layout());
      window.addEventListener("resize", this._onResize);
      if (this._hass && this._ents && !this._unsubFc) this._subscribeForecast();
    }

    disconnectedCallback() {
      clearInterval(this._timer);
      clearInterval(this._tick);
      clearTimeout(this._rz);
      window.removeEventListener("resize", this._onResize);
      this._ro?.disconnect();
      this._mounted = false;
      const u = this._unsubFc;
      this._unsubFc = null;
      if (u) Promise.resolve(u).then((f) => typeof f === "function" && f()).catch(() => {});
    }

    /* ----- entities and data ----- */

    _resolve() {
      const states = this._hass.states;
      let slug = this._config.station;
      if (!slug) slug = findStation(states);
      if (!slug) { this._ents = null; return; }
      const over = this._config.entities ?? {};
      const ents = {};
      for (const k of KEYS) ents[k] = over[k] ?? `sensor.${slug}_${k}`;
      if (!states[ents.temperature]) { this._ents = null; return; }
      this._slug = slug;
      this._ents = ents;
      this._rapid = this._rapid ?? [];
      this._stats = this._stats ?? {};
      this._daily = this._daily ?? {};
      this._fc = this._fc ?? { hourly: [], daily: [] };
    }

    _st(k) { const id = this._ents?.[k]; return id ? this._hass.states[id] : undefined; }
    _num(k) { const s = this._st(k); const v = s ? parseFloat(s.state) : NaN; return Number.isFinite(v) ? v : null; }
    _unit(k) { return this._st(k)?.attributes?.unit_of_measurement ?? ""; }

    _fmt() {
      const lang = this._hass.locale?.language ?? this._hass.language ?? "en";
      const tz = this._hass.config?.time_zone;
      const clock = this._hass.locale?.time_format, numbers = this._hass.locale?.number_format;
      const c = this._fmtCache;
      if (!c || c.lang !== lang || c.tz !== tz || c.clock !== clock || c.numbers !== numbers) this._fmtCache = new Fmt(lang, tz, clock, numbers);
      return this._fmtCache;
    }

    _ingestRapid() {
      const s = this._st("wind_speed"), d = this._st("wind_direction");
      if (!s || !d) return;
      const t = Date.parse(s.last_reported ?? s.last_updated);
      const last = this._rapid[this._rapid.length - 1];
      if (last && last.t >= t) return;
      const ms = SPEED.to(parseFloat(s.state), this._unit("wind_speed"));
      const dir = parseFloat(d.state);
      if (!Number.isFinite(ms) || !Number.isFinite(dir)) return;
      this._rapid.push({ t, ms, dir });
      const cut = Date.now() - 15 * 60e3;
      while (this._rapid.length && this._rapid[0].t < cut) this._rapid.shift();
    }

    async _refresh() {
      if (!this._hass || !this._ents || this._refreshing) return;
      this._refreshing = true;
      const now = Date.now();
      const day0 = this._fmt().startOfDay(this._fmt().startOfDay(now) - (PAST_DAYS - 1) * DAY + 12 * HOUR);
      try {
        const [short, daily] = await Promise.all([
          this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(now - PAST).toISOString(),
            end_time: new Date(now).toISOString(), statistic_ids: STAT_KEYS.map((k) => this._ents[k]), period: "5minute",
            types: ["mean", "min", "max", "change"] }),
          this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(day0).toISOString(),
            statistic_ids: LONG_KEYS.map((k) => this._ents[k]), period: "day", types: ["mean", "min", "max", "change"] }),
        ]);
        this._stats = short ?? {};
        this._daily = daily ?? {};
        this._error = null;
      } catch (e) {
        this._error = e?.message ?? String(e);
      }
      this._renderAll(true);
    }

    _subscribeForecast() {
      const entityId = this._config.forecast;
      const conn = this._hass?.connection;
      if (!entityId || !conn?.subscribeMessage || this._unsubFc || !this._hass.states[entityId]) return;
      const sub = (type) => conn.subscribeMessage((msg) => {
        const a = this._hass.states[entityId]?.attributes ?? {};
        const tu = this._unit("temperature"), su = this._unit("wind_speed") || this._unit("wind_speed_average"), ru = this._unit("precipitation");
        const temp = (v) => (v == null ? null : fromC(toC(v, a.temperature_unit ?? tu), tu));
        this._fc[type] = (msg?.forecast ?? []).map((x) => ({
          t: Date.parse(x.datetime),
          temp: temp(x.temperature), low: temp(x.templow),
          wind: x.wind_speed == null ? null : SPEED.from(SPEED.to(x.wind_speed, a.wind_speed_unit ?? su), su),
          rain: x.precipitation == null ? null : DEPTH.from(DEPTH.to(x.precipitation, a.precipitation_unit ?? ru), ru),
          rh: x.humidity ?? null,
        }));
        this._renderAll();
      }, { type: "weather/subscribe_forecast", entity_id: entityId, forecast_type: type });
      const subs = [sub("hourly"), sub("daily")];
      this._unsubFc = Promise.all(subs.map((p) => p.catch(() => null))).then((fs) => () => fs.forEach((f) => f && f()));
    }

    // 5-minute statistic points for a key, plotted at the bucket's midpoint.
    _pts(k, field = "mean") {
      const rows = this._stats[this._ents[k]] ?? [];
      const out = [];
      for (const r of rows) {
        const v = r[field];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        const start = typeof r.start === "number" ? r.start : Date.parse(r.start);
        out.push({ t: start + FIVE_MIN / 2, start, v });
      }
      return out;
    }

    _dailyRows(k) {
      return (this._daily[this._ents[k]] ?? []).map((r) => ({
        t: typeof r.start === "number" ? r.start : Date.parse(r.start), min: r.min, max: r.max, mean: r.mean, change: r.change,
      }));
    }

    /* ----- the derived model ----- */

    _model() {
      const f = this._fmt();
      const now = Date.now();
      const cfg = this._hass.config ?? {};
      const lat = cfg.latitude ?? 0, lon = cfg.longitude ?? 0;
      const sod = f.startOfDay(now);
      const m = { now, sod, lat, lon, f };
      const today = (pts) => pts.filter((p) => p.start >= sod);

      // Temperature
      const metric = this._hass.config?.unit_system?.length === "km";
      const tu = this._unit("temperature") || (metric ? "°C" : "°F");
      const t = this._num("temperature");
      const feels = this._num("feels_like");
      const tPts = this._pts("temperature");
      let lo = null, hi = null;
      for (const p of today(this._pts("temperature", "min"))) if (!lo || p.v < lo.v) lo = { v: p.v, t: p.t };
      for (const p of today(this._pts("temperature", "max"))) if (!hi || p.v > hi.v) hi = { v: p.v, t: p.t };
      if (t !== null) {
        if (!lo || t < lo.v) lo = { v: t, t: now };
        if (!hi || t > hi.v) hi = { v: t, t: now };
      }
      const firstToday = today(tPts)[0];
      const hourAgo = nearest(tPts, now - HOUR, 10 * 60e3);
      const fcToday = this._fc.daily.find((d) => f.startOfDay(d.t) === sod);
      m.temp = {
        v: t, unit: tu, feels, lo, hi,
        since: firstToday && firstToday.start - sod > 20 * 60e3 ? firstToday.start : null,
        trend: hourAgo && t !== null ? t - hourAgo.v : null,
        word: t === null ? "" : tempWord(fromC(toC(t, tu), "°F")),
      };

      // Moisture
      const dew = this._num("dew_point");
      const dewF = dew === null ? null : fromC(toC(dew, tu), "°F");
      m.moist = { rh: this._num("humidity"), dew, dewF, comfort: dewF === null ? null : comfort(dewF) };

      // Pressure, as the station reads it
      const pu = this._unit("air_pressure") || "hPa";
      const p = this._num("air_pressure");
      const pPts = this._pts("air_pressure");
      const ago3 = nearest(pPts, now - 3 * HOUR, 10 * 60e3);
      m.pres = { v: p, unit: pu, have: pPts.length ? now - pPts[0].start : 0 };
      if (p !== null && ago3) {
        const dH = PRES.to(p, pu) - PRES.to(ago3.v, pu);
        m.pres.tend = { ...tendency(dH), dHpa: dH };
      }

      // Wind
      const su = this._unit("wind_speed") || (metric ? "km/h" : "mph");
      const ws = this._num("wind_speed"), wd = this._num("wind_direction");
      const recent = this._rapid.filter((r) => r.t >= now - 10 * 60e3);
      m.wind = {
        v: ws, unit: su, dir: wd, card: wd === null ? "" : CARD16[sector16(wd)],
        bf: ws === null ? null : beaufort(SPEED.to(ws, su)),
        avg: this._num("wind_speed_average"), gust: this._num("wind_gust"), lull: this._num("wind_lull"),
      };
      // Where the wind has come from over the last 10 minutes of 3-second samples: a smoothed share per 5° of rim.
      // Each sample lights its own 5° and, more faintly, the 10° either side; nothing lights where no sample came from.
      const dirs = recent.filter((r) => r.ms >= 0.3).map((r) => norm360(r.dir));
      if (dirs.length >= 4) {
        const bins = new Array(RING).fill(0);
        for (const d of dirs) for (let k = -2; k <= 2; k++) bins[(Math.floor(d / (360 / RING)) + k + RING) % RING] += [0.25, 0.6, 1, 0.6, 0.25][k + 2];
        const top = Math.max(...bins);
        m.wind.ring = bins.map((b) => b / top);
      }
      // 24 h rose from the recorder's 5-minute mean direction and mean speed. (The recorder averages a plain
      // direction sensor arithmetically; a station whose direction has the measurement_angle state class gets a true circular mean.)
      const dPts = this._pts("wind_direction"), sPts = this._pts("wind_speed");
      const rose = Array.from({ length: 16 }, () => ({ n: 0 }));
      let calm = 0, total = 0;
      for (const dp of dPts) {
        const sp = nearest(sPts, dp.t, 60e3);
        if (!sp) continue;
        total++;
        if (SPEED.to(sp.v, su) < 0.3) { calm++; continue; }
        const r = rose[sector16(dp.v)];
        r.n++; r.sum += sp.v;
      }
      m.wind.rose = rose.map((r, i) => ({ dir: CARD16[i], share: total ? r.n / total : 0 }));
      m.wind.roseSpan = dPts.length ? now - dPts[0].start : 0;

      // Sun and light
      const el = sunElevation(now, lat, lon);
      if (this._sunDay?.sod !== sod || this._sunDay.lat !== lat || this._sunDay.lon !== lon) this._sunDay = { sod, lat, lon, st: sunTimes(sod, lat, lon) };
      const st = this._sunDay.st;
      const uv = this._num("uv_index");
      const irr = this._num("irradiance");
      m.sun = {
        el, irr, uv, uvs: uv === null ? null : uvScale(uv),
        rise: st.rise, set: st.set,
        // Below 10° the clear-sky model and the sensor's cosine response both get unreliable.
        pct: irr !== null && el > 10 && clearSky(el) > 0 ? irr / clearSky(el) : null,
        kwh: today(this._pts("irradiance")).length ? today(this._pts("irradiance")).reduce((a, p2) => a + (p2.v * FIVE_MIN) / HOUR / 1000, 0) : null,
      };
      if (st.rise && now < st.rise) m.sun.next = { word: "Rises", t: st.rise };
      else if (st.set && now < st.set) m.sun.next = { word: "Sets", t: st.set };
      else { const tm = sunTimes(sod + DAY, lat, lon); m.sun.next = tm.rise ? { word: "Rises", t: tm.rise } : null; }

      // Rain
      const ru = this._unit("precipitation") || (metric ? "mm" : "in");
      const iu = this._unit("precipitation_intensity") || (metric ? "mm/h" : "in/h");
      const rate = this._num("precipitation_intensity");
      const rChanges = this._pts("precipitation", "change");
      const ptype = this._st("precipitation_type")?.state;
      m.rain = {
        today: rChanges.length ? today(rChanges).reduce((a, p2) => a + Math.max(0, p2.v), 0) : null,
        unit: ru, rate, rateUnit: iu, rs: rate === null ? null : rainRate(DEPTH.to(rate, iu)),
        type: ({ rain: "rain", hail: "hail", rain_hail: "rain and hail", sleet: "sleet", snow: "snow" })[ptype] ?? null,
      };

      // Lightning
      const lChanges = this._pts("lightning_count", "change");
      const lSum = (since) => lChanges.filter((p2) => p2.start >= since).reduce((a, p2) => a + Math.max(0, p2.v), 0);
      const lastStrike = Date.parse(this._st("lightning_last_strike")?.state ?? "");
      const du = this._unit("lightning_last_distance") || (metric ? "km" : "mi");
      const ld = this._num("lightning_last_distance");
      m.bolt = {
        h24: lSum(now - PAST),
        last: Number.isFinite(lastStrike) ? lastStrike : null, dist: ld, distUnit: du,
        distMi: ld === null ? null : DIST.to(ld, du) / 1.609344,
      };
      m.bolt.near = !!(m.bolt.last && now - m.bolt.last < 30 * 60e3 && m.bolt.distMi !== null && m.bolt.distMi <= STRIKE_MI);
      m.bolt.recent = !!(m.bolt.last && now - m.bolt.last < PAST);

      // Station: the newest update across every sensor is the station's last report.
      let obs = null;
      for (const k of KEYS) {
        const s = this._st(k);
        if (!s) continue;
        const t2 = Math.max(Date.parse(s.last_updated) || 0, Date.parse(s.last_reported ?? "") || 0);
        if (t2 && (obs === null || t2 > obs)) obs = t2;
      }
      const bv = this._num("battery_voltage");
      m.station = { bv, mode: bv === null ? null : powerMode(bv), obs };

      m.lede = this._lede(m);
      return m;
    }

    // One short paragraph that says what it is like outside, the way a person would: the feel of the air first,
    // placed in the day ("cool, dry and still tonight"), then the wind, the pressure and the rain. Nothing here
    // repeats an alert or a scale beneath it; the sun's next moment belongs to the Sun instrument.
    _lede(m) {
      const f = m.f, out = [];
      const ws = m.wind.avg ?? m.wind.v, wd = this._num("wind_direction_average") ?? m.wind.dir;
      const bf = ws === null ? null : beaufort(SPEED.to(ws, m.wind.unit));
      const raining = !!(m.rain.rs && m.rain.rs.i > 0);
      if (m.temp.v !== null) {
        const h = f.parts(m.now).hour;
        const when = h < 5 ? "tonight" : h < 12 ? "this morning" : h < 17 ? "this afternoon" : h < 21 ? "this evening" : "tonight";
        // The comfort word is about the air's moisture; in rain it would read as a contradiction.
        const adj = [m.temp.word.toLowerCase(), !raining && m.moist.comfort ? ["dry", "sticky", "oppressive"][m.moist.comfort.i] : null, bf && bf.i === 0 ? "still" : null].filter(Boolean);
        const feel = adj.length > 1 ? `${adj.slice(0, -1).join(", ")} and ${adj[adj.length - 1]}` : adj[0];
        const tr = m.temp.trend;
        const trend = tr !== null && Math.abs(tr) >= 1 ? `, ${tr < 0 ? "cooling" : "warming"} ${f.num(Math.abs(tr), 1)}° an hour` : "";
        out.push(`${feel[0].toUpperCase()}${feel.slice(1)} ${when}${trend}.`);
      }
      if (bf && bf.i > 0) out.push(wd === null ? `${bf.word}.` : `${bf.word} from the ${CARD16_WORDS[sector16(wd)]}.`);
      else if (bf && m.temp.v === null) out.push("Calm.");
      if (m.pres.tend && m.pres.tend.i !== 4) out.push(`Pressure ${m.pres.tend.word.toLowerCase()}.`);
      const dp = m.rain.unit === "in" ? 2 : 1;
      if (raining) out.push(`${m.rain.rs.word} ${m.rain.type ?? "rain"} now.`);
      else if (m.rain.today > 0) {
        const amt = f.num(m.rain.today, dp), word = DEPTH_WORDS[m.rain.unit]?.[Number(amt) === 1 ? 0 : 1] ?? m.rain.unit;
        out.push(`${amt}${NB}${word} of rain today.`);
      }
      else if (m.rain.today === 0) out.push("No rain today.");
      return out.join(" ");
    }

    /* ----- shell and layout ----- */

    _renderMissing() {
      this._mountShell();
      this._body.innerHTML = `<section class="card"><h2>Weather station</h2><p class="small">No Tempest station found.
        Set <code>station:</code> to the entity slug, for example <code>st_00012345</code> from
        <code>sensor.st_00012345_temperature</code>.</p></section>`;
    }

    _mountShell() {
      if (this._root) return;
      this._root = this.attachShadow({ mode: "open" });
      this._root.innerHTML = `<style>${STYLE}</style><div class="wrap"></div>`;
      this._body = this._root.querySelector(".wrap");
      this._root.addEventListener("click", (e) => {
        const range = e.target.closest?.("[data-range]");
        if (range) {
          if (range.dataset.range === this._range) return;
          this._range = range.dataset.range;
          try { window.localStorage.setItem(`${RANGE_KEY}:${this._config.station ?? ""}`, this._range); } catch (err) { /* not remembered */ }
          this._mgT = null;
          this._swapMeteogram();
          return;
        }
        if (e.target.closest?.("[data-table]")) { this._table = !this._table; this._swapMeteogram(); }
        if (e.target.closest?.("[data-csv]")) this._downloadCsv();
      });
      const away = () => { if (this._mgHold === "pointer") { this._mgHold = null; this._mgShow(null); } };
      this._root.addEventListener("pointermove", (e) => { if (!e.target.closest?.(".mg")) away(); });
      this.addEventListener("pointerleave", away);
    }

    _mount() {
      this._mountShell();
      this._mounted = true;
      this._ro?.disconnect();
      this._ro = new ResizeObserver(() => this._layout());
      this._ro.observe(this);
      this._layout(true);
    }

    // Wide: one screen, two columns cut to the window's height below the card's top. Narrower: stacked, scrolling.
    _layout(force = false) {
      if (!this._mounted || !this._body) return;
      const w = this.clientWidth || this._body.clientWidth;
      const mode = w >= 1000 ? "wide" : w >= 640 ? "mid" : "narrow";
      let avail = 0;
      if (mode === "wide") avail = Math.max(540, Math.floor(window.innerHeight - Math.max(0, this.getBoundingClientRect().top)));
      const tight = mode === "wide" && avail < 700;
      const dialPref = mode === "wide" ? Math.round(Math.max(128, Math.min(176, 128 + (avail - 660) * 0.3))) : mode === "mid" ? 184 : 168;
      const changed = force || mode !== this._mode || tight !== this._tight || dialPref !== this._dialPref;
      if (changed) this._ledeW = 0;
      this._mode = mode; this._tight = tight; this._dialPref = dialPref;
      this._body.className = `wrap ${mode}${tight ? " tight" : ""}${this._body.classList.contains("arrive") ? " arrive" : ""}`;
      this._body.style.setProperty("--wx-h", mode === "wide" ? `${avail}px` : "auto");
      if (changed) this._renderAll();
      else { clearTimeout(this._rz); this._rz = setTimeout(() => this._drawCharts(), 60); }
    }

    _renderAll(fade = false) {
      if (!this._mounted || !this._ents) return;
      const m = this._model();
      this._m = m;
      this._bandsKey = this._keyOf(m);
      this._mgFocus = this._mgFocus || !!this._root.activeElement?.classList?.contains("mg");
      const ghost = fade ? this._ghost(this._root.querySelector("[data-mg]")) : null;
      this._redrawing = true;
      this._body.innerHTML = this._nowCol(m) + this._timeCol(m);
      this._redrawing = false;
      this._body.classList.remove("dense");
      this._reserveLede();
      const col = this._root.querySelector(".col-now");
      if (this._mode === "wide" && col && col.scrollHeight > col.clientHeight) { this._body.classList.add("dense"); this._reserveLede(); }
      this._needleAngle = undefined;
      this._drawCharts();
      this._settle(this._root.querySelector("[data-mg]"), ghost);
      this._applyLive(m);
      this._ensureLong(this._range);
    }

    _drawCharts() { this._fitDial(); this._drawSun(); this._drawMeteogram(); }

    // A new range, or the table: only the chart changes, and it crossfades. The rest of the page, and the button
    // that was pressed, are left alone.
    _swapMeteogram() {
      const host = this._root?.querySelector("[data-mg]");
      if (!host || !this._m) { this._renderAll(); return; }
      this._syncControls();
      const ghost = this._ghost(host);
      this._drawMeteogram();
      this._settle(host, ghost);
      this._ensureLong(this._range);
    }

    _syncControls() {
      const ctl = this._root.querySelector(".head-r");
      if (!ctl) return;
      ctl.querySelectorAll("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === this._range)));
      const tb = ctl.querySelector("[data-table]"), csv = ctl.querySelector("[data-csv]");
      if (tb) { tb.setAttribute("aria-pressed", String(!!this._table)); tb.textContent = this._table ? "Chart" : "Table"; }
      if (this._table && !csv) tb?.insertAdjacentHTML("afterend", CSV_BTN);
      else if (!this._table && csv) csv.remove();
    }

    _motion() { return !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; }

    // The chart about to be replaced, lifted out of its host so it can fade over the new one.
    _ghost(host) {
      if (!host?.firstElementChild || !this._motion()) return null;
      host.querySelector(":scope > .mg-ghost")?.remove();
      const g = document.createElement("div");
      g.className = "mg-ghost";
      g.setAttribute("aria-hidden", "true");
      g.inert = true;
      g.append(...host.childNodes);
      g.querySelectorAll("[tabindex]").forEach((el) => el.removeAttribute("tabindex"));
      return g;
    }

    _settle(host, ghost) {
      if (!host || !ghost) return;
      host.appendChild(ghost);
      host.classList.add("swap");
      clearTimeout(this._swapT);
      this._swapT = setTimeout(() => { ghost.remove(); host.classList.remove("swap"); }, 300);
    }

    // A figure that changes crossfades: the old digits stay in a ghost that fades as the new ones darken.
    _swapText(el, text) {
      if (!el || el.textContent === text) return;
      const old = el.textContent;
      el.textContent = text;
      if (!old || !this._motion()) return;
      el.dataset.old = old;
      el.classList.remove("xf");
      void el.offsetWidth;
      el.classList.add("xf");
      clearTimeout(el._xf);
      el._xf = setTimeout(() => { el.classList.remove("xf"); delete el.dataset.old; }, 260);
    }

    // The sentence's box is always as tall as the longest sentence the card can write at this width, so a change of
    // wording, however large, never moves what sits below it.
    _reserveLede() {
      const lede = this._root?.querySelector('[data-k="lede"]');
      if (!lede?.clientWidth) return;
      if (this._body.classList.contains("dense")) { lede.style.minHeight = ""; return; }
      if (lede.clientWidth !== this._ledeW) {
        const probe = lede.cloneNode(false);
        probe.removeAttribute("data-k");
        probe.style.cssText = `position:absolute;visibility:hidden;min-height:0;width:${lede.clientWidth}px`;
        probe.textContent = LEDE_LONGEST;
        lede.parentNode.appendChild(probe);
        this._ledeW = lede.clientWidth; this._ledeH = probe.offsetHeight;
        probe.remove();
      }
      lede.style.minHeight = `${this._ledeH}px`;
    }

    _tileW() { return this._mode === "narrow" ? 0 : this._tight ? 168 : 184; }

    // Whose forecast it is, for the credit its licence asks for: MET Norway by name, else the provider's own short line.
    _fcCredit() {
      const a = String(this._hass?.states?.[this._config.forecast]?.attributes?.attribution ?? "");
      return /met\.no|norwegian meteorological/i.test(a) ? "MET Norway" : a.length <= 28 ? a : "";
    }

    // The dial fills its band: as tall as the row the two cards share, never wider than the tile column under it.
    _fitDial() {
      const dial = this._root?.querySelector(".dial"), row = dial?.closest(".figs2");
      if (!dial || !row || this._mode === "narrow" || !this._m) return;
      const cs = getComputedStyle(row);
      const h = row.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const D = Math.floor(Math.max(96, Math.min(this._tileW() - 16, h)));
      if (D === this._dialSize) return;
      this._dialSize = D;
      dial.style.width = dial.style.height = `${D}px`;
      dial.innerHTML = this._dialSvg(this._m, D);
      this._needleAngle = undefined;
      this._applyLive(this._m);
    }

    // Live wind crosses a Beaufort edge every few seconds on a light day: a band change redraws the Now column
    // alone, so the charts, and anyone reading them, are left where they are.
    _renderNow(m) {
      const col = this._root.querySelector(".col-now");
      if (!col) { this._renderAll(); return; }
      this._bandsKey = this._keyOf(m);
      const before = col.querySelector(".top")?.offsetHeight;
      col.outerHTML = this._nowCol(m);
      this._body.classList.remove("dense");
      this._reserveLede();
      const now = this._root.querySelector(".col-now");
      if (this._mode === "wide" && now && now.scrollHeight > now.clientHeight) { this._body.classList.add("dense"); this._reserveLede(); }
      this._applyLive(m);
      if (now?.querySelector(".top")?.offsetHeight !== before) this._drawCharts();
    }

    // Which band each scale is in, plus the alerts; a change redraws the Now column.
    _keyOf(m) {
      return [m.wind.bf?.i, m.pres.tend?.i, m.moist.comfort?.i, m.sun.uvs?.i, m.rain.rs?.i, m.bolt.near,
        Math.floor((m.station.mode ?? 0) * 2), this._stale(m)].join("|");
    }
    _stale(m) { return m.station.obs !== null && m.now - m.station.obs > 3 * 60e3; }

    /* ----- the now column ----- */

    // Scale: one continuous track. Only the band in force takes the measure's colour, notches mark the named groups,
    // the poles say what the track spans, and the verdict above is the one place the band is named.
    _scale(id, { label, verdict, value, bands, active, pos, poles = [], notches = [], fill, aria }) {
      const widths = bands ? bands.map((b) => b.w) : [1];
      const starts = widths.map((_, i) => widths.slice(0, i).reduce((x, y) => x + y, 0));
      const at = (i, frac) => `${((starts[i] + frac * widths[i]) * 100).toFixed(3)}%`;
      const on = bands && active >= 0 && bands[active].color ? `<i class="sc-on" style="left:${at(active, 0)};width:${(widths[active] * 100).toFixed(3)}%;background:${bands[active].color}"></i>` : "";
      const fillEl = fill ? `<i class="sc-on" style="left:${at(0, fill.from)};width:${((fill.to - fill.from) * 100).toFixed(3)}%;background:${fill.color}"></i>` : "";
      const cuts = notches.map((i) => `<i class="sc-notch" style="left:${at(i, 0)}"></i>`).join("");
      const mark = pos ? `<i class="sc-mark" data-pos="${id}" style="left:${at(pos.i, pos.f)}"></i>` : "";
      this._scaleGeom = this._scaleGeom ?? {};
      this._scaleGeom[id] = at;
      return `<div class="scale" role="img" aria-label="${esc(aria)}">
        <div class="sc-head"><span class="small">${esc(label)}</span><span class="sc-read"><b data-k="${id}-v">${esc(verdict)}</b>${value ? ` <span data-k="${id}-n">${esc(value)}</span>` : ""}</span></div>
        <div class="sc-track">${on}${fillEl}${cuts}${mark}</div>
        ${poles.length ? `<div class="sc-labels"><span>${esc(poles[0])}</span><span>${esc(poles[1] ?? "")}</span></div>` : ""}</div>`;
    }

    _alerts(m) {
      const f = m.f, out = [];
      const row = (color, text) => `<div class="alert"><i style="background:var(${color})"></i><span>${text}</span></div>`;
      if (m.bolt.near) out.push(row("--wx-critical", `<b>Lightning ${esc(f.num(m.bolt.dist))}${NB}${esc(m.bolt.distUnit)} away</b>, ${esc(f.ago(m.now - m.bolt.last))}. Within ${m.bolt.distUnit === "km" ? `16${NB}km` : `${STRIKE_MI}${NB}mi`} is striking distance: go indoors.`));
      if (this._stale(m)) out.push(row("--wx-warn", `<b>No report from the station</b> for ${esc(f.dur(m.now - m.station.obs))}.`));
      if (m.station.mode !== null && m.station.mode >= 1) {
        const p = POWER[Math.floor(m.station.mode)];
        out.push(row("--wx-warn", `<b>Battery ${esc(f.num(m.station.bv, 2))}${NB}V</b>: the station is in ${esc(p.label)}, ${esc(p.detail)}.`));
      }
      if (this._error) out.push(row("--wx-warn", `<b title="${esc(this._error)}">History unavailable.</b> The recorder's statistics could not be read; live readings still work.`));
      return out.join("");
    }

    _nowCol(m) {
      const f = m.f, T = m.temp;
      // Feels-like sits beside the reading, and only when wind chill or heat index makes it differ.
      const feels = T.feels === null || T.v === null || Math.abs(T.feels - T.v) < 0.3 ? ""
        : `<div class="feels">Feels like <b data-k="feels">${esc(f.num(T.feels, 1))}°</b><div class="small">${T.feels < T.v ? "wind chill" : "heat index"}</div></div>`;
      const [today, ...scales] = this._shelf(m);
      return `<section class="card col-now">
        <div class="top">
          <div class="head"><h2>${esc(this._config.name || "Now")}</h2><span class="meta" data-k="clock"></span>
            <span class="status" data-k="live-cls"><i></i><span data-k="live"></span></span></div>
          <div class="hero-row"><div class="hero"><span data-k="t">${esc(f.num(T.v, 1))}</span><span class="u">${esc(T.unit)}</span></div>${feels}</div>
          ${today}</div>
        <div class="body">
          <div class="alerts" data-k="alerts">${this._alerts(m)}</div>
          <p class="lede" data-k="lede">${esc(m.lede)}</p>
          <div class="scales">${scales.join("")}</div></div></section>`;
    }

    // Six scales: temperature and comfort, wind and pressure, UV and rain.
    _shelf(m) {
      const f = m.f, T = m.temp, out = [];
      const equal = (n, color) => Array.from({ length: n }, () => ({ w: 1 / n, color }));

      // Today: the observed range as the fill, now as the mark; the poles say when the low and high came.
      if (T.lo && T.hi) {
        const pad = Math.max(1, (T.hi.v - T.lo.v) * 0.12);
        const d0 = T.lo.v - pad, d1 = T.hi.v + pad;
        const fr = (v) => clamp01((v - d0) / (d1 - d0));
        out.push(this._scale("today", {
          label: T.since ? `Since ${f.time(T.since)}` : "Today",
          verdict: `${span2(f.num(T.lo.v, 1), f.num(T.hi.v, 1))}°`,
          fill: { from: fr(T.lo.v), to: fr(T.hi.v), color: "var(--wx-temp)" },
          pos: T.v === null ? null : { i: 0, f: fr(T.v) },
          poles: T.lo.t === T.hi.t ? [] : [`Low ${f.time(T.lo.t)}`, `High ${f.time(T.hi.t)}`],
          aria: `Today ${f.num(T.lo.v, 1)} to ${f.num(T.hi.v, 1)} degrees`,
        }));
      } else out.push(this._scale("today", { label: "Today", verdict: "—", aria: "No temperature yet today" }));

      const C = m.moist.comfort;
      out.push(this._scale("comfort", {
        label: "Dew point", verdict: C ? C.word : "—", value: C ? `${f.num(m.moist.dew, 1)}°` : "",
        bands: [20 / 45, 10 / 45, 15 / 45].map((x) => ({ w: x, color: "var(--wx-dew)" })), active: C ? C.i : -1, pos: C ? { i: C.i, f: C.f } : null,
        notches: [1, 2], poles: ["Dry", "Oppressive"],
        aria: C ? `Comfort ${C.word}, dew point ${f.num(m.moist.dew, 1)} degrees, on a scale from dry through sticky to oppressive` : "No dew point",
      }));

      const bf = m.wind.bf;
      out.push(this._scale("bf", {
        label: "Beaufort force", verdict: bf ? bf.word : "—", value: bf ? `force ${bf.i}` : "",
        bands: equal(13, "var(--wx-wind)"), active: bf ? bf.i : -1, pos: bf ? { i: bf.i, f: bf.f } : null,
        notches: [1, 7, 10], poles: ["Calm", "Hurricane"],
        aria: bf ? `Beaufort force ${bf.i} of 12, ${bf.word}` : "No wind reading",
      }));

      const P = m.pres, t = P.tend;
      out.push(this._scale("tend", {
        label: `Pressure, last 3${NB}h`, verdict: t ? t.word : "Collecting", value: t ? tendIn(f, t.dHpa, P.unit).text : P.have >= 60e3 ? f.dur(P.have) : "",
        bands: equal(9, "var(--wx-pres)"), active: t ? t.i : -1, pos: t ? { i: t.i, f: t.f } : null,
        notches: [4, 5], poles: ["Falling", "Rising"],
        aria: t ? `Pressure ${t.word.toLowerCase()}, ${tendIn(f, t.dHpa, P.unit).text.split(NB)[0]} ${tendIn(f, t.dHpa, P.unit).words} in 3 hours` : "Pressure tendency needs 3 hours of data",
      }));

      const U = m.sun.uvs;
      out.push(this._scale("uv", {
        label: "UV index", verdict: U ? U.word : "—", value: U ? f.num(m.sun.uv, 1) : "",
        bands: UV_BANDS.map((b, i) => ({ w: (UV_EDGES[i + 1] - UV_EDGES[i]) / 14, color: b.color })), active: U ? U.i : -1, pos: U ? { i: U.i, f: U.f } : null,
        notches: [1, 2, 3, 4], poles: ["Low", "Extreme"],
        aria: U ? `UV index ${f.num(m.sun.uv, 1)}, ${U.word}, on the WHO scale from low to extreme` : "No UV reading",
      }));

      // No rain is not a rain colour: the "None" band takes no fill.
      const Rr = m.rain.rs, dp = m.rain.unit === "in" ? 2 : 1;
      out.push(this._scale("rate", {
        label: "Rain now", verdict: Rr ? (Rr.i ? `${Rr.word} ${m.rain.type ?? "rain"}` : "None") : "—", value: Rr ? `${f.num(m.rain.rate, dp)}${NB}${m.rain.rateUnit}` : "",
        bands: [{ w: 0.25, color: null }, ...equal(3, "var(--wx-rain)").map((b) => ({ ...b, w: 0.25 }))], active: Rr ? Rr.i : -1, pos: Rr ? { i: Rr.i, f: Rr.f } : null,
        notches: [1, 2, 3], poles: ["None", "Heavy"],
        aria: Rr ? `Rain now ${Rr.word}, ${f.num(m.rain.rate, dp)} ${m.rain.rateUnit}, on a scale from none to heavy` : "No rain reading",
      }));
      return out;
    }

    /* ----- the time column ----- */

    _timeCol(m) {
      const f = m.f, W = m.wind, D = this._mode === "narrow" ? this._dialPref : Math.min(this._tileW() - 16, this._dialPref);
      this._dialSize = D;
      const wind = `<div class="zone inst wind">
          <div class="dial" style="width:${D}px;height:${D}px">${this._dialSvg(m, D)}</div>
          <div class="txt"><h2>Wind</h2>
            <div class="read"><span data-k="ws">${esc(f.num(W.v, 1))}</span><span class="unit">${esc(W.unit)}</span></div>
            <div>From <b data-k="wfrom">${esc(W.card)}</b> <span class="small" data-k="wdeg">${esc(f.num(W.dir))}°</span></div>
            <div class="small" data-k="gustlull"></div>
            <div class="small cap" data-k="rosecap"></div></div></div>`;
      const sun = `<div class="zone inst sun">
          <div class="sunfig" data-sun></div>
          <div class="txt"><h2>Sun</h2>
            <div class="read"><span data-k="irr">${esc(f.num(m.sun.irr))}</span><span class="unit">W/m²</span></div>
            <div data-k="sunline1"></div>
            <div class="small" data-k="sunenergy"></div>
            <div class="small" data-k="sunline2"></div>
            <div class="small" data-k="daylen"></div></div></div>`;
      return `<section class="card col-time"><div class="figs2">${wind}${sun}</div>
        <div class="hist"><div class="head mg-head"><h2 data-k="mgtitle"></h2>
          <div class="head-r">
            <span class="seg" role="group" aria-label="Time range">${RANGES.map((r) => `<button data-range="${r}" aria-pressed="${this._range === r}">${r[0].toUpperCase()}${r.slice(1)}</button>`).join("")}</span>
            <button class="tbtn" data-table aria-pressed="${!!this._table}">${this._table ? "Chart" : "Table"}</button>${this._table ? CSV_BTN : ""}</div></div>
        <div class="mg-body" data-mg></div></div></section>`;
    }

    _dialSvg(m, S) {
      const c = S / 2, R = c - 22, r0 = Math.max(12, Math.round(S * 0.09)), rm = (R - 8 + r0 + 4) / 2;
      const maxShare = Math.max(0.0001, ...m.wind.rose.map((p) => p.share));
      const petals = m.wind.rose.map((p, i) => {
        if (!(p.share > 0)) return "";
        const len = r0 + 4 + (R - 8 - r0 - 4) * (p.share / maxShare);
        const a0 = (i * 22.5 - 11.25 + 1.8) * RAD, a1 = (i * 22.5 + 11.25 - 1.8) * RAD;
        const pt = (a, r) => `${(c + r * Math.sin(a)).toFixed(1)},${(c - r * Math.cos(a)).toFixed(1)}`;
        return `<path d="M${pt(a0, r0 + 4)}L${pt(a0, len)}A${len},${len} 0 0 1 ${pt(a1, len)}L${pt(a1, r0 + 4)}A${r0 + 4},${r0 + 4} 0 0 0 ${pt(a0, r0 + 4)}Z" fill="var(--wx-wind)" fill-opacity="0.3" stroke="var(--wx-wind)" stroke-width="1" stroke-linejoin="round"/>`;
      }).join("");
      // The recent-wind ring: 72 segments just inside the rim, lit by where the wind came from in the last 10 minutes.
      const Rr = R - 5, step = 360 / RING;
      const ring = Array.from({ length: RING }, (_, i) => {
        const pt = (a) => `${(c + Rr * Math.sin(a * RAD)).toFixed(1)},${(c - Rr * Math.cos(a * RAD)).toFixed(1)}`;
        return `<path data-ring d="M${pt(i * step)}A${Rr},${Rr} 0 0 1 ${pt((i + 1) * step)}" fill="none" stroke="var(--wx-wind)" stroke-width="4" style="stroke-opacity:0"/>`;
      }).join("");
      const ticks = Array.from({ length: 16 }, (_, i) => {
        const a = i * 22.5 * RAD, major = i % 4 === 0, mid = i % 2 === 0 && !major;
        const r1 = R + (major ? 6 : mid ? 4 : 3);
        return `<line x1="${(c + R * Math.sin(a)).toFixed(1)}" y1="${(c - R * Math.cos(a)).toFixed(1)}" x2="${(c + r1 * Math.sin(a)).toFixed(1)}" y2="${(c - r1 * Math.cos(a)).toFixed(1)}" stroke="var(--wx-${major ? "ink2" : "axis"})" stroke-width="1"/>`;
      }).join("");
      const labels = ["N", "E", "S", "W"].map((l, i) => {
        const a = i * 90 * RAD, rr = R + 17;
        return `<text x="${(c + rr * Math.sin(a)).toFixed(1)}" y="${(c - rr * Math.cos(a) + 4).toFixed(1)}" text-anchor="middle" class="tick" style="font-weight:500">${l}</text>`;
      }).join("");
      // The needle: a wedge outside the rim at the bearing the wind comes from, its shaft running from the rim's inner edge
      // to the hub; a thinner red shaft carries on to the middle ring, and an arrowhead just beyond it points where the wind goes.
      const needle = `<g class="needle" data-needle style="transform-origin:${c}px ${c}px">
          <path d="M${c},${c - R - 1}L${c - 6},${c - R - 11}L${c + 6},${c - R - 11}Z" fill="var(--wx-ink)" stroke="var(--wx-surface)" stroke-width="1.5" stroke-linejoin="round"/>
          <line x1="${c}" y1="${c - R + 1}" x2="${c}" y2="${c - r0}" stroke="var(--wx-ink)" stroke-width="2" stroke-linecap="round"/>
          <line x1="${c}" y1="${c + r0}" x2="${c}" y2="${(c + rm - 1).toFixed(1)}" stroke="var(--wx-downwind)" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M${c},${(c + rm + 11).toFixed(1)}L${c - 5},${(c + rm + 1).toFixed(1)}L${c + 5},${(c + rm + 1).toFixed(1)}Z" fill="var(--wx-downwind)" stroke="var(--wx-surface)" stroke-width="1.5" stroke-linejoin="round"/></g>`;
      return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img" aria-label="Wind from ${esc(m.wind.card)}, blowing toward ${esc(m.wind.dir === null ? "" : CARD16[(sector16(m.wind.dir) + 8) % 16])}; rose of the last 24 hours">
        <title>Black end: where the wind is coming from. Red arrow: where it is blowing. Ring: where it came from over the last 10 minutes. Petals: over the last 24 hours.</title>
        <circle cx="${c}" cy="${c}" r="${R}" fill="none" stroke="var(--wx-axis)"/>
        <circle cx="${c}" cy="${c}" r="${rm.toFixed(1)}" fill="none" stroke="var(--wx-grid)"/>
        ${petals}
        <g>${ring}</g>
        ${ticks}${labels}${needle}
        <circle cx="${c}" cy="${c}" r="${r0}" fill="var(--wx-surface)" stroke="var(--wx-grid)"/></svg>`;
    }

    // Today's sunlight on one W/m² axis: the clear-sky potential as a dashed bell (the sun's path, as energy),
    // what the station measured filled beneath it, so cloud reads as a bite out of the bell. Sunrise to sunset, an hour each side.
    _drawSun() {
      const host = this._root?.querySelector("[data-sun]");
      if (!host || !this._m) return;
      const m = this._m, f = m.f;
      const W = Math.max(140, host.clientWidth), H = Math.max(80, host.clientHeight), padX = 2, padT = 8, padB = 20;
      const a = m.sun.rise ? m.sun.rise - HOUR : m.sod, b = m.sun.set ? m.sun.set + HOUR : m.sod + DAY;
      const cs = [];
      for (let t = a; t <= b; t += 600e3) cs.push({ t, v: clearSky(sunElevation(t, m.lat, m.lon)) });
      const meas = this._pts("irradiance").filter((p) => p.t >= a && p.t <= b && p.start >= m.sod)
        .concat(m.sun.irr !== null && m.now >= a && m.now <= b ? [{ t: m.now, v: m.sun.irr }] : []);
      const top = Math.max(100, ...cs.map((p) => p.v), ...meas.map((p) => p.v)) * 1.08;
      const sx = (t) => padX + ((t - a) / (b - a)) * (W - 2 * padX);
      const sy = (v) => padT + (1 - v / top) * (H - padT - padB);
      const base = sy(0);
      let g = "";
      if (meas.length > 1) g += `<path d="${areaPath(meas, sx, sy, base, 16 * 60e3)}" fill="var(--wx-sun)" fill-opacity="0.18"/>
        <path d="${linePath(meas, sx, sy, 16 * 60e3)}" fill="none" stroke="var(--wx-sun)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      g += `<path d="${linePath(cs, sx, sy, HOUR)}" fill="none" stroke="var(--wx-muted)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
      // The dashed bell names itself on the flank away from now, just outside the curve, where nothing else is drawn.
      const peak = cs.reduce((p, q) => (q.v > p.v ? q : p), cs[0]);
      if (peak && peak.v > 0) {
        const nowIn = m.now >= a && m.now <= b, prefer = nowIn && m.now > peak.t ? ["morning", "afternoon"] : ["afternoon", "morning"];
        const spot = (side) => {
          const at = side === "morning" ? cs.filter((p) => p.t < peak.t && p.v <= peak.v * 0.72).pop() : cs.find((p) => p.t > peak.t && p.v <= peak.v * 0.72);
          if (!at) return null;
          const x = sx(at.t) + (side === "morning" ? -6 : 6);
          return (side === "morning" ? x - 52 >= 0 : x + 52 <= W) ? { x, y: sy(at.v), anchor: side === "morning" ? "end" : "start" } : null;
        };
        const crest = !nowIn || Math.abs(sx(m.now) - sx(peak.t)) >= 32 ? { x: sx(peak.t), y: sy(peak.v) - 5, anchor: "middle" } : null;
        const lab = spot(prefer[0]) ?? spot(prefer[1]) ?? crest;
        if (lab) g += `<text x="${lab.x.toFixed(1)}" y="${lab.y.toFixed(1)}" text-anchor="${lab.anchor}" class="tick">clear sky</text>`;
      }
      g += `<line x1="0" x2="${W}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" stroke="var(--wx-axis)"/>`;
      for (const t of [m.sun.rise, m.sun.set]) {
        if (!t) continue;
        g += `<line x1="${sx(t).toFixed(1)}" x2="${sx(t).toFixed(1)}" y1="${(base - 3).toFixed(1)}" y2="${(base + 3).toFixed(1)}" stroke="var(--wx-ink2)"/>
          <text x="${sx(t).toFixed(1)}" y="${(H - 3).toFixed(1)}" text-anchor="middle" class="tick">${esc(f.time(t))}</text>`;
      }
      if (m.now >= a && m.now <= b) {
        const nx = sx(m.now).toFixed(1);
        g += `<line x1="${nx}" x2="${nx}" y1="${padT}" y2="${base.toFixed(1)}" stroke="var(--wx-axis)"/>`;
        if (m.sun.irr !== null) g += `<circle cx="${nx}" cy="${sy(m.sun.irr).toFixed(1)}" r="4" fill="var(--wx-sun)" stroke="var(--wx-surface)" stroke-width="2"/>`;
      }
      const aria = `Sunlight today: clear-sky potential and measured sunlight from ${m.sun.rise ? f.time(m.sun.rise) : "sunrise"} to ${m.sun.set ? f.time(m.sun.set) : "sunset"}; ${m.sun.kwh === null ? "no energy total yet" : `${f.num(m.sun.kwh, 1)} kilowatt-hours per square meter so far`}`;
      host.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(aria)}">${g}</svg>`;
    }

    /* ----- the meteogram: one specification per range, one renderer ----- */

    // Every strip answers two questions with the same shape of readout: what happened over the range
    // (its headline, idle) and what it was at one moment (under the crosshair).
    // Readout: { value, unit, caption, lines: [{ text, color, dash, dot, light }] }

    // Hours: the last 24 h from 5-minute statistics and the next 12 from the forecast.
    _hoursSpec(m) {
      const f = m.f, now = m.now;
      const x0 = now - PAST, x1 = now + AHEAD;
      const live = (k) => { const v = this._num(k); return v === null ? [] : [{ t: now, v }]; };
      const obs = (k) => this._pts(k).concat(live(k));
      const fc = (field) => this._fc.hourly.filter((x) => x.t >= now && x.t <= x1 && x[field] != null).map((x) => ({ t: x.t, v: x[field] }));
      // The forecast line is drawn from the last observation; its values come from the forecast alone.
      const bridge = (k, pts) => (pts.length ? live(k).concat(pts) : pts);
      const tu = m.temp.unit, su = m.wind.unit, pu = m.pres.unit, ru = m.rain.unit;
      const deg = (v) => `${f.num(v, 1)}°`;
      const pdp = presDp(pu), rdp = ru === "in" ? 2 : 1;
      const at8 = (pts, t) => nearest(pts, t, 8 * 60e3);
      const hourly = (changes) => {
        const h0 = f.startOfHour(x0);
        const bars = [];
        for (let t = h0; t < now; t += HOUR) bars.push({ t0: t, t1: t + HOUR, v: 0, n: 0 });
        for (const p of changes) { const b = bars[Math.floor((p.start - h0) / HOUR)]; if (b) { b.v += Math.max(0, p.v); b.n++; } }
        return bars.filter((b) => b.n > 0);
      };
      const T = obs("temperature"), DP = obs("dew_point"), WB = obs("wet_bulb_temperature"), FL = obs("feels_like");
      const hiP = extreme(this._pts("temperature", "max").concat(live("temperature")), 1), loP = extreme(this._pts("temperature", "min").concat(live("temperature")), -1);
      const lull = this._pts("wind_lull", "min"), gust = this._pts("wind_gust", "max");
      const windBand = gust.map((p) => { const l = nearest(lull, p.t, 1000); return { t: p.t, lo: l ? l.v : 0, hi: p.v }; });
      const WA = obs("wind_speed_average"), gustP = extreme(gust, 1);
      const P = obs("air_pressure"), AD = this._pts("air_density"), RH = obs("humidity"), VP = this._pts("vapor_pressure");
      const IRR = obs("irradiance"), UV = this._pts("uv_index"), LUX = this._pts("illuminance");
      const rainBars = hourly(this._pts("precipitation", "change"));
      const rainFc = this._fc.hourly.filter((x) => x.t >= now && x.t < x1 && x.rain > 0).map((x) => ({ t0: x.t, t1: x.t + HOUR, v: x.rain, fc: true }));
      const boltBars = hourly(this._pts("lightning_count", "change"));
      const rateP = extreme(this._pts("precipitation_intensity", "max"), 1);
      const vpu = this._unit("vapor_pressure") || pu;
      const feelsOff = m.temp.feels !== null && m.temp.v !== null && Math.abs(m.temp.feels - m.temp.v) >= 0.3;
      const hourRange = (b, t) => (b ? `${f.hour(b.t0)}–${f.hour(b.t1)}` : f.hour(f.startOfHour(t)));
      const barAt = (s, t, unit) => {
        const b = s.bars.find((x) => t >= x.t0 && t < x.t1);
        return readout(s.fmt(b ? b.v : 0), unit, b?.fc ? `Forecast, ${hourRange(b, t)}` : hourRange(b, t));
      };
      const ahead = (pts, t, fmt, unit) => { const p = nearest(pts, t, 40 * 60e3); return readout(p ? fmt(p.v) : "—", p ? unit : "", p ? "Forecast" : "No forecast"); };
      const TEMP = "var(--wx-temp)", DEW = "var(--wx-dew)";

      const strips = [
        { key: "temp", name: "Temperature", qual: "", kind: "lines", h: 136, w: 2.3, min: 80, yFmt: (v) => `${f.num(v)}°`, minSpan: 6,
          lines: [
            { key: "fc", color: "var(--wx-muted)", dash: true, pts: fc("temp"), draw: bridge("temperature", fc("temp")) },
            { key: "feels", color: "var(--wx-temp-2)", light: true, pts: FL, endName: feelsOff && FL.length ? `feels like ${deg(FL[FL.length - 1].v)}` : null },
            { key: "wet", color: "var(--wx-wetbulb)", dot: true, light: true, pts: WB, endName: WB.length ? `wet bulb ${deg(WB[WB.length - 1].v)}` : null },
            { key: "dew", color: DEW, pts: DP, endName: DP.length ? `dew point ${deg(DP[DP.length - 1].v)}` : null },
            { key: "t", color: TEMP, pts: T },
          ],
          head: () => { const v = this._num("temperature") ?? T[T.length - 1]?.v;
            return readout(v == null ? "—" : deg(v), "", hiP && loP && hiP.t !== loP.t ? `High ${deg(hiP.v)} · low ${deg(loP.v)}` : ""); },
          at: (t) => {
            if (t > now) return ahead(fc("temp"), t, deg, "");
            const p = at8(T, t), d = at8(DP, t), w = at8(WB, t), fl = at8(FL, t);
            return readout(p ? deg(p.v) : "—", "", "", [d && { text: `Dew point ${deg(d.v)}`, color: DEW }, w && { text: `Wet bulb ${deg(w.v)}`, color: "var(--wx-wetbulb)", dot: true },
              fl && p && Math.abs(fl.v - p.v) >= 0.3 && { text: `Feels like ${deg(fl.v)}`, color: "var(--wx-temp-2)", light: true }].filter(Boolean));
          },
          cols: [{ head: "Temperature", pts: T, fmt: deg, fc: fc("temp") }, { head: "Feels like", pts: FL, fmt: deg }, { head: "Dew point", pts: DP, fmt: deg }, { head: "Wet bulb", pts: WB, fmt: deg }] },
        { key: "wind", name: "Avg wind", qual: "", bandLabel: "gusts", kind: "lines", h: 88, w: 1.5, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 10,
          lines: [
            { key: "fc", color: "var(--wx-muted)", dash: true, pts: fc("wind"), draw: bridge("wind_speed_average", fc("wind")) },
            { key: "w", color: "var(--wx-wind)", pts: WA, band: windBand },
          ],
          head: () => { const v = this._num("wind_speed_average") ?? WA[WA.length - 1]?.v;
            return readout(v == null ? "—" : f.num(v, 1), v == null ? "" : su, gustP ? `Gusts to ${f.num(gustP.v, 1)}${NB}${su}` : ""); },
          at: (t) => {
            if (t > now) return ahead(fc("wind"), t, (v) => f.num(v, 1), su);
            const p = at8(WA, t), b = nearest(windBand, t, 8 * 60e3);
            return readout(p ? f.num(p.v, 1) : "—", p ? su : "", b ? `Gust ${f.num(b.hi, 1)}, lull ${f.num(b.lo, 1)}` : "");
          },
          cols: [{ head: `Wind (${su})`, pts: WA, fmt: (v) => f.num(v, 1), fc: fc("wind") }, { head: `Gust (${su})`, pts: gust, fmt: (v) => f.num(v, 1), agg: "max" }] },
        { key: "pres", name: "Pressure", qual: "", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => f.num(v, presDp(pu) - 1), minSpan: hpaIn(10, pu),
          lines: [{ key: "p", color: "var(--wx-pres)", pts: P }],
          head: () => readout(f.num(this._num("air_pressure") ?? m.pres.v, pdp), pu, m.pres.tend ? `${tendIn(f, m.pres.tend.dHpa, pu).text} in 3${NB}h` : m.pres.have >= 60e3 ? `Trend after 3${NB}h; ${f.dur(m.pres.have)} so far` : `Trend after 3${NB}h`),
          at: (t) => {
            if (t > now) return readout("—", "", "No forecast");
            const p = at8(P, t), a = at8(AD, t);
            return readout(p ? f.num(p.v, pdp) : "—", p ? pu : "", "", a ? [{ text: `Air density ${f.num(a.v, 3)}${NB}kg/m³` }] : []);
          },
          cols: [{ head: `Pressure (${pu})`, pts: P, fmt: (v) => f.num(v, pdp) }, { head: "Air density (kg/m³)", pts: AD, fmt: (v) => f.num(v, 3) }] },
        { key: "rh", name: "Humidity", qual: "", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => `${f.num(v)}%`, yMin: 0, yMax: 100,
          lines: [
            { key: "fc", color: "var(--wx-muted)", dash: true, pts: fc("rh"), draw: bridge("humidity", fc("rh")) },
            { key: "rh", color: DEW, pts: RH },
          ],
          head: () => { const v = this._pts("humidity").concat(live("humidity")).map((p) => p.v);
            const rh = this._num("humidity") ?? RH[RH.length - 1]?.v;
            return readout(rh == null ? "—" : f.num(rh), rh == null ? "" : "%", v.length ? `${span2(f.num(Math.min(...v)), f.num(Math.max(...v)))}% over 24${NB}h` : ""); },
          at: (t) => {
            if (t > now) return ahead(fc("rh"), t, (v) => f.num(v), "%");
            const p = at8(RH, t), vp = at8(VP, t);
            return readout(p ? f.num(p.v) : "—", p ? "%" : "", "", vp ? [{ text: `Vapor pressure ${f.num(vp.v, pdp)}${NB}${vpu}` }] : []);
          },
          cols: [{ head: "Humidity (%)", pts: RH, fmt: (v) => f.num(v), fc: fc("rh") }, { head: `Vapor pressure (${vpu})`, pts: VP, fmt: (v) => f.num(v, pdp) }] },
        { key: "rain", name: "Rain", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-rain)", bars: rainBars.concat(rainFc), fmt: (v) => f.num(v, rdp),
          empty: !rainBars.length && !rainFc.length ? "No rain history yet" : rainBars.every((b) => b.v <= 0) && !rainFc.length ? "No rain in the last 24 hours, and none forecast" : null, zero: rainBars.length > 0,
          head: () => readout(f.num(rainBars.reduce((a, b) => a + b.v, 0), rdp), ru, rateP && rateP.v > 0 ? `Peak ${f.num(rateP.v, rdp)}${NB}${m.rain.rateUnit}` : "",
            [{ text: `Today ${f.num(m.rain.today ?? 0, rdp)}${NB}${ru}` }]),
          at: (t) => barAt(strips.find((s) => s.key === "rain"), t, ru),
          cols: [{ head: `Rain (${ru})`, bars: true }, { head: `Rain rate, peak (${m.rain.rateUnit})`, pts: this._pts("precipitation_intensity", "max"), fmt: (v) => f.num(v, rdp), agg: "max" }] },
        { key: "bolt", name: "Lightning", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-bolt)", bars: boltBars, fmt: (v) => f.num(v),
          empty: !boltBars.length ? "No lightning history yet" : boltBars.every((b) => b.v <= 0) ? "No lightning detected in the last 24 hours" : null, zero: boltBars.length > 0,
          head: () => readout(f.num(m.bolt.h24), "strikes", m.bolt.recent ? `Latest ${f.num(m.bolt.dist)}${NB}${m.bolt.distUnit} away, ${f.ago(Date.now() - m.bolt.last)}` : ""),
          at: (t) => barAt(strips.find((s) => s.key === "bolt"), t, "strikes"),
          cols: [{ head: "Lightning (strikes)", bars: true }, { head: "Battery (V)", pts: this._pts("battery_voltage"), fmt: (v) => f.num(v, 2) }] },
      ];
      return {
        range: "hours", title: "Last 24 hours and next 12", x0, x1, now, marker: now, markerLabel: "Now", key: fc("temp").length ? "kd" : null,
        snap: (t) => Math.round(t / FIVE_MIN) * FIVE_MIN, step: FIVE_MIN, bigStep: HOUR,
        night: nightSpans(x0, x1, m.lat, m.lon), strips,
        when: (t) => `${f.when(t, now)}${t > now ? ", forecast" : ""}`,
        table: () => {
          const rows = [];
          for (let t = f.startOfHour(x1); t >= x0; t -= HOUR) rows.push(t);
          const sunCols = [{ head: "Sunlight (W/m²)", pts: IRR, fmt: (v) => f.num(v) }, { head: "UV index", pts: UV, fmt: (v) => f.num(v, 1) }, { head: "Light (lx)", pts: LUX, fmt: (v) => f.num(v) }];
          const cols = strips.flatMap((s) => s.cols.map((c) => ({ s, c }))).concat(sunCols.map((c) => ({ s: null, c })));
          return {
            head: ["Time", ...cols.map(({ c }) => c.head)],
            rows: rows.map((t) => ({ fc: t > now, cells: [`${f.when(t, now)}${t > now ? " · forecast" : ""}`, ...cols.map(({ s, c }) => {
              if (c.bars) { const b = s.bars.find((x) => x.t0 === t); return b ? s.fmt(b.v) : "—"; }
              if (t > now) { const p = c.fc ? nearest(c.fc, t, 40 * 60e3) : null; return p ? c.fmt(p.v) : "—"; }
              if (c.agg === "max") { const xs = c.pts.filter((p) => p.start >= t && p.start < t + HOUR).map((p) => p.v); return xs.length ? c.fmt(Math.max(...xs)) : "—"; }
              const p = nearest(c.pts, t, 8 * 60e3); return p ? c.fmt(p.v) : "—";
            })] })),
          };
        },
      };
    }

    // Days: daily statistics behind, the forecast's days ahead; today from the same record as the Now column.
    _daysSpec(m) {
      const f = m.f, sod = m.sod;
      const dayOf = (t) => f.startOfDay(t + 12 * HOUR);
      const next = (d) => f.startOfDay(d + 30 * HOUR);
      const rows = (k) => new Map(this._dailyRows(k).map((r) => [dayOf(r.t), r]));
      const TR = rows("temperature"), WA = rows("wind_speed_average"), WG = rows("wind_gust"), WL = rows("wind_lull");
      const PR = rows("air_pressure"), HR = rows("humidity"), IR = rows("irradiance"), RR = rows("precipitation"), LR = rows("lightning_count");
      const fcd = new Map(this._fc.daily.filter((d) => d.temp !== null).map((d) => [f.startOfDay(d.t), d]));
      const firstObs = Math.min(sod, ...TR.keys());
      const ahead = [...fcd.keys()].filter((d) => d > sod).sort((a, b) => a - b).slice(0, AHEAD_DAYS);
      // Count back in local days, not 24-hour blocks: a daylight-saving change in the window would shift the start off midnight.
      const earliest = f.startOfDay(sod - (PAST_DAYS - 1) * DAY + 12 * HOUR);
      const days = [];
      for (let d = Math.max(firstObs, earliest); d <= (ahead.length ? ahead[ahead.length - 1] : sod); d = next(d)) days.push(d);
      const x0 = days[0], x1 = next(days[days.length - 1]);
      const mid = (d) => d + (next(d) - d) / 2;
      const su = m.wind.unit, pu = m.pres.unit, ru = m.rain.unit;
      const deg = (v) => `${f.num(v)}°`;
      const pdp = presDp(pu), rdp = ru === "in" ? 2 : 1;
      const past = days.filter((d) => d <= sod), fut = days.filter((d) => d > sod);
      const val = (map, d, field) => { const r = map.get(d); const v = r?.[field]; return Number.isFinite(v) ? v : null; };
      const line = (map, field) => past.map((d) => ({ t: mid(d), v: val(map, d, field), d })).filter((p) => p.v !== null);
      const band = (lo, loF, hi, hiF) => past.map((d) => ({ t: mid(d), lo: val(lo, d, loF), hi: val(hi, d, hiF), d })).filter((p) => p.lo !== null && p.hi !== null);
      const ranges = days.map((d) => {
        if (d === sod) return { t0: d, t1: next(d), lo: m.temp.lo?.v ?? null, hi: m.temp.hi?.v ?? null, today: true };
        if (d > sod) { const x = fcd.get(d); return { t0: d, t1: next(d), lo: x?.low ?? null, hi: x?.temp ?? null, fc: true }; }
        return { t0: d, t1: next(d), lo: val(TR, d, "min"), hi: val(TR, d, "max") };
      }).filter((r) => r.lo !== null && r.hi !== null);
      const rainBars = days.map((d) => {
        if (d === sod) return { t0: d, t1: next(d), v: m.rain.today ?? 0 };
        if (d > sod) { const x = fcd.get(d); return { t0: d, t1: next(d), v: x?.rain ?? 0, fc: true }; }
        return { t0: d, t1: next(d), v: Math.max(0, val(RR, d, "change") ?? 0) };
      });
      const boltBars = past.map((d) => ({ t0: d, t1: next(d), v: Math.max(0, val(LR, d, "change") ?? 0) }));
      // Daily sunshine as energy: mean irradiance over the day, in kWh/m².
      const sunBars = past.map((d) => ({ t0: d, t1: next(d), v: d === sod ? m.sun.kwh ?? 0 : (val(IR, d, "mean") ?? 0) * 0.024 }));
      const fcWind = fut.map((d) => ({ t: mid(d), v: fcd.get(d)?.wind ?? null })).filter((p) => p.v !== null);
      const fcRh = fut.map((d) => ({ t: mid(d), v: fcd.get(d)?.rh ?? null })).filter((p) => p.v !== null);
      const windLine = line(WA, "mean"), windBand = band(WL, "min", WG, "max");
      const presLine = line(PR, "mean"), presBand = band(PR, "min", PR, "max"), rhLine = line(HR, "mean"), rhBand = band(HR, "min", HR, "max");
      const dayIdx = (t) => days.findIndex((d) => t >= d && t < next(d));
      const dayName = (d) => (d === sod ? "today" : f.dayLabel(d));
      const n = past.length, span = `last ${n} ${n === 1 ? "day" : "days"}`;
      const obsRanges = ranges.filter((r) => !r.fc);
      const top = (arr, key, sign) => arr.reduce((a, x) => (x[key] !== null && (!a || sign * (x[key] - a[key]) > 0) ? x : a), null);
      const lineAt = (pts, bandPts, fcPts, fmt, unit) => (t) => {
        const i = dayIdx(t); if (i < 0) return readout("—");
        const d = days[i], c = mid(d);
        if (d > sod) { const p = fcPts ? nearest(fcPts, c, HOUR) : null; return readout(p ? fmt(p.v) : "—", p ? unit : "", p ? "Forecast" : "No forecast"); }
        const p = nearest(pts, c, HOUR), b = bandPts ? nearest(bandPts, c, HOUR) : null;
        return readout(p ? fmt(p.v) : "—", p ? unit : "", b ? `${span2(fmt(b.lo), fmt(b.hi))}${unit && unit !== "%" ? NB + unit : unit}` : "");
      };
      const barAt = (bars, unit, fmt) => (t) => {
        const i = dayIdx(t); if (i < 0) return readout("—");
        const b = bars.find((x) => x.t0 === days[i]);
        return readout(b ? fmt(b.v) : "—", b ? unit : "", b?.fc ? "Forecast" : "");
      };

      const strips = [
        { key: "temp", name: "Temperature", qual: "", kind: "range", h: 136, w: 2.3, min: 80, yFmt: (v) => `${f.num(v)}°`, minSpan: 6, color: "var(--wx-temp)", ranges,
          head: () => {
            const hi = top(obsRanges, "hi", 1), lo = top(obsRanges, "lo", -1);
            return readout(hi && lo ? `${span2(f.num(lo.lo), f.num(hi.hi))}°` : "—", "", hi && lo ? `Low ${dayName(lo.t0)} · high ${dayName(hi.t0)}` : "",
              obsRanges.length ? [{ text: `Average high ${deg(mean(obsRanges.map((r) => r.hi)))}, low ${deg(mean(obsRanges.map((r) => r.lo)))}` }] : []);
          },
          at: (t) => { const i = dayIdx(t); const r = i < 0 ? null : ranges.find((x) => x.t0 === days[i]);
            return readout(r ? `${span2(f.num(r.lo), f.num(r.hi))}°` : "—", "", r?.fc ? "Forecast low–high" : r?.today ? "Today so far, low–high" : r ? "Low–high" : ""); } },
        { key: "wind", name: "Avg wind", qual: "", bandLabel: "gusts", kind: "lines", h: 88, w: 1.5, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 10,
          lines: [{ key: "fc", color: "var(--wx-muted)", dash: true, pts: fcWind }, { key: "w", color: "var(--wx-wind)", pts: windLine, band: windBand }],
          head: () => { const g = top(windBand, "hi", 1);
            return readout(windLine.length ? f.num(mean(windLine.map((p) => p.v)), 1) : "—", windLine.length ? su : "", g ? `Gusts to ${f.num(g.hi, 1)}, ${dayName(g.d)}` : "Collecting"); },
          at: lineAt(windLine, windBand, fcWind, (v) => f.num(v, 1), su) },
        { key: "pres", name: "Avg pressure", qual: "", bandLabel: "daily range", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => f.num(v, presDp(pu) - 1), minSpan: hpaIn(20, pu),
          lines: [{ key: "p", color: "var(--wx-pres)", pts: presLine, band: presBand }],
          head: () => { const v = presLine.map((p) => p.v);
            return readout(v.length ? f.num(mean(v), pdp) : "—", v.length ? pu : "", v.length ? `Range ${span2(f.num(Math.min(...v), pdp), f.num(Math.max(...v), pdp))}` : "Collecting"); },
          at: lineAt(presLine, presBand, null, (v) => f.num(v, pdp), pu) },
        { key: "rh", name: "Avg humidity", qual: "", bandLabel: "daily range", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => `${f.num(v)}%`, yMin: 0, yMax: 100,
          lines: [{ key: "fc", color: "var(--wx-muted)", dash: true, pts: fcRh }, { key: "rh", color: "var(--wx-dew)", pts: rhLine, band: rhBand }],
          head: () => readout(rhLine.length ? f.num(mean(rhLine.map((p) => p.v))) : "—", rhLine.length ? "%" : "", `Average, ${span}`),
          at: lineAt(rhLine, rhBand, fcRh, (v) => f.num(v), "%") },
        { key: "sun", name: "Sunshine", qual: "", kind: "bars", h: 72, w: 1.2, min: 56, color: "var(--wx-sun)", bars: sunBars, fmt: (v) => f.num(v, 1),
          empty: sunBars.every((b) => b.v <= 0) ? "Daily sunshine appears after the first full day" : null,
          head: () => { const b = top(sunBars, "v", 1);
            return readout(f.num(sunBars.reduce((a, x) => a + x.v, 0), 1), "kWh/m²", `Total, ${span}`, b ? [{ text: `Sunniest ${dayName(b.t0)}` }] : []); },
          at: barAt(sunBars, "kWh/m²", (v) => f.num(v, 1)) },
        { key: "rain", name: "Rain", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-rain)", bars: rainBars, fmt: (v) => f.num(v, rdp),
          empty: rainBars.every((b) => b.v <= 0) ? `No rain in the ${span}, and none forecast` : null, zero: true,
          head: () => { const obsB = rainBars.filter((b) => !b.fc), w = top(obsB, "v", 1);
            return readout(f.num(obsB.reduce((a, x) => a + x.v, 0), rdp), ru, w && w.v > 0 ? `Total, ${span}; wettest ${dayName(w.t0)}` : `Total, ${span}`); },
          at: barAt(rainBars, ru, (v) => f.num(v, rdp)) },
        { key: "bolt", name: "Lightning", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-bolt)", bars: boltBars, fmt: (v) => f.num(v),
          empty: boltBars.every((b) => b.v <= 0) ? `No lightning in the ${span}` : null, zero: true,
          head: () => { const b = top(boltBars, "v", 1);
            return readout(f.num(boltBars.reduce((a, x) => a + x.v, 0)), "strikes", b && b.v > 0 ? `Total, ${span}; most ${dayName(b.t0)}` : `Total, ${span}`); },
          at: barAt(boltBars, "strikes", (v) => f.num(v)) },
      ];
      const todayIdx = days.indexOf(sod);
      return {
        range: "days", title: `Last ${n} ${n === 1 ? "day" : "days"}${fut.length ? ` and next ${fut.length}` : ""}`,
        x0, x1, wash: [sod, next(sod)], days, todayIdx, step: DAY, bigStep: 7 * DAY, key: fut.length ? "kb" : null,
        snap: (t) => { const i = dayIdx(t); return i < 0 ? t : mid(days[i]); }, strips,
        when: (t) => { const i = dayIdx(t); return i < 0 ? "" : `${f.dayLabel(days[i])}${days[i] > sod ? ", forecast" : ""}`; },
        table: () => ({
          head: ["Day", "High", "Low", `Wind (${su})`, `Gust (${su})`, `Pressure (${pu})`, "Humidity (%)", "Sunshine (kWh/m²)", `Rain (${ru})`, "Lightning (strikes)"],
          rows: days.slice().reverse().map((d) => {
            const r = ranges.find((x) => x.t0 === d), c = mid(d), g = (pts) => nearest(pts, c, HOUR);
            const w = g(windLine) ?? (d > sod ? g(fcWind) : null), wb = g(windBand), p = g(presLine), h = g(rhLine) ?? (d > sod ? g(fcRh) : null);
            const s = sunBars.find((x) => x.t0 === d), rn = rainBars.find((x) => x.t0 === d), b = boltBars.find((x) => x.t0 === d);
            return { fc: d > sod, cells: [`${f.dayLabel(d)}${d === sod ? " · so far" : d > sod ? " · forecast" : ""}`, r ? deg(r.hi) : "—", r ? deg(r.lo) : "—",
              w ? f.num(w.v, 1) : "—", wb ? f.num(wb.hi, 1) : "—", p ? f.num(p.v, pdp) : "—", h ? f.num(h.v) : "—", s ? f.num(s.v, 1) : "—", rn ? f.num(rn.v, rdp) : "—", b ? f.num(b.v) : "—"] };
          }),
        }),
      };
    }

    // Months: the last 12 months. Continuous measures as daily averages inside their daily range; totals by month.
    _monthsSpec(m) {
      const f = m.f, sod = m.sod, now = m.now;
      const data = this._long?.months?.data ?? {};
      const dayOf = (t) => f.startOfDay(t + 12 * HOUR);
      const next = (d) => f.startOfDay(d + 30 * HOUR);
      const rows = (k) => (data[this._ents[k]] ?? []).map((r) => ({ d: dayOf(typeof r.start === "number" ? r.start : Date.parse(r.start)), ...r }));
      const x0 = f.startOfDay(sod - 364 * DAY + 12 * HOUR), x1 = next(sod);
      const mid = (d) => d + (next(d) - d) / 2;
      const su = m.wind.unit, pu = m.pres.unit, ru = m.rain.unit;
      const deg = (v) => `${f.num(v)}°`, deg1 = (v) => `${f.num(v, 1)}°`;
      const pdp = presDp(pu), rdp = ru === "in" ? 2 : 1;
      const fin = (v) => (Number.isFinite(v) ? v : null);
      const series = (k, field) => rows(k).filter((r) => r.d >= x0 && fin(r[field]) !== null).map((r) => ({ t: mid(r.d), v: r[field], d: r.d }));
      const bandOf = (kLo, fLo, kHi, fHi) => {
        const hi = new Map(rows(kHi).map((r) => [r.d, r[fHi]]));
        return rows(kLo).filter((r) => r.d >= x0 && fin(r[fLo]) !== null && fin(hi.get(r.d)) !== null).map((r) => ({ t: mid(r.d), lo: r[fLo], hi: hi.get(r.d), d: r.d }));
      };
      const tMean = series("temperature", "mean"), tBand = bandOf("temperature", "min", "temperature", "max");
      const wMean = series("wind_speed_average", "mean"), wBand = bandOf("wind_lull", "min", "wind_gust", "max");
      const pMean = series("air_pressure", "mean"), pBand = bandOf("air_pressure", "min", "air_pressure", "max");
      const hMean = series("humidity", "mean"), hBand = bandOf("humidity", "min", "humidity", "max");
      // Monthly totals from the daily record; the current month is a month so far.
      const months = [];
      for (let t = x0; t < x1; ) { const p = f.parts(t); const start = f.startOfDay(t); let e = start; do { e = next(e); } while (e < x1 && f.parts(e).day !== 1); months.push({ t0: start, t1: e, y: p.year, mo: p.month }); t = e; }
      const monthOf = (d) => months.find((x) => d >= x.t0 && d < x.t1);
      const totals = (k, fn) => months.map((mo) => {
        const rs = rows(k).filter((r) => r.d >= mo.t0 && r.d < mo.t1);
        return { t0: mo.t0, t1: mo.t1, v: rs.reduce((a, r) => a + fn(r), 0), n: rs.length };
      }).filter((b) => b.n > 0);
      const sunBars = totals("irradiance", (r) => (r.d === m.sod ? m.sun.kwh ?? 0 : (fin(r.mean) ?? 0) * 0.024));
      const rainBars = totals("precipitation", (r) => Math.max(0, fin(r.change) ?? 0));
      const boltBars = totals("lightning_count", (r) => Math.max(0, fin(r.change) ?? 0));
      const nDays = tMean.length;
      const enough = nDays >= 2;
      const waiting = nDays ? `Daily history: ${nDays} ${nDays === 1 ? "day" : "days"} of 365 so far` : "Daily history starts after the first full day";
      const monthName = (t) => new Intl.DateTimeFormat(f.lang, { timeZone: f.tz, month: "long" }).format(t);
      const top = (arr, key, sign) => arr.reduce((a, x) => (x[key] !== null && (!a || sign * (x[key] - a[key]) > 0) ? x : a), null);
      const dayIdx = (t) => (t >= x0 && t < x1 ? f.startOfDay(t) : null);
      const lineAt = (pts, bandPts, fmt, unit) => (t) => {
        const d = dayIdx(t); if (d === null) return readout("—");
        const p = nearest(pts, mid(d), 2 * HOUR), b = bandPts ? nearest(bandPts, mid(d), 2 * HOUR) : null;
        return readout(p ? fmt(p.v) : "—", p ? unit : "", b ? `${span2(fmt(b.lo), fmt(b.hi))}${unit && unit !== "%" ? NB + unit : unit}` : "");
      };
      const barAt = (bars, unit, fmt) => (t) => { const b = bars.find((x) => t >= x.t0 && t < x.t1); return readout(b ? fmt(b.v) : "—", b ? unit : "", b ? monthName(b.t0) : ""); };
      const span = enough ? (nDays >= 360 ? "last 12 months" : `last ${nDays} days`) : "";
      const strips = [
        { key: "temp", name: "Temperature", qual: "", bandLabel: "daily range", kind: "lines", h: 136, w: 2.3, min: 80, yFmt: (v) => `${f.num(v)}°`, minSpan: 10, empty: enough ? null : waiting,
          lines: [{ key: "t", color: "var(--wx-temp)", pts: tMean, band: tBand }],
          head: () => { const hi = top(tBand, "hi", 1), lo = top(tBand, "lo", -1);
            return readout(hi && lo ? `${span2(f.num(lo.lo), f.num(hi.hi))}°` : "—", "", hi && lo ? `Low ${f.date(lo.d)} · high ${f.date(hi.d)}` : "Collecting",
              tMean.length ? [{ text: `Average ${deg1(mean(tMean.map((p) => p.v)))}` }] : []); },
          at: lineAt(tMean, tBand, deg1, "") },
        { key: "wind", name: "Avg wind", qual: "", bandLabel: "gusts", kind: "lines", h: 88, w: 1.5, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 10, empty: enough ? null : waiting,
          lines: [{ key: "w", color: "var(--wx-wind)", pts: wMean, band: wBand }],
          head: () => { const g = top(wBand, "hi", 1);
            return readout(wMean.length ? f.num(mean(wMean.map((p) => p.v)), 1) : "—", wMean.length ? su : "", g ? `Gusts to ${f.num(g.hi, 1)}, ${f.date(g.d)}` : "Collecting"); },
          at: lineAt(wMean, wBand, (v) => f.num(v, 1), su) },
        { key: "pres", name: "Avg pressure", qual: "", bandLabel: "daily range", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => f.num(v, presDp(pu) - 1), minSpan: hpaIn(20, pu), empty: enough ? null : waiting,
          lines: [{ key: "p", color: "var(--wx-pres)", pts: pMean, band: pBand }],
          head: () => { const lo = top(pBand, "lo", -1), hi = top(pBand, "hi", 1);
            return readout(pMean.length ? f.num(mean(pMean.map((p) => p.v)), pdp) : "—", pMean.length ? pu : "", lo && hi ? `Range ${span2(f.num(lo.lo, pdp), f.num(hi.hi, pdp))}` : "Collecting"); },
          at: lineAt(pMean, pBand, (v) => f.num(v, pdp), pu) },
        { key: "rh", name: "Avg humidity", qual: "", bandLabel: "daily range", kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => `${f.num(v)}%`, yMin: 0, yMax: 100, empty: enough ? null : waiting,
          lines: [{ key: "rh", color: "var(--wx-dew)", pts: hMean, band: hBand }],
          head: () => readout(hMean.length ? f.num(mean(hMean.map((p) => p.v))) : "—", hMean.length ? "%" : "", hMean.length ? `Average, ${span}` : "Collecting"),
          at: lineAt(hMean, hBand, (v) => f.num(v), "%") },
        { key: "sun", name: "Sunshine", qual: "", kind: "bars", h: 72, w: 1.2, min: 56, color: "var(--wx-sun)", bars: sunBars, fmt: (v) => f.num(v), empty: enough ? null : waiting,
          head: () => { const b = top(sunBars, "v", 1);
            return readout(f.num(sunBars.reduce((a, x) => a + x.v, 0)), "kWh/m²", `Total, ${span}`, b ? [{ text: `Sunniest ${monthName(b.t0)}` }] : []); },
          at: barAt(sunBars, "kWh/m²", (v) => f.num(v)) },
        { key: "rain", name: "Rain", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-rain)", bars: rainBars, fmt: (v) => f.num(v, rdp),
          empty: !enough ? waiting : rainBars.every((b) => b.v <= 0) ? `No rain in the ${span}` : null, zero: enough,
          head: () => { const w = top(rainBars, "v", 1);
            return readout(f.num(rainBars.reduce((a, x) => a + x.v, 0), rdp), ru, w && w.v > 0 ? `Total, ${span}; wettest ${monthName(w.t0)}` : `Total, ${span}`); },
          at: barAt(rainBars, ru, (v) => f.num(v, rdp)) },
        { key: "bolt", name: "Lightning", qual: "", kind: "bars", h: 64, w: 1.05, min: 56, color: "var(--wx-bolt)", bars: boltBars, fmt: (v) => f.num(v),
          empty: !enough ? waiting : boltBars.every((b) => b.v <= 0) ? `No lightning in the ${span}` : null, zero: enough,
          head: () => { const b = top(boltBars, "v", 1);
            return readout(f.num(boltBars.reduce((a, x) => a + x.v, 0)), "strikes", b && b.v > 0 ? `Total, ${span}; most in ${monthName(b.t0)}` : `Total, ${span}`); },
          at: barAt(boltBars, "strikes", (v) => f.num(v)) },
      ];
      return {
        range: "months", title: "Last 12 months", x0, x1, marker: null, step: DAY, bigStep: 30 * DAY, loading: !this._long?.months, failed: this._long?.months?.error,
        snap: (t) => { const d = dayIdx(t); return d === null ? t : mid(d); }, strips,
        when: (t) => { const d = dayIdx(t); return d === null ? "" : `${f.weekday(d)}, ${f.date(d)}`; },
        months,
        table: () => ({
          head: ["Day", "High", "Low", "Average", `Wind (${su})`, `Gust (${su})`, `Pressure (${pu})`, "Humidity (%)"],
          rows: tMean.slice().reverse().map((p) => {
            const b = nearest(tBand, p.t, HOUR), w = nearest(wMean, p.t, HOUR), g = nearest(wBand, p.t, HOUR), pr = nearest(pMean, p.t, HOUR), h = nearest(hMean, p.t, HOUR);
            return { cells: [`${f.weekday(p.d)}, ${f.date(p.d)}`, b ? deg1(b.hi) : "—", b ? deg1(b.lo) : "—", deg1(p.v), w ? f.num(w.v, 1) : "—", g ? f.num(g.hi, 1) : "—", pr ? f.num(pr.v, pdp) : "—", h ? f.num(h.v) : "—"] };
          }),
        }),
      };
    }

    // Years: one January-to-December axis, one line per year. This year in the measure's colour, earlier
    // years in grey; rain, sunshine and lightning run cumulatively, so "ahead of last year?" reads at a glance.
    _yearsSpec(m) {
      const f = m.f, now = m.now;
      const data = this._long?.years?.data ?? {};
      const thisYear = f.parts(now).year, thisMonth = f.parts(now).month - 1, today = f.parts(now).day;
      const rows = (k) => (data[this._ents[k]] ?? []).map((r) => {
        const s = typeof r.start === "number" ? r.start : Date.parse(r.start);
        const p = f.parts(s + 12 * HOUR);
        return { y: p.year, mo: p.month - 1, ...r };
      });
      const recorded = rows("temperature");
      const years = [...new Set(recorded.map((r) => r.y))].sort((a, b) => b - a).slice(0, 6);
      const first = recorded.reduce((a, r) => (!a || r.y * 12 + r.mo < a.y * 12 + a.mo ? r : a), null);
      const enough = new Set(recorded.map((r) => r.y * 12 + r.mo)).size >= 2, multi = years.length > 1;
      const NOM = 2001, x0 = Date.UTC(NOM, 0, 1), x1 = Date.UTC(NOM + 1, 0, 1);
      const startOf = (mo) => Date.UTC(NOM, mo, 1), midOf = (mo) => Date.UTC(NOM, mo, 15), endOf = (mo) => Date.UTC(NOM, mo + 1, 1) - 1;
      const todayNom = Date.UTC(NOM, thisMonth, Math.min(new Date(Date.UTC(NOM, thisMonth + 1, 0)).getUTCDate(), today));
      // This month is still running: its average sits in the middle of the days so far, its running total at today.
      const midAt = (y, mo) => (y === thisYear && mo === thisMonth ? (startOf(mo) + todayNom) / 2 : midOf(mo));
      const endAt = (y, mo) => (y === thisYear && mo === thisMonth ? todayNom : endOf(mo));
      const su = m.wind.unit, pu = m.pres.unit, ru = m.rain.unit;
      const pdp = presDp(pu), rdp = ru === "in" ? 2 : 1;
      const fin = (v) => (Number.isFinite(v) ? v : null);
      const daysIn = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const monthName = (mo) => new Intl.DateTimeFormat(f.lang, { month: "long", timeZone: "UTC" }).format(Date.UTC(NOM, mo, 15));
      const shade = (i) => [1, 0.75, 0.55, 0.42, 0.32, 0.25][i] ?? 0.25;
      // Lines per year: a monthly value, or a running total from the first recorded month.
      const perYear = (k, field) => years.map((y) => {
        const rs = rows(k).filter((r) => r.y === y && fin(r[field]) !== null).sort((a, b) => a.mo - b.mo);
        return { y, from: rs.length ? rs[0].mo : null, pts: rs.map((r) => ({ t: midAt(y, r.mo), v: r[field], mo: r.mo })) };
      });
      // A year whose record starts after January has no year to date to set beside another, so only this year may start late.
      const cumYear = (k, conv) => years.map((y) => {
        let sum = 0;
        const rs = rows(k).filter((r) => r.y === y).sort((a, b) => a.mo - b.mo);
        const pts = rs.length ? [{ t: startOf(rs[0].mo), v: 0, mo: -1 }] : [];
        for (const r of rs) { sum += Math.max(0, conv(r)); pts.push({ t: endAt(y, r.mo), v: sum, mo: r.mo }); }
        return { y, from: rs.length ? rs[0].mo : null, pts };
      }).filter((s) => s.y === thisYear || s.from === 0);
      const temp = perYear("temperature", "mean"), wind = perYear("wind_speed_average", "mean"), pres = perYear("air_pressure", "mean"), rh = perYear("humidity", "mean");
      const insol = (r) => (fin(r.mean) ?? 0) * 0.024 * (r.y === thisYear && r.mo === thisMonth ? today : daysIn(r.y, r.mo));
      const sun = cumYear("irradiance", insol), rain = cumYear("precipitation", (r) => fin(r.change) ?? 0), bolt = cumYear("lightning_count", (r) => fin(r.change) ?? 0);
      const lines = (sets, color) => sets.map((s, j) => ({ key: `y${s.y}`, color: s.y === thisYear ? color : "var(--wx-muted)", opacity: s.y === thisYear ? 1 : shade(j),
        width: s.y === thisYear ? 2 : 1.5, pts: s.pts, endLabel: j < 2 ? String(s.y) : null, year: s.y })).reverse();
      // Year to date against the previous year at the same point: averages over the same days of the same months,
      // running totals read off last year's line at today. No comparison where last year's record doesn't reach.
      const lerp = (pts, t) => {
        for (let i = 1; i < pts.length; i++) if (pts[i].t >= t) { const a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
        return null;
      };
      const days = (mo) => (mo === thisMonth ? today : daysIn(thisYear, mo));
      const ytd = (sets, how) => {
        const cur = sets.find((s) => s.y === thisYear), prev = sets.find((s) => s.y === thisYear - 1);
        if (!cur?.pts.length) return { cur: null, prev: null };
        if (how === "sum") {
          const covers = prev && prev.from !== null && prev.from <= cur.from && prev.pts.some((p) => p.mo >= thisMonth);
          return { cur: cur.pts[cur.pts.length - 1].v, prev: covers ? lerp(prev.pts, todayNom) : null };
        }
        const months = cur.pts.filter((p) => p.mo <= thisMonth).map((p) => p.mo);
        const avg = (s) => {
          let a = 0, w = 0;
          for (const mo of months) { const p = s.pts.find((q) => q.mo === mo); if (!p) return null; a += p.v * days(mo); w += days(mo); }
          return w ? a / w : null;
        };
        return { cur: avg(cur), prev: prev ? avg(prev) : null };
      };
      // "0.8° warmer than 2025": the difference in the reading's own terms, or the same when it rounds away.
      const versus = (c, fmt, unit, [more, less]) => {
        if (c.cur === null || c.prev === null) return "";
        const d = c.cur - c.prev, amt = fmt(Math.abs(d));
        if (Number(amt.replace(/[^\d]/g, "")) === 0) return `Same as ${thisYear - 1}`;
        return `${amt}${unit === "%" ? "%" : unit ? NB + unit : ""} ${d > 0 ? more : less} than ${thisYear - 1}`;
      };
      const headOf = (sets, how, fmt, unit, words) => () => {
        const c = ytd(sets, how);
        return readout(c.cur === null ? "—" : fmt(c.cur), c.cur === null ? "" : unit, versus(c, fmt, unit, words));
      };
      const atOf = (sets, fmt, unit, cum) => (t) => {
        const mo = new Date(t).getUTCMonth();
        const val = (s) => { const p = s.pts.find((q) => q.mo === mo); return p ? p.v : null; };
        const cur = sets.find((s) => s.y === thisYear), others = sets.filter((s) => s.y !== thisYear);
        const cv = cur ? val(cur) : null;
        return readout(cv === null ? "—" : fmt(cv), cv === null ? "" : unit, `${monthName(mo)} ${thisYear}${cum ? (cur?.from === 0 ? ", year to date" : ", running total") : ""}`,
          others.map((s) => { const v = val(s); return v === null ? null : { text: `${s.y}: ${fmt(v)}${unit === "%" ? "%" : unit ? NB + unit : ""}`, color: "var(--wx-muted)" }; }).filter(Boolean));
      };
      const empty = enough ? null : first ? `Monthly history began in ${monthName(first.mo)} ${first.y}; lines start in ${monthName((first.mo + 1) % 12)}` : "No monthly history recorded yet";
      const qMean = multi ? String(thisYear) : "", qSum = multi ? String(thisYear) : "";
      const deg1 = (v) => `${f.num(v, 1)}°`;
      const numF = (dp) => (v) => f.num(v, dp);
      const strips = [
        { key: "temp", name: "Avg temperature", qual: qMean, kind: "lines", h: 136, w: 2.3, min: 80, yFmt: (v) => `${f.num(v)}°`, minSpan: 10, empty,
          lines: lines(temp, "var(--wx-temp)"), head: headOf(temp, "mean", deg1, "", ["warmer", "cooler"]), at: atOf(temp, deg1, "") },
        { key: "wind", name: "Avg wind", qual: qMean, kind: "lines", h: 88, w: 1.5, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 5, empty,
          lines: lines(wind, "var(--wx-wind)"), head: headOf(wind, "mean", numF(1), su, ["windier", "calmer"]), at: atOf(wind, numF(1), su) },
        { key: "pres", name: "Avg pressure", qual: qMean, kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => f.num(v, presDp(pu) - 1), minSpan: hpaIn(10, pu), empty,
          lines: lines(pres, "var(--wx-pres)"), head: headOf(pres, "mean", numF(pdp), pu, ["higher", "lower"]), at: atOf(pres, numF(pdp), pu) },
        { key: "rh", name: "Avg humidity", qual: qMean, kind: "lines", h: 64, w: 1, min: 56, yFmt: (v) => `${f.num(v)}%`, yMin: 0, yMax: 100, empty,
          lines: lines(rh, "var(--wx-dew)"), head: headOf(rh, "mean", numF(0), "%", ["higher", "lower"]), at: atOf(rh, numF(0), "%") },
        { key: "sun", name: "Sunshine", qual: qSum, kind: "lines", h: 72, w: 1.2, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 50, empty,
          lines: lines(sun, "var(--wx-sun)"), head: headOf(sun, "sum", numF(0), "kWh/m²", ["more", "less"]), at: atOf(sun, numF(0), "kWh/m²", true) },
        { key: "rain", name: "Rain", qual: qSum, kind: "lines", h: 64, w: 1.05, min: 56, yFmt: (v) => f.num(v, rdp > 1 ? 1 : 0), yMin: 0, minSpan: ru === "in" ? 1 : 25, empty,
          lines: lines(rain, "var(--wx-rain)"), head: headOf(rain, "sum", numF(rdp), ru, ["more", "less"]), at: atOf(rain, numF(rdp), ru, true) },
        { key: "bolt", name: "Lightning", qual: qSum, kind: "lines", h: 64, w: 1.05, min: 56, yFmt: (v) => f.num(v), yMin: 0, minSpan: 10, empty,
          lines: lines(bolt, "var(--wx-bolt)"), head: headOf(bolt, "sum", numF(0), "strikes", ["more", "fewer"]), at: atOf(bolt, numF(0), "strikes", true) },
      ];
      const title = !enough ? "Year by year" : multi ? `${years[years.length - 1]} to ${thisYear}, year by year` : first.mo > 0 ? `Since ${monthName(first.mo)} ${first.y}` : `${thisYear} so far`;
      return {
        range: "years", title, x0, x1,
        marker: todayNom, markerLabel: "Today", step: 30 * DAY, bigStep: 90 * DAY, loading: !this._long?.years, failed: this._long?.years?.error,
        snap: (t) => midAt(thisYear, new Date(Math.max(x0, Math.min(x1 - 1, t))).getUTCMonth()), strips,
        when: (t) => monthName(new Date(t).getUTCMonth()),
        table: () => {
          const ym = [...new Set(rows("temperature").map((r) => `${r.y}-${r.mo}`))].map((s) => s.split("-").map(Number)).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
          const get = (k, y, mo) => rows(k).find((r) => r.y === y && r.mo === mo);
          return {
            head: ["Month", "Average", "High", "Low", `Wind (${su})`, `Gust (${su})`, `Pressure (${pu})`, "Humidity (%)", "Sunshine (kWh/m²)", `Rain (${ru})`, "Lightning (strikes)"],
            rows: ym.map(([y, mo]) => {
              const t = get("temperature", y, mo), w = get("wind_speed_average", y, mo), g = get("wind_gust", y, mo), p = get("air_pressure", y, mo), h = get("humidity", y, mo);
              const ir = get("irradiance", y, mo), rn = get("precipitation", y, mo), b = get("lightning_count", y, mo);
              const n = (v, dp) => (fin(v) === null ? "—" : f.num(v, dp));
              return { cells: [`${monthName(mo)} ${y}`, t ? `${n(t.mean, 1)}°` : "—", t ? `${n(t.max, 1)}°` : "—", t ? `${n(t.min, 1)}°` : "—", n(w?.mean, 1), n(g?.max, 1),
                n(p?.mean, pdp), n(h?.mean, 0), ir ? f.num(insol({ ...ir, y, mo })) : "—", n(rn?.change, rdp), n(b?.change, 0)] };
            }),
          };
        },
      };
    }

    // Months and Years read the long-term statistics, which grow with the station; fetch them when shown, then every 6 h.
    async _ensureLong(range) {
      if ((range !== "months" && range !== "years") || !this._hass || !this._ents) return;
      this._long = this._long ?? {};
      const slot = this._long[range];
      if ((slot && Date.now() - slot.at < (slot.error ? 5 * 60e3 : 6 * HOUR)) || this._longPending?.[range]) return;
      (this._longPending = this._longPending ?? {})[range] = true;
      const f = this._fmt(), now = Date.now();
      try {
        const start = range === "months" ? f.startOfDay(f.startOfDay(now) - 365 * DAY + 12 * HOUR) : f.startOfDay(Date.UTC(f.parts(now).year - 5, 0, 1) + 12 * HOUR);
        const data = await this._hass.callWS({ type: "recorder/statistics_during_period", start_time: new Date(start).toISOString(),
          statistic_ids: LONG_KEYS.map((k) => this._ents[k]), period: range === "months" ? "day" : "month", types: ["mean", "min", "max", "change"] });
        this._long[range] = { data: data ?? {}, at: Date.now() };
      } catch (e) {
        this._long[range] = { data: {}, at: Date.now(), error: e?.message ?? String(e) };
      }
      this._longPending[range] = false;
      if (this._range === range) this._renderAll(true);
    }

    // Strip heights: in the one-screen layout they share the body's height by weight; otherwise their natural size.
    _allocate(strips, total, narrow) {
      const base = strips.map((s) => (s.empty ? (narrow ? 32 : 40) : narrow ? Math.max(56, Math.round(s.h * 0.82)) : s.h));
      if (!total) return base;
      // Nothing to plot anywhere: the empty wells share the height evenly.
      if (strips.every((s) => s.empty)) { const each = Math.floor(total / strips.length); return strips.map((_, i) => each + (i === 0 ? total - each * strips.length : 0)); }
      const fixed = strips.reduce((a, s, i) => a + (s.empty ? base[i] : 0), 0);
      const wsum = strips.reduce((a, s) => a + (s.empty ? 0 : s.w), 0) || 1;
      const room = total - fixed;
      const mins = strips.map((s) => (s.empty ? 0 : this._tight ? Math.max(46, Math.round(s.min * 0.8)) : s.min));
      const minSum = mins.reduce((a, b) => a + b, 0);
      const out = strips.map((s, i) => (s.empty ? base[i] : 0));
      if (minSum > room) {
        // Too short for every minimum: all strips scale down together.
        strips.forEach((s, i) => { if (!s.empty) out[i] = Math.max(32, Math.floor(mins[i] * (room / minSum))); });
      } else {
        // Water-filling: strips whose weighted share falls below their minimum take the minimum; the rest share what remains.
        let active = strips.map((s, i) => i).filter((i) => !strips[i].empty), budget = room;
        for (;;) {
          const ws = active.reduce((a, i) => a + strips[i].w, 0);
          const low = active.filter((i) => (budget * strips[i].w) / ws < mins[i]);
          if (!low.length) { active.forEach((i) => { out[i] = Math.floor((budget * strips[i].w) / ws); }); break; }
          low.forEach((i) => { out[i] = mins[i]; budget -= mins[i]; });
          active = active.filter((i) => !low.includes(i));
          if (!active.length) break;
        }
      }
      // Rounding settles on the first full strip, so the last well lands exactly on the card's bottom line.
      const first = strips.findIndex((s) => !s.empty);
      const diff = total - out.reduce((a, b) => a + b, 0);
      if (first >= 0) out[first] += diff;
      return out;
    }

    _spec(m) {
      return this._range === "years" ? this._yearsSpec(m) : this._range === "months" ? this._monthsSpec(m) : this._range === "days" ? this._daysSpec(m) : this._hoursSpec(m);
    }

    _drawMeteogram() {
      const host = this._root?.querySelector("[data-mg]");
      if (!host || !this._m) return;
      const m = this._m, f = m.f;
      const spec = this._spec(m);
      this._mgSpec = spec;
      const title = this._root.querySelector('[data-k="mgtitle"]');
      if (title) this._swapText(title, spec.title);
      this._mgFocus = this._mgFocus || !!this._root.activeElement?.classList?.contains("mg");
      if (this._table) { this._mgFocus = false; this._mgHold = null; this._redrawing = true; host.innerHTML = this._tableHtml(spec); this._redrawing = false; return; }
      const narrow = this._mode === "narrow", wide = this._mode === "wide";
      const tileW = this._tileW();
      const W = Math.max(240, host.clientWidth - tileW);
      const longest = Math.max(0, ...spec.strips.filter((s) => !s.empty && s.yFmt).flatMap((s) => {
        const vals = s.kind === "range" ? s.ranges.flatMap((r) => [r.lo, r.hi]) : s.kind === "lines" ? s.lines.flatMap((l) => l.pts.map((q) => q.v)) : [];
        return vals.length ? [s.yFmt(Math.max(...vals)).length, s.yFmt(Math.min(...vals)).length] : [];
      }), ...spec.strips.filter((s) => s.kind === "bars" && !s.empty).map((s) => f.num(Math.max(...s.bars.map((b) => b.v), 0), 2).length));
      const padL = Math.max(narrow ? 32 : 36, 14 + longest * 7), padR = 6, axisH = 24, gap = narrow ? 4 : this._tight ? 4 : 8;
      const { x0, x1 } = spec;
      const pw = W - padL - padR;
      const sx = (t) => padL + ((t - x0) / (x1 - x0)) * pw;
      const n = spec.strips.length;
      const heights = this._allocate(spec.strips, wide ? host.clientHeight - axisH - gap * n : null, narrow);
      // One headline size per column: 32 px only when every strip with data has room for it, else 24 px for all.
      this._headlineTier = narrow ? "full" : !this._tight && spec.strips.every((st, k) => st.empty || heights[k] >= 56) ? "full" : "m";
      const markX = spec.marker !== null && spec.marker !== undefined ? sx(spec.marker) : null;
      this._mgGeom = { spec, sx, padL, pw, strips: [] };

      const bandSeen = new Set();
      const rows = spec.strips.map((s, si) => {
        const H = heights[si];
        const padT = 12, padB = s.kind === "lines" || s.kind === "range" ? 8 : 0, ph = H - padT - padB;
        let g = "";
        if (spec.wash) g += `<rect x="${sx(spec.wash[0]).toFixed(1)}" y="0" width="${(sx(spec.wash[1]) - sx(spec.wash[0])).toFixed(1)}" height="${H}" fill="var(--wx-wash)"/>`;
        if (markX !== null) g += `<line x1="${markX.toFixed(1)}" x2="${markX.toFixed(1)}" y1="0" y2="${H}" stroke="var(--wx-axis)"/>`;
        const geom = { s, H };
        if (s.empty) {
          g += `<line data-xh x1="0" x2="0" y1="0" y2="${H}" stroke="var(--wx-ink2)" visibility="hidden"/>`;
          this._mgGeom.strips.push(geom);
          const repeat = si > 0 && spec.strips[si - 1].empty === s.empty;
          const msg = spec.failed ? (si === 0 ? "History unavailable: the recorder's statistics could not be read" : "") : spec.loading ? (si === 0 ? "Loading history…" : "") : repeat ? "" : s.empty;
          return { s, H, svg: `<svg width="${W}" height="${H}" aria-hidden="true">${g}</svg>${msg ? `<div class="mg-none small" style="left:${padL + 8}px">${esc(msg)}</div>` : ""}` };
        }
        const label = (v, y) => `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" class="tick">${esc(v)}</text>`;
        const grid = (y) => `<line x1="${padL}" x2="${padL + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--wx-grid)"/>`;
        if (s.kind === "bars") {
          // Air over the tallest bar; one labelled tick, the largest that fits.
          const vmax = Math.max(...s.bars.map((b) => b.v), 0) || 1;
          const top = vmax * 1.12;
          const nt = niceTicks(0, vmax, 2);
          const tick = nt.ticks.filter((v) => v > 0 && v <= top).pop() ?? nt.ticks[1] ?? vmax;
          const sy = (v) => padT + ph - (v / top) * ph;
          if (H >= 52) g += grid(sy(tick)) + label(f.num(tick, nt.step < 0.1 ? 2 : nt.step < 1 ? 1 : 0), sy(tick));
          s.bars.forEach((b, i) => {
            const slot = sx(b.t1) - sx(b.t0), bw = Math.max(2, Math.min(24, slot - 2));
            const x = sx(b.t0) + (slot - bw) / 2, y = sy(b.v);
            g += `<path data-bar="${i}" d="${barPath(x, y, bw, padT + ph - y)}" fill="${b.fc ? "var(--wx-muted)" : s.color}"${b.fc ? ' fill-opacity="0.5"' : ""}/>`;
          });
          geom.sy = sy;
        } else {
          // Fit the data with a little air above and below; ticks fall where they fall inside.
          const vals = [];
          if (s.kind === "range") for (const r of s.ranges) vals.push(r.lo, r.hi);
          else for (const ln of s.lines) {
            for (const p of ln.pts) if (p.t >= x0 && p.t <= x1) vals.push(p.v);
            for (const b of ln.band ?? []) if (b.t >= x0) vals.push(b.lo, b.hi);
          }
          let lo = s.yMin ?? (vals.length ? Math.min(...vals) : 0), hi = s.yMax ?? (vals.length ? Math.max(...vals) : 1);
          if (s.minSpan && hi - lo < s.minSpan) { const md = (hi + lo) / 2; lo = s.yMin ?? md - s.minSpan / 2; hi = lo + s.minSpan; }
          const span = hi - lo || 1;
          const y0 = s.yMin ?? lo - span * 0.06, y1 = s.yMax ?? hi + span * 0.1;
          const nt = niceTicks(y0, y1, H >= 110 ? 3 : 2);
          const sy = (v) => padT + ph - ((v - y0) / (y1 - y0)) * ph;
          // Under 52 px a strip is a sparkline: no ticks or gridlines; its tile carries the value.
          let lastY = Infinity;
          if (H >= 52) for (const v of nt.ticks) {
            if (v < y0 - 1e-9 || v > y1 + 1e-9) continue;
            const y = sy(v);
            g += grid(y);
            if (y < padT + ph - 10 && y > 8 && lastY - y >= 20) { g += label(s.yFmt(v), y); lastY = y; }
          }
          if (s.kind === "range") {
            for (const r of s.ranges) {
              const slot = sx(r.t1) - sx(r.t0), bw = Math.max(4, Math.min(16, slot * 0.4));
              const x = sx(r.t0) + (slot - bw) / 2, y = sy(r.hi), h = Math.max(8, sy(r.lo) - y);
              // A floating range has a data end at both ends: 4 px rounding at each, like every other bar.
              g += `<rect data-bar="${r.t0}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${r.fc ? "var(--wx-muted)" : s.color}"${r.fc ? ' fill-opacity="0.5"' : ""}/>`;
            }
          } else {
            const gapMs = spec.range === "hours" ? 16 * 60e3 : spec.range === "years" ? 70 * DAY : 1.5 * DAY;
            // This year's label claims its place first; earlier years' labels give way to it and to each other.
            // A label's box is about 30 px wide, right of its line's end when there is room; boxes clash only where they meet.
            const box = (e) => { const ex = sx(e.t), right = ex + 40 < padL + pw; return { right, x: right ? ex + 6 : ex - 36, y: sy(e.v) + 4 }; };
            const meets = (a, b) => Math.abs(a.y - b.y) < 13 && a.x < b.x + 34 && b.x < a.x + 34;
            const yearLabels = [];
            for (const ln of s.lines) {
              if (!ln.endLabel || ln.opacity !== 1) continue;
              const pts = ln.pts.filter((p) => p.t >= x0 && p.t <= x1);
              if (pts.length) yearLabels.push(box(pts[pts.length - 1]));
            }
            for (const ln of s.lines) {
              const pts = (ln.draw ?? ln.pts).filter((p) => p.t >= x0 - FIVE_MIN && p.t <= x1);
              if (!pts.length) continue;
              if (ln.band?.length) g += `<path d="${bandPath(ln.band.filter((p) => p.t >= x0), sx, sy, gapMs)}" fill="${ln.color}" fill-opacity="0.14"/>`;
              if (ln.band?.length && s.bandLabel && !bandSeen.has(s.bandLabel)) {
                const bs = ln.band.filter((b) => b.t >= x0 && b.t <= x1), last = bs[bs.length - 1];
                if (last) {
                  bandSeen.add(s.bandLabel);
                  const lx = sx(last.t), top = Math.min(...bs.filter((b) => sx(b.t) >= lx - 46).map((b) => sy(b.hi)));
                  g += `<text x="${(lx - 4).toFixed(1)}" y="${Math.max(11, top - 5).toFixed(1)}" text-anchor="end" class="tick halo">${esc(s.bandLabel)}</text>`;
                }
              }
              const width = ln.width ?? (ln.dot ? 2.25 : ln.light ? 1.25 : ln.dash ? 1.5 : 2);
              const op = ln.opacity ?? 1;
              g += `<path d="${linePath(pts, sx, sy, ln.dash ? 2 * (spec.range === "hours" ? HOUR : DAY) : gapMs)}" fill="none" stroke="${ln.color}" stroke-width="${width}"${op < 1 ? ` stroke-opacity="${op}"` : ""} stroke-linejoin="round" stroke-linecap="round"${ln.dash ? ' stroke-dasharray="4 4"' : ln.dot ? ' stroke-dasharray="0.01 4.5"' : ""}/>`;
              const e = pts[pts.length - 1];
              if (!ln.dash && !ln.light && (ln.year === undefined || ln.opacity === 1) && pts.length < 400) {
                g += `<circle cx="${sx(e.t).toFixed(1)}" cy="${sy(e.v).toFixed(1)}" r="${spec.range === "hours" ? 4 : 3}" fill="${ln.color}" stroke="var(--wx-surface)" stroke-width="2"/>`;
              }
              // Years label their lines at the end: this year always, the year before when it has room; the rest live in the tile and table.
              if (ln.endLabel && pts.length) {
                const b = box(e);
                if (ln.opacity === 1 || !yearLabels.some((o) => meets(o, b))) {
                  if (ln.opacity !== 1) yearLabels.push(b);
                  g += `<text x="${(b.right ? b.x : b.x + 30).toFixed(1)}" y="${b.y.toFixed(1)}" text-anchor="${b.right ? "start" : "end"}" class="${ln.opacity === 1 ? "yearlabel" : "tick"}">${esc(ln.endLabel)}</text>`;
                }
              }
            }
            // Secondary lines name themselves where they end, just past their last reading; crowded names step apart.
            // Where the right side is too narrow for them (a phone), they sit to the left of the line's end on their halo.
            const room = (x) => x + 8 + 84 <= padL + pw;
            const ends = s.lines.filter((ln) => ln.endName && ln.pts.length).map((ln) => { const e = ln.pts[ln.pts.length - 1], x = sx(e.t); return { x: room(x) ? x + 8 : x - 8, right: room(x), y: sy(e.v) + 4, text: ln.endName }; })
              .sort((a, b) => a.y - b.y);
            for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
            const over = ends.length ? ends[ends.length - 1].y - (padT + ph + 2) : 0;
            for (const l of ends) g += `<text x="${l.x.toFixed(1)}" y="${(l.y - Math.max(0, over)).toFixed(1)}" text-anchor="${l.right ? "start" : "end"}" class="tick halo">${esc(l.text)}</text>`;
          }
          geom.sy = sy;
        }
        g += `<line data-xh x1="0" x2="0" y1="0" y2="${H}" stroke="var(--wx-ink2)" visibility="hidden"/><g data-dots></g>`;
        this._mgGeom.strips.push(geom);
        return { s, H, svg: `<svg width="${W}" height="${H}" aria-hidden="true">${g}</svg>` };
      });

      this._redrawing = true;
      host.innerHTML = `<div class="mg" tabindex="0" role="img" style="--wx-tile:${tileW}px;row-gap:${gap}px" aria-label="${esc(`${spec.title}: ${spec.strips.map((s) => s.name.toLowerCase()).join(", ")}. Use the arrow keys to read values; the table view lists them.`)}">
        ${rows.map((r) => `${this._tileHtml(r, narrow)}<div class="mg-p" style="height:${r.H}px">${r.svg}</div>`).join("")}
        ${spec.key ? `<div class="mg-key small"><i class="${spec.key}"></i>forecast${this._fcCredit() ? ` · ${esc(this._fcCredit())}` : ""}</div>` : ""}
        <div class="mg-axis"><svg width="${W}" height="${axisH}" aria-hidden="true">${this._axis(spec, sx, padL, pw, markX)}<g data-xt visibility="hidden">
          <line data-xtl y1="0" y2="6" stroke="var(--wx-ink2)"/><rect data-xtb y="6" height="18" rx="4" fill="var(--wx-well)"/><text data-xtt y="19" text-anchor="middle" class="tick day now"></text></g></svg></div></div>`;
      this._redrawing = false;
      this._bindMeteogram();
      if (!this._arrived && Object.keys(this._stats ?? {}).length) {
        this._arrived = true;
        this._body.classList.add("arrive");
        setTimeout(() => this._body?.classList.remove("arrive"), 600);
      }
      // A redraw while someone is reading (a new forecast, the refresh, history arriving) keeps their place and focus.
      const keep = !!this._mgHold && this._mgRange === spec.range && this._mgT != null && this._mgT >= spec.x0 && this._mgT < spec.x1;
      if (this._mgFocus) this._root.querySelector(".mg")?.focus({ preventScroll: true });
      this._mgFocus = false;
      if (!keep) this._mgHold = null;
      this._mgShow(keep ? spec.snap(this._mgT) : null);
    }

    _axis(spec, sx, padL, pw, markX) {
      const f = this._m.f, out = [];
      const put = (x, text, day, now) => out.push(`<text x="${x.toFixed(1)}" y="19" text-anchor="middle" class="tick${day ? " day" : ""}${now ? " now" : ""}">${esc(text)}</text>`);
      // Night, once: a ribbon along the time axis instead of a shade in every well.
      for (const [a, b] of spec.night ?? []) out.push(`<rect x="${sx(a).toFixed(1)}" y="2" width="${(sx(b) - sx(a)).toFixed(1)}" height="3" rx="1.5" fill="var(--wx-ink2)" fill-opacity="0.35"/>`);
      if (spec.night?.length) out.push(`<text x="${(padL - 8).toFixed(1)}" y="9" text-anchor="end" class="tick">night</text>`);
      const clear = (x) => x >= padL + 14 && x <= padL + pw - 14 && (markX === null || Math.abs(x - markX) >= 34);
      if (spec.range === "hours") {
        const every = pw / ((spec.x1 - spec.x0) / HOUR) < 14 ? 12 : 6;
        for (let t = f.startOfHour(spec.x0 + HOUR - 1); t <= spec.x1; t += HOUR) {
          const h = f.parts(t).hour;
          if (h % every || !clear(sx(t))) continue;
          put(sx(t), h === 0 ? f.weekday(t) : f.hour(t), h === 0);
        }
      } else if (spec.range === "days") {
        const slot = pw / spec.days.length, every = Math.max(1, Math.ceil(52 / slot));
        spec.days.forEach((d, i) => {
          const today = i === spec.todayIdx;
          if (!today && ((spec.todayIdx - i) % every !== 0 || Math.abs(i - spec.todayIdx) < every)) return;
          put(padL + slot * (i + 0.5), today ? "Today" : f.dayLabel(d), today);
        });
      } else if (spec.range === "months") {
        const short = new Intl.DateTimeFormat(f.lang, { timeZone: f.tz, month: "short" });
        const every = pw / 12 < 40 ? 2 : 1;
        spec.months.forEach((mo, i) => {
          const x = sx(mo.t0 + (mo.t1 - mo.t0) / 2);
          if ((spec.months.length - 1 - i) % every || x < padL + 10 || x > padL + pw - 10) return;
          put(x, mo.mo === 1 ? String(mo.y) : short.format(mo.t0), mo.mo === 1);
        });
      } else {
        const short = new Intl.DateTimeFormat(f.lang, { timeZone: "UTC", month: "short" });
        for (let mo = 0; mo < 12; mo++) { const x = sx(Date.UTC(2001, mo, 15)); if (markX === null || Math.abs(x - markX) >= 30) put(x, short.format(Date.UTC(2001, mo, 15)), false); }
      }
      if (markX !== null && spec.markerLabel) put(markX, spec.markerLabel, true, true);
      return out.join("");
    }

    // How many lines a tile has under its headline: what its height allows; on a phone, one.
    _slots(s, H, narrow) {
      if (narrow) return s.empty ? 0 : 1;
      const base = this._headlineTier === "full" ? 56 : 46;
      return H >= base ? Math.max(0, Math.floor((H - base) / 18)) : 0;
    }

    // The tile: the strip's name, its headline at readout size, what the headline is, and companions as room allows.
    _tileHtml(r, narrow) {
      const s = r.s;
      if (s.empty && !s.zero) return `<div class="tile" style="${narrow ? "" : `height:${r.H}px`}"><div class="small tn">${esc(s.name)}</div></div>`;
      const size = narrow ? "" : s.empty ? " s" : this._headlineTier === "full" ? "" : r.H >= 46 ? " m" : " s";
      const extra = size === " s" ? 0 : this._slots(s, r.H, narrow);
      return `<div class="tile${size}" style="${narrow ? "" : `height:${r.H}px`}">
        <div class="small tn">${esc(s.name)}<span data-tq="${s.key}">${s.qual ? ` · ${esc(s.qual)}` : ""}</span></div>
        <div class="tv"><span data-tv="${s.key}"></span><span class="unit" data-tu="${s.key}"></span></div>
        ${extra ? `<div class="tls">${Array.from({ length: extra }, (_, i) => `<div class="small tl" data-tl="${s.key}-${i}"></div>`).join("")}</div>` : ""}</div>`;
    }

    _mgShow(t) {
      const G = this._mgGeom;
      if (!G || !this._root) return;
      const spec = G.spec;
      for (const geom of G.strips) {
        const s = geom.s;
        if (s.empty && !s.zero) continue;
        const v = t === null || s.empty ? s.head() : s.at(t);
        const tv = this._root.querySelector(`[data-tv="${s.key}"]`), tu = this._root.querySelector(`[data-tu="${s.key}"]`);
        const tq = this._root.querySelector(`[data-tq="${s.key}"]`);
        if (tq) tq.style.visibility = t === null ? "" : "hidden";
        if (tv) { if (t === null) this._swapText(tv, v.value); else if (tv.textContent !== v.value) tv.textContent = v.value; }
        if (tu) { const u = v.unit ?? ""; if (tu.textContent !== u) tu.textContent = u; tu.classList.toggle("pct", u === "%"); }
        // Caption first, then companion lines, into however many lines the tile has.
        const slots = this._root.querySelectorAll(`[data-tl^="${s.key}-"]`);
        const lines = fitLines(v, slots.length);
        slots.forEach((el) => {
          const ln = lines[Number(el.dataset.tl.slice(s.key.length + 1))];
          const html = ln ? `${ln.color ? `<i class="k${ln.dash ? " dash" : ln.dot ? " dot" : ""}" style="border-color:${ln.color}${ln.light && !ln.dot ? ";border-top-width:1px" : ""}"></i>` : ""}${esc(ln.text)}` : "";
          if (el.innerHTML !== html) el.innerHTML = html;
        });
      }
      const svgs = this._root.querySelectorAll(".mg-p svg");
      G.strips.forEach((geom, i) => {
        const svg = svgs[i];
        const xh = svg?.querySelector("[data-xh]"), dots = svg?.querySelector("[data-dots]");
        if (!xh) return;
        if (t === null) {
          xh.setAttribute("visibility", "hidden");
          if (dots) dots.innerHTML = "";
          svg.querySelectorAll("[data-bar]").forEach((p) => p.removeAttribute("opacity"));
          return;
        }
        const x = G.sx(t).toFixed(1);
        xh.setAttribute("x1", x); xh.setAttribute("x2", x); xh.setAttribute("visibility", "visible");
        const s = geom.s;
        if (s.kind === "bars") {
          svg.querySelectorAll("[data-bar]").forEach((p) => { const b = s.bars[Number(p.dataset.bar)]; p.setAttribute("opacity", t >= b.t0 && t < b.t1 ? "1" : "0.45"); });
        } else if (s.kind === "range") {
          svg.querySelectorAll("[data-bar]").forEach((p) => { const t0 = Number(p.dataset.bar); p.setAttribute("opacity", t >= t0 && t < t0 + DAY ? "1" : "0.45"); });
        } else if (dots && geom.sy) {
          const tol = spec.range === "hours" ? 8 * 60e3 : spec.range === "years" ? 20 * DAY : 2 * HOUR;
          dots.innerHTML = s.lines.filter((l) => !l.light && !l.draw && (l.opacity ?? 1) === 1).map((l) => {
            const p = nearest(l.pts, t, l.dash ? 40 * 60e3 : tol);
            return p ? `<circle cx="${G.sx(p.t).toFixed(1)}" cy="${geom.sy(p.v).toFixed(1)}" r="4" fill="${l.color}" stroke="var(--wx-surface)" stroke-width="2"/>` : "";
          }).join("");
        }
      });
      if (t === null) { if (this._hinted) this._chip(null); else this._mgHint(); }
      else {
        if (!this._hinted) { this._hinted = true; try { window.localStorage.setItem(HINT_KEY, "9"); } catch (e) { /* not remembered */ } }
        this._chip(spec.when(t), G.sx(t));
      }
      this._mgT = t;
      this._mgRange = spec.range;
    }

    // The chip on the axis: the time under the crosshair or, before the first reading, how to get one. It sits in
    // the axis, out of the layout, so a reading never moves anything; an axis label it touches steps aside whole.
    _chip(label, x, hint = false) {
      const xt = this._root.querySelector("[data-xt]");
      if (!xt) return;
      const labels = xt.ownerSVGElement.querySelectorAll(":scope > text");
      if (!label) { xt.setAttribute("visibility", "hidden"); labels.forEach((lab) => { lab.style.visibility = ""; }); return; }
      const txt = xt.querySelector("[data-xtt]"), bg = xt.querySelector("[data-xtb]"), tick = xt.querySelector("[data-xtl]");
      const right = Number(xt.ownerSVGElement.getAttribute("width"));
      if (txt.textContent !== label) txt.textContent = label;
      txt.setAttribute("class", hint ? "tick hint" : "tick day now");
      const w = txt.getComputedTextLength() + 16, cx = Math.max(w / 2, Math.min(right - w / 2, x));
      txt.setAttribute("x", cx.toFixed(1));
      bg.setAttribute("x", (cx - w / 2).toFixed(1));
      bg.setAttribute("width", w.toFixed(1));
      tick.setAttribute("x1", x.toFixed(1));
      tick.setAttribute("x2", x.toFixed(1));
      tick.setAttribute("visibility", hint ? "hidden" : "visible");
      xt.setAttribute("visibility", "visible");
      const lo = cx - w / 2 - 4, hi = cx + w / 2 + 4;
      labels.forEach((lab) => { const b = lab.getBBox(); lab.style.visibility = b.x < hi && b.x + b.width > lo ? "hidden" : ""; });
    }

    // Until the first reading, the chip says how to get one, in the widest gap between the axis labels, on a
    // browser's first three visits. A reading retires it for good.
    _mgHint() {
      if (this._hinted) return;
      let n = 0;
      try { n = Number(window.localStorage.getItem(HINT_KEY)) || 0; } catch (e) { n = 0; }
      if (n >= 3) { this._hinted = true; this._chip(null); return; }
      if (!this._hintCounted) { this._hintCounted = true; try { window.localStorage.setItem(HINT_KEY, String(n + 1)); } catch (e) { /* not remembered */ } }
      const G = this._mgGeom, xt = this._root.querySelector("[data-xt]");
      if (!G || !xt) return;
      const boxes = [...xt.ownerSVGElement.querySelectorAll(":scope > text")].map((l) => l.getBBox()).sort((a, b) => a.x - b.x);
      let best = { gap: -1, x: G.padL + G.pw / 2 }, prev = G.padL;
      for (const b of [...boxes, { x: G.padL + G.pw, width: 0 }]) {
        if (b.x - prev > best.gap) best = { gap: b.x - prev, x: (prev + b.x) / 2 };
        prev = Math.max(prev, b.x + b.width);
      }
      const touch = !!window.matchMedia?.("(hover: none)")?.matches;
      this._chip(touch ? "Drag to read" : "Hover or ← → to read", best.x, true);
    }

    _bindMeteogram() {
      const mg = this._root.querySelector(".mg");
      const G = this._mgGeom;
      if (!mg || !G) return;
      const spec = G.spec;
      const clampT = (t) => Math.max(spec.x0, Math.min(spec.x1 - 1, t));
      // Every plot shares one x origin, so a captured finger is read against the first plot wherever it has gone.
      const fromEvent = (e) => {
        const svg = e.target.closest?.(".mg-p svg, .mg-axis svg") ?? (this._mgTouch === e.pointerId ? mg.querySelector(".mg-p svg, .mg-axis svg") : null);
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        const x = e.clientX - r.left;
        if (x < G.padL || x > G.padL + G.pw) return null;
        return spec.snap(clampT(spec.x0 + ((x - G.padL) / G.pw) * (spec.x1 - spec.x0)));
      };
      const scrub = (e) => { const t = fromEvent(e); if (t !== null) { this._mgHold = "pointer"; this._mgShow(t); } };
      // A mouse reads by hovering. A finger or a pen reads by touching and dragging, captured so the reading follows
      // it off the plot, and let go when it lifts.
      mg.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "mouse" || !e.isPrimary) return;
        const t = fromEvent(e);
        if (t === null) return;
        this._mgTouch = e.pointerId;
        try { mg.setPointerCapture(e.pointerId); } catch (err) { /* already lifted */ }
        this._mgHold = "pointer";
        this._mgShow(t);
      });
      mg.addEventListener("pointermove", (e) => { if (e.pointerType === "touch" && this._mgTouch !== e.pointerId) return; scrub(e); });
      // A chart removed by a redraw is not the reader leaving it.
      const release = () => { this._mgTouch = null; if (mg.isConnected && !this._redrawing) { this._mgHold = null; this._mgShow(null); } };
      mg.addEventListener("pointerleave", release);
      mg.addEventListener("pointerup", (e) => { if (e.pointerType !== "mouse") release(); });
      mg.addEventListener("pointercancel", release);
      mg.addEventListener("contextmenu", (e) => { if (this._mgTouch !== null && this._mgTouch !== undefined) e.preventDefault(); });
      mg.addEventListener("blur", release);
      mg.addEventListener("keydown", (e) => {
        const step = e.shiftKey ? spec.bigStep : spec.step;
        const cur = this._mgT ?? spec.snap(spec.marker ?? spec.wash?.[0] ?? spec.x1 - 1);
        if (e.key === "ArrowLeft") { this._mgHold = "key"; this._mgShow(spec.snap(clampT(cur - step))); e.preventDefault(); }
        if (e.key === "ArrowRight") { this._mgHold = "key"; this._mgShow(spec.snap(clampT(cur + step))); e.preventDefault(); }
        if (e.key === "Escape") { this._mgHold = null; this._mgShow(null); }
      });
    }

    _tableHtml(spec) {
      const t = spec.table();
      if (!t.rows.length) return `<div class="table-wrap"><p class="small" style="padding:12px 0">${esc(spec.loading ? "Loading history…" : "No history recorded for this range yet.")}</p></div>`;
      return `<div class="table-wrap"><table><thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${
        t.rows.map((r) => `<tr class="${r.fc ? "fc" : ""}">${r.cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")
      }</tbody></table></div>`;
    }

    // The table as a file: the rows as shown, with the display's thin spaces, minus signs and dashes turned back into ASCII.
    _downloadCsv() {
      const spec = this._mgSpec, t = spec?.table?.();
      if (!t?.rows.length) return;
      const cell = (c) => { const v = String(c).replace(/\u00a0/g, " ").replace(/\u2212/g, "-").replace(/\u2014/g, ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
      const csv = [t.head, ...t.rows.map((r) => r.cells)].map((r) => r.map(cell).join(",")).join("\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
      a.download = `${this._slug}-${spec.range}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    /* ----- live values ----- */

    _applyLive(m = null) {
      if (!this._mounted || !this._ents || !this._root) return;
      this._ingestRapid();
      m = m ?? this._model();
      if (this._keyOf(m) !== this._bandsKey) { this._renderNow(m); return; }
      this._m = m;
      const f = m.f;
      // The large figures crossfade when they change; the rest is set in place.
      const set = (k, v, fade = false) => this._root.querySelectorAll(`[data-k="${k}"]`).forEach((el) => { if (fade) this._swapText(el, v); else if (el.textContent !== v) el.textContent = v; });
      const T = m.temp, W = m.wind, St = m.station;

      set("clock", `${f.weekday(m.now)}, ${f.date(m.now)} · ${f.time(m.now)}`);
      const age = St.obs === null ? null : m.now - St.obs;
      const fresh = age !== null && age < 3 * 60e3;
      set("live", age === null ? "No report yet" : fresh ? "Live" : `Last report ${f.ago(age)}`);
      this._root.querySelectorAll('[data-k="live-cls"]').forEach((el) => { el.className = `status ${fresh ? "good" : "warn"}`; el.title = this._stationNote(m); });
      const al = this._root.querySelector('[data-k="alerts"]');
      if (al) { const html = this._alerts(m); if (al.innerHTML !== html) al.innerHTML = html; }
      set("t", f.num(T.v, 1), true);
      set("feels", `${f.num(T.feels, 1)}°`, true);
      set("lede", m.lede);
      this._reserveLede();
      set("ws", f.num(W.v, 1), true);
      set("wfrom", W.card); set("wdeg", W.dir === null ? "" : `${f.num(W.dir)}°`);
      set("gustlull", W.gust === null ? "" : `Gusts ${f.num(W.gust, 1)}, lulls ${f.num(W.lull, 1)}${NB}${W.unit}`);
      set("rosecap", W.roseSpan > 0
        ? `Red arrow: blowing toward. Ring: last 10${NB}min. Petals: ${W.roseSpan > 23.5 * HOUR ? `last 24${NB}h` : `since ${f.time(m.now - W.roseSpan)}`}.`
        : "Red arrow: blowing toward. Ring: last 10 min. Petals fill in as the wind is recorded.");
      const Sn = m.sun;
      set("daylen", Sn.rise && Sn.set ? `${f.dur(Sn.set - Sn.rise)} of daylight` : "");
      set("irr", f.num(Sn.irr), true);
      // By the sun's height: civil twilight is dawn or dusk, the first six degrees are golden hour, above ten the sky's clarity.
      const pm = f.parts(m.now).hour >= 12;
      set("sunline1", Sn.el > 10 && Sn.pct !== null ? `${f.num(Math.min(Sn.pct, 1.5) * 100)}% of a clear sky` : Sn.el > 6 ? "" : Sn.el > 0 ? "Golden hour" : Sn.el > -6 ? (pm ? "Dusk" : "Dawn") : "");
      set("sunenergy", Sn.kwh === null ? "" : `${f.num(Sn.kwh, 1)}${NB}kWh/m² today`);
      set("sunline2", !Sn.next ? "" : Sn.next.t - m.now <= 60 * 60e3 ? `${Sn.next.word === "Rises" ? "Sunrise" : "Sunset"} in ${f.dur(Sn.next.t - m.now)}, at ${f.time(Sn.next.t)}` : `${Sn.next.word} ${f.time(Sn.next.t)}, in ${f.dur(Sn.next.t - m.now)}`);
      if (W.bf) { set("bf-v", W.bf.word); set("bf-n", `force ${W.bf.i}`); }
      if (m.pres.tend) { set("tend-v", m.pres.tend.word); set("tend-n", tendIn(f, m.pres.tend.dHpa, m.pres.unit).text); }
      else set("tend-n", m.pres.have >= 60e3 ? f.dur(m.pres.have) : "");
      if (m.moist.comfort) { set("comfort-v", m.moist.comfort.word); set("comfort-n", `${f.num(m.moist.dew, 1)}°`); }
      if (m.sun.uvs) { set("uv-v", m.sun.uvs.word); set("uv-n", f.num(m.sun.uv, 1)); }
      if (m.rain.rs) set("rate-n", `${f.num(m.rain.rate, m.rain.unit === "in" ? 2 : 1)}${NB}${m.rain.rateUnit}`);
      if (T.lo && T.hi) set("today-v", `${span2(f.num(T.lo.v, 1), f.num(T.hi.v, 1))}°`, true);
      if (this._mgT === null || this._mgT === undefined) this._mgShow(null);

      // Marks move without a re-render while the reading stays in its band.
      const moveMark = (id, pos) => {
        const at = this._scaleGeom?.[id];
        const el = this._root.querySelector(`[data-pos="${id}"]`);
        if (at && el && pos) el.style.left = at(pos.i, pos.f);
      };
      if (W.bf) moveMark("bf", W.bf);
      if (m.pres.tend) moveMark("tend", m.pres.tend);
      if (m.moist.comfort) moveMark("comfort", m.moist.comfort);
      if (m.sun.uvs) moveMark("uv", m.sun.uvs);
      if (m.rain.rs) moveMark("rate", m.rain.rs);

      // Needle: follow the shortest turn so 350° → 10° doesn't spin backwards, and glide to each 3-second sample over
      // the gap since the one before, as a damped vane would: always heading for the latest reading, never past it.
      const g = this._root.querySelector("[data-needle]");
      if (g && W.dir !== null) {
        const cur = this._needleAngle;
        let next = W.dir;
        if (cur !== undefined) { const d = ((W.dir - cur) % 360 + 540) % 360 - 180; next = cur + d; }
        if (next !== cur) {
          const R = this._rapid, gap = R.length > 1 ? R[R.length - 1].t - R[R.length - 2].t : 3000;
          g.style.transitionDuration = cur === undefined ? "0ms" : `${Math.round(Math.max(1000, Math.min(6000, gap)))}ms`;
          this._needleAngle = next;
          g.style.transform = `rotate(${next.toFixed(1)}deg)`;
        }
        g.classList.toggle("calm", !!W.bf && W.bf.i === 0);
      }
      this._root.querySelectorAll("[data-ring]").forEach((seg, i) => {
        const v = W.ring ? W.ring[i] : 0, o = v < 0.04 ? "0" : (0.12 + 0.5 * v).toFixed(2);
        if (seg.style.strokeOpacity !== o) seg.style.strokeOpacity = o;
      });
    }

    // The station's details, on the status: quiet unless something needs saying (then it is an alert).
    _stationNote(m) {
      const f = m.f, St = m.station;
      const dev = this._slug.replace(/^st_/, "ST-").toUpperCase();
      return [`Tempest ${dev}`, St.obs ? `reported ${f.ago(m.now - St.obs)}` : "",
        St.bv === null ? "" : `battery ${f.num(St.bv, 2)} V, ${St.mode === 0 ? POWER[0].label : St.mode === 0.5 ? "near power save" : POWER[Math.floor(St.mode)].label}`,
        ].filter(Boolean).join(" · ");
    }
  }

  customElements.define(TAG, TempestStationCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: TAG, name: "Tempest Station Card", description: "A WeatherFlow Tempest station: the reading now in plain words, wind and sun, and a meteogram from hours to years.",
    preview: false, documentationURL: "https://github.com/Treehouse-00/tempest-station-card" });
  console.info(`%c${TAG} ${VERSION}`, "color:#898781");
})();
