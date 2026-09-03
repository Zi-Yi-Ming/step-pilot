import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { runOAuthFlow, type OAuthServerConfig } from './oauth.js';

/** 把 MCP 工具的 JSON inputSchema 转成带类型强转的 zod schema（模型常给字符串数字/布尔）。 */
export function mcpInputSchemaToZod(inputSchema: unknown): z.ZodTypeAny {
  const props = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props === undefined || typeof props !== 'object') {
    return z.record(z.string(), z.unknown());
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, rawProp] of Object.entries(props)) {
    const prop = rawProp as { type?: string; description?: string };
    let field: z.ZodTypeAny;
    switch (prop?.type) {
      case 'number':
      case 'integer':
        field = z.coerce.number();
        break;
      case 'boolean':
        field = z.coerce.boolean();
        break;
      case 'string':
        field = z.string();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (typeof prop?.description === 'string') field = field.describe(prop.description);
    shape[key] = field;
  }
  // MCP 工具的 required 数组决定可选性
  const required = new Set(
    ((inputSchema as { required?: string[] } | undefined)?.required ?? []) as string[],
  );
  const finalShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    finalShape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(finalShape).passthrough();
}

/**
 * MCP（Model Context Protocol）接入：连接管理 + list_tools 注册 + call_tool。
 * 配置来源 ~/.step-pilot/mcp.json 的 mcpServers 表。
 * 两种 transport：stdio（command 启动本地进程）与 streamable http（url 连远程 server，
 * MCP 官方现行传输协议；旧 SSE-only 传输已被上游废弃，不支持）。
 * 授权：http 类型暂不做 OAuth，需要鉴权的服务器用 headers 手填（如 Authorization）。
 */
export interface McpServerConfig {
  /** stdio：启动命令。与 url 互斥，二者必填其一。 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** streamable http：server 端点。与 command 互斥。 */
  url?: string;
  /** http 类型附带的自定义请求头（如 Authorization）；stdio 类型忽略。 */
  headers?: Record<string, string>;
  enabled?: boolean;
  /** 单个 server 的启动超时（毫秒），缺省 30000。 */
  startupTimeoutMs?: number;
  /** 单次工具调用超时（毫秒），缺省 60000。超时转 isError 结果回灌，不挂起回合。 */
  callTimeoutMs?: number;
  /** http 类型：SSE 流断线重连最大次数（SDK 缺省 2）。clamp [0,10]。 */
  maxRetries?: number;
  /** http 类型：重连初始退避（毫秒），SDK 按指数增长到 maxReconnectionDelay。clamp [100,60000]。 */
  reconnectDelayMs?: number;
  /** OAuth 配置（仅 http 类型支持）。 */
  auth?: OAuthServerConfig;
}

/** SDK 重连参数的缺省值（与 StreamableHTTPClientTransport 内部默认对齐，此处显式便于组合）。 */
const RECONNECT_GROW_FACTOR = 1.5;
const RECONNECT_MAX_DELAY_DEFAULT = 30_000;

/**
 * 组装 http transport 的连接选项：headers 鉴权 + 重连策略。
 * 未配置重连字段时返回不含 reconnectionOptions 的选项（尊重 SDK 默认）。
 * 纯函数，便于单测。
 */
export function httpTransportOptions(config: McpServerConfig): {
  requestInit: { headers?: Record<string, string> };
  reconnectionOptions?: {
    maxRetries: number;
    initialReconnectionDelay: number;
    maxReconnectionDelay: number;
    reconnectionDelayGrowFactor: number;
  };
} {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const opts: ReturnType<typeof httpTransportOptions> = {
    requestInit: { headers: config.headers },
  };
  if (config.maxRetries !== undefined || config.reconnectDelayMs !== undefined) {
    const initial = config.reconnectDelayMs !== undefined ? clamp(config.reconnectDelayMs, 100, 60_000) : 1000;
    opts.reconnectionOptions = {
      maxRetries: config.maxRetries !== undefined ? clamp(Math.floor(config.maxRetries), 0, 10) : 2,
      initialReconnectionDelay: initial,
      maxReconnectionDelay: Math.max(RECONNECT_MAX_DELAY_DEFAULT, initial),
      reconnectionDelayGrowFactor: RECONNECT_GROW_FACTOR,
    };
  }
  return opts;
}

/** server 类型判别：url 非空即 http（streamable），否则 stdio（command）。 */
export function isHttpServerConfig(config: McpServerConfig): boolean {
  return typeof config.url === 'string' && config.url !== '';
}

/**
 * 配置校验：返回单行错误摘要，null = 通过。connect() 前置调用，
 * 坏配置不抛异常，以 failed 状态呈现在 /mcp 面板，与其他连接失败同一出口。
 */
export function validateServerConfig(config: McpServerConfig): string | null {
  const hasCommand = typeof config.command === 'string' && config.command !== '';
  const hasUrl = isHttpServerConfig(config);
  if (hasCommand && hasUrl) return 'command 与 url 只能二选一（stdio 与 streamable http 互斥）';
  if (!hasCommand && !hasUrl) return '缺少 command（stdio）或 url（streamable http），二者必填其一';
  if (hasUrl) {
    try {
      void new URL(config.url!);
    } catch {
      return `url 不是合法的绝对地址：${config.url}`;
    }
    // OAuth 仅支持 http 类型
    if (config.auth?.type === 'oauth') {
      const a = config.auth;
      if (!a.authorizationUrl) return 'auth.type = "oauth" 时 authorizationUrl 必填';
      if (!a.tokenUrl) return 'auth.type = "oauth" 时 tokenUrl 必填';
      if (!a.clientId) return 'auth.type = "oauth" 时 clientId 必填';
      try {
        void new URL(a.authorizationUrl);
      } catch {
        return `auth.authorizationUrl 不是合法地址：${a.authorizationUrl}`;
      }
      try {
        void new URL(a.tokenUrl);
      } catch {
        return `auth.tokenUrl 不是合法地址：${a.tokenUrl}`;
      }
    }
  }
  return null;
}

/** server 连接状态（供 /mcp 面板展示）。 */
export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled';

export interface McpServerState {
  name: string;
  status: McpServerStatus;
  /** 已连接时为发现的工具数，其余为 0。 */
  toolCount: number;
  /** 失败时的单行错误摘要。 */
  error?: string;
  /** transport 展示形态：'stdio: <command>' 或 'http: <url>'；配置未过校验时为 undefined。 */
  transport?: string;
  /** 单次工具调用超时（毫秒）；配置未设置时为 undefined。 */
  callTimeoutMs?: number;
  /** OAuth 状态（仅 auth.type === 'oauth' 时设置）。 */
  auth?: { type: 'oauth'; status: string };
}

export interface McpToolInfo {
  /** 规范化工具名 mcp__server__tool。 */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
}

/** 单个 MCP 工具的失败统计（供 /mcp 面板展示）。 */
export interface McpToolFailureStat {
  qualifiedName: string;
  /** 本回合内连续失败次数。 */
  consecutiveFailures: number;
  /** 最近一次失败的错误摘要。 */
  lastError?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

/** 生成 mcp__server__tool 命名（超 64 字符时截断并追加 8 字符 FNV-1a 哈希后缀）。 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
  if (full.length <= MAX_TOOL_NAME_LEN) return full;
  // 截断保留前 55 字符 + '_' + 8 字符哈希（哈希取自截断前的完整名，保证稳定性与区分度）
  return `${full.slice(0, MAX_TOOL_NAME_LEN - 9)}_${fnv1aHex(full)}`;
}

/** 工具名最大长度（64 字符上限）。 */
export const MAX_TOOL_NAME_LEN = 64;

/** FNV-1a 32 位哈希的 8 位十六进制串（自实现，不引依赖；用于命名截断方案）。 */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: McpToolInfo[];
  /** 工具调用超时（毫秒），mcp.json 可配；缺省见 DEFAULT_CALL_TIMEOUT_MS。 */
  callTimeoutMs?: number;
}

/** 单个 server 的默认启动超时（可用 mcp.json 的 startupTimeoutMs 覆盖）。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/**
 * 工具调用默认超时。stdio 时代进程崩溃即失败、问题不显；http 化后一个挂起的
 * 远程 server 会卡死整个 agent 回合，必须有限界。
 */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** 带超时的 promise 包装：超时即拒，原 promise 挂 catch 防止 unhandled rejection。label 区分「启动/调用」语境。 */
async function withTimeout<T>(p: Promise<T>, ms: number, label = '启动'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（超过 ${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    p.catch(() => {});
  }
}

/** 错误信息压成单行（/mcp 面板逐行展示用）。 */
function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/** MCP 工具调用失败分类：把原始异常转成用户可执行的提示。 */
function formatMcpToolError(
  e: unknown,
  qualifiedName: string,
  server: { name: string; callTimeoutMs?: number; transport?: string },
): string {
  const raw = oneLine((e as Error).message);
  const lower = raw.toLowerCase();
  const serverLabel = server.name ?? qualifiedName;

  if (lower.includes('timeout') || lower.includes('timed out')) {
    const limit = server.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return 'MCP 工具调用超时（' + qualifiedName + '）：等待超过 ' + limit + 'ms。可检查该工具是否卡住，或使用 `/mcp` 调整 callTimeoutMs 后重试。';
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('fetch failed')) {
    return 'MCP 工具调用网络失败（' + qualifiedName + '）：无法连接到 ' + serverLabel + '（' + (server.transport ?? 'MCP server') + '）。请检查服务是否启动，或使用 `/mcp` 查看状态。';
  }
  if (lower.includes('401') || lower.includes('403') || lower.includes('auth') || lower.includes('token')) {
    return 'MCP 工具调用鉴权失败（' + qualifiedName + '）：' + serverLabel + ' 拒绝访问。请检查 API key / OAuth token 是否有效，或使用 `/mcp` 查看配置。';
  }
  if (lower.includes('not found') || lower.includes('unknown tool')) {
    return 'MCP 工具不存在（' + qualifiedName + '）：' + serverLabel + ' 未提供该工具。请检查工具名，或使用 `/mcp` 查看已发现工具列表。';
  }
  if (lower.includes('invalid') || lower.includes('schema') || lower.includes('arguments')) {
    return 'MCP 工具参数错误（' + qualifiedName + '）：' + raw + '。请检查参数类型与必填项后重试。';
  }
  if (lower.includes('iserror') || lower.includes('server error') || lower.includes('internal')) {
    return 'MCP 工具执行失败（' + qualifiedName + '）：服务端返回错误。原始信息：' + raw;
  }

  return 'MCP 工具调用失败（' + qualifiedName + '）：' + raw;
}

/** MCP 连接管理器：并行连接配置的 server（stdio / streamable http），发现工具，统一调用，暴露 per-server 状态。 */
export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly states = new Map<string, McpServerState>();
  /** 工具级连续失败统计：qualifiedName -> 连续失败次数 + 最近错误。 */
  private readonly toolFailures = new Map<string, { count: number; lastError: string }>();
  /** 工具级调用统计：qualifiedName -> 成功次数 + 失败次数。 */
  private readonly toolStats = new Map<string, { success: number; failure: number }>();

  /**
   * 连接一个 stdio MCP server 并发现工具。
   * 失败不抛出：状态（failed + 单行错误摘要）记入状态表，返回 false；成功返回 true。
   */
  async connect(name: string, config: McpServerConfig): Promise<boolean> {
    if (config.enabled === false) {
      this.states.set(name, { name, status: 'disabled', toolCount: 0 });
      return false;
    }
    const invalid = validateServerConfig(config);
    if (invalid !== null) {
      this.states.set(name, { name, status: 'failed', toolCount: 0, error: invalid });
      return false;
    }
    // transport 展示形态：headers 只显示「已配置」不显值（Authorization 等不能进 /mcp 面板）
    const transport = isHttpServerConfig(config)
      ? `http: ${config.url}${config.headers !== undefined && Object.keys(config.headers).length > 0 ? ' (+headers)' : ''}`
      : `stdio: ${config.command ?? ''}`;
    this.states.set(name, { name, status: 'pending', toolCount: 0, transport });
    
    // OAuth 预处理：http + auth.type === 'oauth' 时先拿 token 再握手
    let effectiveConfig = config;
    try {
      if (isHttpServerConfig(config) && config.auth?.type === 'oauth') {
        effectiveConfig = await runOAuthFlow(name, {
          url: config.url,
          headers: config.headers,
          auth: config.auth,
        });
      }
    } catch (e) {
      this.states.set(name, { name, status: 'failed', toolCount: 0, error: oneLine((e as Error).message), transport });
      return false;
    }
    
    const client = new Client({ name: 'step-pilot', version: VERSION });
    try {
      const tools = await withTimeout(
        this.connectAndListTools(client, effectiveConfig),
        effectiveConfig.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      const infos: McpToolInfo[] = tools.map((tool) => ({
        qualifiedName: qualifyMcpToolName(name, tool.name),
        serverName: name,
        toolName: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Anthropic.Tool['input_schema'],
      }));
      this.servers.set(name, { name, client, tools: infos, callTimeoutMs: effectiveConfig.callTimeoutMs });
      this.states.set(name, { name, status: 'connected', toolCount: infos.length, transport, callTimeoutMs: effectiveConfig.callTimeoutMs });
      return true;
    } catch (e) {
      // 失败/超时后尽力关闭 client（会 kill stdio 子进程），避免进程泄漏
      try {
        await client.close();
      } catch {
        // client 可能从未连上，close 报错属预期
      }
      this.states.set(name, { name, status: 'failed', toolCount: 0, error: oneLine((e as Error).message), transport });
      return false;
    }
  }

  /**
   * 并行连接全部配置的 server（Promise.allSettled，单点失败互不影响）。
   * 每个 server 连接成功即触发 onConnected（供工具增量补登 deferred）。
   */
  async connectAll(
    configs: Record<string, McpServerConfig>,
    onConnected?: (name: string) => void,
  ): Promise<void> {
    await Promise.allSettled(
      Object.entries(configs).map(async ([name, config]) => {
        if (await this.connect(name, config)) onConnected?.(name);
      }),
    );
  }

  /** 与 server 握手并发现工具（按 config 分发 stdio / streamable http transport；测试可覆盖为假实现）。 */
  protected async connectAndListTools(
    client: Client,
    config: McpServerConfig,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const transport = isHttpServerConfig(config)
      ? new StreamableHTTPClientTransport(new URL(config.url!), httpTransportOptions(config))
      : new StdioClientTransport({
          command: config.command!,
          args: config.args ?? [],
          env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
          cwd: config.cwd,
          stderr: 'pipe',
        });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools;
  }

  /** 各 server 的当前状态（pending/connected/failed/disabled + 错误摘要 + 工具数），供 /mcp 展示。 */
  statuses(): McpServerState[] {
    return [...this.states.values()];
  }

  /**
   * 关闭全部已连接 server（逐个尽力 client.close()，会 kill stdio 子进程），并清空登记。
   * 非交互模式（-p / --reflect）跑完必须调用：stdio 子进程挂着会让事件循环永不排空、进程不退出。
   */
  async closeAll(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client.close();
      } catch {
        // 已断开或从未连上，close 报错属预期
      }
    }
    this.servers.clear();
  }

  /** 指定 server 已发现的工具（未连接返回空）。 */
  toolsOf(name: string): McpToolInfo[] {
    return this.servers.get(name)?.tools ?? [];
  }

  /** 所有已发现工具。 */
  allTools(): McpToolInfo[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  /** 按规范化名查工具（含所属 client、server 配置）。 */
  find(qualifiedName: string): { client: Client; info: McpToolInfo; server: ConnectedServer } | undefined {
    for (const s of this.servers.values()) {
      const info = s.tools.find((t) => t.qualifiedName === qualifiedName);
      if (info !== undefined) return { client: s.client, info, server: s };
    }
    return undefined;
  }

  /** 调用一个 MCP 工具，返回文本结果。超时（callTimeoutMs，缺省 60s）转 isError 回灌，不挂起回合。 */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const found = this.find(qualifiedName);
    if (found === undefined) {
      return { content: `未找到 MCP 工具 ${qualifiedName}`, isError: true };
    }
    const timeoutMs = found.server.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    try {
      const result = await withTimeout(
        found.client.callTool({ name: found.info.toolName, arguments: args }),
        timeoutMs,
        '调用',
      );
      // 归一结果：取 text 内容
      const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = blocks
        .map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
        .join('\n');
      const isError = (result as { isError?: boolean }).isError === true;
      // 统计调用结果
      const stats = this.toolStats.get(qualifiedName) ?? { success: 0, failure: 0 };
      if (!isError) {
        stats.success++;
        this.toolFailures.delete(qualifiedName);
      } else {
        stats.failure++;
        if (text) {
          this.toolFailures.set(qualifiedName, { count: 1, lastError: text.slice(0, 120) });
        }
      }
      this.toolStats.set(qualifiedName, stats);
      return { content: text === '' ? '[无输出]' : text, isError };
    } catch (e) {
      const message = formatMcpToolError(e, qualifiedName, found.server);
      const prev = this.toolFailures.get(qualifiedName);
      this.toolFailures.set(qualifiedName, {
        count: (prev?.count ?? 0) + 1,
        lastError: oneLine(message),
      });
      const stats = this.toolStats.get(qualifiedName) ?? { success: 0, failure: 0 };
      stats.failure++;
      this.toolStats.set(qualifiedName, stats);
      return { content: message, isError: true };
    }
  }

  /** 工具级连续失败统计（供 /mcp 面板或调试使用）。 */
  toolFailureStats(): McpToolFailureStat[] {
    return [...this.toolFailures.entries()].map(([qualifiedName, stat]) => ({
      qualifiedName,
      consecutiveFailures: stat.count,
      lastError: stat.lastError,
    }));
  }

  /** 工具级调用统计（供 /mcp 面板展示）。 */
  toolCallStats(): Array<{ qualifiedName: string; success: number; failure: number; total: number }> {
    return [...this.toolStats.entries()].map(([qualifiedName, stat]) => ({
      qualifiedName,
      success: stat.success,
      failure: stat.failure,
      total: stat.success + stat.failure,
    }));
  }
}
