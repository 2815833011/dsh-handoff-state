/**
 * Pure logic for the handoff-state plugin.
 *
 * Everything here is importable and side-effect free so it can be asserted
 * in-process: the DSH sandbox denies `spawnSync`, which rules out any test
 * that shells out to the plugin.
 *
 * The one rule that shapes every function below: the rendered text must be
 * **stable between events**. The agent loop re-renders each runtime-context
 * provider on every step and admits a new snapshot only when the joined text
 * changes. A line that printed a live "3 小时 12 分钟前" would therefore inject
 * a fresh user message on every single step. So the age appears only as a
 * coarse bucket, which crosses a boundary at most twice per day.
 *
 * @module dsh-handoff-state/state
 */

/** A handoff older than this is called out as stale. Matches `tools/handoff.mjs`. */
export const STALE_MINUTES = 90;

/** A handoff older than this is cold: the scene has moved on without it. */
export const COLD_MINUTES = 24 * 60;

/** The four fields every §〇 section must carry. */
export const FIELDS = ['目标', '做到哪', '下一步', '未决'];

const STAMP_RE = /^[ \t>*-]*更新[ \t]*[:：][ \t]*(\d{4})-(\d{2})-(\d{2})[ \t]+(\d{2}):(\d{2})/m;
const SECTION_HEAD_RE = /^##[ \t]*§〇.*$/m;

/** UTF-8 byte length: the limit the README states is in bytes, not characters. */
export function bytesOf(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/**
 * Parse the `更新: YYYY-MM-DD HH:MM` line.
 * @returns {Date|null} `null` when the line is absent or malformed.
 */
export function parseStamp(text) {
  const match = STAMP_RE.exec(String(text ?? ''));
  if (match === null) return null;
  const [, y, mo, d, h, mi] = match;
  const stamp = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
  return Number.isNaN(stamp.getTime()) ? null : stamp;
}

/**
 * Extract the `## §〇 …` section, stopping at the next `## ` heading.
 * @returns {string|null} `null` when the document has no §〇 heading.
 */
export function sectionOf(text) {
  const source = String(text ?? '');
  const head = SECTION_HEAD_RE.exec(source);
  if (head === null) return null;
  const start = head.index;
  const after = source.slice(start + head[0].length);
  const next = /^##[ \t]+/m.exec(after);
  const end = next === null ? source.length : start + head[0].length + next.index;
  return source.slice(start, end);
}

/** Read one `- 字段: 值` line out of a section. */
function fieldOf(section, field) {
  if (section === null) return null;
  const re = new RegExp(`^[ \\t>*-]*\\*{0,2}${field}\\*{0,2}[ \\t]*[:：][ \\t]*(.*)$`, 'm');
  const match = re.exec(section);
  if (match === null) return null;
  const value = match[1].trim();
  return value === '' ? null : value;
}

/**
 * Parse a scene memory document.
 * @returns {{section: string|null, stamp: Date|null, goal, done, next, open}}
 */
export function parseHandoff(text) {
  const section = sectionOf(text);
  return {
    section,
    stamp: parseStamp(section ?? text),
    goal: fieldOf(section, '目标'),
    done: fieldOf(section, '做到哪'),
    next: fieldOf(section, '下一步'),
    open: fieldOf(section, '未决'),
  };
}

/**
 * Classify a stamp against the current time.
 *
 * `future` is its own bucket rather than "fresh": a timestamp later than now
 * cannot describe work that already happened, and the gate rejects it — so
 * the injection must not present it as trustworthy.
 *
 * @returns {'fresh'|'stale'|'cold'|'future'|'none'}
 */
export function freshnessBucket(stamp, now = new Date()) {
  if (!(stamp instanceof Date) || Number.isNaN(stamp.getTime())) return 'none';
  const ageMin = (now.getTime() - stamp.getTime()) / 60000;
  if (ageMin < 0) return 'future';
  if (ageMin > COLD_MINUTES) return 'cold';
  if (ageMin > STALE_MINUTES) return 'stale';
  return 'fresh';
}

/**
 * Pick the scene this session belongs to.
 *
 * A scene name that occurs in the working directory wins (longest first, so
 * `工作台改造-v2` beats `工作台改造`). With exactly one registered scene there
 * is nothing to guess. Several competing scenes and no match means `null`:
 * injecting a stranger's handoff is worse than injecting none.
 *
 * @returns {string|null}
 */
export function resolveScene(cwd, index) {
  const scenes = Array.isArray(index?.场景) ? index.场景.filter((s) => typeof s === 'string' && s !== '') : [];
  if (scenes.length === 0) return null;

  const path = String(cwd ?? '').replace(/\\/g, '/').toLowerCase();
  const matched = scenes
    .filter((scene) => path.includes(scene.replace(/\\/g, '/').toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (matched.length > 0) return matched[0];

  return scenes.length === 1 ? scenes[0] : null;
}

/** Bucket wording. Deliberately coarse: see the module comment. */
const BUCKET_NOTE = {
  stale: '已过期：超过 90 分钟没更新，下面的"下一步"可能已经不成立。',
  cold: '已过期：超过一天没更新，先核对再动手。',
  future: '时间在未来：这条交接的时间戳晚于此刻，内容不可信，先核对。',
};

/**
 * Render the injected state line.
 *
 * Returns `''` when there is nothing worth injecting, so a session without a
 * handoff gets no empty heading in its context.
 */
const NL = String.fromCharCode(10);
/** 单个 §〇 段的注入预算（字节）。超出即压缩字段，并在尾部给出全文路径。 */
export const SECTION_BUDGET_BYTES = 4000;

/** 记忆索引行最多占预算的这个比例，防止 20 条 topic 把正文挤没。 */
const MEMORY_SHARE = 0.2;

/** 按 UTF-8 字节截断字符串，且不切断多字节字符。 */
function sliceBytes(text, limit) {
  const buf = Buffer.from(String(text), 'utf8');
  if (buf.length <= limit) return String(text);
  let cut = buf.subarray(0, Math.max(0, limit)).toString('utf8');
  // 只剥掉截断产生的尾部替身字符，不碰正文里本来就有的
  cut = cut.replace(/\uFFFD+$/, '');
  return cut;
}

/** 自动记忆索引行：去重、去空，超长时按预算收缩。 */
function memoryLine(memories, room) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const seen = new Set();
  const names = [];
  for (const raw of memories) {
    const name = String(raw === null || raw === undefined ? '' : raw).trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return '';
  const suffix = '（正文用 node ~/.dsh/tools/memory.mjs --get <topic> 读）';
  const budget = Math.max(64, Math.floor(room));
  let line = '自动记忆: ' + names.join('、') + suffix;
  if (bytesOf(line) <= budget) return line;
  const head = '自动记忆: ';
  const keep = [];
  for (const name of names) {
    const trial = head + keep.concat([name]).join('、') + suffix;
    if (bytesOf(trial) > budget) break;
    keep.push(name);
  }
  if (keep.length === 0) return '';
  const tail = keep.length < names.length ? ' 等 ' + String(names.length) + ' 条' : '';
  line = head + keep.join('、') + tail + suffix;
  return bytesOf(line) <= budget ? line : '';
}

/**
 * Render the injected block.
 *
 * maxBytes is a hard cap, not a warning: every byte here is paid on every
 * request, and any change to the block invalidates the whole prompt prefix.
 *
 * 分配策略是注水（water-filling）而不是均分：需求小于平均份额的字段整段
 * 放行并退出竞争，剩下的预算再均分给仍然超长的字段。均分会把最长的那个
 * 字段砍掉大半，同时把用不完的份额浪费掉——实测 4 个字段里 2,029 B 被丢，
 * 而 356 B 预算闲置。
 */
export function renderHandoffState({ scene, parsed, bucket, docPath = null, memories = [], maxBytes = SECTION_BUDGET_BYTES }) {
  if (parsed === null || parsed === undefined) return '';
  if (typeof parsed.section !== 'string' || parsed.section === '') return '';

  const limit = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : SECTION_BUDGET_BYTES;
  const lines = [];
  const label = scene === null || scene === undefined ? '当前场景' : scene;
  lines.push('Handoff for ' + label + ' (§〇 交接，每轮自动注入):');

  const note = BUCKET_NOTE[bucket];
  if (note !== undefined) lines.push('! ' + note);

  const footer = '收工时更新 §〇 并跑 node ~/.dsh/tools/handoff.mjs。';
  const pointerReserve = docPath === null ? 80 : 300;
  let used = bytesOf(lines.join(NL)) + bytesOf(footer) + 2;

  const mem = memoryLine(memories, Math.floor(limit * MEMORY_SHARE));
  if (mem !== '') used += bytesOf(mem) + 1;

  const wanted = [
    ['目标', parsed.goal],
    ['做到哪', parsed.done],
    ['下一步', parsed.next],
    ['未决', parsed.open],
  ]
    .filter(function (pair) { return pair[1] !== null && pair[1] !== undefined && pair[1] !== ''; })
    .map(function (pair) {
      const prefix = pair[0] + ': ';
      const body = String(pair[1]);
      return { field: pair[0], prefix: prefix, body: body, need: bytesOf(prefix) + bytesOf(body) };
    });

  let avail = limit - used - pointerReserve;
  let truncated = false;

  // 注水：短字段整段放行，余下预算留给长字段
  let pending = wanted.slice();
  for (let round = 0; round < wanted.length + 1 && pending.length > 0; round++) {
    const level = Math.floor(avail / pending.length);
    const keep = [];
    let progressed = false;
    for (const item of pending) {
      if (item.need <= level) {
        item.budget = item.need;
        avail -= item.need;
        progressed = true;
      } else {
        keep.push(item);
      }
    }
    pending = keep;
    if (!progressed) break;
  }
  if (pending.length > 0) {
    const level = Math.floor(avail / pending.length);
    for (let i = 0; i < pending.length; i++) {
      const last = i === pending.length - 1;
      pending[i].budget = last ? Math.max(0, avail - level * (pending.length - 1)) : level;
    }
  }

  for (const item of wanted) {
    const budget = typeof item.budget === 'number' ? item.budget : 0;
    if (budget < 40) {
      truncated = true;
      continue;
    }
    if (item.need <= budget) {
      lines.push(item.prefix + item.body);
      continue;
    }
    const room = Math.max(16, budget - bytesOf(item.prefix) - 3);
    lines.push(item.prefix + sliceBytes(item.body, room) + '…');
    truncated = true;
  }

  if (lines.length === 1) return '';
  if (mem !== '') lines.push(mem);

  if (truncated) {
    const where = docPath === null ? '全文见场景记忆文档' : ('全文：' + docPath);
    lines.push('（§〇 已按 ' + String(limit) + ' 字节预算压缩，' + where + '）');
  }
  lines.push(footer);

  let out = lines.join(NL);
  // 兜底：任何累积误差都不许突破硬上限
  while (bytesOf(out) > limit && lines.length > 2) {
    let worst = -1;
    let worstLen = -1;
    for (let i = 1; i < lines.length - 1; i++) {
      const len = bytesOf(lines[i]);
      if (len > worstLen && !lines[i].startsWith('（§〇')) { worst = i; worstLen = len; }
    }
    if (worst < 0 || worstLen <= 64) break;
    lines[worst] = sliceBytes(lines[worst], worstLen - 64) + '…';
    out = lines.join(NL);
  }
  return out;
}
