import { describe, it, expect } from 'vitest';
import { unknownToolMessage } from '../../src/tools/index.js';

/**
 * G2：未知工具报错必须携带恢复信息。
 *
 * 护栏要点有两面——
 *  - 拦截面：拼写偏移要能给出近似候选（编辑距离 + 子串包含两种信号）
 *  - 不误伤面：毫不相干的工具名不能被"凑"成候选（乱建议比不建议更误导模型）
 */
describe('unknownToolMessage：未知工具恢复提示', () => {
  const AVAILABLE = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob'];

  it('永远包含原始工具名与可用清单', () => {
    const msg = unknownToolMessage('nope', AVAILABLE);
    expect(msg).toContain('未知工具：nope');
    expect(msg).toContain('可用工具：');
    for (const name of AVAILABLE) expect(msg).toContain(name);
  });

  it('拼写偏移（少一个字母）识别为 nearest 候选', () => {
    expect(unknownToolMessage('read_fil', AVAILABLE)).toContain('是否想用 nearest：read_file');
    expect(unknownToolMessage('writ_fil', AVAILABLE)).toContain('是否想用 nearest：write_file');
  });

  it('漏写下划线同样识别', () => {
    expect(unknownToolMessage('readfile', AVAILABLE)).toContain('是否想用 nearest：read_file');
    expect(unknownToolMessage('editfile', AVAILABLE)).toContain('是否想用 nearest：edit_file');
  });

  it('子串形态（带前缀的限定名）识别为候选', () => {
    // MCP 工具常带 mcp__server__ 前缀，模型可能只写尾段
    expect(unknownToolMessage('server__grep', AVAILABLE)).toContain('是否想用 nearest：grep');
  });

  it('毫不相干的工具名不给候选（不误伤）', () => {
    const msg = unknownToolMessage('sing_a_song', AVAILABLE);
    expect(msg).toContain('可用工具：');
    expect(msg).not.toContain('是否想用');
  });

  it('大小写差异不影响识别', () => {
    expect(unknownToolMessage('READ_FILE', AVAILABLE)).toContain('read_file');
  });

  it('可用清单为空时给出明确说明而非空清单', () => {
    const msg = unknownToolMessage('anything', []);
    expect(msg).toContain('未知工具：anything');
    expect(msg).toContain('没有可用工具');
    expect(msg).not.toContain('可用工具：。');
  });
});
