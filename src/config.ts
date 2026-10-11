import os from "node:os";
import path from "node:path";

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface Config {
  /** Base URL of the WeatherWise web app. */
  weatherwiseUrl: string;
  /** Optional WeatherWise account credentials for automatic login. */
  weatherwiseEmail?: string;
  weatherwisePassword?: string;
  /** Directory for the saved browser session and the discovered API catalog. */
  dataDir: string;
  /** Whether the WeatherWise browser tools are registered at all. */
  browserEnabled: boolean;
  headless: boolean;
  /** Allows ww_evaluate (run JavaScript inside the WeatherWise tab). Off by default. */
  allowEval: boolean;
  /** Explicit Chromium/Chrome binary; otherwise Playwright's default lookup is used. */
  chromiumPath?: string;
  viewport: { width: number; height: number };
  /** Extra hostnames (besides the WeatherWise domain) that ww_call_api may contact. */
  extraApiHosts: string[];
  /** Contact string sent in the User-Agent (api.weather.gov requires one). */
  contact: string;
  /** Max zoom level for RainViewer radar tiles (the free API caps this). */
  radarMaxZoom: number;
  http: {
    host: string;
    port: number;
    path: string;
    authToken?: string;
    allowedHosts?: string[];
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.WEATHERWISE_DATA_DIR || path.join(os.homedir(), ".weatherwise-connector");
  return {
    weatherwiseUrl: (env.WEATHERWISE_URL || "https://web.weatherwise.app").replace(/\/+$/, ""),
    weatherwiseEmail: env.WEATHERWISE_EMAIL || undefined,
    weatherwisePassword: env.WEATHERWISE_PASSWORD || undefined,
    dataDir,
    browserEnabled: bool(env.WEATHERWISE_BROWSER, true),
    headless: bool(env.WEATHERWISE_HEADLESS, true),
    allowEval: bool(env.WEATHERWISE_ALLOW_EVAL, false),
    chromiumPath: env.CHROMIUM_PATH || undefined,
    viewport: {
      width: int(env.WEATHERWISE_VIEWPORT_WIDTH, 1280),
      height: int(env.WEATHERWISE_VIEWPORT_HEIGHT, 800),
    },
    extraApiHosts: (env.WEATHERWISE_API_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    contact: env.CONTACT || "https://github.com/rgvmdtc/WeatherWise-Connector-for-Claude",
    radarMaxZoom: int(env.RADAR_MAX_ZOOM, 7),
    http: {
      host: env.HOST || "127.0.0.1",
      port: int(env.PORT, 3000),
      path: env.MCP_PATH || "/mcp",
      authToken: env.MCP_AUTH_TOKEN || undefined,
      allowedHosts: env.ALLOWED_HOSTS
        ? env.ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
        : undefined,
    },
  };
}

export const USER_AGENT_PRODUCT = "WeatherWise-Connector-for-Claude/1.0";
