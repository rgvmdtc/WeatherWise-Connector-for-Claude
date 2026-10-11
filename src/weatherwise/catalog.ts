import fs from "node:fs";
import path from "node:path";

/** One request observed while the WeatherWise web app was running. */
export interface CapturedRequest {
  id: number;
  time: string;
  method: string;
  url: string;
  status: number;
  resourceType: string;
  contentType: string;
  size?: number;
  /** Truncated body sample for JSON/text responses. */
  sample?: string;
}

export interface Endpoint {
  id: string;
  method: string;
  host: string;
  /** Path with variable segments replaced, e.g. /radar/{station}/{n}/{z}/{x}/{y}.png */
  pathTemplate: string;
  queryParams: string[];
  kind: "json" | "image" | "tile" | "text" | "binary" | "other";
  contentTypes: string[];
  count: number;
  lastStatus: number;
  exampleUrl: string;
  /** Top-level keys of a JSON response sample. */
  jsonKeys?: string[];
  sample?: string;
  firstSeen: string;
  lastSeen: string;
}

const TILE_RE = /\/(\d{1,2})\/(\d+)\/(\d+)(@2x)?\.(png|jpe?g|webp|pbf|mvt)$/i;

/** Replaces obviously variable path segments (ids, numbers, timestamps, hashes) with placeholders. */
export function templatePath(pathname: string): string {
  const tile = TILE_RE.exec(pathname);
  let prefix = pathname;
  let suffix = "";
  if (tile) {
    prefix = pathname.slice(0, tile.index);
    suffix = `/{z}/{x}/{y}${tile[4] ?? ""}.${tile[5]}`;
  }
  const segments = prefix.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d{9,13}$/.test(seg)) return "{timestamp}";
    if (/^\d{8}(T|_)?\d{4,6}Z?$/i.test(seg)) return "{datetime}";
    if (/^\d{4}-\d{2}-\d{2}([T_]\d{2}[:\-]?\d{2}([:\-]?\d{2})?(\.\d+)?Z?)?$/i.test(seg)) return "{datetime}";
    if (/^-?\d+(\.\d+)?$/.test(seg)) return "{n}";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return "{uuid}";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return "{hash}";
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(seg)) return "{lat},{lon}";
    return seg;
  });
  return segments.join("/") + suffix;
}

export function classify(url: string, contentType: string, resourceType: string): Endpoint["kind"] {
  const ct = contentType.toLowerCase();
  if (TILE_RE.test(new URL(url).pathname)) return "tile";
  if (ct.includes("json")) return "json";
  if (ct.startsWith("image/") || resourceType === "image") return "image";
  if (ct.startsWith("text/") || ct.includes("xml") || ct.includes("javascript")) return "text";
  if (ct.includes("octet-stream") || ct.includes("protobuf")) return "binary";
  return "other";
}

const IGNORED_TYPES = new Set(["stylesheet", "font", "media", "manifest", "script", "document"]);
const IGNORED_HOSTS = [
  /google-analytics\.com$/,
  /googletagmanager\.com$/,
  /doubleclick\.net$/,
  /sentry\.io$/,
  /segment\.(io|com)$/,
  /mixpanel\.com$/,
  /amplitude\.com$/,
  /hotjar\.com$/,
  /clarity\.ms$/,
  /fonts\.(googleapis|gstatic)\.com$/,
];

export function isInteresting(req: Pick<CapturedRequest, "url" | "resourceType">): boolean {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (IGNORED_TYPES.has(req.resourceType)) return false;
  return !IGNORED_HOSTS.some((re) => re.test(url.hostname));
}

function jsonKeys(sample?: string): string[] | undefined {
  if (!sample) return undefined;
  try {
    const parsed = JSON.parse(sample);
    if (Array.isArray(parsed)) {
      return parsed.length && typeof parsed[0] === "object" && parsed[0] ? [`[]`, ...Object.keys(parsed[0]).slice(0, 30)] : ["[]"];
    }
    if (parsed && typeof parsed === "object") return Object.keys(parsed).slice(0, 40);
  } catch {
    // truncated sample – fall back to a regex scan of the first level keys
    const keys = [...sample.matchAll(/"([A-Za-z_][\w-]{0,40})"\s*:/g)].map((m) => m[1]);
    return keys.length ? [...new Set(keys)].slice(0, 40) : undefined;
  }
  return undefined;
}

/** Persistent catalog of WeatherWise endpoints discovered from captured traffic. */
export class EndpointCatalog {
  private endpoints = new Map<string, Endpoint>();

  constructor(private readonly file?: string) {
    if (file && fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const ep of data.endpoints ?? []) this.endpoints.set(ep.id, ep);
      } catch {
        // corrupt catalog – start fresh
      }
    }
  }

  static keyFor(method: string, host: string, pathTemplate: string): string {
    return `${method} ${host}${pathTemplate}`;
  }

  ingest(requests: CapturedRequest[]): { added: number; updated: number } {
    let added = 0;
    let updated = 0;
    for (const req of requests) {
      if (!isInteresting(req)) continue;
      const url = new URL(req.url);
      const pathTemplate = templatePath(url.pathname);
      const key = EndpointCatalog.keyFor(req.method, url.host, pathTemplate);
      const existing = this.endpoints.get(key);
      const kind = classify(req.url, req.contentType, req.resourceType);
      const params = [...url.searchParams.keys()];
      if (existing) {
        existing.count++;
        existing.lastStatus = req.status;
        existing.lastSeen = req.time;
        existing.queryParams = [...new Set([...existing.queryParams, ...params])];
        if (req.contentType && !existing.contentTypes.includes(req.contentType)) existing.contentTypes.push(req.contentType);
        if (req.status < 400) existing.exampleUrl = req.url;
        if (req.sample && (!existing.sample || req.status < 400)) {
          existing.sample = req.sample;
          existing.jsonKeys = kind === "json" ? jsonKeys(req.sample) : existing.jsonKeys;
        }
        updated++;
      } else {
        this.endpoints.set(key, {
          id: key,
          method: req.method,
          host: url.host,
          pathTemplate,
          queryParams: params,
          kind,
          contentTypes: req.contentType ? [req.contentType] : [],
          count: 1,
          lastStatus: req.status,
          exampleUrl: req.url,
          jsonKeys: kind === "json" ? jsonKeys(req.sample) : undefined,
          sample: req.sample,
          firstSeen: req.time,
          lastSeen: req.time,
        });
        added++;
      }
    }
    return { added, updated };
  }

  list(filter?: { kind?: Endpoint["kind"]; search?: string }): Endpoint[] {
    let list = [...this.endpoints.values()];
    if (filter?.kind) list = list.filter((e) => e.kind === filter.kind);
    if (filter?.search) {
      const s = filter.search.toLowerCase();
      list = list.filter((e) => e.id.toLowerCase().includes(s) || e.exampleUrl.toLowerCase().includes(s));
    }
    return list.sort((a, b) => b.count - a.count);
  }

  get(id: string): Endpoint | undefined {
    return this.endpoints.get(id);
  }

  hosts(): Set<string> {
    return new Set([...this.endpoints.values()].map((e) => e.host.toLowerCase()));
  }

  clear(): void {
    this.endpoints.clear();
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ updated: new Date().toISOString(), endpoints: this.list() }, null, 2),
    );
  }

  toJSON() {
    return { count: this.endpoints.size, endpoints: this.list() };
  }
}
