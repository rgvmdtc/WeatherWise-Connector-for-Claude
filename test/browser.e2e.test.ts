import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "playwright-core";
import { loadConfig } from "../src/config.js";
import { createServer, createSharedResources, type SharedResources } from "../src/server.js";
import { solidPng } from "./fixtures.js";

const CHROMIUM =
  process.env.CHROMIUM_PATH ??
  [chromium.executablePath(), "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(
    (p) => p && fs.existsSync(p),
  );

/** A tiny stand-in for the WeatherWise web app: login form, geolocation, layer buttons backed by a bearer-protected API. */
const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>WeatherWise</title></head><body>
<header><button id="layers" aria-label="Layers">☰</button><button>Radar</button><button>Lightning</button><button>Alerts</button></header>
<div id="loc">Locating…</div><div id="out"></div>
<canvas id="map" width="800" height="500" style="border:1px solid #000"></canvas>
<script>
const TOKEN = "Bearer secret-token";
navigator.geolocation.getCurrentPosition(p => {
  document.getElementById("loc").textContent = "Location: " + p.coords.latitude.toFixed(2) + ", " + p.coords.longitude.toFixed(2);
}, e => { document.getElementById("loc").textContent = "Location error " + e.message; });
async function load(name) {
  const r = await fetch("/api/v1/" + name + "?lat=35.2&lon=-97.4", { headers: { Authorization: TOKEN } });
  const data = await r.json();
  document.getElementById("out").textContent = name + ": " + JSON.stringify(data);
}
for (const b of document.querySelectorAll("header button")) b.addEventListener("click", () => load(b.textContent.toLowerCase()));
let zoom = 5;
document.getElementById("map").addEventListener("wheel", e => { zoom += e.deltaY < 0 ? 1 : -1; document.getElementById("out").textContent = "zoom " + zoom; });
fetch("/tiles/radar/KTLX/1728650000/7/30/50.png");
</script></body></html>`;

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in – WeatherWise</title></head><body>
<form method="post" action="/login"><h1>Sign in</h1>
<label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Sign in</button></form></body></html>`;

function startFakeApp(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const loggedIn = /session=ok/.test(req.headers.cookie ?? "");
    if (req.method === "POST" && url.pathname === "/login") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const ok = form.get("email") === "pro@example.com" && form.get("password") === "hunter2";
        res.writeHead(302, { Location: "/", ...(ok ? { "Set-Cookie": "session=ok; Path=/; HttpOnly" } : {}) });
        res.end();
      });
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(loggedIn ? APP_HTML : LOGIN_HTML);
      return;
    }
    if (url.pathname.startsWith("/api/v1/")) {
      if (!loggedIn || req.headers.authorization !== "Bearer secret-token") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const name = url.pathname.split("/").pop();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ layer: name, lat: Number(url.searchParams.get("lat")), strikes: name === "lightning" ? [{ t: 1, lat: 35.1, lon: -97.3 }] : [] }));
      return;
    }
    if (url.pathname.startsWith("/tiles/")) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(solidPng(0, 200, 0, 255));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("WeatherWise browser tools (end-to-end against a fake app)", { skip: CHROMIUM ? false : "no Chromium found" }, () => {
  let app: http.Server;
  let client: Client;
  let shared: SharedResources;
  let dispose: () => Promise<void>;
  let base: string;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ww-e2e-"));

  before(async () => {
    app = await startFakeApp();
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const config = loadConfig({
      WEATHERWISE_URL: base,
      WEATHERWISE_EMAIL: "pro@example.com",
      WEATHERWISE_PASSWORD: "hunter2",
      WEATHERWISE_DATA_DIR: dataDir,
      CHROMIUM_PATH: CHROMIUM,
    } as NodeJS.ProcessEnv);
    shared = createSharedResources(config);
    const handle = createServer(shared);
    dispose = handle.dispose;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "e2e", version: "1.0.0" });
    await Promise.all([handle.server.connect(a), client.connect(b)]);
  });

  after(async () => {
    await client?.close();
    await dispose?.();
    await shared?.browser.close();
    app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content.find((c: any) => c.type === "text")?.text ?? "";
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { res, text, data, images: res.content.filter((c: any) => c.type === "image") };
  }

  it("detects the login wall, logs in and shows the app at the emulated location", async () => {
    const first = await call("ww_open", { location: "35.2,-97.4", wait_ms: 1500 });
    assert.equal(first.res.isError, undefined, first.text);
    assert.equal(first.data.loginRequired, true);
    assert.equal(first.images.length, 1);

    const login = await call("ww_login");
    assert.equal(login.data.ok, true, login.text);

    const opened = await call("ww_open", { location: "35.2,-97.4", wait_ms: 1500, screenshot: false });
    assert.equal(opened.data.loginRequired, false);
    const page = await call("ww_read_page");
    assert.match(page.data.text, /Location: 35\.20, -97\.40/);
    const labels = page.data.controls.flatMap((c: any) => [c.text, c.label]);
    assert.ok(labels.includes("Lightning") && labels.includes("Layers"), JSON.stringify(labels));
  });

  it("clicks features and captures their API traffic", async () => {
    const click = await call("ww_click", { text: "Lightning", screenshot: false });
    assert.equal(click.res.isError, undefined, click.text);
    const page = await call("ww_read_page");
    assert.match(page.data.text, /lightning: \{"layer":"lightning"/);

    const log = await call("ww_network_log", { search: "/api/v1/" });
    assert.ok(log.data.some((r: any) => r.url.includes("/api/v1/lightning") && r.status === 200));

    const byIndex = page.data.controls.find((c: any) => c.text === "Alerts");
    await call("ww_click", { index: byIndex.index, screenshot: false });
    assert.match((await call("ww_read_page")).data.text, /alerts: \{"layer":"alerts"/);
  });

  it("builds an endpoint catalog and replays endpoints with the app's auth", async () => {
    const disc = await call("ww_discover_api", { explore: ["Radar"] });
    assert.equal(disc.data.explored.Radar, "clicked");
    const ids = disc.data.endpoints.map((e: any) => e.id);
    assert.ok(ids.some((id: string) => id.endsWith("/api/v1/lightning")), JSON.stringify(ids));
    assert.ok(ids.some((id: string) => id.endsWith("/tiles/radar/KTLX/{timestamp}/{z}/{x}/{y}.png")), JSON.stringify(ids));
    assert.ok(fs.existsSync(path.join(dataDir, "api-catalog.json")));

    const lightningId = ids.find((id: string) => id.endsWith("/api/v1/lightning"));
    const apiCall = await call("ww_call_api", { endpoint_id: lightningId, query: { lat: "40.5" } });
    assert.match(apiCall.text, /^HTTP 200 application\/json/);
    assert.match(apiCall.text, /"lat": 40.5/);

    const tile = await call("ww_call_api", { url: `${base}/tiles/radar/KTLX/1728650000/7/30/51.png` });
    assert.equal(tile.images.length, 1);

    const blocked = await call("ww_call_api", { url: "https://example.org/steal" });
    assert.equal(blocked.res.isError, true);
    assert.match(blocked.text, /not part of the WeatherWise app traffic/);

    const resource = await client.readResource({ uri: "weatherwise://api-catalog" });
    assert.ok(JSON.parse((resource.contents[0] as any).text).count >= 3);
  });

  it("drives the map, takes screenshots and keeps the session after login", async () => {
    const zoom = await call("ww_map", { action: "zoom_in", steps: 2, screenshot: false });
    assert.equal(zoom.res.isError, undefined, zoom.text);
    assert.match((await call("ww_read_page")).data.text, /zoom 7/);

    const shot = await call("ww_screenshot", { format: "png" });
    assert.equal(shot.images[0].mimeType, "image/png");

    const status = await call("ww_status");
    assert.equal(status.data.pageOpen, true);
    assert.ok(status.data.catalogedEndpoints >= 3);

    await call("ww_close");
    const reopened = await call("ww_open", { wait_ms: 1000, screenshot: false });
    assert.equal(reopened.data.loginRequired, false, "persistent profile should keep the login");
  });
});
