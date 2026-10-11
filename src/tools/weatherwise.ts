import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { describeLocation, resolveLocation } from "../lib/geo.js";
import type { EndpointCatalog } from "../weatherwise/catalog.js";
import type { WeatherWiseSession } from "../weatherwise/session.js";
import { json, safe } from "./util.js";

const BROWSER = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const BROWSER_READ = { readOnlyHint: true, openWorldHint: true } as const;

const screenshotFlag = z.boolean().default(true).describe("Attach a screenshot of the app after the action.");

async function withScreenshot(session: WeatherWiseSession, data: unknown, include: boolean): Promise<CallToolResult> {
  const result = json(data);
  if (include) {
    const shot = await session.screenshot().catch(() => null);
    if (shot) result.content.push({ type: "image", data: shot.data, mimeType: shot.mimeType });
  }
  return result;
}

/**
 * Tools that drive the WeatherWise web app (web.weatherwise.app) in a headless browser and turn the
 * app's own network traffic into a callable API.
 */
export function registerWeatherWiseTools(
  server: McpServer,
  config: Config,
  session: WeatherWiseSession,
  catalog: EndpointCatalog,
): void {
  server.registerTool(
    "ww_status",
    {
      title: "WeatherWise: status",
      description: "Shows whether the WeatherWise browser is running, the current page, whether a login is required, and how many API endpoints have been discovered.",
      inputSchema: {},
      annotations: BROWSER_READ,
    },
    safe(async () => json({ app: config.weatherwiseUrl, ...(await session.status()) })),
  );

  server.registerTool(
    "ww_open",
    {
      title: "WeatherWise: open app",
      description:
        "Opens the WeatherWise web app (radar, lightning, alerts, outlooks, 3D radar, etc.) in the connector's browser, optionally centered on a location via emulated GPS. " +
        "Returns page status and a screenshot. Start here, then use ww_read_page / ww_click / ww_map to use any WeatherWise feature. " +
        "If loginRequired is true, call ww_login.",
      inputSchema: {
        location: z.string().optional().describe('Place name or "lat,lon" to use as the device location (WeatherWise centers "my location" on it).'),
        path: z.string().optional().describe("Optional path/query/hash within the app, e.g. '/?lat=35.2&lon=-97.4' once known from ww_read_page."),
        wait_ms: z.number().int().min(0).max(30_000).default(6000).describe("Max time to wait for the app to finish loading data."),
        screenshot: screenshotFlag,
      },
      annotations: BROWSER,
    },
    safe(async ({ location, path, wait_ms, screenshot }) => {
      const loc = location ? await resolveLocation(location) : undefined;
      const status = await session.open({ path, location: loc ? { lat: loc.latitude, lon: loc.longitude } : undefined, waitMs: wait_ms });
      return withScreenshot(session, { location: loc ? describeLocation(loc) : undefined, ...status }, screenshot);
    }),
  );

  server.registerTool(
    "ww_login",
    {
      title: "WeatherWise: log in",
      description:
        "Logs into the WeatherWise account (needed for the web app, which is a Plus/Pro feature) using WEATHERWISE_EMAIL / WEATHERWISE_PASSWORD from the connector's environment. The session is persisted.",
      inputSchema: {},
      annotations: BROWSER,
    },
    safe(async () => withScreenshot(session, await session.login(), true)),
  );

  server.registerTool(
    "ww_screenshot",
    {
      title: "WeatherWise: screenshot",
      description: "Takes a screenshot of the WeatherWise app as it is currently shown (radar map, panels, alerts, etc.).",
      inputSchema: {
        full_page: z.boolean().default(false),
        format: z.enum(["jpeg", "png"]).default("jpeg").describe("jpeg is smaller; png is lossless (better for reading radar color scales)."),
        selector: z.string().optional().describe("CSS selector to capture just one element (e.g. a panel)."),
      },
      annotations: BROWSER_READ,
    },
    safe(async ({ full_page, format, selector }) => {
      if (!session.isOpen) throw new Error("WeatherWise is not open yet. Call ww_open first.");
      const shot = await session.screenshot({ fullPage: full_page, format, selector });
      return { content: [{ type: "image", data: shot.data, mimeType: shot.mimeType }] };
    }),
  );

  server.registerTool(
    "ww_read_page",
    {
      title: "WeatherWise: read page",
      description:
        "Returns the visible text of the WeatherWise app (alert texts, storm attributes, legends, menus, settings) and a numbered list of all visible controls (buttons, layer toggles, tabs, inputs) with their screen positions. Use the control index with ww_click.",
      inputSchema: { max_chars: z.number().int().min(500).max(50_000).default(6000) },
      annotations: BROWSER_READ,
    },
    safe(async ({ max_chars }) => {
      if (!session.isOpen) throw new Error("WeatherWise is not open yet. Call ww_open first.");
      return json(await session.readPage(max_chars));
    }),
  );

  server.registerTool(
    "ww_click",
    {
      title: "WeatherWise: click",
      description:
        "Clicks something in the WeatherWise app: a control index from ww_read_page, visible text / accessible name (e.g. 'Lightning', 'Velocity', 'Layers', 'Outlooks'), a CSS selector, or x/y pixel coordinates (e.g. a storm cell or alert polygon on the map).",
      inputSchema: {
        index: z.number().int().min(0).optional(),
        text: z.string().optional(),
        exact: z.boolean().default(false).describe("Exact text match instead of case-insensitive substring."),
        selector: z.string().optional(),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        double: z.boolean().default(false).describe("Double-click."),
        screenshot: screenshotFlag,
      },
      annotations: BROWSER,
    },
    safe(async ({ screenshot, ...target }) => withScreenshot(session, await session.click(target), screenshot)),
  );

  server.registerTool(
    "ww_type",
    {
      title: "WeatherWise: type",
      description: "Types into an input of the WeatherWise app (e.g. the location search). Target by CSS selector or by label/placeholder; without either, types into the focused element.",
      inputSchema: {
        text: z.string(),
        selector: z.string().optional(),
        label: z.string().optional().describe("Label or placeholder text of the input, e.g. 'Search'."),
        clear: z.boolean().default(true),
        submit: z.boolean().default(false).describe("Press Enter afterwards."),
        screenshot: screenshotFlag,
      },
      annotations: BROWSER,
    },
    safe(async ({ screenshot, ...opts }) => withScreenshot(session, await session.type(opts), screenshot)),
  );

  server.registerTool(
    "ww_press_key",
    {
      title: "WeatherWise: press key",
      description: "Presses a keyboard key in the WeatherWise app, e.g. 'Escape' to close a panel, 'Space' to play/pause the radar loop, 'ArrowLeft'/'ArrowRight' to step frames.",
      inputSchema: {
        key: z.string().describe("Playwright key name, e.g. Escape, Enter, Space, ArrowLeft, PageDown, Control+K."),
        times: z.number().int().min(1).max(50).default(1),
        screenshot: screenshotFlag,
      },
      annotations: BROWSER,
    },
    safe(async ({ key, times, screenshot }) => withScreenshot(session, await session.pressKey(key, times), screenshot)),
  );

  server.registerTool(
    "ww_map",
    {
      title: "WeatherWise: move map",
      description: "Zooms or pans the WeatherWise radar map with mouse gestures. Optionally zoom around a specific screen point (e.g. a storm).",
      inputSchema: {
        action: z.enum(["zoom_in", "zoom_out", "pan_north", "pan_south", "pan_east", "pan_west"]),
        steps: z.number().int().min(1).max(10).default(1),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        screenshot: screenshotFlag,
      },
      annotations: BROWSER,
    },
    safe(async ({ action, steps, x, y, screenshot }) =>
      withScreenshot(session, await session.map(action, steps, x !== undefined && y !== undefined ? { x, y } : undefined), screenshot),
    ),
  );

  server.registerTool(
    "ww_network_log",
    {
      title: "WeatherWise: network log",
      description:
        "Shows the HTTP requests the WeatherWise app made while you used it (API calls, radar/lightning tiles, alert feeds) – the raw material of the scraper API. Use after opening a feature to see where its data comes from.",
      inputSchema: {
        search: z.string().optional().describe("Substring filter on the URL."),
        kind: z.enum(["api", "all"]).default("api").describe("api = fetch/XHR/JSON only; all = include images and tiles."),
        since_id: z.number().int().optional().describe("Only requests with id greater than this."),
        limit: z.number().int().min(1).max(500).default(60),
      },
      annotations: BROWSER_READ,
    },
    safe(async ({ search, kind, since_id, limit }) => json(session.networkLog({ search, kind, sinceId: since_id, limit }))),
  );

  server.registerTool(
    "ww_discover_api",
    {
      title: "WeatherWise: build API catalog",
      description:
        "Turns the captured WeatherWise traffic into a persistent catalog of endpoints (method, host, templated path, query params, response type, JSON keys, example URL). " +
        "Optionally first explores the app by opening it and clicking through the given feature names so their endpoints get captured. Call ww_call_api with an endpoint's example URL to use it.",
      inputSchema: {
        explore: z.array(z.string()).optional().describe("Feature/button names to click through before cataloguing, e.g. ['Lightning', 'Alerts', 'Outlooks', 'Satellite']."),
        kind: z.enum(["json", "image", "tile", "text", "binary", "other"]).optional().describe("Only list endpoints of this response kind."),
        search: z.string().optional(),
        include_samples: z.boolean().default(false).describe("Include truncated response samples."),
      },
      annotations: BROWSER,
    },
    safe(async ({ explore, kind, search, include_samples }) => {
      const explored: Record<string, string> = {};
      if (explore?.length) {
        if (!session.isOpen) await session.open({});
        for (const name of explore) {
          try {
            await session.click({ text: name });
            explored[name] = "clicked";
          } catch (err) {
            explored[name] = (err as Error).message;
          }
        }
      }
      const stats = catalog.ingest(session.capturedRequests());
      catalog.save();
      const endpoints = catalog.list({ kind, search }).map(({ sample, ...e }) => (include_samples ? { ...e, sample } : e));
      return json({ explored: explore?.length ? explored : undefined, ...stats, total: endpoints.length, endpoints });
    }),
  );

  server.registerTool(
    "ww_call_api",
    {
      title: "WeatherWise: call API endpoint",
      description:
        "Calls a WeatherWise endpoint directly with the app's own session (cookies and auth headers captured from the app), e.g. an endpoint from ww_discover_api with modified parameters (other station, time, location). " +
        "JSON/text responses are returned as text, images (radar/lightning tiles) as images. Only hosts the app itself uses are allowed.",
      inputSchema: {
        url: z.string().url().optional().describe("Full URL to request."),
        endpoint_id: z.string().optional().describe("Endpoint id from ww_discover_api; its example URL is used (with path/query overrides)."),
        query: z.record(z.string(), z.string()).optional().describe("Query parameters to set/override."),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
        body: z.string().optional().describe("Request body (for POST/PUT/PATCH), usually JSON."),
        headers: z.record(z.string(), z.string()).optional(),
        max_chars: z.number().int().min(200).max(200_000).default(20_000),
      },
      // non-GET methods can change account state
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    safe(async ({ url, endpoint_id, query, method, body, headers, max_chars }) => {
      let target = url;
      if (!target && endpoint_id) {
        const ep = catalog.get(endpoint_id);
        if (!ep) throw new Error(`Unknown endpoint id "${endpoint_id}". See ww_discover_api.`);
        target = ep.exampleUrl;
      }
      if (!target) throw new Error("Provide url or endpoint_id.");
      const u = new URL(target);
      for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
      const finalHeaders = { ...headers };
      if (body && !Object.keys(finalHeaders).some((h) => h.toLowerCase() === "content-type")) finalHeaders["Content-Type"] = "application/json";
      const res = await session.callApi({ url: u.toString(), method, body, headers: finalHeaders });
      const meta = `HTTP ${res.status} ${res.contentType || "(no content-type)"} – ${res.body.length} bytes – ${res.url}`;
      if (res.contentType.startsWith("image/") && res.body.length < 5_000_000) {
        return {
          content: [
            { type: "text", text: meta },
            { type: "image", data: res.body.toString("base64"), mimeType: res.contentType },
          ],
        };
      }
      if (/json|text|xml|javascript|csv/.test(res.contentType) || res.body.length === 0) {
        let text = res.body.toString("utf8");
        if (res.contentType.includes("json")) {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
          } catch {
            // keep raw text
          }
        }
        const truncated = text.length > max_chars;
        return {
          content: [{ type: "text", text: `${meta}\n\n${text.slice(0, max_chars)}${truncated ? `\n... [truncated, ${text.length} chars total]` : ""}` }],
          isError: res.status >= 400,
        };
      }
      return {
        content: [{ type: "text", text: `${meta}\n\nBinary response (first 64 bytes, hex): ${res.body.subarray(0, 64).toString("hex")}` }],
        isError: res.status >= 400,
      };
    }),
  );

  if (config.allowEval) {
    server.registerTool(
      "ww_evaluate",
      {
        title: "WeatherWise: run JavaScript",
        description:
          "Evaluates a JavaScript expression inside the WeatherWise tab and returns the JSON result (e.g. read map state from the app, localStorage settings, or document structure). Enabled via WEATHERWISE_ALLOW_EVAL.",
        inputSchema: { expression: z.string().describe("Expression or async IIFE body, e.g. `document.title` or `JSON.parse(localStorage.getItem('settings'))`.") },
        annotations: BROWSER,
      },
      safe(async ({ expression }) => {
        if (!session.isOpen) throw new Error("WeatherWise is not open yet. Call ww_open first.");
        return json(await session.evaluate(expression));
      }),
    );
  }

  server.registerTool(
    "ww_close",
    {
      title: "WeatherWise: close",
      description: "Closes this session's WeatherWise tab and clears its network log (the login stays saved).",
      inputSchema: {},
      annotations: BROWSER,
    },
    safe(async () => {
      await session.close();
      session.clearNetworkLog();
      return json({ closed: true });
    }),
  );
}
