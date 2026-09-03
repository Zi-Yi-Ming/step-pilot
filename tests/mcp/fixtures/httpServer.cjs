/**
 * 真线协议集成测试用的 MCP server fixture（streamable http，无状态模式）。
 *
 * 独立 .cjs 文件而非 stdin 注入：零转义成本，报错栈可读。
 * 工具集：echo（回环）/ slow（500ms 延迟，供调用超时测试）。
 * 鉴权：所有请求校验 Authorization: Bearer <TOKEN>，缺失/错误一律 401。
 * 启动后向 stdout 打印 `PORT:<n>`，父进程据此得知端点。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const http = require('node:http');

const TOKEN = 'test-token-123';

/** 每请求新建 McpServer（官方无状态模式要求 separate Protocol instance per connection）。 */
function createMcpServer() {
  const mcp = new McpServer({ name: 'integration-server', version: '1.0.0' });
  mcp.tool('echo', 'echo back the message', { message: z.string() }, async ({ message }) => ({
    content: [{ type: 'text', text: 'echo: ' + message }],
  }));
  mcp.tool('slow', 'resolves after 500ms', {}, async () => {
    await new Promise((r) => setTimeout(r, 500));
    return { content: [{ type: 'text', text: 'finally done' }] };
  });
  return mcp;
}

(async () => {
  // 无状态模式的官方口径：每个请求新建 transport + 新建 McpServer 并 connect
  const server = http.createServer(async (req, res) => {
    if ((req.headers['authorization'] ?? '') !== 'Bearer ' + TOKEN) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
    });
    try {
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('PORT:' + server.address().port + '\n');
  });
})().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exit(1);
});
