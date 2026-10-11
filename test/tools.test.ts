import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { loadConfig } from "../src/config.js";
import { clearHttpCache } from "../src/lib/http.js";
import { createServer, createSharedResources } from "../src/server.js";
import { MD_RSS, NWS_ALERTS, NWS_POINT, outlookGeojson, solidPng, STORM_REPORTS_CSV, WW_RSS } from "./fixtures.js";

type Route = [RegExp, (url: URL) => unknown];

const realFetch = globalThis.fetch;
const requested: string[] = [];

function respond(body: unknown, status = 200): Response {
  if (body instanceof Response) return body;
  if (Buffer.isBuffer(body)) return new Response(new Uint8Array(body), { status, headers: { "content-type": "image/png" } });
  if (typeof body === "string") return new Response(body, { status, headers: { "content-type": "text/plain" } });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const routes: Route[] = [
  [/geocoding-api\.open-meteo\.com/, (u) =>
    u.searchParams.get("name") === "Moore"
      ? { results: [{ name: "Moore", admin1: "Oklahoma", country: "United States", country_code: "US", latitude: 35.34, longitude: -97.49, timezone: "America/Chicago" }] }
      : u.searchParams.get("name") === "Berlin"
        ? { results: [{ name: "Berlin", admin1: "Land Berlin", country: "Germany", country_code: "DE", latitude: 52.52, longitude: 13.41, timezone: "Europe/Berlin" }] }
        : {}],
  [/api\.open-meteo\.com\/v1\/forecast/, (u) =>
    u.searchParams.get("current")
      ? { timezone: "America/Chicago", elevation: 370, current_units: { temperature_2m: "°C" }, current: { time: "2026-10-11T15:00", temperature_2m: 27.5, weather_code: 95 } }
      : { timezone: "America/Chicago", daily_units: {}, daily: { time: ["2026-10-11", "2026-10-12"], weather_code: [95, 3], temperature_2m_max: [29, 22] } }],
  [/api\.weather\.gov\/points\//, () => NWS_POINT],
  [/api\.weather\.gov\/alerts\/active/, () => NWS_ALERTS],
  [/api\.weather\.gov\/gridpoints\/OUN\/1,2\/stations/, () => ({ features: [] })],
  [/api\.brightsky\.dev\/alerts/, () => ({
    alerts: [{ alert_id: "dwd1", event_de: "STARKES GEWITTER", event_en: "STRONG THUNDERSTORMS", headline_de: "Amtliche WARNUNG vor STARKEM GEWITTER", severity: "moderate", description_de: "Es treten Gewitter auf." }],
    location: { name: "Berlin", state: "Berlin" },
  })],
  [/day\do?tlk_cat\.lyr\.geojson/, () => outlookGeojson(["TSTM", "MRGL", "SLGT"])],
  [/day\dotlk_torn\.lyr\.geojson/, () => outlookGeojson(["0.02", "0.05"])],
  [/otlk_\w+\.lyr\.geojson/, () => outlookGeojson([])],
  [/spcmdrss\.xml/, () => MD_RSS],
  [/spcwwrss\.xml/, () => WW_RSS],
  [/climo\/reports\/today_filtered\.csv/, () => STORM_REPORTS_CSV],
  [/CurrentStorms\.json/, () => ({ activeStorms: [{ id: "al142026", name: "Test", classification: "HU", intensity: "100", pressure: "960", latitudeNumeric: 25, longitudeNumeric: -80 }] })],
  [/api\.rainviewer\.com/, () => ({
    host: "https://tilecache.rainviewer.com",
    generated: 1_791_720_000,
    radar: { past: [{ time: 1_791_719_400, path: "/v2/radar/a" }, { time: 1_791_720_000, path: "/v2/radar/b" }], nowcast: [] },
    satellite: { infrared: [] },
  })],
  [/tilecache\.rainviewer\.com/, () => solidPng(0, 0, 255, 255)],
  [/basemaps\.cartocdn\.com/, () => solidPng(255, 255, 255, 255)],
];

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  requested.push(url.href);
  for (const [re, handler] of routes) if (re.test(url.href)) return respond(handler(url));
  return respond("not found", 404);
}

describe("MCP tools (mocked data sources)", () => {
  let client: Client;
  let dispose: () => Promise<void>;

  before(async () => {
    const config = loadConfig({ WEATHERWISE_DATA_DIR: path.join(os.tmpdir(), `ww-test-${process.pid}`) } as NodeJS.ProcessEnv);
    const handle = createServer(createSharedResources(config));
    dispose = handle.dispose;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([handle.server.connect(a), client.connect(b)]);
  });

  after(async () => {
    await client.close();
    await dispose();
  });

  beforeEach(() => {
    globalThis.fetch = fakeFetch as typeof fetch;
    requested.length = 0;
    clearHttpCache();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const textPart = res.content.find((c: any) => c.type === "text")?.text ?? "";
    return { res, text: textPart as string, data: (() => { try { return JSON.parse(textPart); } catch { return undefined; } })() };
  }

  it("lists all weather and WeatherWise tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "search_location",
      "get_current_weather",
      "get_forecast",
      "get_nws_forecast",
      "get_weather_alerts",
      "get_convective_outlook",
      "get_mesoscale_discussions",
      "get_spc_watches",
      "get_storm_reports",
      "get_tropical_cyclones",
      "get_forecast_discussion",
      "get_air_quality",
      "get_marine_forecast",
      "get_radar_frames",
      "get_radar_image",
      "get_severe_weather_briefing",
      "ww_status",
      "ww_open",
      "ww_login",
      "ww_screenshot",
      "ww_read_page",
      "ww_click",
      "ww_type",
      "ww_press_key",
      "ww_map",
      "ww_network_log",
      "ww_discover_api",
      "ww_call_api",
      "ww_close",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    assert.ok(!names.includes("ww_evaluate"), "ww_evaluate must be opt-in");
    const prompts = await client.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ["explore_weatherwise", "severe_weather_briefing"]);
  });

  it("returns NWS alerts for a US place with impact parameters", async () => {
    const { data } = await call("get_weather_alerts", { location: "Moore, Oklahoma" });
    assert.equal(data.provider, "NWS");
    assert.equal(data.count, 1);
    assert.equal(data.alerts[0].event, "Tornado Warning");
    assert.equal(data.alerts[0].parameters.tornadoDetection, "OBSERVED");
    assert.ok(requested.some((u) => u.includes("point=35.34%2C-97.49")));
  });

  it("routes German locations to DWD warnings", async () => {
    const { data } = await call("get_weather_alerts", { location: "Berlin", language: "de" });
    assert.equal(data.provider, "DWD");
    assert.equal(data.alerts[0].event, "STARKES GEWITTER");
    assert.equal(data.alerts[0].senderName, "Deutscher Wetterdienst");
  });

  it("evaluates the SPC outlook at a point", async () => {
    const { data } = await call("get_convective_outlook", { day: 1, location: "35.2,-97.4" });
    assert.equal(data.highestCategoryIssued, "SLGT");
    assert.equal(data.layers.categorical.atLocation, "SLGT label");
    assert.equal(data.layers.tornado.atLocation, "0.05 label");
    assert.equal(data.layers.wind.atLocation, null);
  });

  it("filters storm reports by distance", async () => {
    const { data } = await call("get_storm_reports", { location: "35.22,-97.44", radius_km: 100 });
    assert.equal(data.total, 3);
    assert.deepEqual(data.counts, { tornado: 1, wind: 1, hail: 1 });
    assert.equal(data.reports[0].location, "Norman");
  });

  it("returns mesoscale discussions, watches and tropical cyclones", async () => {
    assert.equal((await call("get_mesoscale_discussions")).data[0].areasAffected, "Central Oklahoma");
    assert.equal((await call("get_spc_watches")).data[0].title, "Tornado Watch 500");
    assert.equal((await call("get_tropical_cyclones")).data.storms[0].intensity_kt, 100);
  });

  it("renders a radar image with radar over basemap and a marker", async () => {
    const { res } = await call("get_radar_image", { location: "35.2,-97.4", zoom: 9, size: 256, frames: 2 });
    const images = res.content.filter((c: any) => c.type === "image");
    assert.equal(images.length, 2);
    assert.match(res.content[0].text, /requested 9, capped by radar provider/);
    const png = PNG.sync.read(Buffer.from(images[0].data, "base64"));
    assert.equal(png.width, 256);
    // corner pixel: blue radar blended over white basemap at 80% opacity
    assert.deepEqual([...png.data.subarray(0, 3)], [51, 51, 255]);
    // center pixel: red marker
    const c = (128 * 256 + 128) * 4;
    assert.deepEqual([...png.data.subarray(c, c + 3)], [220, 0, 0]);
  });

  it("builds a severe weather briefing and survives partial failures", async () => {
    const { data } = await call("get_severe_weather_briefing", { location: "Moore, Oklahoma" });
    assert.equal(data.current.weather, "Thunderstorm");
    assert.equal(data.alerts.alerts[0].event, "Tornado Warning");
    assert.equal(data.alerts.alerts[0].description, undefined);
    assert.equal(data.spcDay1.atLocation.categorical, "SLGT label");
    assert.equal(data.stormReports.total, 3);
    assert.equal(data.tropical.count, 1);
  });

  it("reports errors as tool errors", async () => {
    const { res, text } = await call("get_forecast", { location: "Atlantis-does-not-exist" });
    assert.equal(res.isError, true);
    assert.match(text, /Location not found/);
  });
});
