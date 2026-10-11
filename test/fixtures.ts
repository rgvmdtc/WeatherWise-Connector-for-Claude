import { PNG } from "pngjs";

export const STORM_REPORTS_CSV = `Time,F_Scale,Location,County,State,Lat,Lon,Comments
2015,UNK,2 N Moore,Cleveland,OK,35.37,-97.49,TORNADO OBSERVED BY SPOTTERS. (OUN)
Time,Speed,Location,County,State,Lat,Lon,Comments
2030,65,Norman,Cleveland,OK,35.22,-97.44,TREES DOWN, POWER LINES DOWN. (OUN)
2100,UNK,Denver,Denver,CO,39.74,-104.99,LARGE BRANCHES DOWN. (BOU)
Time,Size,Location,County,State,Lat,Lon,Comments
2045,175,Noble,Cleveland,OK,35.14,-97.39,GOLF BALL SIZE HAIL. (OUN)
`;

export const MD_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>SPC MDs</title>
<item><title>SPC MD 1234</title><link>https://www.spc.noaa.gov/products/md/md1234.html</link>
<pubDate>Sat, 11 Oct 2026 18:00:00 GMT</pubDate>
<description><![CDATA[<pre>Mesoscale Discussion 1234
Areas affected...Central Oklahoma

Concerning...Severe potential...Watch likely

SUMMARY...Supercells expected.
</pre>]]></description></item>
</channel></rss>`;

export const WW_RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Tornado Watch 500</title><link>https://www.spc.noaa.gov/products/watch/ww0500.html</link><description>Tornado Watch for OK</description></item>
</channel></rss>`;

const square = (lon: number, lat: number, d: number) => [
  [
    [lon - d, lat - d],
    [lon + d, lat - d],
    [lon + d, lat + d],
    [lon - d, lat + d],
    [lon - d, lat - d],
  ],
];

export function outlookGeojson(labels: string[]) {
  return {
    type: "FeatureCollection",
    features: labels.map((label, i) => ({
      type: "Feature",
      properties: { DN: i + 2, LABEL: label, LABEL2: `${label} label`, VALID: "202610111200", EXPIRE: "202610121200", ISSUE: "202610111130" },
      geometry: { type: "Polygon", coordinates: square(-97.4, 35.2, 5 - i) },
    })),
  };
}

export const NWS_ALERTS = {
  features: [
    {
      id: "urn:alert:1",
      properties: {
        id: "urn:alert:1",
        event: "Tornado Warning",
        headline: "Tornado Warning issued for Cleveland County",
        severity: "Extreme",
        certainty: "Observed",
        urgency: "Immediate",
        areaDesc: "Cleveland, OK",
        sent: "2026-10-11T20:00:00Z",
        effective: "2026-10-11T20:00:00Z",
        expires: "2026-10-11T20:45:00Z",
        senderName: "NWS Norman OK",
        description: "At 300 PM CDT, a confirmed tornado was located near Moore.",
        instruction: "TAKE COVER NOW!",
        parameters: { tornadoDetection: ["OBSERVED"], maxHailSize: ["1.75"] },
      },
    },
  ],
};

export const NWS_POINT = {
  properties: {
    gridId: "OUN",
    gridX: 1,
    gridY: 2,
    cwa: "OUN",
    radarStation: "KTLX",
    forecast: "https://api.weather.gov/gridpoints/OUN/1,2/forecast",
    forecastHourly: "https://api.weather.gov/gridpoints/OUN/1,2/forecast/hourly",
    observationStations: "https://api.weather.gov/gridpoints/OUN/1,2/stations",
    relativeLocation: { properties: { city: "Norman", state: "OK" } },
  },
};

export function solidPng(r: number, g: number, b: number, a: number): Buffer {
  const png = new PNG({ width: 256, height: 256 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = a;
  }
  return PNG.sync.write(png);
}
