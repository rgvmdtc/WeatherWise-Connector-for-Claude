import { distanceKm, geometryContains } from "../lib/geo.js";
import { getJson, getText } from "../lib/http.js";

const BASE = "https://www.spc.noaa.gov";

export const CATEGORICAL_LEVELS = ["TSTM", "MRGL", "SLGT", "ENH", "MDT", "HIGH"] as const;

const CATEGORY_NAMES: Record<string, string> = {
  TSTM: "General thunderstorms",
  MRGL: "Marginal risk (1/5)",
  SLGT: "Slight risk (2/5)",
  ENH: "Enhanced risk (3/5)",
  MDT: "Moderate risk (4/5)",
  HIGH: "High risk (5/5)",
};

export type OutlookDay = 1 | 2 | 3;

function outlookLayers(day: OutlookDay): Record<string, string> {
  if (day === 3) {
    return { categorical: "day3otlk_cat", probabilistic: "day3otlk_prob", significant: "day3otlk_sigprob" };
  }
  return {
    categorical: `day${day}otlk_cat`,
    tornado: `day${day}otlk_torn`,
    wind: `day${day}otlk_wind`,
    hail: `day${day}otlk_hail`,
    significant_tornado: `day${day}otlk_sigtorn`,
    significant_wind: `day${day}otlk_sigwind`,
    significant_hail: `day${day}otlk_sighail`,
  };
}

interface LayerSummary {
  valid?: string;
  expire?: string;
  issued?: string;
  /** All risk labels drawn anywhere in this layer (e.g. MRGL, SLGT or 0.05, 0.15). */
  areasIssued: string[];
  /** Highest label that contains the requested point (if a point was given). */
  atLocation?: string | null;
}

function summarizeLayer(geojson: any, point?: { lat: number; lon: number }): LayerSummary {
  const features: any[] = geojson?.features ?? [];
  const first = features[0]?.properties ?? {};
  const sorted = [...features].sort((a, b) => (a.properties?.DN ?? 0) - (b.properties?.DN ?? 0));
  const summary: LayerSummary = {
    valid: first.VALID_ISO ?? first.VALID,
    expire: first.EXPIRE_ISO ?? first.EXPIRE,
    issued: first.ISSUE_ISO ?? first.ISSUE,
    areasIssued: [...new Set(sorted.map((f) => String(f.properties?.LABEL ?? "")).filter(Boolean))],
  };
  if (point) {
    const hits = sorted.filter((f) => geometryContains(f.geometry, point.lat, point.lon));
    const top = hits[hits.length - 1];
    summary.atLocation = top ? String(top.properties?.LABEL2 ?? top.properties?.LABEL) : null;
  }
  return summary;
}

export async function getConvectiveOutlook(day: OutlookDay, point?: { lat: number; lon: number }) {
  const layers = outlookLayers(day);
  const entries = await Promise.all(
    Object.entries(layers).map(async ([name, file]) => {
      try {
        const geo = await getJson(`${BASE}/products/outlook/${file}.lyr.geojson`, { ttl: 600 });
        return [name, summarizeLayer(geo, point)] as const;
      } catch (err) {
        return [name, { error: (err as Error).message }] as const;
      }
    }),
  );
  const result: Record<string, unknown> = Object.fromEntries(entries);
  const cat = result.categorical as LayerSummary | undefined;
  return {
    day,
    source: "NOAA Storm Prediction Center",
    legend: CATEGORY_NAMES,
    highestCategoryIssued: cat?.areasIssued?.length
      ? [...cat.areasIssued].sort((a, b) => CATEGORICAL_LEVELS.indexOf(a as any) - CATEGORICAL_LEVELS.indexOf(b as any)).pop()
      : null,
    layers: result,
    graphic: `${BASE}/products/outlook/day${day}otlk.html`,
  };
}

export interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  description: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const body = m[1];
    const tag = (name: string) => {
      const t = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(body);
      return t ? decodeEntities(t[1]).trim() : "";
    };
    items.push({
      title: stripHtml(tag("title")),
      link: tag("link"),
      pubDate: tag("pubDate") || undefined,
      description: stripHtml(tag("description")),
    });
  }
  return items;
}

export async function getMesoscaleDiscussions(limit: number) {
  const xml = await getText(`${BASE}/products/spcmdrss.xml`, { ttl: 300 });
  return parseRss(xml)
    .slice(0, limit)
    .map((item) => {
      const areas = /Areas? affected\.{3}\s*([\s\S]*?)\n\s*\n/i.exec(item.description)?.[1]?.replace(/\s+/g, " ").trim();
      const concerning = /Concerning\.{3}\s*([\s\S]*?)\n\s*\n/i.exec(item.description)?.[1]?.replace(/\s+/g, " ").trim();
      return { ...item, areasAffected: areas, concerning };
    });
}

export async function getWatches(limit: number) {
  const xml = await getText(`${BASE}/products/spcwwrss.xml`, { ttl: 300 });
  return parseRss(xml).slice(0, limit);
}

export interface StormReport {
  type: "tornado" | "wind" | "hail";
  time: string;
  magnitude: string;
  location: string;
  county: string;
  state: string;
  lat: number;
  lon: number;
  comments: string;
  distanceKm?: number;
}

/** Parses SPC's combined storm report CSV (tornado, wind and hail sections, each with its own header). */
export function parseStormReportsCsv(csv: string): StormReport[] {
  const reports: StormReport[] = [];
  let type: StormReport["type"] | null = null;
  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Time,")) {
      const second = line.split(",")[1]?.toLowerCase();
      type = second === "f_scale" ? "tornado" : second === "speed" ? "wind" : second === "size" ? "hail" : null;
      continue;
    }
    if (!type) continue;
    const parts = line.split(",");
    if (parts.length < 8) continue;
    const [time, magnitude, location, county, state, lat, lon, ...rest] = parts;
    const latN = Number(lat);
    const lonN = Number(lon);
    if (!Number.isFinite(latN) || !Number.isFinite(lonN)) continue;
    reports.push({
      type,
      time,
      magnitude: magnitude === "UNK" ? "unknown" : magnitude,
      location,
      county,
      state,
      lat: latN,
      lon: lonN,
      comments: rest.join(",").trim(),
    });
  }
  return reports;
}

export async function getStormReports(opts: {
  day: "today" | "yesterday";
  near?: { lat: number; lon: number; radiusKm: number };
  types?: StormReport["type"][];
  limit: number;
}) {
  const csv = await getText(`${BASE}/climo/reports/${opts.day}_filtered.csv`, { ttl: 300 });
  let reports = parseStormReportsCsv(csv);
  if (opts.types?.length) reports = reports.filter((r) => opts.types!.includes(r.type));
  if (opts.near) {
    const { lat, lon, radiusKm } = opts.near;
    reports = reports
      .map((r) => ({ ...r, distanceKm: Math.round(distanceKm(lat, lon, r.lat, r.lon)) }))
      .filter((r) => r.distanceKm! <= radiusKm)
      .sort((a, b) => a.distanceKm! - b.distanceKm!);
  }
  const counts = { tornado: 0, wind: 0, hail: 0 };
  for (const r of reports) counts[r.type]++;
  return {
    day: opts.day,
    note: "SPC report day runs 12Z to 12Z. Reports are preliminary.",
    counts,
    total: reports.length,
    reports: reports.slice(0, opts.limit),
    page: `${BASE}/climo/reports/${opts.day}.html`,
  };
}
