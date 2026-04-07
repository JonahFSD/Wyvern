import http from 'node:http';
import https from 'node:https';
import type Database from 'better-sqlite3';

export type VcrMode = 'record' | 'replay' | 'passthrough';

export function createVcrProxy(
  db: Database.Database,
  taskId: string,
  targetHost: string,
  mode: VcrMode,
  listenPort: number,
): http.Server {
  const conversationId = `${taskId}:${Date.now()}`;
  let sequenceCounter = 0;

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const requestBody = Buffer.concat(chunks).toString('utf-8');

    sequenceCounter++;
    const seqNum = sequenceCounter;

    if (mode === 'replay') {
      const cassette = db.prepare(
        'SELECT * FROM vcr_cassettes WHERE conversation_id = ? AND sequence_number = ?'
      ).get(conversationId, seqNum) as any;

      if (cassette) {
        const headers = cassette.response_headers
          ? JSON.parse(cassette.response_headers)
          : { 'content-type': 'application/json' };
        res.writeHead(cassette.response_status, headers);
        res.end(cassette.response_body);
        return;
      }

      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: `VCR replay divergence: no cassette for conversation ${conversationId} at sequence ${seqNum}.`,
      }));
      return;
    }

    // Forward to real API -- stream response through to preserve SSE
    const proxyReq = https.request({
      hostname: targetHost,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetHost },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode!, proxyRes.headers);

      if (mode === 'record') {
        // Tee: stream to client AND buffer for recording
        const responseChunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => {
          responseChunks.push(chunk);
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          const responseBody = Buffer.concat(responseChunks).toString('utf-8');
          db.prepare(`
            INSERT INTO vcr_cassettes
            (task_id, conversation_id, sequence_number, request_body, response_body,
             response_status, response_headers, model, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            taskId, conversationId, seqNum, requestBody, responseBody,
            proxyRes.statusCode, JSON.stringify(Object.fromEntries(
              Object.entries(proxyRes.headers).filter(([, v]) => v !== undefined)
            )),
            extractModel(requestBody), new Date().toISOString(),
          );
          res.end();
        });
      } else {
        // Passthrough -- just pipe
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    });

    proxyReq.write(requestBody);
    proxyReq.end();
  });

  server.listen(listenPort, '127.0.0.1');
  return server;
}

function extractModel(body: string): string {
  try {
    return JSON.parse(body).model || 'unknown';
  } catch {
    return 'unknown';
  }
}
