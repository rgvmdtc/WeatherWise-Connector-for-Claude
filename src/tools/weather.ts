import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { describeLocation, guessCountry, type Location, resolveLocation, searchLocations } from "../lib/geo.js";
import { getDwdAlerts } from "../sources/dwd.js";
import { getActiveTropicalCyclones } from "../sources/nhc.js";
import * as nws from "../sources/nws.js";
import * as om from "../sources/openmeteo.js";
import { ATTRIBUTION, getRadarTimeline, radarTileTemplate, renderRadarImage, BASEMAP_TEMPLATE } from "../sources/radar.js";
import * as spc from "../sources/spc.js";
import { json, READ_ONLY, safe } from "./util.js";

const location = z
  .string()
  .min(1)
  .describe('Place name ("Berlin", "Moore, Oklahoma", "Norman, OK, US") or coordinates "lat,lon" (e.g. "35.22,-97.44").');
const units = z.enum(["metric", "imperial"]).default("metric").describe("Unit system for temperatures, wind and precipitation.");

function countryOf(loc: Location): string | undefined {
  return loc.countryCode?.toUpperCase() ?? guessCountry(loc.latitude, loc.longitude);
}

async function alertsFor(loc: Location, includeText: boolean, lang: "de" | "en") {
  const country = countryOf(loc);
  if (country === "DE") {
    return { provider: "DWD", alerts: await getDwdAlerts(loc.latitude, loc.longitude, lang, includeText) };
  }
  if (country === "US" || country === "PR" || country === "GU" || country === "VI" || country === "AS" || country === "MP" || !country) {
    try {
      const alerts = await nws.getActiveAlerts({ point: { lat: loc.latitude, lon: loc.longitude }, includeText });
      return { provider: "NWS", alerts };
    } catch (err) {
      if (country) throw err;
    }
  }
  return {
    provider: null,
    alerts: [],
    note:
      "Official warnings are built in for the USA (NWS) and Germany (DWD). For other regions, open WeatherWise " +
      "with ww_open and read its alert panel, or check the national weather service / meteoalarm.org.",
  };
}

export function registerWeatherTools(server: McpServer, config: Config): void {
  server.registerTool(
    "search_location",
    {
      title: "Search location",
      description: "Geocode a place name to coordinates (with country, region and time zone). Use it to disambiguate places before other tools.",
      inputSchema: {
        query: z.string().min(1).describe("Place name, e.g. 'Springfield' or 'München'."),
        count: z.number().int().min(1).max(20).default(5),
        language: z.string().default("en").describe("Language for place names, e.g. 'de' or 'en'."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ query, count, language }) => json(await searchLocations(query, count, language))),
  );

  server.registerTool(
    "get_current_weather",
    {
      title: "Current weather",
      description:
        "Current conditions for a location: temperature, feels-like, humidity, dew point, wind/gusts, pressure, precipitation, cloud cover, visibility, UV and CAPE. For US locations the latest observation from the nearest NWS station is added.",
      inputSchema: { location, units },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, units: u }) => {
      const loc = await resolveLocation(input);
      const current = await om.getCurrent(loc, u);
      let observation: unknown;
      if (countryOf(loc) === "US") {
        const point = await nws.getPoint(loc.latitude, loc.longitude).catch(() => null);
        if (point) observation = await nws.getLatestObservation(point).catch(() => undefined);
      }
      return json({ ...current, nwsObservation: observation, source: "Open-Meteo" + (observation ? " + NWS" : "") });
    }),
  );

  server.registerTool(
    "get_forecast",
    {
      title: "Weather forecast",
      description:
        "Daily (up to 16 days) and optional hourly forecast: temperatures, precipitation amount/probability, snow, wind/gusts, UV, sunrise/sunset, plus storm-relevant hourly fields (CAPE, lifted index, freezing level). Optionally pick a specific weather model.",
      inputSchema: {
        location,
        units,
        days: z.number().int().min(1).max(16).default(7),
        hourly: z.boolean().default(false).describe("Include hourly data."),
        hours: z.number().int().min(1).max(384).default(48).describe("Number of hourly steps to return when hourly=true."),
        model: z
          .string()
          .optional()
          .describe("Optional Open-Meteo model id, e.g. 'gfs_seamless', 'icon_seamless', 'ecmwf_ifs025', 'gem_seamless', 'gfs_hrrr'."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, units: u, days, hourly, hours, model }) => {
      const loc = await resolveLocation(input);
      return json({ ...(await om.getForecast(loc, { units: u, days, hourly, hours, model })), source: "Open-Meteo" });
    }),
  );

  server.registerTool(
    "get_nws_forecast",
    {
      title: "NWS forecast (US)",
      description: "Official National Weather Service text forecast for a US location (7-day periods or hourly).",
      inputSchema: {
        location,
        hourly: z.boolean().default(false),
        periods: z.number().int().min(1).max(156).default(14),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, hourly, periods }) => {
      const loc = await resolveLocation(input);
      const point = await nws.getPoint(loc.latitude, loc.longitude);
      if (!point) throw new Error(`${describeLocation(loc)} is outside NWS coverage. Use get_forecast instead.`);
      return json({ location: loc, ...(await nws.getTextForecast(point, hourly, periods)) });
    }),
  );

  server.registerTool(
    "get_weather_alerts",
    {
      title: "Weather warnings",
      description:
        "Active official weather warnings, watches and advisories (tornado, severe thunderstorm, flash flood, winter storm, heat, etc.). " +
        "USA: NWS alerts for a point or a whole state. Germany: DWD warnings. Includes impact details such as tornado detection, max hail size and max wind gust when issued.",
      inputSchema: {
        location: location.optional(),
        state: z.string().length(2).optional().describe("US state/territory code (e.g. 'OK') to list all NWS alerts in that state instead of a point."),
        event: z.string().optional().describe("US only: filter by event name, e.g. 'Tornado Warning'."),
        include_text: z.boolean().default(true).describe("Include full description and instruction texts."),
        language: z.enum(["de", "en"]).default("en").describe("Language for DWD warnings."),
        limit: z.number().int().min(1).max(500).default(50),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, state, event, include_text, language, limit }) => {
      if (state || (!input && event)) {
        const alerts = await nws.getActiveAlerts({ area: state, event, includeText: include_text, limit });
        return json({ provider: "NWS", area: state ?? "all", count: alerts.length, alerts });
      }
      if (!input) throw new Error("Provide a location or a US state code.");
      const loc = await resolveLocation(input);
      const result = await alertsFor(loc, include_text, language);
      const alerts = event ? result.alerts.filter((a) => a.event?.toLowerCase().includes(event.toLowerCase())) : result.alerts;
      return json({ location: loc, ...result, count: alerts.length, alerts: alerts.slice(0, limit) });
    }),
  );

  server.registerTool(
    "get_convective_outlook",
    {
      title: "SPC convective outlook",
      description:
        "NOAA Storm Prediction Center severe-weather outlook (Day 1-3): categorical risk (TSTM, MRGL, SLGT, ENH, MDT, HIGH) and probabilities for tornado, damaging wind and large hail (incl. significant/hatched areas). Pass a US location to get the risk at that point.",
      inputSchema: {
        day: z.number().int().min(1).max(3).default(1),
        location: location.optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ day, location: input }) => {
      const loc = input ? await resolveLocation(input) : undefined;
      const outlook = await spc.getConvectiveOutlook(day as spc.OutlookDay, loc ? { lat: loc.latitude, lon: loc.longitude } : undefined);
      return json({ location: loc, ...outlook });
    }),
  );

  server.registerTool(
    "get_mesoscale_discussions",
    {
      title: "SPC mesoscale discussions",
      description: "Latest Storm Prediction Center mesoscale discussions (short-term severe-weather/winter-weather concerns, often preceding watches).",
      inputSchema: { limit: z.number().int().min(1).max(30).default(10) },
      annotations: READ_ONLY,
    },
    safe(async ({ limit }) => json(await spc.getMesoscaleDiscussions(limit))),
  );

  server.registerTool(
    "get_spc_watches",
    {
      title: "SPC watches",
      description: "Current tornado and severe thunderstorm watches issued by the Storm Prediction Center.",
      inputSchema: { limit: z.number().int().min(1).max(30).default(15) },
      annotations: READ_ONLY,
    },
    safe(async ({ limit }) => json(await spc.getWatches(limit))),
  );

  server.registerTool(
    "get_storm_reports",
    {
      title: "Storm reports",
      description: "Preliminary local storm reports (tornado, wind damage, hail) from the SPC for today or yesterday, optionally only near a location.",
      inputSchema: {
        day: z.enum(["today", "yesterday"]).default("today"),
        location: location.optional(),
        radius_km: z.number().min(1).max(2000).default(200),
        types: z.array(z.enum(["tornado", "wind", "hail"])).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ day, location: input, radius_km, types, limit }) => {
      const loc = input ? await resolveLocation(input) : undefined;
      const near = loc ? { lat: loc.latitude, lon: loc.longitude, radiusKm: radius_km } : undefined;
      return json({ location: loc, ...(await spc.getStormReports({ day, near, types, limit })) });
    }),
  );

  server.registerTool(
    "get_tropical_cyclones",
    {
      title: "Tropical cyclones",
      description: "Active hurricanes, tropical storms and depressions in the Atlantic and Eastern/Central Pacific (NOAA NHC) with position, intensity, movement and advisory links.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => json(await getActiveTropicalCyclones())),
  );

  server.registerTool(
    "get_forecast_discussion",
    {
      title: "NWS forecast discussion",
      description: "Latest Area Forecast Discussion (AFD) written by the local NWS office for a US location – the meteorologists' reasoning behind the forecast. Other NWS text products can be fetched via product_type (e.g. 'HWO' hazardous weather outlook).",
      inputSchema: {
        location,
        product_type: z.string().default("AFD").describe("NWS product code, e.g. AFD, HWO, SPS, LSR."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, product_type }) => {
      const loc = await resolveLocation(input);
      const point = await nws.getPoint(loc.latitude, loc.longitude);
      if (!point) throw new Error(`${describeLocation(loc)} is outside NWS coverage.`);
      const product = await nws.getLatestProduct(product_type.toUpperCase(), point.cwa);
      if (!product) throw new Error(`No ${product_type} product found for office ${point.cwa}.`);
      return json({ location: loc, forecastOffice: point.cwa, ...product });
    }),
  );

  server.registerTool(
    "get_air_quality",
    {
      title: "Air quality & pollen",
      description: "Air quality index (European and US AQI), particulate matter, ozone, NO2, SO2, CO, dust, UV and pollen levels, current and hourly.",
      inputSchema: { location, hours: z.number().int().min(1).max(120).default(24) },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, hours }) => json({ ...(await om.getAirQuality(await resolveLocation(input), hours)), source: "Open-Meteo (CAMS)" })),
  );

  server.registerTool(
    "get_marine_forecast",
    {
      title: "Marine forecast",
      description: "Wave height, direction, period, swell and sea surface temperature for a coastal or offshore location.",
      inputSchema: { location, days: z.number().int().min(1).max(8).default(5) },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, days }) => json({ ...(await om.getMarine(await resolveLocation(input), days)), source: "Open-Meteo Marine" })),
  );

  server.registerTool(
    "get_radar_frames",
    {
      title: "Radar timeline",
      description: "Available global precipitation-radar frames (past ~2 hours, plus nowcast if offered) with XYZ tile URL templates usable by any map.",
      inputSchema: {
        color_scheme: z.number().int().min(0).max(8).default(2).describe("RainViewer color scheme id."),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ color_scheme }) => {
      const t = await getRadarTimeline();
      return json({
        generated: t.generated,
        maxZoom: config.radarMaxZoom,
        frames: t.frames.map((f) => ({ ...f, tileUrl: radarTileTemplate(t.host, f, color_scheme) })),
        satelliteInfrared: t.satellite.map((f) => ({ ...f, tileUrl: `${t.host}${f.path}/256/{z}/{x}/{y}/0/0_0.png` })),
        attribution: ATTRIBUTION,
      });
    }),
  );

  server.registerTool(
    "get_radar_image",
    {
      title: "Radar image",
      description:
        "Renders a radar map image (precipitation over a street basemap) centered on a location with a marker. Use frames > 1 to see the latest frames as a loop and judge storm motion. For WeatherWise's own high-resolution radar products (velocity, CC, 3D, lightning) use ww_open + ww_screenshot.",
      inputSchema: {
        location,
        zoom: z.number().int().min(3).max(12).default(7).describe("Map zoom (3 = continent, 7 = region, 9+ = city). Radar tiles are capped at the provider's max zoom."),
        size: z.number().int().min(256).max(1024).default(640),
        frames: z.number().int().min(1).max(6).default(1).describe("Number of most recent frames to render (oldest first)."),
        color_scheme: z.number().int().min(0).max(8).default(2),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, zoom, size, frames, color_scheme }) => {
      const loc = await resolveLocation(input);
      const t = await getRadarTimeline();
      const past = t.frames.filter((f) => f.kind === "past");
      if (!past.length) throw new Error("No radar frames available right now.");
      const z = Math.min(zoom, config.radarMaxZoom);
      const selected = past.slice(-frames);
      const content: any[] = [
        {
          type: "text",
          text:
            `Radar for ${describeLocation(loc)} at zoom ${z}` +
            (z < zoom ? ` (requested ${zoom}, capped by radar provider)` : "") +
            `. Frames (UTC): ${selected.map((f) => f.iso).join(", ")}. Red dot = location. ${ATTRIBUTION}`,
        },
      ];
      for (const frame of selected) {
        const png = await renderRadarImage({
          lat: loc.latitude,
          lon: loc.longitude,
          zoom: z,
          size,
          radarTemplate: radarTileTemplate(t.host, frame, color_scheme),
          basemapTemplate: BASEMAP_TEMPLATE,
        });
        content.push({ type: "text", text: `Frame ${frame.iso}` });
        content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
      }
      return { content };
    }),
  );

  server.registerTool(
    "get_severe_weather_briefing",
    {
      title: "Severe weather briefing",
      description:
        "One-call situational briefing for a location: current conditions, active warnings, SPC Day 1 outlook at the point, nearby storm reports, latest mesoscale discussions and active tropical cyclones. Ideal starting point for 'is severe weather coming?' questions.",
      inputSchema: { location, units, radius_km: z.number().min(10).max(1000).default(150) },
      annotations: READ_ONLY,
    },
    safe(async ({ location: input, units: u, radius_km }) => {
      const loc = await resolveLocation(input);
      const isUS = countryOf(loc) === "US";
      const point = { lat: loc.latitude, lon: loc.longitude };
      const tasks = {
        current: om.getCurrent(loc, u).then((c) => c.current),
        today: om.getForecast(loc, { units: u, days: 2, hourly: false, hours: 0 }).then((f) => f.daily),
        alerts: alertsFor(loc, false, "en"),
        spcDay1: isUS ? spc.getConvectiveOutlook(1, point) : Promise.resolve(undefined),
        spcDay2: isUS ? spc.getConvectiveOutlook(2, point) : Promise.resolve(undefined),
        stormReports: isUS ? spc.getStormReports({ day: "today", near: { ...point, radiusKm: radius_km }, limit: 25 }) : Promise.resolve(undefined),
        mesoscaleDiscussions: isUS ? spc.getMesoscaleDiscussions(5) : Promise.resolve(undefined),
        tropical: getActiveTropicalCyclones(),
      };
      const keys = Object.keys(tasks) as (keyof typeof tasks)[];
      const settled = await Promise.allSettled(keys.map((k) => tasks[k]));
      const briefing: Record<string, unknown> = { location: loc, generated: new Date().toISOString(), units: u };
      settled.forEach((r, i) => {
        const key = keys[i];
        if (r.status === "fulfilled") {
          if (r.value !== undefined) briefing[key] = r.value;
        } else {
          briefing[key] = { error: (r.reason as Error)?.message ?? String(r.reason) };
        }
      });
      const outlook = briefing.spcDay1 as any;
      if (outlook?.layers) {
        briefing.spcDay1 = {
          atLocation: Object.fromEntries(Object.entries(outlook.layers).map(([k, v]: [string, any]) => [k, v?.atLocation ?? null])),
          highestCategoryIssued: outlook.highestCategoryIssued,
        };
      }
      const day2 = briefing.spcDay2 as any;
      if (day2?.layers) briefing.spcDay2 = { atLocation: day2.layers.categorical?.atLocation ?? null };
      return json(briefing);
    }),
  );
}
