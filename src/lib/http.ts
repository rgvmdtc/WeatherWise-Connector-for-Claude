import { USER_AGENT_PRODUCT } from "../config.js";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 500;

let contact = "";

/** Sets the contact info included in the User-Agent (required by api.weather.gov). */
export function setContact(value: string): void {
  contact = value;
}

export function clearHttpCache(): void {
  cache.clear();
}

export interface RequestOptions {
  /** Cache the parsed response for this many seconds (0 = no cache). */
  ttl?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

async function request(url: string, opts: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": contact ? `${USER_AGENT_PRODUCT} (${contact})` : USER_AGENT_PRODUCT,
        ...opts.headers,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(
        `HTTP ${res.status} for ${url}${body ? `: ${body.slice(0, 300)}` : ""}`,
        res.status,
        url,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new HttpError(`Timeout while requesting ${url}`, 504, url);
    }
    throw new HttpError(`Request to ${url} failed: ${(err as Error).message}`, 502, url);
  } finally {
    clearTimeout(timer);
  }
}

async function cached<T>(key: string, ttl: number | undefined, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (ttl && hit && hit.expires > now) return hit.value as T;
  const value = await load();
  if (ttl) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { expires: now + ttl * 1000, value });
  }
  return value;
}

export function getJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  return cached(`json:${url}`, opts.ttl, async () => {
    const res = await request(url, {
      ...opts,
      headers: { Accept: "application/geo+json, application/json", ...opts.headers },
    });
    return (await res.json()) as T;
  });
}

export function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  return cached(`text:${url}`, opts.ttl, async () => {
    const res = await request(url, opts);
    return res.text();
  });
}

export function getBuffer(url: string, opts: RequestOptions = {}): Promise<Buffer> {
  return cached(`buf:${url}`, opts.ttl, async () => {
    const res = await request(url, opts);
    return Buffer.from(await res.arrayBuffer());
  });
}

export function buildUrl(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url.toString();
}
