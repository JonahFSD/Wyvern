import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WyvernConfig } from '../types.js';
import { registerTools } from './tools.js';

/**
 * Create a fresh McpServer instance with tools registered.
 * The MCP SDK's Protocol.connect() throws "Already connected" if called twice
 * on the same instance, so we need one McpServer per agent session.
 */
function createMcpServerInstance(db: Database.Database, config: WyvernConfig): McpServer {
  const server = new McpServer({
    name: 'wyvern',
    version: '3.0.0',
  });
  registerTools(server, db, config);
  return server;
}

export function createMcpServer(db: Database.Database, config: WyvernConfig): McpServer {
  return createMcpServerInstance(db, config);
}

export async function startHttpServer(
  _mcpServer: McpServer,
  port: number = 3001,
  db?: Database.Database,
  config?: WyvernConfig,
): Promise<http.Server> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        // Route to existing session
        const session = sessions.get(sessionId);
        if (!session) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }

      // No session ID — must be an initialize request.
      // Create a NEW McpServer + transport per session. The MCP SDK's
      // Protocol base class only supports one transport per Server instance
      // (it throws "Already connected" on a second connect()). Since each
      // agent needs its own session, we spin up a lightweight server per agent.
      const perSessionServer = (db && config)
        ? createMcpServerInstance(db, config)
        : _mcpServer;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server: perSessionServer });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        },
      });
      await perSessionServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  });

  httpServer.listen(port, '127.0.0.1');
  return httpServer;
}
