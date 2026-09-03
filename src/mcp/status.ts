import { homedir } from 'node:os';
import { join } from 'node:path';
import { t } from '../i18n.js';
import type { McpManager, McpServerState } from './manager.js';

/** 单个 server 的状态行（名称 + transport + 状态 + 工具数/错误摘要）。 */
function statusLine(s: McpServerState): string {
  const where = s.transport !== undefined ? ` [${s.transport}]` : '';
  const timeout =
    s.callTimeoutMs !== undefined
      ? ` (${t('app.mcp.line.callTimeout', { ms: s.callTimeoutMs })})`
      : '';
  const auth =
    s.auth?.type === 'oauth'
      ? ` (${t('app.mcp.line.oauth', { status: s.auth.status })})`
      : '';
  switch (s.status) {
    case 'connected':
      return t('app.mcp.line.connected', { name: s.name, count: s.toolCount }) + where + timeout + auth;
    case 'pending':
      return t('app.mcp.line.pending', { name: s.name }) + where + timeout + auth;
    case 'failed':
      return t('app.mcp.line.failed', { name: s.name, error: s.error ?? '' }) + where;
    case 'disabled':
      return t('app.mcp.line.disabled', { name: s.name });
  }
}

/** /mcp 面板文案：每 server 一行状态；无配置时给配置指引（指向 ~/.step-pilot/mcp.json）。 */
export function formatMcpStatus(manager: McpManager): string {
  const states = manager.statuses();
  if (states.length === 0) {
    return t('app.mcp.none', { path: join(homedir(), '.step-pilot', 'mcp.json') });
  }
  const lines = states.map(statusLine).join('\n');
  return `${t('app.mcp.title')}\n${lines}`;
}
