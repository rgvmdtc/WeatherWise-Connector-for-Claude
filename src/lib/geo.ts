import { buildUrl, getJson } from "./http.js";

export interface Location {
  name: string;
  latitude: number;
  longitude: number;
  /** ISO 3166-1 alpha-2, if known. */
  countryCode?: string;
  country?: string;
  admin1?: string;
  timezone?: string;
}

const COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseCoordinates(input: string): { latitude: number; longitude: number } | null {
  const m = COORD_RE.exec(input);
  if (!m) return null;
  const latitude = Number(m[1]);
  const longitude = Number(m[2]);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

export async function searchLocations(query: string, count = 5, language = "en"): Promise<Location[]> {
  const url = buildUrl("https://geocoding-api.open-meteo.com/v1/search", {
    name: query,
    count,
    language,
    format: "json",
  });
  const data = await getJson<{ results?: any[] }>(url, { ttl: 86_400 });
  return (data.results ?? []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
    latitude: r.latitude,
    longitude: r.longitude,
    countryCode: r.country_code,
    country: r.country,
    admin1: r.admin1,
    timezone: r.timezone,
  }));
}

/**
 * Resolves a free-form location: either "lat,lon" or a place name ("Berlin", "Moore, Oklahoma").
 * For "City, Region" queries the first part is searched and the rest is used to pick the best match.
 */
export async function resolveLocation(input: string): Promise<Location> {
  const coords = parseCoordinates(input);
  if (coords) {
    return {
      name: `${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)}`,
      ...coords,
      countryCode: guessCountry(coords.latitude, coords.longitude),
    };
  }
  const [head, ...rest] = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (!head) throw new Error("Empty location");
  const results = await searchLocations(head, 10);
  if (results.length === 0) throw new Error(`Location not found: "${input}"`);
  if (rest.length) {
    const hints = rest.map((h) => h.toLowerCase());
    const match = results.find((r) =>
      hints.every((h) =>
        [r.admin1, r.country, r.countryCode].some((f) => f?.toLowerCase().startsWith(h) || f?.toLowerCase() === h),
      ),
    );
    if (match) return match;
  }
  return results[0];
}

/** Very rough country guess for raw coordinates; only used to route region-specific data sources. */
export function guessCountry(lat: number, lon: number): string | undefined {
  if (lat >= 47.2 && lat <= 55.1 && lon >= 5.8 && lon <= 15.1) return "DE";
  // CONUS
  if (lat >= 24.4 && lat <= 49.4 && lon >= -125 && lon <= -66.9) return "US";
  // Alaska, Hawaii, Puerto Rico
  if (lat >= 51 && lat <= 71.5 && lon >= -170 && lon <= -129.9) return "US";
  if (lat >= 18.8 && lat <= 22.3 && lon >= -160.3 && lon <= -154.7) return "US";
  if (lat >= 17.8 && lat <= 18.6 && lon >= -67.3 && lon <= -65.2) return "US";
  return undefined;
}

const EARTH_RADIUS_KM = 6371;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

type Ring = number[][];

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon: number, lat: number, polygon: Ring[]): boolean {
  if (!polygon.length || !pointInRing(lon, lat, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(lon, lat, hole));
}

/** Point-in-geometry test for GeoJSON Polygon / MultiPolygon geometries. */
export function geometryContains(geometry: any, lat: number, lon: number): boolean {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygon(lon, lat, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((poly: Ring[]) => pointInPolygon(lon, lat, poly));
  }
  if (geometry.type === "GeometryCollection") {
    return geometry.geometries.some((g: any) => geometryContains(g, lat, lon));
  }
  return false;
}

/** Slippy-map tile coordinates (fractional) for a lat/lon at a zoom level. */
export function lonLatToTile(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const latRad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

export function describeLocation(loc: Location): string {
  return `${loc.name} (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`;
}
