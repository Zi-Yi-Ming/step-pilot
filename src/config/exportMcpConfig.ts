/**
 * 把 ~/.step-pilot/mcp.json 导出成脱敏分享模板。
 *
 * 脱敏分两层：
 * 1. 先按敏感 key 名做确定性脱敏（api_key / Authorization / token 等）；
 * 2. 再把所有 headers 对象里的值替换为占位符——headers 的键名是任意的，
 *    分享模板里不应保留任何请求头值，包括非标准自定义头。
 *
 * 解析失败时退回纯文本擦除，不阻塞导出。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactJson, REDACTED } from '../utils/redact.js';

export interface ExportMcpConfigResult {
  output: string;
  /** 脱敏替换的敏感值个数（headers 值 + 其他敏感字段）。 */
  redactedCount: number;
  /** 目标文件不存在。 */
  missing: boolean;
}

/** 递归把对象里所有 `headers` 字段的值替换成占位符（原地修改）。 */
function redactAllHeaders(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) redactAllHeaders(item);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.headers !== undefined && typeof obj.headers === 'object' && obj.headers !== null) {
    const headers = obj.headers as Record<string, unknown>;
    for (const key of Object.keys(headers)) {
      if (typeof headers[key] === 'string') {
        headers[key] = REDACTED;
      }
    }
  }
  for (const val of Object.values(obj)) {
    redactAllHeaders(val);
  }
}

/**
 * 导出 mcp.json 脱敏模板。文件不存在时返回 missing=true，不抛异常。
 */
export function exportMcpConfigTemplate(mcpPath?: string): ExportMcpConfigResult {
  const path = mcpPath ?? join(homedir(), '.step-pilot', 'mcp.json');
  if (!existsSync(path)) {
    return { output: '', redactedCount: 0, missing: true };
  }
  const raw = readFileSync(path, 'utf8');
  let redacted = redactJson(raw);
  // 额外脱敏：把 JSON 里所有 headers 的值替换为占位符（分享模板不应保留任何请求头值）
  try {
    const obj = JSON.parse(redacted) as unknown;
    redactAllHeaders(obj);
    redacted = JSON.stringify(obj, null, 2);
  } catch {
    // 解析失败不影响主流程，退回已脱敏的文本
  }
  // 计算脱敏数量：统计 [REDACTED] 出现次数
  const matches = redacted.match(new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  return { output: redacted, redactedCount: matches?.length ?? 0, missing: false };
}
