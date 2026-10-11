import { buildUrl, getJson } from "../lib/http.js";
import type { Alert } from "./nws.js";

/** Official DWD (Deutscher Wetterdienst) warnings for a point in Germany, via the Bright Sky API. */
export async function getDwdAlerts(lat: number, lon: number, lang: "de" | "en", includeText = true): Promise<Alert[]> {
  const url = buildUrl("https://api.brightsky.dev/alerts", { lat, lon });
  const data = await getJson(url, { ttl: 120 });
  const pick = (a: any, field: string) => a[`${field}_${lang}`] ?? a[`${field}_de`] ?? a[`${field}_en`];
  const area = [data.location?.name, data.location?.district, data.location?.state].filter(Boolean).join(", ");
  return (data.alerts ?? []).map((a: any) => ({
    id: String(a.alert_id ?? a.id),
    event: pick(a, "event"),
    headline: pick(a, "headline"),
    severity: a.severity,
    certainty: a.certainty,
    urgency: a.urgency,
    areaDesc: area || undefined,
    sent: a.effective,
    onset: a.onset,
    effective: a.effective,
    expires: a.expires,
    senderName: "Deutscher Wetterdienst",
    description: includeText ? pick(a, "description") : undefined,
    instruction: includeText ? pick(a, "instruction") : undefined,
    source: "DWD via Bright Sky (api.brightsky.dev)",
  }));
}
