import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import type Database from 'better-sqlite3';
import type { WyvernConfig } from '../types.js';
import { registerTools } from './tools.js';

export function createMcpServer(db: Database.Database, config: WyvernConfig): McpServer {
  const server = new McpServer({
    name: 'wyvern',
    version: '3.0.0',
  });
  registerTools(server, db, config);
  return server;
}

export function startHttpServer(mcpServer: McpServer, port: number = 3001): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/mcp' && req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  httpServer.listen(port, '127.0.0.1');
  return httpServer;
}
