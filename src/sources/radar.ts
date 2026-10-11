import { PNG } from "pngjs";
import { getBuffer, getJson } from "../lib/http.js";
import { lonLatToTile } from "../lib/geo.js";

const TILE = 256;

export interface RadarFrame {
  time: number;
  iso: string;
  path: string;
  kind: "past" | "nowcast";
}

export interface RadarTimeline {
  host: string;
  generated: string;
  frames: RadarFrame[];
  satellite: RadarFrame[];
}

export async function getRadarTimeline(): Promise<RadarTimeline> {
  const data = await getJson("https://api.rainviewer.com/public/weather-maps.json", { ttl: 120 });
  const toFrame = (kind: RadarFrame["kind"]) => (f: any): RadarFrame => ({
    time: f.time,
    iso: new Date(f.time * 1000).toISOString(),
    path: f.path,
    kind,
  });
  return {
    host: data.host,
    generated: new Date((data.generated ?? 0) * 1000).toISOString(),
    frames: [...(data.radar?.past ?? []).map(toFrame("past")), ...(data.radar?.nowcast ?? []).map(toFrame("nowcast"))],
    satellite: (data.satellite?.infrared ?? []).map(toFrame("past")),
  };
}

export function radarTileTemplate(host: string, frame: RadarFrame, color = 2, smooth = true, snow = true): string {
  return `${host}${frame.path}/${TILE}/{z}/{x}/{y}/${color}/${smooth ? 1 : 0}_${snow ? 1 : 0}.png`;
}

export const BASEMAP_TEMPLATE = "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png";
export const ATTRIBUTION = "Radar: RainViewer.com | Basemap: © OpenStreetMap contributors © CARTO";

function fill(template: string, z: number, x: number, y: number): string {
  return template.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
}

async function loadTile(url: string): Promise<PNG | null> {
  try {
    return PNG.sync.read(await getBuffer(url, { ttl: 300, timeoutMs: 15_000 }));
  } catch {
    return null;
  }
}

export interface RenderOptions {
  lat: number;
  lon: number;
  zoom: number;
  size: number;
  radarTemplate?: string;
  basemapTemplate?: string;
  opacity?: number;
}

/** Composites basemap + radar tiles into a single PNG centered on lat/lon, with a location marker. */
export async function renderRadarImage(opts: RenderOptions): Promise<Buffer> {
  const { zoom, size } = opts;
  const n = 2 ** zoom;
  const center = lonLatToTile(opts.lat, opts.lon, zoom);
  const left = Math.round(center.x * TILE - size / 2);
  const top = Math.round(center.y * TILE - size / 2);
  const out = new PNG({ width: size, height: size });
  // neutral background for areas outside the map
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 220;
    out.data[i + 3] = 255;
  }

  const tx0 = Math.floor(left / TILE);
  const ty0 = Math.floor(top / TILE);
  const tx1 = Math.floor((left + size - 1) / TILE);
  const ty1 = Math.floor((top + size - 1) / TILE);
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = tx0; tx <= tx1; tx++) {
      const wx = ((tx % n) + n) % n;
      jobs.push(
        (async () => {
          const [base, radar] = await Promise.all([
            loadTile(fill(opts.basemapTemplate ?? BASEMAP_TEMPLATE, zoom, wx, ty)),
            opts.radarTemplate ? loadTile(fill(opts.radarTemplate, zoom, wx, ty)) : Promise.resolve(null),
          ]);
          blit(out, base, tx * TILE - left, ty * TILE - top, 1);
          blit(out, radar, tx * TILE - left, ty * TILE - top, opts.opacity ?? 0.8);
        })(),
      );
    }
  }
  // Blits of different tiles never overlap, so running them concurrently is safe.
  await Promise.all(jobs);
  drawMarker(out, Math.round(size / 2), Math.round(size / 2));
  return PNG.sync.write(out);
}

function blit(dst: PNG, src: PNG | null, ox: number, oy: number, opacity: number): void {
  if (!src) return;
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (y * src.width + x) * 4;
      const di = (dy * dst.width + dx) * 4;
      const a = (src.data[si + 3] / 255) * opacity;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round(src.data[si + c] * a + dst.data[di + c] * (1 - a));
      dst.data[di + 3] = 255;
    }
  }
}

function drawMarker(img: PNG, cx: number, cy: number): void {
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = r;
    img.data[i + 1] = g;
    img.data[i + 2] = b;
    img.data[i + 3] = 255;
  };
  for (let d = -9; d <= 9; d++) {
    for (let w = -1; w <= 1; w++) {
      if (Math.abs(d) < 3) continue;
      set(cx + d, cy + w, 0, 0, 0);
      set(cx + w, cy + d, 0, 0, 0);
    }
  }
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) set(cx + x, cy + y, 220, 0, 0);
}
