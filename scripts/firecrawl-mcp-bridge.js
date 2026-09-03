#!/usr/bin/env node
/**
 * Minimal stdio-to-HTTP MCP bridge for FireCrawl.
 *
 * AtomCode `mcp add` only supports stdio MCP servers, so this script
 * forwards JSON-RPC messages to FireCrawl's remote HTTP MCP endpoint
 * and translates SSE responses back to JSON-RPC lines.
 */

const MCP_URL = process.env.FIRECRAWL_MCP_URL || 'https://mcp.firecrawl.dev/v2/mcp';

async function main() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buffer = new Uint8Array(1024 * 1024);
  let bufLen = 0;

  async function flush() {
    while (true) {
      let nl = -1;
      for (let i = 0; i < bufLen; i++) {
        if (buffer[i] === 10) { nl = i; break; }
      }
      if (nl === -1) break;

      const line = decoder.decode(buffer.slice(0, nl));
      bufLen -= (nl + 1);
      buffer.copyWithin(0, nl + 1, bufLen + (nl + 1));

      if (!line.trim()) continue;

      try {
        const req = JSON.parse(line);

        const res = await fetch(MCP_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json, text/event-stream',
          },
          body: JSON.stringify(req),
        });

        const text = await res.text();
        const lines = text.split(/\r?\n/);
        for (const rawLine of lines) {
          const trimmed = rawLine.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          try {
            const out = JSON.parse(data);
            process.stdout.write(encoder.encode(JSON.stringify(out) + '\n'));
          } catch {
            process.stdout.write(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { text: data } }) + '\n'));
          }
        }
      } catch (err) {
        process.stdout.write(encoder.encode(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err) } }) + '\n'));
      }
    }
  }

  process.stdin.on('data', (chunk) => {
    buffer.set(chunk, bufLen);
    bufLen += chunk.length;
    flush();
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n');
  process.exit(1);
});
