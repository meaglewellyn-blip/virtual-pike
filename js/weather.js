/* Virtual Pike — Weather module
 * Fetches from Open-Meteo (free, no API key) and renders a weather strip on Today.
 * Caches in localStorage for 30 minutes to avoid hammering the API.
 */

(function (global) {
  'use strict';

  const LAT = 34.0232;
  const LON = -84.3616;
  const CACHE_KEY = 'pike_weather_v2';
  const CACHE_TTL_MS = 30 * 60 * 1000;

  const WMO = {
    0:  { label: 'Clear',          icon: '☀️' },
    1:  { label: 'Mostly clear',   icon: '🌤️' },
    2:  { label: 'Partly cloudy',  icon: '⛅' },
    3:  { label: 'Overcast',       icon: '☁️' },
    45: { label: 'Foggy',          icon: '🌫️' },
    48: { label: 'Foggy',          icon: '🌫️' },
    51: { label: 'Drizzle',        icon: '🌦️' },
    53: { label: 'Drizzle',        icon: '🌦️' },
    55: { label: 'Drizzle',        icon: '🌦️' },
    61: { label: 'Rain',           icon: '🌧️' },
    63: { label: 'Rain',           icon: '🌧️' },
    65: { label: 'Heavy rain',     icon: '🌧️' },
    71: { label: 'Snow',           icon: '❄️' },
    73: { label: 'Snow',           icon: '❄️' },
    75: { label: 'Heavy snow',     icon: '❄️' },
    80: { label: 'Showers',        icon: '🌦️' },
    81: { label: 'Showers',        icon: '🌦️' },
    82: { label: 'Heavy showers',  icon: '🌧️' },
    95: { label: 'Thunderstorm',   icon: '⛈️' },
    96: { label: 'Thunderstorm',   icon: '⛈️' },
    99: { label: 'Severe storm',   icon: '⛈️' },
  };

  function wmo(code) {
    return WMO[code] || { label: '—', icon: '🌡️' };
  }

  function fmtHour(isoStr) {
    const d = new Date(isoStr);
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h} ${ampm}`;
  }

  let cached = null;

  async function load() {
    // Try cache first
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const c = JSON.parse(raw);
        if (Date.now() - c.fetchedAt < CACHE_TTL_MS) {
          cached = c;
          render(c);
          return;
        }
      }
    } catch (_) {}

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${LAT}&longitude=${LON}` +
      `&current=temperature_2m,weathercode,apparent_temperature` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&hourly=temperature_2m,precipitation_probability,weathercode` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch` +
      `&timezone=America%2FNew_York&forecast_days=2`;

    try {
      const res = await window.fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const data = {
        fetchedAt: Date.now(),
        current: {
          temp:      Math.round(json.current.temperature_2m),
          feelsLike: Math.round(json.current.apparent_temperature),
          code:      json.current.weathercode,
        },
        daily: {
          high:         Math.round(json.daily.temperature_2m_max[0]),
          low:          Math.round(json.daily.temperature_2m_min[0]),
          precipChance: json.daily.precipitation_probability_max[0],
        },
        hourly: json.hourly.time.map((t, i) => ({
          time:   t,
          temp:   Math.round(json.hourly.temperature_2m[i]),
          precip: json.hourly.precipitation_probability[i],
          code:   json.hourly.weathercode[i],
        })),
      };
      cached = data;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
      render(data);
    } catch (e) {
      console.info('Pike: weather fetch failed', e);
    }
  }

  function render(data) {
    const el = document.getElementById('today-weather');
    if (!el || !data) return;

    const condition = wmo(data.current.code);
    const nowHour = new Date().getHours();

    // Show the next 10 hours starting from the current hour.
    // Uses timestamp comparison so the window crosses midnight naturally —
    // not capped to any day boundary or planner window.
    const HOURS_AHEAD = 10;
    const windowStart = new Date();
    windowStart.setMinutes(0, 0, 0);  // snap to top of current hour
    const windowEndMs = windowStart.getTime() + HOURS_AHEAD * 60 * 60 * 1000;

    const upcoming = data.hourly
      .filter((h) => {
        const t = new Date(h.time).getTime();
        return t >= windowStart.getTime() && t <= windowEndMs;
      })
      .slice(0, HOURS_AHEAD + 1);

    const hourCells = upcoming.map((h) => {
      const hTime = new Date(h.time);
      const isNow = hTime.getTime() === windowStart.getTime();
      const precipHTML = h.precip >= 20
        ? `<span class="wx-precip">${h.precip}%</span>`
        : '';
      return `
        <div class="wx-hour${isNow ? ' is-now' : ''}">
          <div class="wx-hour-label">${isNow ? 'Now' : fmtHour(h.time)}</div>
          <div class="wx-hour-icon">${wmo(h.code).icon}</div>
          <div class="wx-hour-temp">${h.temp}°</div>
          ${precipHTML}
        </div>`;
    }).join('');

    const precipSuffix = data.daily.precipChance >= 20
      ? ` · ${data.daily.precipChance}% rain`
      : '';

    el.hidden = false;
    el.innerHTML = `
      <div class="wx-current">
        <span class="wx-icon-lg">${condition.icon}</span>
        <div class="wx-summary">
          <div class="wx-temp-main">${data.current.temp}°</div>
          <div class="wx-condition">${condition.label} &nbsp;·&nbsp; H:${data.daily.high}° L:${data.daily.low}°${precipSuffix}</div>
        </div>
        <div class="wx-location">Roswell, GA</div>
      </div>
      <div class="wx-hourly">${hourCells}</div>
    `;
  }

  global.Pike = global.Pike || {};
  global.Pike.weather = { load, render: () => cached && render(cached) };
})(window);
