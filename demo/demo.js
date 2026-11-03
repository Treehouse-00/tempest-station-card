// Demo: the card running against a mock Home Assistant with a synthetic station, so it can be tried in a
// browser before installing. A day of 5-minute statistics, two years of daily history, a forecast, and live
// wind every 3 seconds, all invented. Query options: theme=dark, units=metric, lang=de, clock=24,
// at=HH:MM, storm=now, range=days|months|years, history=<days>, w=<px>.
(() => {
  const ID = (k) => `sensor.st_00012345_${k}`;
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark";
  const width = params.get("w");
  const stormNow = params.get("storm") === "now";

  // ?at=13:30 moves the clock to that local (PST) time today, to render daylight states.
  const at = params.get("at");
  if (at) {
    const [hh, mm] = at.split(":").map(Number);
    const real = Date.now();
    const midnight = Math.floor((real - 8 * 3600e3) / 864e5) * 864e5 + 8 * 3600e3;
    const offset = midnight + (hh * 60 + mm) * 60e3 - real;
    const orig = Date.now.bind(Date);
    Date.now = () => orig() + offset;
  }

  document.documentElement.dataset.theme = dark ? "dark" : "light";
  // ?shot=1 hides the harness nav before the card mounts, so the card measures the window it will really get.
  if (params.get("shot")) document.body.classList.add("shot");
  if (width) document.querySelector("#stage").style.maxWidth = `${width}px`;
  for (const a of document.querySelectorAll("nav a")) {
    const u = new URL(a.href);
    const here = [...u.searchParams].every(([k, v]) => (params.get(k) || { theme: "light", w: "", units: "", range: "", storm: "" }[k]) === v);
    if (here) a.setAttribute("aria-current", "true");
  }

  function st(eid, state, attrs, t) {
    const iso = new Date(t).toISOString();
    return { entity_id: eid, state: String(state), attributes: attrs, last_updated: iso, last_changed: iso, last_reported: iso };
  }

  function synthForecast(now, base, bias, wet) {
    const hourly = [];
    const h0 = Math.ceil(now / 3600e3) * 3600e3;
    for (let t = h0; t < now + 48 * 3600e3; t += 3600e3) {
      const hl = (((t / 3600e3 - 8) % 24) + 24) % 24;
      const ahead = (t - now) / 3600e3;
      const breeze = Math.max(0, Math.sin(((hl - 10) / 10) * Math.PI));
      hourly.push({
        datetime: new Date(t).toISOString(),
        temperature: Math.round(base - 2 + bias + 8 * Math.sin(((hl - 9) / 24) * 2 * Math.PI)),
        wind_speed: Math.round((3 + 7 * breeze) * 10) / 10, humidity: Math.round(78 - 18 * breeze),
        precipitation: wet && ahead > 5 && ahead < 9 ? 0.03 : 0,
      });
    }
    const daily = [];
    const d0 = Math.floor((now - 8 * 3600e3) / 864e5) * 864e5 + 8 * 3600e3 + 12 * 3600e3;
    for (let i = 0; i < 7; i++) daily.push({ datetime: new Date(d0 + i * 864e5).toISOString(), temperature: base + 6 + bias - (i % 3), templow: base - 10 + bias + (i % 2), precipitation: wet && i === 2 ? 0.12 : 0 });
    return { hourly, daily };
  }

  function synthFixture(now) {
    const stats = {};
    const add = (k, row) => (stats[ID(k)] ??= []).push(row);
    const t0 = Math.floor((now - 864e5) / 300e3) * 300e3;
    const rnd = mulberry(7);
    const clearSkyAt = (t) => {
      const el = sunEl(t, 37.7749, -122.4194);
      return el > 0 ? 1098 * Math.sin((el * Math.PI) / 180) * Math.exp(-0.057 / Math.sin((el * Math.PI) / 180)) : 0;
    };
    let last = {};
    for (let s = t0; s < now - 300e3; s += 300e3) {
      const hl = (((s / 3600e3 - 8) % 24) + 24) % 24;
      const ago = (now - s) / 3600e3;
      const shower = stormNow ? ago < 1.4 : ago < 6 && ago > 4.5;
      const storm = stormNow ? ago < 1.8 : ago < 6.6 && ago > 5;
      const showerPhase = stormNow ? Math.min(1, (1.4 - ago) / 1.4) : (6 - ago) / 1.5;
      const T = 62 + 8 * Math.sin(((hl - 9) / 24) * 2 * Math.PI) - (shower ? 4 * Math.sin(showerPhase * Math.PI * (stormNow ? 0.5 : 1)) : 0) + (rnd() - 0.5) * 0.4;
      const Td = 55 + 2.5 * Math.sin(((hl - 12) / 24) * 2 * Math.PI) + (shower ? 1.5 : 0) + (rnd() - 0.5) * 0.3;
      const c = (f) => ((f - 32) * 5) / 9;
      const rh = Math.min(100, (100 * Math.exp((17.625 * c(Td)) / (243.04 + c(Td)))) / Math.exp((17.625 * c(T)) / (243.04 + c(T))));
      const P = 29.86 - 0.0045 * (24 - ago) + 0.012 * Math.sin(((hl - 10) / 12) * 2 * Math.PI) - (storm ? 0.015 : 0);
      const breeze = Math.max(0, Math.sin(((hl - 10) / 10) * Math.PI));
      const avg = 2.2 + 8 * breeze + (storm ? 9 : 0) + rnd() * 1.2;
      const dir = breeze > 0.15 ? 245 + (rnd() - 0.5) * 30 : 25 + (rnd() - 0.5) * 50;
      const cloud = shower ? 0.25 : storm ? 0.45 : hl > 13 && hl < 15 ? 0.7 : 0.92;
      const irr = clearSkyAt(s + 150e3) * cloud;
      const rate = shower ? (stormNow ? 0.12 + 0.25 * showerPhase : 0.28 * Math.sin(showerPhase * Math.PI)) : 0;
      const strikes = storm ? Math.floor(rnd() * 4) : 0;
      const row = (mean, spread = 0) => ({ start: s, end: s + 300e3, mean, min: mean - spread, max: mean + spread });
      add("temperature", row(T, 0.3));
      add("dew_point", row(Td, 0.2));
      add("humidity", row(rh, 0.8));
      add("air_pressure", row(P, 0.002));
      add("wind_speed_average", row(avg, 0.6));
      add("wind_speed", row(avg, avg * 0.5));
      add("wind_direction", row(dir, 10));
      add("wind_gust", row(avg * 1.6, avg * 0.3));
      add("wind_lull", row(avg * 0.45, avg * 0.2));
      add("irradiance", row(irr, irr * 0.05));
      add("uv_index", row(irr / 105, 0.1));
      add("precipitation", { start: s, end: s + 300e3, change: (rate * 5) / 60 });
      add("lightning_count", { start: s, end: s + 300e3, change: strikes });
      // Derived series as the WeatherFlow integration reports them: wet bulb (Stull 2011), vapor pressure, air density.
      const Tc = c(T), Tdc = c(Td);
      const twc = Tc * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(Tc + rh) - Math.atan(rh - 1.676331)
        + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
      const Tw = twc * 9 / 5 + 32;
      const eHpa = 6.112 * Math.exp((17.62 * Tdc) / (243.12 + Tdc));
      const rho = ((P * 33.8639 - eHpa) * 100) / (287.05 * (Tc + 273.15)) + (eHpa * 100) / (461.5 * (Tc + 273.15));
      add("wet_bulb_temperature", row(Tw, 0.2));
      add("feels_like", row(T, 0.3));
      add("vapor_pressure", row(eHpa / 33.8639, 0.002));
      add("air_density", row(rho, 0.001));
      add("illuminance", row(irr * 120, irr * 6));
      add("precipitation_intensity", { start: s, end: s + 300e3, mean: rate, min: rate * 0.6, max: rate * 1.3 });
      add("battery_voltage", row(2.6 + 0.04 * Math.max(0, Math.sin(((hl - 7) / 12) * Math.PI)), 0.002));
      last = { T, Td, rh, P, avg, dir, irr, rate, Tw, eHpa, rho };
    }
    // Long-term daily statistics, about 800 days, seasonal like Los Angeles: warm late summer, winter rain,
    // the odd winter storm with lightning; each year a little different so year-over-year lines separate.
    const daily = {};
    const nDays = Number(params.get("history") ?? 800);
    const rd = mulberry(3);
    const today0 = Math.floor((now - 8 * 3600e3) / 864e5) * 864e5 + 8 * 3600e3;
    const push = (k, row) => (daily[ID(k)] ??= []).push(row);
    for (let i = nDays - 1; i >= 0; i--) {
      const t = today0 - i * 864e5;
      const dt = new Date(t - 8 * 3600e3);
      const doy = Math.floor((Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - Date.UTC(dt.getUTCFullYear(), 0, 1)) / 864e5);
      const yr = dt.getUTCFullYear(), mo = dt.getUTCMonth();
      const yb = { 2024: 0.6, 2025: -0.9, 2026: 0.4 }[yr] ?? 0;
      const tm = 63.5 + yb + 8.5 * Math.sin((2 * Math.PI * (doy - 129)) / 365) + (rd() - 0.5) * 4;
      const wet = (mo <= 2 || mo >= 10) && rd() < (yr === 2024 ? 0.16 : 0.1);
      const rain = wet ? 0.05 + rd() ** 2 * 1.3 : 0;
      const w = 3.6 + 1.6 * Math.sin((2 * Math.PI * (doy - 100)) / 365) + rd() * 1.5 + (wet ? 3 : 0);
      const pm = 29.9 + 0.08 * Math.cos((2 * Math.PI * doy) / 365) + (rd() - 0.5) * 0.12 - (wet ? 0.12 : 0);
      const hm = Math.min(96, 68 + (rd() - 0.5) * 16 + (wet ? 14 : 0));
      const irr = Math.max(20, (185 + 80 * Math.sin((2 * Math.PI * (doy - 80)) / 365)) * (wet ? 0.45 : 1) * (0.85 + rd() * 0.15));
      push("temperature", { start: t, end: t + 864e5, mean: tm, min: tm - 7 - rd() * 3, max: tm + 7 + rd() * 4 });
      push("precipitation", { start: t, end: t + 864e5, change: rain });
      push("lightning_count", { start: t, end: t + 864e5, change: wet && rd() < 0.15 ? Math.floor(rd() * 45) : 0 });
      push("wind_speed_average", { start: t, end: t + 864e5, mean: w });
      push("wind_gust", { start: t, end: t + 864e5, max: w * 2.4 + rd() * 6 });
      push("wind_lull", { start: t, end: t + 864e5, min: Math.max(0, w * 0.2 - 0.5) });
      push("air_pressure", { start: t, end: t + 864e5, mean: pm, min: pm - 0.05, max: pm + 0.06 });
      push("humidity", { start: t, end: t + 864e5, mean: hm, min: hm - 26, max: Math.min(100, hm + 16) });
      push("irradiance", { start: t, end: t + 864e5, mean: irr });
    }
    // Monthly statistics aggregated from the days, as the recorder builds them.
    const monthly = {};
    for (const [id, rows] of Object.entries(daily)) {
      const by = new Map();
      for (const r of rows) {
        const d = new Date(r.start - 8 * 3600e3), key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        if (!by.has(key)) by.set(key, { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + 8 * 3600e3, rows: [] });
        by.get(key).rows.push(r);
      }
      monthly[id] = [...by.values()].map(({ start, rows: rs }) => {
        const out = { start, end: start + 28 * 864e5 };
        const fin = (k) => rs.map((r) => r[k]).filter((v) => Number.isFinite(v));
        if (fin("mean").length) out.mean = fin("mean").reduce((a, b) => a + b, 0) / fin("mean").length;
        if (fin("min").length) out.min = Math.min(...fin("min"));
        if (fin("max").length) out.max = Math.max(...fin("max"));
        if (fin("change").length) out.change = fin("change").reduce((a, b) => a + b, 0);
        return out;
      });
    }
    const tA = { unit_of_measurement: "°F", device_class: "temperature", state_class: "measurement" };
    const S = {
      temperature: [last.T, tA], feels_like: [last.T, tA], dew_point: [last.Td, tA], wet_bulb_temperature: [last.Tw, tA],
      humidity: [last.rh, { unit_of_measurement: "%" }], air_pressure: [last.P, { unit_of_measurement: "inHg" }],
      wind_speed: [last.avg, { unit_of_measurement: "mph" }], wind_direction: [last.dir, { unit_of_measurement: "°" }],
      wind_speed_average: [last.avg, { unit_of_measurement: "mph" }], wind_direction_average: [last.dir, { unit_of_measurement: "°" }],
      wind_gust: [last.avg * 1.6, { unit_of_measurement: "mph" }], wind_lull: [last.avg * 0.45, { unit_of_measurement: "mph" }],
      irradiance: [Math.round(last.irr), { unit_of_measurement: "W/m²" }], illuminance: [Math.round(last.irr * 120), { unit_of_measurement: "lx" }],
      uv_index: [last.irr / 105, { unit_of_measurement: "UV index" }], precipitation: [stormNow ? 0.006 : 0, { unit_of_measurement: "in" }],
      precipitation_intensity: [stormNow ? last.rate : 0, { unit_of_measurement: "in/h" }], precipitation_type: [stormNow ? "rain" : "none", {}],
      lightning_count: [0, {}], lightning_last_distance: [stormNow ? 3 : 9, { unit_of_measurement: "mi" }],
      lightning_last_strike: [new Date(now - (stormNow ? 4 * 60e3 : 5.2 * 3600e3)).toISOString(), { device_class: "timestamp" }],
      lightning_average_distance: [11, { unit_of_measurement: "mi" }], battery_voltage: [2.61, { unit_of_measurement: "V" }],
      vapor_pressure: [last.eHpa / 33.8639, { unit_of_measurement: "inHg" }], air_density: [last.rho, { unit_of_measurement: "kg/m³" }],
    };
    const states = {};
    for (const [k, [v, a]] of Object.entries(S)) states[ID(k)] = st(ID(k), v, a, now - 20e3);
    states["weather.forecast_home"] = st("weather.forecast_home", "partlycloudy", { temperature_unit: "°F", wind_speed_unit: "mph", precipitation_unit: "in", attribution: "Weather forecast from met.no, delivered by the Norwegian Meteorological Institute." }, now - 600e3);
    return { config: { latitude: 37.7749, longitude: -122.4194, elevation: 16, time_zone: "America/Los_Angeles" }, states, stats, daily, monthly, forecast: synthForecast(now, 63, 0, true) };
  }

  function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function sunEl(t, lat, lon) {
    const R = Math.PI / 180, d = t / 864e5 - 10957.5, g = (357.529 + 0.98560028 * d) * R, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R, e = (23.439 - 3.6e-7 * d) * R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ha = ((18.697374558 + 24.06570982441908 * d) * 15 + lon) * R - ra;
    return Math.asin(Math.sin(lat * R) * Math.sin(dec) + Math.cos(lat * R) * Math.cos(dec) * Math.cos(ha)) / R;
  }

  const now = Date.now();
  const fx = synthFixture(now);
  // ?units=metric reports the whole fixture as a metric install would; ?lang=en-GB sets a 24-hour locale;
  // ?loc=sf moves the station to a public place, for screenshots.
  if (params.get("empty")) { fx.stats = {}; fx.daily = {}; fx.monthly = {}; }
  if (params.get("nofc")) { delete fx.states["weather.forecast_home"]; }
  if (params.get("nostation")) { for (const k of Object.keys(fx.states)) if (k.startsWith("sensor.st_")) delete fx.states[k]; }
  if (params.get("nowd")) { delete fx.states[ID("wind_direction_average")]; }
  if (params.get("stale")) { for (const [k, v] of Object.entries(fx.states)) if (k.startsWith("sensor.st_")) { const iso = new Date(now - 20 * 60e3).toISOString(); fx.states[k] = { ...v, last_updated: iso, last_changed: iso, last_reported: iso }; } }
  if (params.get("statsfail")) fx.statsFail = true;
  if (params.get("units") === "metric") toMetric(fx);
  function toMetric(fx) {
    const conv = { "°F": ["°C", (v) => ((v - 32) * 5) / 9], mph: ["km/h", (v) => v * 1.609344], inHg: ["hPa", (v) => v * 33.8639],
      in: ["mm", (v) => v * 25.4], "in/h": ["mm/h", (v) => v * 25.4], mi: ["km", (v) => v * 1.609344] };
    const unitOf = {};
    for (const [id, s] of Object.entries(fx.states)) {
      const c = conv[s.attributes?.unit_of_measurement];
      if (!c) continue;
      unitOf[id] = c;
      const v = parseFloat(s.state);
      fx.states[id] = { ...s, state: Number.isFinite(v) ? String(Math.round(c[1](v) * 1000) / 1000) : s.state, attributes: { ...s.attributes, unit_of_measurement: c[0] } };
    }
    for (const src of [fx.stats, fx.daily, fx.monthly]) for (const [id, rows] of Object.entries(src ?? {})) {
      const c = unitOf[id];
      if (c) for (const r of rows) for (const k of ["mean", "min", "max", "change"]) if (Number.isFinite(r[k])) r[k] = c[1](r[k]);
    }
    for (const list of Object.values(fx.forecast)) for (const x of list) {
      if (x.temperature != null) x.temperature = conv["°F"][1](x.temperature);
      if (x.templow != null) x.templow = conv["°F"][1](x.templow);
      if (x.wind_speed != null) x.wind_speed *= 1.609344;
      if (x.precipitation != null) x.precipitation *= 25.4;
    }
    const w = fx.states["weather.forecast_home"];
    if (w) w.attributes = { ...w.attributes, temperature_unit: "°C", wind_speed_unit: "km/h", precipitation_unit: "mm" };
  }
  const calls = [];
  window.WX_CALLS = calls;

  const makeHass = (states) => ({
    states, config: fx.config, themes: { darkMode: dark }, locale: { language: params.get("lang") || "en", time_format: params.get("clock") || "language" }, language: params.get("lang") || "en",
    callWS: async (msg) => {
      calls.push(msg);
      if (msg.type !== "recorder/statistics_during_period") throw new Error(`unsupported ${msg.type}`);
      if (fx.statsFail) throw new Error("Unknown command: recorder/statistics_during_period");
      const src = msg.period === "month" ? fx.monthly ?? {} : msg.period === "day" ? fx.daily : fx.stats;
      const s0 = Date.parse(msg.start_time), s1 = msg.end_time ? Date.parse(msg.end_time) : Infinity;
      const out = {};
      for (const id of msg.statistic_ids) {
        const rows = (src[id] ?? []).filter((r) => r.start >= s0 && r.start < s1);
        if (rows.length) out[id] = rows;
      }
      return out;
    },
    connection: {
      subscribeMessage: async (cb, msg) => {
        calls.push(msg);
        setTimeout(() => cb({ type: msg.forecast_type, forecast: fx.forecast[msg.forecast_type] }), 50);
        return () => {};
      },
    },
  });

  const card = document.createElement("tempest-station-card");
  card.setConfig({ type: "custom:tempest-station-card", ...(params.get("station") ? { station: params.get("station") } : {}), ...(params.get("range") ? { range: params.get("range") } : {}) });
  document.querySelector("#stage").append(card);
  let states = fx.states;
  card.hass = makeHass(states);

  // Replay rapid wind every 3 s around the current reading.
  const ws = states[ID("wind_speed")], wd = states[ID("wind_direction")];
  if (!ws || !wd || params.get("stale")) return;
  const base = { s: parseFloat(ws.state), d: parseFloat(wd.state) };
  const r = mulberry(11);
  setInterval(() => {
    const t = Date.now();
    states = { ...states,
      [ID("wind_speed")]: st(ID("wind_speed"), Math.max(0, base.s + (r() - 0.5) * 2).toFixed(2), ws.attributes, t),
      [ID("wind_direction")]: st(ID("wind_direction"), Math.round((base.d + (r() - 0.5) * 50 + 360) % 360), wd.attributes, t),
    };
    card.hass = makeHass(states);
  }, 3000);
})();
