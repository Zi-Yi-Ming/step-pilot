import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../../src/tools/index.js';

/**
 * ReDoS 防护回归（上游 #90 同失败类）。
 *
 * 时间断言是这里的真测试：`(a+)+` 形态若真进了 `re.test`，200 字符的 a 串就是
 * 指数级回溯，进程挂死、测试超时——所以「快速返回 isError」唯一可能的解释是
 * 守卫在匹配之前拦截了。黑名单是形态启发式（见 grep.ts 注释），本测试同时钉住
 * 不误伤面：常用捕获组写法必须照常工作。
 */

let dir: string;
let ctx: { cwd: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-grep-redos-'));
  ctx = { cwd: dir };
  writeFileSync(join(dir, 'a.txt'), `${'a'.repeat(200)}\n12-34 line\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('grep ReDoS 守卫', () => {
  it('嵌套量词被拦且秒回（未进入不可中断的 re.test）', async () => {
    const start = Date.now();
    const r = await executeTool('grep', { pattern: '(a+)+b' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('嵌套量词');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('同族的组外量词形态一并拦截：(a{2,})+、(x+y)*、(a+)*', async () => {
    for (const pattern of ['(a{2,})+', '(x+y)*', '(a+)*']) {
      const r = await executeTool('grep', { pattern }, ctx);
      expect(r.isError, pattern).toBe(true);
    }
  });

  it('常用捕获组写法不误伤', async () => {
    const pairs = await executeTool('grep', { pattern: '(\\d+)-(\\d+)' }, ctx);
    expect(pairs.isError).toBe(false);
    expect(pairs.content).toContain('12-34');

    const alt = await executeTool('grep', { pattern: '(a|b)+' }, ctx);
    expect(alt.isError).toBe(false);
    expect(alt.content).toContain('a.txt');

    const escaped = await executeTool('grep', { pattern: '\\(literal\\)+' }, ctx);
    expect(escaped.isError).toBe(false);
  });

  it('组内有量词但组未被重复 = 放行', async () => {
    const r = await executeTool('grep', { pattern: '(a+)-' }, ctx);
    expect(r.isError).toBe(false);
  });

  it('超长 pattern 直接拒，不进编译', async () => {
    const r = await executeTool('grep', { pattern: 'a'.repeat(501) }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('正则过长');
  });

  it('语法错误优先级不变：非法正则仍报语法错而非嵌套文案', async () => {
    const r = await executeTool('grep', { pattern: '(a+' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('无效的正则');
  });
});
