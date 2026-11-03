/**
 * Install dsh-handoff-state into the Desktop profile.
 *
 * 1. `pnpm add link:<workspace>/dsh-handoff-state` inside the profile, so the
 *    dependency lands in package.json and pnpm-lock.yaml like any other plugin.
 * 2. Append the bundle id to `dsh.profile.bundles`, matching how the profile's
 *    other plugins are registered (the plugin manager appends new bundles at the
 *    end, which preserves existing config precedence).
 *
 * The script is idempotent and prints what it changed.
 *
 * Run with: node install.cjs
 */
const { execFileSync } = require('node:child_process');
const { existsSync, lstatSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const PNPM = 'D:\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.cjs';
const PROFILE = 'C:\\Users\\28158\\.dsh\\profiles\\desktop';
const PLUGIN_DIR = 'E:\\工作空间\\DSH工作台改造\\dsh-handoff-state';
const ID = 'dsh-handoff-state';

function step(title) {
  console.log(`\n=== ${title}`);
}

step('pnpm add link:');
const spec = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`;
try {
  const out = execFileSync(NODE, [PNPM, 'add', spec, '--reporter=append-only'], {
    cwd: PROFILE,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });
  console.log(out.trim().split('\n').slice(-12).join('\n'));
} catch (error) {
  console.log('STDOUT:', String(error.stdout ?? '').trim().split('\n').slice(-15).join('\n'));
  console.log('STDERR:', String(error.stderr ?? '').trim().split('\n').slice(-15).join('\n'));
  console.log('pnpm failed; continuing to inspect state');
}

step('manifest after install');
const manifestPath = join(PROFILE, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log('dependency:', manifest.dependencies[ID]);
console.log('bundles:', manifest.dsh.profile.bundles.join(', '));

if (manifest.dsh.profile.bundles.includes(ID) === false) {
  manifest.dsh.profile.bundles.push(ID);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  step('appended bundle');
  console.log('bundles:', manifest.dsh.profile.bundles.join(', '));
} else {
  step('bundle already listed');
}

step('module layout');
const mod = join(PROFILE, 'node_modules', ID);
const stat = lstatSync(mod, { throwIfNoEntry: false });
if (stat === undefined) {
  console.log('MISSING:', mod);
  process.exit(1);
}
console.log('link:', stat.isSymbolicLink(), 'dir:', stat.isDirectory());
const pkg = JSON.parse(readFileSync(join(mod, 'package.json'), 'utf8'));
console.log('resolved version:', pkg.version, 'patch:', pkg.dsh.bundle.patch);
for (const file of ['index.js', 'state.js', 'cordis.patch.yml']) {
  console.log(`  ${file}:`, existsSync(join(mod, file)));
}
