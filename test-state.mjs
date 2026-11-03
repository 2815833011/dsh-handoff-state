/**
 * Tests for the handoff-state plugin's pure logic.
 *
 * Nothing here spawns a process: `spawnSync` is denied inside the DSH sandbox,
 * so the module under test must be importable and assertable in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bytesOf,
  freshnessBucket,
  parseHandoff,
  parseStamp,
  renderHandoffState,
  resolveScene,
  STALE_MINUTES,
  COLD_MINUTES,
} from './state.js';

const SAMPLE = `# 场景私有记忆

## §〇 当前交接

更新: 2026-10-29 17:30

- 目标: 把规则层和同步面板做完
- 做到哪: 闸门已装、面板 v2 已交付
- 下一步: 装 handoff 注入插件
- 未决: 多面板壳还没做

## 长期记忆

- 沙箱禁止 spawn
`;

test('parseStamp reads a real timestamp', () => {
  const stamp = parseStamp('更新: 2026-10-29 17:30');
  assert.equal(stamp.getFullYear(), 2026);
  assert.equal(stamp.getMonth(), 9); // October, zero-based
  assert.equal(stamp.getDate(), 29);
  assert.equal(stamp.getHours(), 17);
  assert.equal(stamp.getMinutes(), 30);
});

test('parseStamp returns null when the line is absent', () => {
  assert.equal(parseStamp('没有更新行'), null);
});

test('parseHandoff extracts the §〇 section only', () => {
  const parsed = parseHandoff(SAMPLE);
  assert.ok(parsed.section.includes('把规则层和同步面板做完'));
  assert.equal(parsed.section.includes('沙箱禁止 spawn'), false, '长期记忆 must not leak in');
  assert.equal(parsed.goal, '把规则层和同步面板做完');
  assert.equal(parsed.next, '装 handoff 注入插件');
  assert.equal(parsed.open, '多面板壳还没做');
  assert.equal(parsed.done, '闸门已装、面板 v2 已交付');
});

test('parseHandoff reports a missing section instead of throwing', () => {
  const parsed = parseHandoff('# 只有别的东西\n\n## 长期记忆\n- x\n');
  assert.equal(parsed.section, null);
  assert.equal(parsed.goal, null);
});

test('bytesOf measures UTF-8 bytes, not characters', () => {
  assert.equal(bytesOf('abc'), 3);
  assert.equal(bytesOf('交接'), 6);
});

test('freshnessBucket separates fresh, stale and cold', () => {
  const now = new Date(2026, 9, 29, 18, 0, 0);
  const at = (h, m) => new Date(2026, 9, 29, h, m, 0);

  assert.equal(freshnessBucket(at(17, 45), now), 'fresh');
  assert.equal(freshnessBucket(at(16, 29), now), 'stale', '91 minutes is stale');
  assert.equal(freshnessBucket(at(16, 30), now), 'fresh', 'exactly 90 minutes is still fresh');
  // >24h cold
  assert.equal(freshnessBucket(new Date(2026, 9, 28, 10, 0, 0), now), 'cold');
  // Future timestamps are their own failure, never "fresh".
  assert.equal(freshnessBucket(at(23, 0), now), 'future');
});

test('freshnessBucket thresholds are the declared constants', () => {
  assert.equal(STALE_MINUTES, 90);
  assert.equal(COLD_MINUTES, 24 * 60);
});

test('resolveScene prefers a scene name that appears in the cwd', () => {
  const index = { 版本: 1, 场景: ['dsh工作台改造', '另一个场景'] };
  assert.equal(resolveScene('E:/工作空间/DSH工作台改造', index), 'dsh工作台改造');
});

test('resolveScene falls back to the single scene when there is one', () => {
  const index = { 版本: 1, 场景: ['dsh工作台改造'] };
  assert.equal(resolveScene('C:/随便/哪里', index), 'dsh工作台改造');
});

test('resolveScene refuses to guess when several scenes compete', () => {
  const index = { 版本: 1, 场景: ['a 场景', 'b 场景'] };
  assert.equal(resolveScene('C:/无关路径', index), null);
});

test('renderHandoffState gives a stable string for the same input', () => {
  const parsed = parseHandoff(SAMPLE);
  const a = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'fresh' });
  const b = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'fresh' });
  assert.equal(a, b, 'identical input must render byte-identical text');
  assert.ok(a.includes('装 handoff 注入插件'));
  assert.ok(a.includes('dsh工作台改造'));
});

test('renderHandoffState disappears when there is no handoff', () => {
  const parsed = parseHandoff('什么都没有');
  assert.equal(renderHandoffState({ scene: 'x', parsed, bucket: 'fresh' }), '');
});

test('renderHandoffState warns when the handoff is stale or cold', () => {
  const parsed = parseHandoff(SAMPLE);
  const stale = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'stale' });
  const cold = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'cold' });
  const future = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'future' });
  assert.ok(stale.includes('已过期'));
  assert.ok(cold.includes('已过期'));
  assert.ok(future.includes('在未来'), 'a future stamp must be called out, not trusted');
  assert.ok(stale !== cold, 'the bucket must be visible in the text');
});

test('renderHandoffState trims the section to the four fields', () => {
  const parsed = parseHandoff(SAMPLE);
  const text = renderHandoffState({ scene: 'dsh工作台改造', parsed, bucket: 'fresh' });
  assert.equal(text.includes('## 长期记忆'), false, 'headings below §〇 must not leak in');
  assert.equal(text.includes('# 场景私有记忆'), false, 'the document title must not leak in');
});

test('renderHandoffState 超预算时硬截断并给出全文路径', () => {
  const giant = '甲'.repeat(4000); // 12000 B of 目标
  const parsed = {
    section: `## §〇 当前交接\n- 目标: ${giant}\n- 做到哪: done\n- 下一步: next\n- 未决: open`,
    stamp: null,
    goal: giant,
    done: 'done',
    next: 'next',
    open: 'open',
  };
  const out = renderHandoffState({
    scene: 'S',
    parsed,
    bucket: 'fresh',
    docPath: 'C:/tmp/场景私有记忆.md',
    maxBytes: 4000,
  });
  assert.ok(bytesOf(out) <= 4000, `渲染结果必须在预算内，实际 ${bytesOf(out)} B`);
  assert.ok(out.includes('C:/tmp/场景私有记忆.md'), '截断必须给出全文路径');
  assert.ok(out.includes('done'), '压缩要靠缩字段，而不是砍掉整段字段');
  assert.ok(out.includes('done'), '四个字段都要保留可见性');
  assert.ok(!out.includes('甲'.repeat(4000)), '不能原样倒出超长字段');
});

test('renderHandoffState 在预算内时不截断也不加路径尾巴', () => {
  const parsed = {
    section: '## §〇 当前交接\n- 目标: g\n- 做到哪: d\n- 下一步: n\n- 未决: o',
    stamp: null,
    goal: 'g',
    done: 'd',
    next: 'n',
    open: 'o',
  };
  const out = renderHandoffState({ scene: 'S', parsed, bucket: 'fresh', docPath: 'C:/tmp/x.md', maxBytes: 4000 });
  assert.ok(out.includes('未决: o'));
  assert.ok(!out.includes('C:/tmp/x.md'), '没超预算不该出现路径尾巴');
});

test('renderHandoffState 把自动记忆索引压成一行，且不灌正文', () => {
  const parsed = {
    section: '## §〇 当前交接\n- 目标: g\n- 做到哪: d\n- 下一步: n\n- 未决: o',
    stamp: null,
    goal: 'g',
    done: 'd',
    next: 'n',
    open: 'o',
  };
  const out = renderHandoffState({
    scene: 'S',
    parsed,
    bucket: 'fresh',
    docPath: 'C:/tmp/x.md',
    memories: ['pnpm-锁文件', 'wsl-路径'],
  });
  assert.match(out, /自动记忆: pnpm-锁文件、wsl-路径/, '索引要出现');
  assert.match(out, /memory\.mjs/, '要告诉模型去哪读正文');
  assert.ok(!out.includes('# pnpm-锁文件'), '正文不能进注入');
});

test('renderHandoffState 没有自动记忆时不加这一行', () => {
  const parsed = { section: '## §〇 当前交接\n- 目标: g\n- 做到哪: d\n- 下一步: n\n- 未决: o', stamp: null, goal: 'g', done: 'd', next: 'n', open: 'o' };
  const a = renderHandoffState({ scene: 'S', parsed, bucket: 'fresh' });
  const b = renderHandoffState({ scene: 'S', parsed, bucket: 'fresh', memories: [] });
  assert.ok(!a.includes('自动记忆'), '空数组不该产生该行');
  assert.equal(a, b, '空数组与缺省必须渲染一致，避免每轮抖动');
});
