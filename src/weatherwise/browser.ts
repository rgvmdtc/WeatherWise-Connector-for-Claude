import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import type { Config } from "../config.js";

const CHROMIUM_CANDIDATES = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** WebGL is required by the WeatherWise radar map; SwiftShader makes it work without a GPU. */
const LAUNCH_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

export interface LaunchOverrides {
  headless?: boolean;
}

/**
 * Owns one persistent Chromium profile (cookies, localStorage and IndexedDB survive restarts,
 * so a WeatherWise login is kept). All MCP sessions open their own tab in this shared context.
 */
export class BrowserManager {
  private contextPromise?: Promise<BrowserContext>;

  constructor(private readonly config: Config) {}

  get profileDir(): string {
    return path.join(this.config.dataDir, "browser-profile");
  }

  get running(): boolean {
    return this.contextPromise !== undefined;
  }

  context(overrides: LaunchOverrides = {}): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = this.launch(overrides).catch((err) => {
        this.contextPromise = undefined;
        throw err;
      });
    }
    return this.contextPromise;
  }

  private async launch(overrides: LaunchOverrides): Promise<BrowserContext> {
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Error("playwright-core is not installed. Run `npm install` in the connector directory.");
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    const options = {
      headless: overrides.headless ?? this.config.headless,
      viewport: this.config.viewport,
      args: LAUNCH_ARGS,
      locale: "en-US",
      permissions: ["geolocation"],
      geolocation: { latitude: 39.8283, longitude: -98.5795 },
    };

    const attempts: { label: string; extra: Record<string, unknown> }[] = [];
    if (this.config.chromiumPath) attempts.push({ label: this.config.chromiumPath, extra: { executablePath: this.config.chromiumPath } });
    attempts.push({ label: "Playwright-managed Chromium", extra: {} });
    attempts.push({ label: "installed Google Chrome", extra: { channel: "chrome" } });
    for (const candidate of CHROMIUM_CANDIDATES) {
      if (fs.existsSync(candidate)) attempts.push({ label: candidate, extra: { executablePath: candidate } });
    }

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const ctx = await chromium.launchPersistentContext(this.profileDir, { ...options, ...attempt.extra });
        ctx.on("close", () => {
          this.contextPromise = undefined;
        });
        return ctx;
      } catch (err) {
        errors.push(`${attempt.label}: ${(err as Error).message.split("\n")[0]}`);
      }
    }
    throw new Error(
      "Could not start Chromium for the WeatherWise browser tools. Install a browser with " +
        "`npx playwright install chromium` or set CHROMIUM_PATH to a Chrome/Chromium binary.\n" +
        errors.join("\n"),
    );
  }

  async close(): Promise<void> {
    const pending = this.contextPromise;
    this.contextPromise = undefined;
    if (pending) await (await pending.catch(() => null))?.close().catch(() => undefined);
  }
}
