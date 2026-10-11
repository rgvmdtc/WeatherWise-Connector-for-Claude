import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ServerHandle, SERVER_NAME, SERVER_VERSION, type SharedResources } from "../server.js";

const SESSION_IDLE_MS = 30 * 60 * 1000;

interface LiveSession {
  transport: StreamableHTTPServerTransport;
  handle: ServerHandle;
  lastSeen: number;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express app serving the MCP Streamable HTTP transport (for claude.ai custom connectors and other remote clients).
 * Each MCP session gets its own server instance and its own WeatherWise browser tab.
 */
export function createHttpApp(shared: SharedResources): { app: Express; closeAll: () => Promise<void> } {
  const { http } = shared.config;
  const app = createMcpExpressApp({ host: http.host, allowedHosts: http.allowedHosts });
  const sessions = new Map<string, LiveSession>();

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!http.authToken) return next();
    const header = req.headers.authorization;
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const query = typeof req.query.token === "string" ? req.query.token : undefined;
    if (tokenMatches(bearer, http.authToken) || tokenMatches(query, http.authToken)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  const dropSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.handle.dispose().catch(() => undefined);
    await s.transport.close().catch(() => undefined);
  };

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_IDLE_MS) void dropSession(id);
  }, 60_000);
  sweeper.unref();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION, sessions: sessions.size });
  });

  app.post(http.path, auth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    try {
      let live = sessionId ? sessions.get(sessionId) : undefined;
      if (!live) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(sessionId ? 404 : 400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: sessionId ? "Session not found" : "Bad Request: no valid session ID provided" },
            id: null,
          });
          return;
        }
        const handle = createServer(shared);
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, handle, lastSeen: Date.now() });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) void dropSession(transport.sessionId);
        };
        await handle.server.connect(transport);
        live = { transport, handle, lastSeen: Date.now() };
      }
      live.lastSeen = Date.now();
      await live.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const live = sessionId ? sessions.get(sessionId) : undefined;
    if (!live) {
      res.status(404).send("Session not found");
      return;
    }
    live.lastSeen = Date.now();
    await live.transport.handleRequest(req, res);
  };
  app.get(http.path, auth, sessionRequest);
  app.delete(http.path, auth, sessionRequest);

  return {
    app,
    async closeAll() {
      clearInterval(sweeper);
      await Promise.all([...sessions.keys()].map(dropSession));
    },
  };
}
