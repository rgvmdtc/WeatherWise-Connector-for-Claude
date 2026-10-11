import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { createSharedResources } from "../src/server.js";

describe("Streamable HTTP transport", () => {
  let server: Server;
  let closeAll: () => Promise<void>;
  let base: string;

  before(async () => {
    const config = loadConfig({
      MCP_AUTH_TOKEN: "s3cret",
      HOST: "127.0.0.1",
      WEATHERWISE_DATA_DIR: path.join(os.tmpdir(), `ww-http-${process.pid}`),
    } as NodeJS.ProcessEnv);
    const http = createHttpApp(createSharedResources(config));
    closeAll = http.closeAll;
    server = await new Promise<Server>((resolve) => {
      const s = http.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await closeAll();
    server.close();
  });

  it("serves a health check", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });

  it("rejects requests without the token", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
  });

  for (const mode of ["bearer", "query"] as const) {
    it(`accepts the token via ${mode} and serves tools`, async () => {
      const url = new URL(`${base}/mcp`);
      if (mode === "query") url.searchParams.set("token", "s3cret");
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: mode === "bearer" ? { headers: { Authorization: "Bearer s3cret" } } : undefined,
      });
      const client = new Client({ name: "http-test", version: "1.0.0" });
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "get_severe_weather_briefing"));
      assert.ok(tools.some((t) => t.name === "ww_open"));
      await transport.terminateSession();
      await client.close();
    });
  }
});
