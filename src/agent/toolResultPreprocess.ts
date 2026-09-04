import type { ToolResult } from '../tools/types.js';

/**
 * 对超长工具结果做轻量语义预处理：保留结构单元（行/段落）的头尾，中间用标记省略。
 * 在 capToolResult() 之前执行，先做语义截断、再做字符截断，双层保护。
 *
 * 处理来源：
 * - bash / grep / glob / web_fetch / MCP 工具（mcp__ 前缀）：按行保留头 50 行 + 尾 20 行
 * - read_file：按段落保留头 10 段 + 尾 5 段
 *
 * 阈值设为 50k 字符：低于此值的结果大概率已经在 capToolResult 的 400k 上限内，
 * 不做多余处理；超过时才启动语义截断，减少 Flash 的注意力稀释。
 */
export function preprocessToolResult(result: ToolResult, toolName: string): ToolResult {
  if (typeof result.content !== 'string' || result.content.length < 50_000) {
    return result;
  }

  let processed = result.content;

  if (toolName === 'bash' || toolName === 'grep' || toolName === 'glob' || toolName === 'web_fetch' || toolName.startsWith('mcp__')) {
    processed = truncateLines(processed);
  } else if (toolName === 'read_file') {
    const paragraphs = processed.split(/\n{2,}/);
    if (paragraphs.length > 15) {
      const head = paragraphs.slice(0, 10).join('\n\n');
      const tail = paragraphs.slice(-5).join('\n\n');
      const omitted = paragraphs.length - 15;
      processed = `${head}\n\n[... ${omitted} paragraphs omitted by tool-result preprocessor (total ${paragraphs.length} paragraphs). Re-run with offset/limit to see the middle part. ...]\n\n${tail}`;
    }
  }

  if (processed !== result.content) {
    return { ...result, content: processed };
  }
  return result;
}

/** bash 与 MCP 工具共用的行级截断：保头 50 行 + 尾 20 行，中间标记省略。 */
function truncateLines(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= 70) return text;
  const head = lines.slice(0, 50).join('\n');
  const tail = lines.slice(-20).join('\n');
  const omitted = lines.length - 70;
  return `${head}\n\n[... ${omitted} lines omitted by tool-result preprocessor (total ${lines.length} lines). Re-run with a narrower scope to see the full output. ...]\n\n${tail}`;
}
