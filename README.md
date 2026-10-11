# WeatherWise Connector für Claude

Ein [MCP](https://modelcontextprotocol.io)-Connector, mit dem Claude **WeatherWise** ([web.weatherwise.app](https://web.weatherwise.app)) bedienen kann, plus strukturierte Unwetterdaten aus denselben offiziellen Quellen, die WeatherWise anzeigt.

WeatherWise bietet keine öffentliche API. Der Connector baut sich deshalb seine eigene:

1. **Scraper / Browser-Steuerung:** Ein Headless-Chromium öffnet die WeatherWise-Web-App mit deinem Account. Claude kann sie wie ein Mensch bedienen (Screenshots, Texte lesen, Buttons und Layer klicken, Karte zoomen und verschieben) und erreicht so **jedes Feature** der App.
2. **Eigene API aus dem App-Traffic:** Beim Bedienen schneidet der Connector die Requests der App mit (Radar-Scans, Blitze, Warnungen, Kacheln …). `ww_discover_api` macht daraus einen dauerhaften Endpunkt-Katalog. `ww_call_api` ruft diese Endpunkte danach direkt mit der Session der App auf (Cookies und Auth-Header), auch mit geänderten Parametern wie einer anderen Station, Zeit oder Position.
3. **Strukturierte Wetterdaten (ohne Login):** NWS-Warnungen, SPC-Outlooks, Mesoscale Discussions, Watches, Storm Reports, NHC-Hurrikane, DWD-Warnungen, Vorhersagen, Luftqualität und gerenderte Radarbilder. Das sind dieselben Primärquellen, die WeatherWise anzeigt, nur maschinenlesbar.

Der Connector läuft lokal über **stdio** (Claude Desktop, Claude Code) und remote über **Streamable HTTP** (Custom Connector auf claude.ai).

> **Hinweis:** Das ist ein inoffizielles Projekt ohne Verbindung zu Interactive Weather Limited. Die Web-App ist laut WeatherWise ein Plus/Pro-Feature. Nutze den Connector nur mit deinem eigenen Account und im Rahmen der Nutzungsbedingungen von WeatherWise. Für Warnungen gilt immer: Maßgeblich sind die offiziellen Wetterdienste.

---

## Tools

### WeatherWise-App (Scraper)

| Tool | Zweck |
|---|---|
| `ww_open` | Öffnet WeatherWise und setzt optional den Standort per emulierter Geolocation. Liefert Status und Screenshot. |
| `ww_login` | Login mit `WEATHERWISE_EMAIL`/`WEATHERWISE_PASSWORD`. Die Session wird im Browser-Profil gespeichert. |
| `ww_status` | Browser- und Login-Status, aktuelle Seite, Anzahl der entdeckten Endpunkte |
| `ww_screenshot` | Screenshot der App, ganz oder nur ein Element (JPEG oder PNG) |
| `ww_read_page` | Sichtbarer Text (Warnungstexte, Legenden, Menüs) plus nummerierte Liste aller Bedienelemente mit Position |
| `ww_click` | Klickt per Index, Text bzw. Accessible Name, CSS-Selektor oder x/y (z. B. auf eine Gewitterzelle) |
| `ww_type` | Text in Eingabefelder eingeben, z. B. in die Ortssuche |
| `ww_press_key` | Tasten wie Escape, Space (Loop abspielen) oder Pfeiltasten (Frames durchgehen) |
| `ww_map` | Karte zoomen und verschieben |
| `ww_network_log` | Mitgeschnittene Requests der App |
| `ww_discover_api` | Baut den Endpunkt-Katalog und kann vorher Features automatisch durchklicken |
| `ww_call_api` | Ruft einen entdeckten Endpunkt mit der App-Session auf: JSON als Text, Bilder bzw. Kacheln als Bild |
| `ww_evaluate` | *(optional, `WEATHERWISE_ALLOW_EVAL=true`)* JavaScript im App-Tab ausführen |
| `ww_close` | Tab schließen; der Login bleibt gespeichert |

Ressource: `weatherwise://api-catalog` (der entdeckte Endpunkt-Katalog).
Prompts: `severe_weather_briefing`, `explore_weatherwise`.

### Wetterdaten (ohne Login)

| Tool | Quelle | Inhalt |
|---|---|---|
| `get_severe_weather_briefing` | alle | Lagebild in einem Aufruf: aktuelles Wetter, Warnungen, SPC Tag 1/2 am Ort, Storm Reports in der Nähe, MDs, Tropenstürme |
| `get_weather_alerts` | NWS / DWD | Aktive amtliche Warnungen (USA per Punkt oder Bundesstaat, Deutschland per Punkt) inkl. Tornado-Erkennung, Hagelgröße und Böen |
| `get_convective_outlook` | SPC | Tag 1–3: kategorisch (TSTM…HIGH) und Wahrscheinlichkeiten für Tornado, Wind und Hagel, mit Auswertung am Punkt |
| `get_mesoscale_discussions` | SPC | Aktuelle Mesoscale Discussions |
| `get_spc_watches` | SPC | Tornado- und Severe-Thunderstorm-Watches |
| `get_storm_reports` | SPC | Tornado-, Wind- und Hagelmeldungen von heute oder gestern, mit Umkreisfilter |
| `get_tropical_cyclones` | NHC | Aktive Hurrikane und Tropenstürme |
| `get_forecast_discussion` | NWS | Area Forecast Discussion und andere NWS-Textprodukte (HWO, SPS …) |
| `get_current_weather` | Open-Meteo (+ NWS-Station) | Aktuelle Bedingungen inkl. CAPE |
| `get_forecast` | Open-Meteo | Bis 16 Tage täglich und stündlich, Modellwahl (GFS, ICON, ECMWF, HRRR …) |
| `get_nws_forecast` | NWS | Offizielle US-Textvorhersage |
| `get_air_quality` | Open-Meteo/CAMS | AQI, Feinstaub, Ozon, Pollen |
| `get_marine_forecast` | Open-Meteo | Wellen, Dünung, Wassertemperatur |
| `get_radar_frames` | RainViewer | Radar-Zeitleiste mit Kachel-URLs |
| `get_radar_image` | RainViewer + CARTO/OSM | Gerendertes Radarbild mit Ortsmarker, optional mehrere Frames als Loop |
| `search_location` | Open-Meteo | Geocoding |

---

## Installation (lokal)

Voraussetzung: Node.js ≥ 20.

```bash
git clone https://github.com/rgvmdtc/WeatherWise-Connector-for-Claude.git
cd WeatherWise-Connector-for-Claude
npm install
npm run build
npx playwright-core install chromium   # Browser für die WeatherWise-Tools
```

Statt des Playwright-Chromiums kann auch ein installiertes Chrome genutzt werden: Es wird automatisch gefunden, alternativ setzt du `CHROMIUM_PATH`.

### Bei WeatherWise anmelden

Du hast zwei Möglichkeiten:

- **Interaktiv (empfohlen, funktioniert auch mit 2FA oder Captcha):**
  ```bash
  npm run login
  ```
  Ein Browserfenster öffnet sich. Melde dich an und drücke danach Enter im Terminal. Die Session liegt dann in `~/.weatherwise-connector/browser-profile`. Wichtig: Der Connector darf dabei nicht laufen, weil das Profil während der Nutzung gesperrt ist.
- **Automatisch:** Setze `WEATHERWISE_EMAIL` und `WEATHERWISE_PASSWORD`. Claude ruft dann bei Bedarf `ww_login` auf.

### Claude Desktop

In `claude_desktop_config.json` eintragen (Vorlage: [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "weatherwise": {
      "command": "node",
      "args": ["/ABSOLUTER/PFAD/WeatherWise-Connector-for-Claude/dist/index.js"],
      "env": { "WEATHERWISE_EMAIL": "du@example.com", "WEATHERWISE_PASSWORD": "…" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add weatherwise -- node /ABSOLUTER/PFAD/WeatherWise-Connector-for-Claude/dist/index.js
```

---

## Als Custom Connector auf claude.ai (Remote)

claude.ai braucht eine öffentlich erreichbare HTTPS-URL. Am einfachsten geht das mit Docker, z. B. auf einem VPS, Fly.io, Render oder Railway hinter HTTPS:

```bash
cp .env.example .env          # MCP_AUTH_TOKEN und WeatherWise-Zugangsdaten setzen
docker build -t weatherwise-connector .
docker run -d -p 3000:3000 --env-file .env -v weatherwise-data:/data weatherwise-connector
```

(oder `docker compose -f examples/docker-compose.yml up -d`)

Danach in claude.ai unter **Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen** diese URL eintragen:

```
https://dein-server.example.com/mcp?token=DEIN_MCP_AUTH_TOKEN
```

Der Token wird als `?token=` oder als `Authorization: Bearer …` akzeptiert. **Setze immer `MCP_AUTH_TOKEN`, wenn der Server öffentlich erreichbar ist**, sonst kann jeder deine WeatherWise-Session benutzen. Zum Prüfen gibt es den Health-Check `GET /health`.

Lokal im HTTP-Modus starten: `npm run start:http` (Standard: `http://127.0.0.1:3000/mcp`).

---

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `WEATHERWISE_URL` | `https://web.weatherwise.app` | Adresse der Web-App |
| `WEATHERWISE_EMAIL` / `WEATHERWISE_PASSWORD` | – | Zugangsdaten für `ww_login` |
| `WEATHERWISE_DATA_DIR` | `~/.weatherwise-connector` | Browser-Profil (Login) und `api-catalog.json` |
| `WEATHERWISE_BROWSER` | `true` | `false` deaktiviert alle `ww_*`-Tools |
| `WEATHERWISE_HEADLESS` | `true` | `false` zeigt das Browserfenster an |
| `WEATHERWISE_ALLOW_EVAL` | `false` | Aktiviert `ww_evaluate` |
| `WEATHERWISE_API_HOSTS` | – | Zusätzliche Hosts für `ww_call_api` (kommagetrennt) |
| `WEATHERWISE_VIEWPORT_WIDTH` / `_HEIGHT` | `1280` / `800` | Fenstergröße für Screenshots |
| `CHROMIUM_PATH` | automatisch | Pfad zu Chrome oder Chromium |
| `MCP_TRANSPORT` | `stdio` | `http` entspricht `--http` |
| `HOST` / `PORT` / `MCP_PATH` | `127.0.0.1` / `3000` / `/mcp` | HTTP-Modus |
| `MCP_AUTH_TOKEN` | – | Token für den HTTP-Modus |
| `ALLOWED_HOSTS` | – | Host-Header-Allowlist (Schutz vor DNS-Rebinding) |
| `CONTACT` | Repo-URL | Kontakt im User-Agent (api.weather.gov verlangt einen) |
| `RADAR_MAX_ZOOM` | `7` | Maximaler Zoom der RainViewer-Kacheln |

Hinter einem Firmen-Proxy: Node-`fetch` nutzt `HTTPS_PROXY` erst mit `NODE_USE_ENV_PROXY=1` (ab Node 22.21 / 24).

---

## So funktioniert der Scraper

```
Claude ──MCP──▶ ww_open / ww_click / ww_map ──▶ Headless-Chromium ──▶ web.weatherwise.app
                                                    │  (Response-Listener)
                                                    ▼
                                        Netzwerk-Log ──▶ ww_discover_api ──▶ api-catalog.json
                                                                                 │
Claude ──MCP──▶ ww_call_api ──▶ Browser-Request-Kontext (Cookies + Auth-Header der App) ──▶ WeatherWise-API
```

- **Standort:** WeatherWise zentriert „Mein Standort“ auf die Geolocation des Browsers. `ww_open` mit `location` setzt sie auf einen beliebigen Ort.
- **WebGL:** Die Radarkarte braucht WebGL. Chromium wird deshalb mit SwiftShader gestartet, also ohne GPU.
- **Endpunkt-Katalog:** Variable Pfadteile (Zeitstempel, IDs, `{z}/{x}/{y}`-Kacheln, Koordinaten) werden zu Platzhaltern zusammengefasst, z. B. `GET tiles.example/radar/KTLX/{timestamp}/{z}/{x}/{y}.png`. Pro Endpunkt werden Query-Parameter, Content-Type, JSON-Schlüssel und eine Beispiel-URL gespeichert.
- **Sicherheit:** `ww_call_api` kontaktiert nur Hosts, die die App selbst benutzt hat (plus die WeatherWise-Domain und `WEATHERWISE_API_HOSTS`). Auth-Header der App bleiben im Speicher und werden weder ausgegeben noch in den Katalog geschrieben. `ww_open` navigiert nur innerhalb der WeatherWise-Origin.
- **Mehrere Clients:** Im HTTP-Modus bekommt jede MCP-Session ihren eigenen Tab. Alle Tabs teilen sich ein Browser-Profil und damit den Login. Inaktive Sessions werden nach 30 Minuten geschlossen.

**Typischer Ablauf mit Claude:** „Öffne WeatherWise für Moore, Oklahoma, schalte Blitze und Velocity ein und sag mir, was du siehst.“ Claude ruft dann `ww_open`, `ww_read_page` und `ww_click` auf und wertet die Screenshots aus. Danach: „Bau mir aus dem Traffic eine API.“ Daraus werden `ww_discover_api` und anschließend `ww_call_api` mit geänderten Parametern.

---

## Entwicklung

```bash
npm run build       # TypeScript → dist/
npm test            # Unit-, Tool-, HTTP- und Browser-E2E-Tests
npm run dev         # stdio-Server direkt aus den Quellen (tsx)
```

Die Tests laufen komplett offline:

- `test/units.test.ts`: Parser (Storm-Report-CSV, RSS), Geometrie und Endpunkt-Templating
- `test/tools.test.ts`: alle Wetter-Tools über einen echten MCP-Client mit gemockten Datenquellen, inkl. Pixelprüfung des gerenderten Radarbilds
- `test/http.test.ts`: Streamable-HTTP-Transport, Token-Auth und Health-Check
- `test/browser.e2e.test.ts`: echter Chromium gegen eine lokale Fake-WeatherWise-App (Login-Wall, Geolocation, Layer-Buttons, Bearer-geschützte API). Getestet werden Login, Klicks, Mitschnitt, Endpunkt-Katalog, API-Replay mit Auth, die Host-Sperre, Karten-Zoom und das persistente Profil. Ohne gefundenes Chromium wird der Test übersprungen.

## Bekannte Grenzen

- Die Selektoren sind bewusst generisch (Rollen, Labels, Texte, Koordinaten), weil sich die WeatherWise-Oberfläche jederzeit ändern kann. Welche Endpunkte die echte App nutzt, ergibt sich erst beim ersten `ww_discover_api` mit deinem Account.
- Blitzdaten und WeatherWise-eigene Radarprodukte (Velocity, CC, 3D) gibt es nur über die App-Tools, weil es dafür keine freie offene API gibt.
- Die strukturierten Unwetter-Tools (SPC, NWS, NHC) decken die USA ab. Für Deutschland gibt es DWD-Warnungen, Vorhersage, Luftqualität und Radar weltweit.
