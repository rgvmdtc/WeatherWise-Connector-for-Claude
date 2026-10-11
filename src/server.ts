import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { setContact } from "./lib/http.js";
import { registerWeatherTools } from "./tools/weather.js";
import { registerWeatherWiseTools } from "./tools/weatherwise.js";
import { BrowserManager } from "./weatherwise/browser.js";
import { EndpointCatalog } from "./weatherwise/catalog.js";
import { WeatherWiseSession } from "./weatherwise/session.js";

export const SERVER_NAME = "weatherwise";
export const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `WeatherWise connector.

Two groups of tools:
1. Structured weather data (no login needed): get_severe_weather_briefing, get_weather_alerts, get_convective_outlook,
   get_mesoscale_discussions, get_spc_watches, get_storm_reports, get_tropical_cyclones, get_forecast, get_nws_forecast,
   get_current_weather, get_forecast_discussion, get_air_quality, get_marine_forecast, get_radar_frames, get_radar_image,
   search_location. These use the same official sources WeatherWise displays (NWS, SPC, NHC, DWD) plus Open-Meteo/RainViewer.
2. ww_* tools drive the real WeatherWise web app (web.weatherwise.app) in a browser: ww_open -> ww_read_page/ww_screenshot ->
   ww_click/ww_type/ww_map to use any feature (radar products, lightning, 3D radar, alerts, outlooks, storm tracks, settings).
   ww_network_log + ww_discover_api turn the app's own traffic into a callable API (ww_call_api).
   The web app requires a WeatherWise Plus/Pro login; if ww_open reports loginRequired, call ww_login.

Prefer group 1 for facts and numbers; use group 2 when the user asks for WeatherWise specifically, for its radar imagery,
or for data only WeatherWise has (e.g. lightning, high-res radar products).`;

export interface SharedResources {
  config: Config;
  browser: BrowserManager;
  catalog: EndpointCatalog;
}

export function createSharedResources(config: Config): SharedResources {
  setContact(config.contact);
  return {
    config,
    browser: new BrowserManager(config),
    catalog: new EndpointCatalog(path.join(config.dataDir, "api-catalog.json")),
  };
}

export interface ServerHandle {
  server: McpServer;
  /** Releases per-session resources (the WeatherWise tab). */
  dispose(): Promise<void>;
}

/** Builds one MCP server instance. Each connected client gets its own instance (and its own WeatherWise tab). */
export function createServer(shared: SharedResources): ServerHandle {
  const { config, browser, catalog } = shared;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  registerWeatherTools(server, config);

  let session: WeatherWiseSession | undefined;
  if (config.browserEnabled) {
    session = new WeatherWiseSession(config, browser, catalog);
    registerWeatherWiseTools(server, config, session, catalog);

    server.registerResource(
      "weatherwise-api-catalog",
      "weatherwise://api-catalog",
      {
        title: "WeatherWise API catalog",
        description: "Endpoints of the WeatherWise web app discovered from its network traffic (see ww_discover_api).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(catalog.toJSON(), null, 2) }],
      }),
    );
  }

  server.registerPrompt(
    "severe_weather_briefing",
    {
      title: "Severe weather briefing",
      description: "Prepare a concise severe-weather briefing for a location.",
      argsSchema: { location: z.string().describe("Place name or lat,lon") },
    },
    ({ location }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Give me a severe weather briefing for ${location}. Start with get_severe_weather_briefing, then add detail with ` +
              `get_weather_alerts, get_convective_outlook (day 1-3) and get_radar_image as needed. If WeatherWise is available, ` +
              `open it at the location (ww_open) and include what its radar shows. Summarize threats, timing and recommended actions.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "explore_weatherwise",
    {
      title: "Explore WeatherWise",
      description: "Walk through the WeatherWise web app, map its features and build the API catalog.",
      argsSchema: { location: z.string().optional().describe("Optional location to center the app on") },
    },
    ({ location }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Open WeatherWise${location ? ` at ${location}` : ""} with ww_open (log in with ww_login if needed). ` +
              `Use ww_read_page to list all menus, layers and radar products, click through each feature (ww_click), ` +
              `then run ww_discover_api and give me a structured overview of every feature and the API endpoints behind it.`,
          },
        },
      ],
    }),
  );

  return {
    server,
    async dispose() {
      await session?.close();
    },
  };
}
