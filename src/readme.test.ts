import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * README 里那些「说得出数」的说法，让测试盯着。
 *
 * 上一次审视翻出来的问题：README 写着 146 个测试，实际已经 330 多；
 * 「还没做」里还列着早就做完的图片/附件。文档漂移不是小事 —— 它是唯一
 * 一份别人（和三个月后的自己）拿来判断这个项目能不能用的材料，写错的
 * 部分会被当真。
 *
 * 手动同步的数字必然会漂，所以这里不去生成它，而是在它漂掉时让测试变红。
 *
 * 只盯**会骗人**的说法。版本号不在其列 —— 它在 package.json 和 Git tag 里
 * 各有一份权威，再往 README 抄一遍只是给每次发版添一道必须同步的手续。
 */
const ROOT = join(import.meta.dirname, '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** 数一遍 src 下所有 .test.ts 里的 it(/test( —— 和 vitest 报的总数是一回事 */
function countTests(): number {
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) {
        total += readFileSync(full, 'utf8').match(/^\s*(it|test)\(/gm)?.length ?? 0;
      }
    }
  };
  walk(join(ROOT, 'src'));
  return total;
}

describe('README 别撒谎', () => {
  it('写的测试数量和实际跑的对得上', () => {
    const declared = README.match(/^(\d+) 个测试/m)?.[1];
    expect(declared, 'README 里应该有一行以「N 个测试」开头').toBeDefined();
    expect(Number(declared)).toBe(countTests());
  });

  /*
   * 「还没做」是最容易过期的一节：做完一件事时人会去改 CHANGELOG、改版本号，
   * 很少想起来回去把它从这张清单里划掉。
   */
  it('「还没做」里不能列着已经做完的东西', () => {
    const section = README.split('## 还没做')[1] ?? '';
    for (const done of ['图片', '附件', '完整备份', '知识库检索']) {
      expect(section, `「${done}」已经做完了，不该还挂在「还没做」里`).not.toContain(done);
    }
  });
});
