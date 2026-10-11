import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distanceKm, geometryContains, guessCountry, lonLatToTile, parseCoordinates } from "../src/lib/geo.js";
import { columnsToRows, describeWeatherCode } from "../src/sources/openmeteo.js";
import { parseRss, parseStormReportsCsv } from "../src/sources/spc.js";
import { classify, EndpointCatalog, isInteresting, templatePath } from "../src/weatherwise/catalog.js";
import { STORM_REPORTS_CSV, MD_RSS } from "./fixtures.js";

describe("geo", () => {
  it("parses coordinates", () => {
    assert.deepEqual(parseCoordinates("35.22,-97.44"), { latitude: 35.22, longitude: -97.44 });
    assert.deepEqual(parseCoordinates(" 52.5 13.4 "), { latitude: 52.5, longitude: 13.4 });
    assert.equal(parseCoordinates("Berlin"), null);
    assert.equal(parseCoordinates("95,10"), null);
  });

  it("guesses countries for routing", () => {
    assert.equal(guessCountry(35.2, -97.4), "US");
    assert.equal(guessCountry(52.5, 13.4), "DE");
    assert.equal(guessCountry(-33.9, 151.2), undefined);
  });

  it("computes distances", () => {
    const d = distanceKm(52.52, 13.405, 48.137, 11.575); // Berlin – Munich
    assert.ok(d > 500 && d < 510, `got ${d}`);
  });

  it("tests points against polygons with holes and multipolygons", () => {
    const square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]];
    assert.equal(geometryContains({ type: "Polygon", coordinates: square }, 2, 2), true);
    assert.equal(geometryContains({ type: "Polygon", coordinates: square }, 5, 5), false);
    assert.equal(geometryContains({ type: "MultiPolygon", coordinates: [square] }, 11, 1), false);
  });

  it("converts to tile coordinates", () => {
    const t = lonLatToTile(0, 0, 1);
    assert.deepEqual(t, { x: 1, y: 1 });
  });
});

describe("open-meteo helpers", () => {
  it("turns columns into rows with weather descriptions", () => {
    const rows = columnsToRows({ time: ["a", "b"], weather_code: [95, 0], temperature_2m: [20, 21] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].weather, "Thunderstorm");
    assert.equal(rows[1].temperature_2m, 21);
    assert.equal(describeWeatherCode(999), "Weather code 999");
  });
});

describe("SPC parsers", () => {
  it("parses storm report CSV sections", () => {
    const reports = parseStormReportsCsv(STORM_REPORTS_CSV);
    assert.equal(reports.length, 4);
    assert.deepEqual(reports.map((r) => r.type), ["tornado", "wind", "wind", "hail"]);
    assert.equal(reports[0].magnitude, "unknown");
    assert.equal(reports[1].comments, "TREES DOWN, POWER LINES DOWN. (OUN)");
    assert.equal(reports[3].magnitude, "175");
  });

  it("parses RSS items", () => {
    const items = parseRss(MD_RSS);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "SPC MD 1234");
    assert.match(items[0].description, /Areas affected/);
  });
});

describe("endpoint catalog", () => {
  it("templates variable path segments", () => {
    assert.equal(templatePath("/radar/KTLX/1728650000/7/30/50.png"), "/radar/KTLX/{timestamp}/{z}/{x}/{y}.png");
    assert.equal(templatePath("/api/v2/alerts/3fa85f64-5717-4562-b3fc-2c963f66afa6"), "/api/v2/alerts/{uuid}");
    assert.equal(templatePath("/api/point/35.2,-97.4"), "/api/point/{lat},{lon}");
    assert.equal(templatePath("/api/scans/20261011T1200Z"), "/api/scans/{datetime}");
  });

  it("classifies and filters requests", () => {
    assert.equal(classify("https://x.test/a/5/1/2.png", "image/png", "image"), "tile");
    assert.equal(classify("https://x.test/api", "application/json", "fetch"), "json");
    assert.equal(isInteresting({ url: "https://www.google-analytics.com/collect", resourceType: "fetch" }), false);
    assert.equal(isInteresting({ url: "https://x.test/app.js", resourceType: "script" }), false);
    assert.equal(isInteresting({ url: "https://api.x.test/v1/radar", resourceType: "fetch" }), true);
  });

  it("groups requests into endpoints", () => {
    const catalog = new EndpointCatalog();
    const base = { method: "GET", status: 200, resourceType: "fetch", contentType: "application/json", time: "t" };
    const stats = catalog.ingest([
      { ...base, id: 1, url: "https://api.x.test/v1/sites/KTLX/scans?product=REF", sample: '{"scans":[],"site":"KTLX"}' },
      { ...base, id: 2, url: "https://api.x.test/v1/sites/KTLX/scans?product=VEL&limit=10", sample: '{"scans":[1]}' },
      { ...base, id: 3, url: "https://api.x.test/v1/lightning/1728650000", sample: "[]" },
    ]);
    assert.deepEqual(stats, { added: 2, updated: 1 });
    const scans = catalog.list({ search: "scans" })[0];
    assert.equal(scans.count, 2);
    assert.deepEqual(scans.queryParams, ["product", "limit"]);
    assert.deepEqual(scans.jsonKeys, ["scans"]);
    assert.ok(catalog.hosts().has("api.x.test"));
  });
});

describe("ww_call_api host allowlist", () => {
  it("allows the app's domain family but not arbitrary hosts", async () => {
    const { WeatherWiseSession } = await import("../src/weatherwise/session.js");
    const { loadConfig } = await import("../src/config.js");
    const mk = (url: string) =>
      new WeatherWiseSession(loadConfig({ WEATHERWISE_URL: url, WEATHERWISE_API_HOSTS: "tiles.example.net" } as NodeJS.ProcessEnv), {} as any, new EndpointCatalog());
    const ww = mk("https://web.weatherwise.app");
    assert.equal(ww.isAllowedHost("web.weatherwise.app"), true);
    assert.equal(ww.isAllowedHost("api.weatherwise.app"), true);
    assert.equal(ww.isAllowedHost("tiles.example.net"), true);
    assert.equal(ww.isAllowedHost("evilweatherwise.app"), false);
    assert.equal(ww.isAllowedHost("example.org"), false);
    const ip = mk("http://127.0.0.1:8080");
    assert.equal(ip.isAllowedHost("127.0.0.1:8080"), true);
    assert.equal(ip.isAllowedHost("10.0.0.1"), false);
  });
});
