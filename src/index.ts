#!/usr/bin/env node
import readline from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createHttpApp } from "./http/app.js";
import { createServer, createSharedResources } from "./server.js";

const HELP = `weatherwise-connector – MCP connector for WeatherWise

Usage:
  weatherwise-connector              Run as stdio MCP server (Claude Desktop / Claude Code)
  weatherwise-connector --http       Run as Streamable HTTP server (claude.ai custom connector)
  weatherwise-connector login        Open a visible browser to sign in to WeatherWise once (session is saved)
  weatherwise-connector --help

Environment: see README.md (WEATHERWISE_URL, WEATHERWISE_EMAIL, WEATHERWISE_PASSWORD, WEATHERWISE_DATA_DIR,
CHROMIUM_PATH, HOST, PORT, MCP_PATH, MCP_AUTH_TOKEN, ...)`;

async function runStdio() {
  const shared = createSharedResources(loadConfig());
  const { server, dispose } = createServer(shared);
  const shutdown = async () => {
    await dispose();
    await shared.browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(new StdioServerTransport());
  console.error("WeatherWise MCP server running on stdio");
}

async function runHttp() {
  const config = loadConfig();
  const shared = createSharedResources(config);
  const { app, closeAll } = createHttpApp(shared);
  const listener = app.listen(config.http.port, config.http.host, () => {
    console.error(`WeatherWise MCP server listening on http://${config.http.host}:${config.http.port}${config.http.path}`);
    if (!config.http.authToken && !["127.0.0.1", "localhost", "::1"].includes(config.http.host)) {
      console.error("WARNING: MCP_AUTH_TOKEN is not set – anyone who can reach this server can use it (and your WeatherWise login).");
    }
  });
  const shutdown = async () => {
    listener.close();
    await closeAll();
    await shared.browser.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runLogin() {
  const config = loadConfig();
  const shared = createSharedResources(config);
  console.log(`Opening ${config.weatherwiseUrl} in a browser window. Profile: ${shared.browser.profileDir}`);
  const ctx = await shared.browser.context({ headless: false });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(config.weatherwiseUrl);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Sign in to WeatherWise in the browser window, then press Enter here to save the session… ");
  rl.close();
  await shared.browser.close();
  console.log("Session saved. Stop any running connector instance before logging in again (the profile is locked while in use).");
}

const args = process.argv.slice(2);
const main = args.includes("--help") || args.includes("-h")
  ? async () => console.log(HELP)
  : args[0] === "login"
    ? runLogin
    : args.includes("--http") || process.env.MCP_TRANSPORT === "http"
      ? runHttp
      : runStdio;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
