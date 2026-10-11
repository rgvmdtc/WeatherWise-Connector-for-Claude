import { buildUrl, getJson, HttpError } from "../lib/http.js";

const BASE = "https://api.weather.gov";

export interface NwsPoint {
  gridId: string;
  gridX: number;
  gridY: number;
  cwa: string;
  radarStation?: string;
  timeZone?: string;
  forecastUrl: string;
  forecastHourlyUrl: string;
  observationStationsUrl: string;
  county?: string;
  forecastZone?: string;
  city?: string;
  state?: string;
}

function round4(n: number): string {
  return (Math.round(n * 10_000) / 10_000).toString();
}

/** Returns NWS grid metadata for a point, or null when the point is outside NWS coverage. */
export async function getPoint(lat: number, lon: number): Promise<NwsPoint | null> {
  try {
    const data = await getJson(`${BASE}/points/${round4(lat)},${round4(lon)}`, { ttl: 86_400 });
    const p = data.properties;
    return {
      gridId: p.gridId,
      gridX: p.gridX,
      gridY: p.gridY,
      cwa: p.cwa,
      radarStation: p.radarStation,
      timeZone: p.timeZone,
      forecastUrl: p.forecast,
      forecastHourlyUrl: p.forecastHourly,
      observationStationsUrl: p.observationStations,
      county: p.county?.split("/").pop(),
      forecastZone: p.forecastZone?.split("/").pop(),
      city: p.relativeLocation?.properties?.city,
      state: p.relativeLocation?.properties?.state,
    };
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

export interface Alert {
  id: string;
  event: string;
  headline?: string;
  severity?: string;
  certainty?: string;
  urgency?: string;
  areaDesc?: string;
  sent?: string;
  onset?: string;
  effective?: string;
  expires?: string;
  ends?: string;
  senderName?: string;
  description?: string;
  instruction?: string;
  parameters?: Record<string, unknown>;
  source: string;
}

export function mapNwsAlert(feature: any, includeText = true): Alert {
  const p = feature.properties ?? {};
  const params = p.parameters ?? {};
  const pick = (k: string) => (Array.isArray(params[k]) ? params[k][0] : params[k]);
  const extra: Record<string, unknown> = {};
  for (const k of [
    "tornadoDetection",
    "tornadoDamageThreat",
    "thunderstormDamageThreat",
    "flashFloodDetection",
    "flashFloodDamageThreat",
    "maxWindGust",
    "maxHailSize",
    "windThreat",
    "hailThreat",
    "VTEC",
  ]) {
    const v = pick(k);
    if (v !== undefined) extra[k] = v;
  }
  return {
    id: p.id ?? feature.id,
    event: p.event,
    headline: p.headline ?? undefined,
    severity: p.severity,
    certainty: p.certainty,
    urgency: p.urgency,
    areaDesc: p.areaDesc,
    sent: p.sent,
    onset: p.onset ?? undefined,
    effective: p.effective,
    expires: p.expires,
    ends: p.ends ?? undefined,
    senderName: p.senderName,
    description: includeText ? p.description ?? undefined : undefined,
    instruction: includeText ? p.instruction ?? undefined : undefined,
    parameters: Object.keys(extra).length ? extra : undefined,
    source: "NWS (api.weather.gov)",
  };
}

export interface AlertQuery {
  point?: { lat: number; lon: number };
  /** Two-letter state/territory code or marine area code. */
  area?: string;
  event?: string;
  severity?: string;
  includeText?: boolean;
  limit?: number;
}

export async function getActiveAlerts(q: AlertQuery): Promise<Alert[]> {
  const url = buildUrl(`${BASE}/alerts/active`, {
    point: q.point ? `${round4(q.point.lat)},${round4(q.point.lon)}` : undefined,
    area: q.area?.toUpperCase(),
    event: q.event,
    severity: q.severity,
  });
  const data = await getJson(url, { ttl: 60 });
  const alerts = (data.features ?? []).map((f: any) => mapNwsAlert(f, q.includeText ?? true));
  return q.limit ? alerts.slice(0, q.limit) : alerts;
}

export async function getTextForecast(point: NwsPoint, hourly: boolean, limit: number) {
  const data = await getJson(hourly ? point.forecastHourlyUrl : point.forecastUrl, { ttl: 900 });
  const periods = (data.properties?.periods ?? []).slice(0, limit).map((p: any) => ({
    name: p.name || undefined,
    startTime: p.startTime,
    endTime: p.endTime,
    isDaytime: p.isDaytime,
    temperature: p.temperature,
    temperatureUnit: p.temperatureUnit,
    precipitationChance: p.probabilityOfPrecipitation?.value ?? undefined,
    windSpeed: p.windSpeed,
    windDirection: p.windDirection,
    shortForecast: p.shortForecast,
    detailedForecast: p.detailedForecast || undefined,
  }));
  return { office: point.gridId, updated: data.properties?.updateTime, periods };
}

export async function getLatestProduct(type: string, location: string) {
  const list = await getJson(`${BASE}/products/types/${encodeURIComponent(type)}/locations/${encodeURIComponent(location)}`, {
    ttl: 600,
  });
  const latest = list["@graph"]?.[0];
  if (!latest) return null;
  const product = await getJson(`${BASE}/products/${latest.id}`, { ttl: 600 });
  return {
    id: product.id,
    type: product.productCode,
    name: product.productName,
    office: product.issuingOffice,
    issued: product.issuanceTime,
    text: product.productText as string,
  };
}

export async function getLatestObservation(point: NwsPoint) {
  const stations = await getJson(point.observationStationsUrl, { ttl: 86_400 });
  const station = stations.features?.[0];
  if (!station) return null;
  const id = station.properties.stationIdentifier;
  const obs = await getJson(`${BASE}/stations/${id}/observations/latest`, { ttl: 300 });
  const p = obs.properties ?? {};
  const val = (o: any) => (o && o.value !== null && o.value !== undefined ? { value: o.value, unit: o.unitCode?.replace("wmoUnit:", "") } : undefined);
  return {
    station: id,
    stationName: station.properties.name,
    timestamp: p.timestamp,
    textDescription: p.textDescription,
    temperature: val(p.temperature),
    dewpoint: val(p.dewpoint),
    windDirection: val(p.windDirection),
    windSpeed: val(p.windSpeed),
    windGust: val(p.windGust),
    barometricPressure: val(p.barometricPressure),
    visibility: val(p.visibility),
    relativeHumidity: val(p.relativeHumidity),
    rawMessage: p.rawMessage || undefined,
  };
}
