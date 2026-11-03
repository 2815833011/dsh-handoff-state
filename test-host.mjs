/**
 * Host-level tests: does the plugin register what it claims, and does the
 * rendered text obey the stability rule?
 *
 * Run with `node test-host.mjs` — in-process only. `spawnSync` is denied in the
 * sandbox, so this file must never shell out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, createStateText, inject, name } from './index.js';

const HANDOFF = (stamp) => `# 场景私有记忆 · dsh工作台改造

## §〇 当前交接（≤4096 字节，覆盖写，不追加）
更新: ${stamp}
- 目标: 把规则层做完
- 做到哪: 闸门修好了
- 下一步: 装注入插件
- 未决: 多面板壳

## 长期记忆

### 某条记忆
写入: 2026-10-29
作废条件: 无
内容: 不该出现在注入里
`;

/** Create a throwaway scene-memory tree and return its root. */
function makeRoot(stamp) {
  const root = mkdtempSync(join(tmpdir(), 'handoff-state-'));
  mkdirSync(join(root, '_共享记忆'), { recursive: true });
  mkdirSync(join(root, 'dsh工作台改造'), { recursive: true });
  writeFileSync(
    join(root, '_共享记忆', '索引.json'),
    JSON.stringify({ 版本: 1, 场景: ['dsh工作台改造'] }),
    'utf8',
  );
  writeFileSync(join(root, 'dsh工作台改造', '场景私有记忆.md'), HANDOFF(stamp), 'utf8');
  return root;
}

/** The smallest host that satisfies the plugin's registrations. */
function createHost() {
  const contexts = [];
  const sections = [];
  const systemPrompt = {
    section(definition) {
      sections.push(definition);
      return () => {};
    },
    context(definition) {
      contexts.push(definition);
      return () => {};
    },
  };
  return { ctx: { systemPrompt }, contexts, sections };
}

function render(host, context) {
  const entry = host.contexts.find((candidate) => candidate.name === 'handoff:state');
  if (entry === undefined) return undefined;
  return typeof entry.text === 'function' ? entry.text(context) : entry.text;
}

// --- registration ---------------------------------------------------------

test('declares the plugin name', () => {
  assert.equal(name, 'handoff-state');
});

test('injects only the prompt registry', () => {
  assert.deepEqual(inject, ['systemPrompt']);
});

test('registers a context entry and no prompt section', () => {
  const host = createHost();
  apply(host.ctx, { scenesRoot: makeRoot('2026-10-29 17:30') });
  assert.equal(host.contexts.length, 1);
  assert.equal(host.contexts[0].name, 'handoff:state');
  assert.equal(host.contexts[0].order, 135);
  assert.equal(host.contexts[0].interpolate, false);
  assert.equal(host.sections.length, 0, 'a section would invalidate the cached prompt prefix');
});

test('enabled:false registers nothing', () => {
  const host = createHost();
  apply(host.ctx, { enabled: false });
  assert.equal(host.contexts.length, 0);
});

// --- rendering ------------------------------------------------------------

test('renders the §〇 fields and nothing below them', () => {
  const root = makeRoot('2026-10-29 17:30');
  try {
    const text = createStateText({ scenesRoot: root })({ agent: { session: { cwd: 'E:/工作空间/DSH工作台改造' } } });
    assert.ok(text.includes('装注入插件'));
    assert.ok(text.includes('dsh工作台改造'));
    assert.equal(text.includes('不该出现在注入里'), false, 'the long-term memory must not leak in');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the text is byte-identical across repeated renders', () => {
  const root = makeRoot('2026-10-29 17:30');
  try {
    const stateText = createStateText({ scenesRoot: root });
    const context = { agent: { session: { cwd: 'E:/工作空间/DSH工作台改造' } } };
    const first = stateText(context);
    const second = stateText(context);
    const third = stateText(context);
    assert.equal(first, second);
    assert.equal(second, third);
    assert.notEqual(first, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a changed handoff is picked up on the next render', () => {
  const root = makeRoot('2026-10-29 17:30');
  try {
    const stateText = createStateText({ scenesRoot: root });
    const context = { agent: { session: { cwd: 'E:/工作空间/DSH工作台改造' } } };
    assert.ok(stateText(context).includes('装注入插件'));

    const path = join(root, 'dsh工作台改造', '场景私有记忆.md');
    writeFileSync(path, HANDOFF('2026-10-29 17:30').replace('装注入插件', '改成别的下一步'), 'utf8');
    // Force a distinct mtime: writes within the same millisecond would
    // otherwise look unchanged to the cache key.
    const future = new Date(Date.now() + 2000);
    utimesSync(path, future, future);

    assert.ok(stateText(context).includes('改成别的下一步'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing scene file degrades to empty instead of throwing', () => {
  const root = makeRoot('2026-10-29 17:30');
  try {
    rmSync(join(root, 'dsh工作台改造', '场景私有记忆.md'));
    const text = createStateText({ scenesRoot: root })({ agent: { session: { cwd: 'E:/工作空间/DSH工作台改造' } } });
    assert.equal(text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing root degrades to empty instead of throwing', () => {
  const stateText = createStateText({ scenesRoot: join(tmpdir(), 'definitely-not-here-9f3a') });
  assert.equal(stateText({ agent: { session: { cwd: 'E:/工作空间/DSH工作台改造' } } }), '');
});

test('an unknown cwd with several scenes injects nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-state-'));
  try {
    mkdirSync(join(root, '_共享记忆'), { recursive: true });
    writeFileSync(join(root, '_共享记忆', '索引.json'), JSON.stringify({ 版本: 1, 场景: ['甲场景', '乙场景'] }), 'utf8');
    for (const scene of ['甲场景', '乙场景']) {
      mkdirSync(join(root, scene), { recursive: true });
      writeFileSync(join(root, scene, '场景私有记忆.md'), HANDOFF('2026-10-29 17:30'), 'utf8');
    }
    const text = createStateText({ scenesRoot: root })({ agent: { session: { cwd: 'C:/无关路径' } } });
    assert.equal(text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
