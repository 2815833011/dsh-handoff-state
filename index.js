/**
 * Put the current scene's handoff back in front of the model on every turn.
 *
 * The problem this solves is an incentive problem, not a storage one. The
 * handoff file, the gate that validates it and the health check that reports
 * on it all exist and all work — but nothing reads the file at the start of a
 * session. `~/.dsh/AGENTS.md` asks the model to read it, and a rule that lives
 * only in prose is a rule that gets skipped under load. Measured on this
 * machine: `grep 场景记忆` over the constitution returned zero hits before the
 * rule was added, and even after, nothing enforces it.
 *
 * So the handoff is injected instead. A host-side plugin cannot rewrite the
 * model's instructions, but it can contribute to the "Current runtime context"
 * block, which is re-rendered from scratch every step and is the one place
 * whose freshness is guaranteed rather than hoped for.
 *
 * Why a context entry and not a prompt section: a section is part of the
 * cached system prompt, so any change to it invalidates the whole prefix and
 * the next request pays for the entire cached prompt again (~161K tokens was
 * measured for one section change here). The runtime-context block already
 * changes between steps (working directory, todo state), so a line there costs
 * nothing while it stays the same — and the loop admits a new snapshot only
 * when the joined text actually differs.
 *
 * That "only when the text differs" rule is the constraint that shapes
 * `state.js`: nothing rendered may depend on wall-clock time finer than a
 * coarse bucket, or the plugin would inject a fresh user message every step.
 *
 * The plugin imports only Node builtins. A profile installs it with
 * `pnpm add link:<dir>`, which resolves through the real path, so anything
 * under the profile's own `node_modules` would fail to resolve.
 *
 * @module dsh-handoff-state
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { freshnessBucket, parseHandoff, renderHandoffState, resolveScene } from './state.js';

/** Stable Cordis plugin name used by loader diagnostics. */
export const name = 'handoff-state';

/** Only the prompt registry: this plugin owns no session projection. */
export const inject = ['systemPrompt'];

/** Runtime-context name for the injected handoff. */
const STATE_CONTEXT = 'handoff:state';

/**
 * Placement inside the "Current runtime context" snapshot.
 *
 * Working directory (100), sandbox (110), approval (115), subagent (120),
 * team (125) and the todo restatement (130) come first; a handoff summary
 * belongs immediately after the todo list, since both answer "where was I".
 */
const STATE_ORDER = 135;

/** The scene-memory root, resolved once. */
function scenesRoot(config) {
  const configured = typeof config?.scenesRoot === 'string' && config.scenesRoot !== '';
  return configured ? config.scenesRoot : join(homedir(), '.dsh', '场景记忆');
}

/** Read the shared scene index, or `null` when it is missing or unreadable. */
function readIndex(root) {
  try {
    return JSON.parse(readFileSync(join(root, '_共享记忆', '索引.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Every registered scene name, used when the index is absent. */
function scenesOnDisk(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '_共享记忆' && entry.name !== 'templates')
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** The working directory the session is actually in, if the host exposes it. */
function cwdOf(context) {
  const session = context?.agent?.session;
  for (const candidate of [session?.cwd, session?.workspace, context?.cwd]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return '';
}

/** Read the auto-memory index as a bare topic list. Missing or broken -> []. */
function readMemories(file) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(doc.entries)) return [];
    return doc.entries
      .map((entry) => entry && entry.topic)
      .filter((topic) => typeof topic === 'string' && topic !== '');
  } catch {
    return [];
  }
}

/**
 * Build the text provider.
 *
 * The provider runs on every step, so it must stay cheap and stable:
 *
 * - the scene is resolved once and then kept, because the working directory
 *   does not move mid-session;
 * - the file is re-stat'd every step but re-read only when its size or mtime
 *   changed, so an unchanged handoff yields a byte-identical string and the
 *   loop does not admit a new snapshot;
 * - any failure degrades to `''` rather than throwing, because a plugin that
 *   throws inside the context renderer would take the turn down with it.
 *
 * @export for the host tests
 */
export function createStateText(config = {}) {
  const root = scenesRoot(config);
  let scene;
  let cachedPath;
  let cachedKey;
  let cachedText = '';

  return function stateText(context) {
    if (scene === undefined) {
      const index = readIndex(root);
      scene = resolveScene(cwdOf(context), index ?? { 场景: scenesOnDisk(root) });
    }
    if (scene === null) return '';

    const path = join(root, scene, '场景私有记忆.md');
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return '';
    }

    const memFile = join(root, scene, '自动记忆', '_index.json');
    let memKey = '0';
    try {
      const memStat = statSync(memFile);
      memKey = `${memStat.size}:${memStat.mtimeMs}`;
    } catch {
      // 没有自动记忆层就是空，不算错误
    }

    const key = `${stat.size}:${stat.mtimeMs}:${memKey}`;
    if (path === cachedPath && key === cachedKey) return cachedText;

    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return '';
    }

    const parsed = parseHandoff(raw);
    const text = renderHandoffState({
      scene,
      parsed,
      bucket: freshnessBucket(parsed.stamp),
      docPath: path,
      memories: readMemories(memFile),
    });

    cachedPath = path;
    cachedKey = key;
    cachedText = text;
    return text;
  };
}

/**
 * Register the runtime-context entry.
 * @param ctx - plugin context carrying {@link inject}.
 * @param config - optional `{ enabled?: boolean, scenesRoot?: string }`.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  ctx.systemPrompt.context({
    name: STATE_CONTEXT,
    order: STATE_ORDER,
    interpolate: false,
    text: createStateText(config),
  });
}
