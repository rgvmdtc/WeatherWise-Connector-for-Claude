import type { Page, Request, Response } from "playwright-core";
import type { Config } from "../config.js";
import type { BrowserManager } from "./browser.js";
import { type CapturedRequest, type EndpointCatalog, isInteresting } from "./catalog.js";

const MAX_CAPTURED = 1000;
const SAMPLE_BYTES = 4000;
const MAX_SAMPLE_SOURCE_BYTES = 2_000_000;

/** Headers worth replaying when calling a discovered endpoint ourselves. */
const REPLAY_HEADERS = /^(authorization|x-api-key|x-auth-token|x-access-token|x-client-[\w-]+|x-app-[\w-]+|x-requested-with|x-ww-[\w-]+|apikey|api-key)$/i;

export interface Control {
  index: number;
  tag: string;
  role?: string;
  text?: string;
  label?: string;
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  x: number;
  y: number;
}

export interface ScreenshotResult {
  data: string;
  mimeType: "image/jpeg" | "image/png";
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One tab in the WeatherWise web app, driven on behalf of a single MCP session. */
export class WeatherWiseSession {
  private page?: Page;
  private captured: CapturedRequest[] = [];
  private seq = 0;
  private controls: Control[] = [];
  /** Auth-ish request headers seen per host; kept in memory only, never returned to the model. */
  private replayHeaders = new Map<string, Record<string, string>>();

  constructor(
    private readonly config: Config,
    private readonly browser: BrowserManager,
    private readonly catalog: EndpointCatalog,
  ) {}

  get appOrigin(): string {
    return new URL(this.config.weatherwiseUrl).origin;
  }

  get isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const ctx = await this.browser.context();
    const page = await ctx.newPage();
    page.on("response", (res) => void this.onResponse(res));
    page.on("requestfailed", (req) => this.onFailed(req));
    this.page = page;
    return page;
  }

  private push(entry: Omit<CapturedRequest, "id" | "time">) {
    this.captured.push({ id: ++this.seq, time: new Date().toISOString(), ...entry });
    if (this.captured.length > MAX_CAPTURED) this.captured.splice(0, this.captured.length - MAX_CAPTURED);
  }

  private async onResponse(res: Response) {
    const req = res.request();
    const url = req.url();
    const resourceType = req.resourceType();
    if (!isInteresting({ url, resourceType })) return;
    const headers = res.headers();
    const contentType = (headers["content-type"] ?? "").split(";")[0].trim();
    const length = Number(headers["content-length"] ?? NaN);
    let sample: string | undefined;
    if (/json|text|xml/.test(contentType) && !(length > MAX_SAMPLE_SOURCE_BYTES)) {
      try {
        const body = await res.text();
        sample = body.slice(0, SAMPLE_BYTES);
      } catch {
        // body unavailable (redirect, aborted)
      }
    }
    try {
      const reqHeaders = await req.allHeaders();
      const keep: Record<string, string> = {};
      for (const [k, v] of Object.entries(reqHeaders)) if (REPLAY_HEADERS.test(k)) keep[k] = v;
      if (Object.keys(keep).length) {
        const host = new URL(url).host.toLowerCase();
        this.replayHeaders.set(host, { ...this.replayHeaders.get(host), ...keep });
      }
    } catch {
      // page closed
    }
    this.push({
      method: req.method(),
      url,
      status: res.status(),
      resourceType,
      contentType,
      size: Number.isFinite(length) ? length : sample?.length,
      sample,
    });
  }

  private onFailed(req: Request) {
    const url = req.url();
    if (!isInteresting({ url, resourceType: req.resourceType() })) return;
    this.push({ method: req.method(), url, status: 0, resourceType: req.resourceType(), contentType: "", sample: req.failure()?.errorText });
  }

  private async settle(ms = 2500) {
    const page = this.page;
    if (!page) return;
    await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => undefined);
    await wait(400);
  }

  /** Moves the emulated GPS position. WeatherWise centers on "my location" using it. */
  async setLocation(lat: number, lon: number) {
    const ctx = await this.browser.context();
    await ctx.setGeolocation({ latitude: lat, longitude: lon });
  }

  async open(opts: { path?: string; location?: { lat: number; lon: number }; waitMs?: number }) {
    const page = await this.ensurePage();
    if (opts.location) await this.setLocation(opts.location.lat, opts.location.lon);
    const target = new URL(opts.path ?? "/", this.config.weatherwiseUrl + "/");
    if (target.origin !== this.appOrigin) throw new Error(`Only ${this.appOrigin} can be opened with ww_open.`);
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.settle(opts.waitMs ?? 6000);
    return this.status();
  }

  async status() {
    const page = this.page && !this.page.isClosed() ? this.page : undefined;
    let loginRequired: boolean | undefined;
    if (page) loginRequired = await this.looksLikeLoginPage().catch(() => undefined);
    return {
      browserRunning: this.browser.running,
      pageOpen: !!page,
      url: page?.url(),
      title: page ? await page.title().catch(() => undefined) : undefined,
      loginRequired,
      capturedRequests: this.captured.length,
      catalogedEndpoints: this.catalog.list().length,
      credentialsConfigured: !!(this.config.weatherwiseEmail && this.config.weatherwisePassword),
    };
  }

  private async looksLikeLoginPage(): Promise<boolean> {
    const page = await this.ensurePage();
    if (await page.locator('input[type="password"]:visible').count()) return true;
    const text = (await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")).toLowerCase();
    return /\b(sign in|log in|login|create account)\b/.test(text) && text.length < 1500;
  }

  async login(): Promise<{ ok: boolean; message: string }> {
    const { weatherwiseEmail: email, weatherwisePassword: password } = this.config;
    const page = await this.ensurePage();
    if (!page.url().startsWith(this.appOrigin)) {
      await page.goto(this.config.weatherwiseUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await this.settle(6000);
    }
    if (!(await this.looksLikeLoginPage())) {
      // Login form may be behind a button.
      const opener = page.getByRole("button", { name: /sign in|log in|login|account/i }).or(page.getByRole("link", { name: /sign in|log in|login/i }));
      if (await opener.count()) {
        await opener.first().click().catch(() => undefined);
        await this.settle(3000);
      }
    }
    if (!(await page.locator('input[type="password"]:visible').count())) {
      return { ok: true, message: "No login form visible – the saved session appears to be logged in already." };
    }
    if (!email || !password) {
      return {
        ok: false,
        message:
          "A login form is shown but WEATHERWISE_EMAIL / WEATHERWISE_PASSWORD are not set. " +
          "Either set them, or run `weatherwise-connector login` once to sign in interactively (the session is saved).",
      };
    }
    const emailInput = page
      .locator('input[type="email"]:visible, input[name*="email" i]:visible, input[autocomplete="username"]:visible, input[name*="user" i]:visible')
      .first();
    if (await emailInput.count()) await emailInput.fill(email);
    else return { ok: false, message: "Could not find the email field on the login form." };
    // Some forms reveal the password field only after the email step.
    let pwd = page.locator('input[type="password"]:visible').first();
    if (!(await pwd.count())) {
      await page.keyboard.press("Enter");
      await this.settle(2500);
      pwd = page.locator('input[type="password"]:visible').first();
    }
    await pwd.fill(password);
    const submit = page
      .locator('button[type="submit"]:visible')
      .or(page.getByRole("button", { name: /sign in|log in|login|continue|anmelden/i }))
      .first();
    if (await submit.count()) await submit.click();
    else await pwd.press("Enter");
    await this.settle(8000);
    const still = await page.locator('input[type="password"]:visible').count();
    return still
      ? { ok: false, message: "Login form is still visible – check the credentials (or a captcha / 2FA may be required; use `weatherwise-connector login`)." }
      : { ok: true, message: "Logged in. The session is stored in the browser profile." };
  }

  async screenshot(opts: { fullPage?: boolean; format?: "jpeg" | "png"; selector?: string } = {}): Promise<ScreenshotResult> {
    const page = await this.ensurePage();
    const format = opts.format ?? "jpeg";
    const shotOpts = format === "jpeg" ? { type: "jpeg" as const, quality: 75 } : { type: "png" as const };
    const buf = opts.selector
      ? await page.locator(opts.selector).first().screenshot({ ...shotOpts, timeout: 10_000 })
      : await page.screenshot({ ...shotOpts, fullPage: opts.fullPage ?? false, timeout: 20_000 });
    return { data: buf.toString("base64"), mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  }

  /** Lists visible interactive elements (buttons, toggles, menus, inputs) with their screen position. */
  async listControls(limit = 150): Promise<Control[]> {
    const page = await this.ensurePage();
    const controls = await page.evaluate((max) => {
      const selector = [
        "button",
        "a[href]",
        "input",
        "select",
        "textarea",
        "[role=button]",
        "[role=tab]",
        "[role=menuitem]",
        "[role=menuitemcheckbox]",
        "[role=menuitemradio]",
        "[role=option]",
        "[role=switch]",
        "[role=checkbox]",
        "[role=radio]",
        "[role=slider]",
        "[aria-label]",
        "[title]",
        "[onclick]",
        "summary",
        "label",
      ].join(",");
      const seen = new Set<Element>();
      const out: any[] = [];
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (out.length >= max) break;
        if (seen.has(el)) continue;
        seen.add(el);
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
        const input = el as HTMLInputElement;
        const text = ((el as HTMLElement).innerText || input.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "").trim().slice(0, 80);
        if (!text && !label && !["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) continue;
        const ariaChecked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-pressed") ?? el.getAttribute("aria-selected");
        out.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || undefined,
          text: text || undefined,
          label: label && label !== text ? label : undefined,
          type: input.type || undefined,
          checked: input.type === "checkbox" || input.type === "radio" ? input.checked : ariaChecked ? ariaChecked === "true" : undefined,
          disabled: (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || undefined,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        });
      }
      return out;
    }, limit);
    this.controls = controls.map((c, index) => ({ index, ...c }));
    return this.controls;
  }

  async readPage(maxChars = 6000) {
    const page = await this.ensurePage();
    const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const controls = await this.listControls();
    return {
      url: page.url(),
      title: await page.title(),
      text: text.replace(/\n{3,}/g, "\n\n").slice(0, maxChars),
      truncated: text.length > maxChars,
      controls,
    };
  }

  async click(target: { index?: number; text?: string; selector?: string; x?: number; y?: number; exact?: boolean; double?: boolean }) {
    const page = await this.ensurePage();
    const clickCount = target.double ? 2 : 1;
    let how: string;
    if (target.index !== undefined) {
      const c = this.controls.find((ctl) => ctl.index === target.index);
      if (!c) throw new Error(`No control with index ${target.index}. Call ww_read_page or ww_list_controls first.`);
      await page.mouse.click(c.x, c.y, { clickCount });
      how = `control #${c.index} (${c.text ?? c.label ?? c.tag}) at ${c.x},${c.y}`;
    } else if (target.selector) {
      await page.locator(target.selector).first().click({ timeout: 10_000, clickCount });
      how = `selector ${target.selector}`;
    } else if (target.text) {
      const name = target.exact ? target.text : new RegExp(target.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const candidates = [
        page.getByRole("button", { name }),
        page.getByRole("tab", { name }),
        page.getByRole("menuitem", { name }),
        page.getByRole("switch", { name }),
        page.getByRole("checkbox", { name }),
        page.getByRole("link", { name }),
        page.getByLabel(name),
        page.getByTitle(name),
        page.getByText(name, { exact: target.exact }),
      ];
      let clicked = false;
      for (const loc of candidates) {
        const visible = loc.locator("visible=true");
        if (await visible.count().catch(() => 0)) {
          await visible.first().click({ timeout: 10_000, clickCount });
          clicked = true;
          break;
        }
      }
      if (!clicked) throw new Error(`No visible element matching "${target.text}". Use ww_read_page to see available controls.`);
      how = `text "${target.text}"`;
    } else if (target.x !== undefined && target.y !== undefined) {
      await page.mouse.click(target.x, target.y, { clickCount });
      how = `coordinates ${target.x},${target.y}`;
    } else {
      throw new Error("Provide one of: index, text, selector, or x+y.");
    }
    await this.settle();
    return { clicked: how, url: page.url() };
  }

  async type(opts: { text: string; selector?: string; label?: string; clear?: boolean; submit?: boolean }) {
    const page = await this.ensurePage();
    let locator = undefined as ReturnType<Page["locator"]> | undefined;
    if (opts.selector) locator = page.locator(opts.selector).first();
    else if (opts.label) locator = page.getByLabel(new RegExp(opts.label, "i")).or(page.getByPlaceholder(new RegExp(opts.label, "i"))).first();
    if (locator) {
      if (opts.clear ?? true) await locator.fill(opts.text, { timeout: 10_000 });
      else await locator.pressSequentially(opts.text, { timeout: 10_000 });
      if (opts.submit) await locator.press("Enter");
    } else {
      await page.keyboard.type(opts.text);
      if (opts.submit) await page.keyboard.press("Enter");
    }
    await this.settle();
    return { typed: opts.text.length, url: page.url() };
  }

  async pressKey(key: string, times = 1) {
    const page = await this.ensurePage();
    for (let i = 0; i < Math.min(times, 50); i++) await page.keyboard.press(key);
    await this.settle(1500);
    return { pressed: key, times };
  }

  /** Map gestures on the WebGL radar map (zoom with the mouse wheel, pan by dragging). */
  async map(action: "zoom_in" | "zoom_out" | "pan_north" | "pan_south" | "pan_east" | "pan_west", steps = 1, at?: { x: number; y: number }) {
    const page = await this.ensurePage();
    const vp = page.viewportSize() ?? this.config.viewport;
    const cx = at?.x ?? Math.round(vp.width / 2);
    const cy = at?.y ?? Math.round(vp.height / 2);
    await page.mouse.move(cx, cy);
    const n = Math.max(1, Math.min(steps, 10));
    for (let i = 0; i < n; i++) {
      if (action === "zoom_in" || action === "zoom_out") {
        await page.mouse.wheel(0, action === "zoom_in" ? -300 : 300);
        await wait(250);
      } else {
        const dist = Math.round(Math.min(vp.width, vp.height) / 3);
        // dragging the map east reveals the west, so the drag goes opposite to the pan direction
        const [dx, dy] = { pan_north: [0, dist], pan_south: [0, -dist], pan_east: [-dist, 0], pan_west: [dist, 0] }[action];
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
        await page.mouse.up();
        await wait(250);
      }
    }
    await this.settle(2500);
    return { action, steps: n };
  }

  /** Evaluates an expression via the DevTools protocol (not subject to the page's CSP); promises are awaited. */
  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensurePage();
    return (await page.evaluate(expression)) ?? null;
  }

  networkLog(filter: { search?: string; kind?: "api" | "all"; limit: number; sinceId?: number }) {
    let list = this.captured;
    if (filter.sinceId) list = list.filter((r) => r.id > filter.sinceId!);
    if (filter.kind !== "all") list = list.filter((r) => r.resourceType === "xhr" || r.resourceType === "fetch" || /json/.test(r.contentType));
    if (filter.search) {
      const s = filter.search.toLowerCase();
      list = list.filter((r) => r.url.toLowerCase().includes(s));
    }
    return list.slice(-filter.limit).map(({ sample, ...r }) => ({ ...r, sample: sample?.slice(0, 300) }));
  }

  capturedRequests(): CapturedRequest[] {
    return [...this.captured];
  }

  clearNetworkLog() {
    this.captured = [];
  }

  /** Hosts ww_call_api may contact: the app's own domain, anything the app itself called, and configured extras. */
  isAllowedHost(host: string): boolean {
    const h = host.toLowerCase();
    const { host: appHostRaw, hostname } = new URL(this.config.weatherwiseUrl);
    const appHost = appHostRaw.toLowerCase();
    if (h === appHost) return true;
    // sibling subdomains of a real domain (e.g. api.weatherwise.app next to web.weatherwise.app)
    const isDomain = /[a-z]/i.test(hostname) && hostname.includes(".") && !hostname.includes(":");
    if (isDomain) {
      const appBase = hostname.toLowerCase().split(".").slice(-2).join(".");
      const bareHost = h.split(":")[0];
      if (bareHost === appBase || bareHost.endsWith(`.${appBase}`)) return true;
    }
    if (this.config.extraApiHosts.includes(h)) return true;
    if (this.catalog.hosts().has(h)) return true;
    return this.captured.some((r) => {
      try {
        return new URL(r.url).host.toLowerCase() === h;
      } catch {
        return false;
      }
    });
  }

  /**
   * Calls an endpoint with the browser's cookies plus auth headers the app itself used for that host,
   * i.e. exactly as the WeatherWise app would.
   */
  async callApi(opts: { url: string; method: string; body?: string; headers?: Record<string, string> }) {
    const url = new URL(opts.url);
    if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) URLs are supported.");
    if (!this.isAllowedHost(url.host)) {
      throw new Error(
        `Host ${url.host} is not part of the WeatherWise app traffic. Browse the feature with ww_open/ww_click first ` +
          "so the connector sees the app call it, or add it to WEATHERWISE_API_HOSTS.",
      );
    }
    const ctx = await this.browser.context();
    const page = await this.ensurePage();
    const headers: Record<string, string> = {
      ...(this.replayHeaders.get(url.host.toLowerCase()) ?? {}),
      ...(page.url().startsWith("http") ? { Referer: page.url(), Origin: new URL(page.url()).origin } : {}),
      ...opts.headers,
    };
    const res = await ctx.request.fetch(url.toString(), {
      method: opts.method,
      headers,
      data: opts.body,
      timeout: 30_000,
      failOnStatusCode: false,
    });
    const contentType = (res.headers()["content-type"] ?? "").split(";")[0].trim();
    const body = await res.body();
    return { status: res.status(), contentType, body, url: res.url() };
  }

  async close() {
    const page = this.page;
    this.page = undefined;
    await page?.close().catch(() => undefined);
  }
}
