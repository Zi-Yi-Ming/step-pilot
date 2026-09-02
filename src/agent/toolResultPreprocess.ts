import type { ToolResult } from '../tools/types.js';

/**
 * 对超长工具结果做语义化预处理：保留结构单元（行/段落）的头尾，中间用标记省略。
 * 在 capToolResult() 之前执行，先做语义截断、再做字符截断，双层保护。
 */
export function preprocessToolResult(result: ToolResult, toolName: string): ToolResult {
  // 只对文本内容处理；images / isError 透传
  if (typeof result.content !== 'string' || result.content.length < 50_000) {
    return result;
  }

  let processed = result.content;

  if (toolName === 'bash') {
    // bash 输出按行保留：头 50 行 + 尾 20 行
    const lines = processed.split(/\r?\n/);
    if (lines.length > 70) {
      const head = lines.slice(0, 50).join('\n');
      const tail = lines.slice(-20).join('\n');
      const omitted = lines.length - 70;
      processed = `${head}\n\n[... ${omitted} lines omitted by tool-result preprocessor (total ${lines.length} lines). Re-run with a narrower scope to see the full output. ...]\n\n${tail}`;
    }
  } else if (toolName === 'read_file') {
    // read_file 按段落保留：头 10 段 + 尾 5 段
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
