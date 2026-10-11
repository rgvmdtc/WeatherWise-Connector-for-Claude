import { getJson } from "../lib/http.js";

export async function getActiveTropicalCyclones() {
  const data = await getJson("https://www.nhc.noaa.gov/CurrentStorms.json", { ttl: 600 });
  const storms = (data.activeStorms ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    classification: s.classification,
    intensity_kt: s.intensity ? Number(s.intensity) : undefined,
    pressure_mb: s.pressure ? Number(s.pressure) : undefined,
    latitude: s.latitudeNumeric ?? s.latitude,
    longitude: s.longitudeNumeric ?? s.longitude,
    movement: s.movementDir !== undefined ? { directionDeg: s.movementDir, speedMph: s.movementSpeed } : undefined,
    lastUpdate: s.lastUpdate,
    publicAdvisory: s.publicAdvisory?.url,
    forecastDiscussion: s.forecastDiscussion?.url,
    forecastGraphics: s.forecastGraphics?.url,
    cone: s.forecastTrack?.kmzFile ?? s.trackCone?.kmzFile,
  }));
  return {
    source: "NOAA National Hurricane Center / Central Pacific Hurricane Center",
    count: storms.length,
    storms,
    outlook: "https://www.nhc.noaa.gov/gtwo.php",
  };
}
