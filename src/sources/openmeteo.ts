import { buildUrl, getJson } from "../lib/http.js";
import type { Location } from "../lib/geo.js";

export type Units = "metric" | "imperial";

const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export function describeWeatherCode(code: number | null | undefined): string {
  if (code === null || code === undefined) return "Unknown";
  return WMO_CODES[code] ?? `Weather code ${code}`;
}

function unitParams(units: Units) {
  return units === "imperial"
    ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" }
    : { temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm" };
}

const CURRENT_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation",
  "rain",
  "showers",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "pressure_msl",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "visibility",
  "uv_index",
  "cape",
  "is_day",
];

const HOURLY_VARS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "dew_point_2m",
  "precipitation_probability",
  "precipitation",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "cape",
  "lifted_index",
  "freezing_level_height",
  "visibility",
  "uv_index",
];

const DAILY_VARS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "precipitation_sum",
  "precipitation_probability_max",
  "precipitation_hours",
  "snowfall_sum",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "wind_direction_10m_dominant",
  "uv_index_max",
  "sunrise",
  "sunset",
];

/** Turns Open-Meteo's column-oriented arrays into a list of row objects. */
export function columnsToRows(block: Record<string, unknown[]> | undefined, limit?: number): Record<string, unknown>[] {
  if (!block || !Array.isArray(block.time)) return [];
  const keys = Object.keys(block);
  const n = limit ? Math.min(limit, block.time.length) : block.time.length;
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (const k of keys) row[k] = (block[k] as unknown[])[i];
    if (typeof row.weather_code === "number") row.weather = describeWeatherCode(row.weather_code as number);
    rows.push(row);
  }
  return rows;
}

export async function getCurrent(loc: Location, units: Units) {
  const url = buildUrl("https://api.open-meteo.com/v1/forecast", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    current: CURRENT_VARS.join(","),
    timezone: "auto",
    ...unitParams(units),
  });
  const data = await getJson(url, { ttl: 300 });
  const current = { ...data.current };
  current.weather = describeWeatherCode(current.weather_code);
  return {
    location: loc,
    timezone: data.timezone,
    elevation_m: data.elevation,
    units: data.current_units,
    current,
  };
}

export interface ForecastOptions {
  units: Units;
  days: number;
  hourly: boolean;
  hours: number;
  model?: string;
}

export async function getForecast(loc: Location, opts: ForecastOptions) {
  const url = buildUrl("https://api.open-meteo.com/v1/forecast", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    daily: DAILY_VARS.join(","),
    hourly: opts.hourly ? HOURLY_VARS.join(",") : undefined,
    forecast_days: opts.days,
    timezone: "auto",
    models: opts.model,
    ...unitParams(opts.units),
  });
  const data = await getJson(url, { ttl: 900 });
  return {
    location: loc,
    timezone: data.timezone,
    model: opts.model ?? "best_match",
    daily_units: data.daily_units,
    daily: columnsToRows(data.daily),
    ...(opts.hourly
      ? { hourly_units: data.hourly_units, hourly: columnsToRows(data.hourly, opts.hours) }
      : {}),
  };
}

export async function getAirQuality(loc: Location, hours: number) {
  const vars = [
    "european_aqi",
    "us_aqi",
    "pm10",
    "pm2_5",
    "carbon_monoxide",
    "nitrogen_dioxide",
    "sulphur_dioxide",
    "ozone",
    "dust",
    "uv_index",
    "alder_pollen",
    "birch_pollen",
    "grass_pollen",
    "mugwort_pollen",
    "olive_pollen",
    "ragweed_pollen",
  ];
  const url = buildUrl("https://air-quality-api.open-meteo.com/v1/air-quality", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    current: vars.join(","),
    hourly: vars.join(","),
    forecast_hours: hours,
    timezone: "auto",
  });
  const data = await getJson(url, { ttl: 1800 });
  return {
    location: loc,
    timezone: data.timezone,
    units: data.current_units,
    current: data.current,
    hourly: columnsToRows(data.hourly, hours),
  };
}

export async function getMarine(loc: Location, days: number) {
  const url = buildUrl("https://marine-api.open-meteo.com/v1/marine", {
    latitude: loc.latitude,
    longitude: loc.longitude,
    daily: ["wave_height_max", "wave_direction_dominant", "wave_period_max", "swell_wave_height_max"].join(","),
    current: ["wave_height", "wave_direction", "wave_period", "swell_wave_height", "sea_surface_temperature"].join(","),
    forecast_days: days,
    timezone: "auto",
  });
  const data = await getJson(url, { ttl: 1800 });
  return {
    location: loc,
    current_units: data.current_units,
    current: data.current,
    daily_units: data.daily_units,
    daily: columnsToRows(data.daily),
  };
}
