/**
 * Regression check for the tool-output contract on DSH 0.2.x.
 *
 * `@deepseek-ai/dsh-tools` snapshots every tool result with
 * `snapshotJsonValue` (@deepseek-ai/dsh-util-values). A single `undefined`
 * field, NaN/±Infinity/-0, a sparse array or a non-plain object rejects the
 * WHOLE call with "value is not lossless JSON" (INVALID_TOOL_OUTPUT). SVN's XML
 * legitimately omits fields — unversioned entries carry no revision, `svn log`
 * without -v has no paths, `svn list` has no size for directories — which is
 * exactly how svn_info / svn_status / svn_log / svn_list / svn_cat broke on
 * 0.2.x before the tool layer normalised its own output.
 *
 * This script builds a throwaway repository (svnadmin), drives the plugin's
 * real tools through a fake context, and asserts every answer passes the same
 * snapshot. It also pins the parser fixes: repositoryUuid must really be read
 * from the nested <repository> element, and absent fields must be absent
 * (not `key: undefined`).
 *
 * Usage:  node scripts/verify-tool-output.mjs [working-copy-path]
 *   Without an argument a temporary repository is created and removed again;
 *   with an argument that working copy is inspected (read-only tools only).
 * Exit code 0 = all checks passed, 2 = prerequisites missing.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const SVN = process.platform === 'win32' ? 'svn.exe' : 'svn';
const SVNADMIN = process.platform === 'win32' ? 'svnadmin.exe' : 'svnadmin';

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

// ------------------------------------------------------- lossless snapshot
/** Mirror of dsh-util-values' rules, used only when the real package is absent. */
function localSnapshot(value, ancestors = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : undefined;
  if (type !== 'object') return undefined;
  if (ancestors.has(value)) return undefined;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return undefined;
    ancestors.add(value);
    const out = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) return undefined;
      const item = localSnapshot(value[i], ancestors);
      if (item === undefined) return undefined;
      out[i] = item;
    }
    ancestors.delete(value);
    return out;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
  ancestors.add(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const next = localSnapshot(item, ancestors);
    if (next === undefined) return undefined;
    out[key] = next;
  }
  ancestors.delete(value);
  return out;
}

let snapshotJsonValue = localSnapshot;
try {
  ({ snapshotJsonValue } = await import('@deepseek-ai/dsh-util-values'));
  console.log('snapshot: @deepseek-ai/dsh-util-values');
} catch {
  console.log('snapshot: local lossless-JSON mirror (@deepseek-ai/dsh-util-values is not installed here)');
}

// --------------------------------------------------------------- fixture
function run(binary, args, opts = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

/** Create a working copy that covers every optional-field case at once. */
function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-svn-tool-output-'));
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  run(SVNADMIN, ['create', repo]);
  const url = fileUrl(repo);
  run(SVN, ['mkdir', url + '/trunk', '-m', 'init', '--non-interactive']);
  run(SVN, ['checkout', url + '/trunk', wc, '--non-interactive']);
  writeFileSync(path.join(wc, 'a.txt'), 'line1\n');
  run(SVN, ['add', path.join(wc, 'a.txt'), '--non-interactive']);
  run(SVN, ['commit', wc, '-m', 'add a', '--non-interactive']);
  // A committed directory makes `svn list` emit a kind="dir" entry (no size).
  mkdirSync(path.join(wc, 'sub'));
  writeFileSync(path.join(wc, 'sub', 'b.txt'), 'b\n');
  run(SVN, ['add', path.join(wc, 'sub'), '--non-interactive']);
  run(SVN, ['commit', wc, '-m', 'add sub', '--non-interactive']);
  // Local changes: one modified file and one unversioned file (no revision).
  appendFileSync(path.join(wc, 'a.txt'), 'line2\n');
  writeFileSync(path.join(wc, 'new.txt'), 'new\n');
  return { root, wc, url: url + '/trunk' };
}

let fixture = null;
let wc = process.argv[2];
if (wc === undefined) {
  try {
    run(SVNADMIN, ['--version', '--quiet']);
  } catch {
    console.error('svnadmin is not available; pass an existing working-copy path instead');
    process.exit(2);
  }
  fixture = makeFixture();
  wc = fixture.wc;
}
console.log('working copy: ' + wc);

// ------------------------------------------------------------ tool harness
const toolByName = new Map();
const ctx = {
  tools: { register(tool) { toolByName.set(tool.name, tool); } },
  webServer: { register() {} },
  sessions: { get: () => ({ header: { cwd: wc } }) },
  agents: {},
  llm: {},
  effect(fn) { return fn(); },
  inject() { return { dispose() {} }; },
  get() { return undefined; },
};
apply(ctx, {});
console.log('tools registered: ' + toolByName.size);
check(toolByName.size === 33, 'all 33 svn_* tools register');

const exec = { agent: { session: { header: { cwd: wc } } } };

const cases = [
  ['svn_info', {}],
  ['svn_status', {}],
  ['svn_log', {}],
  ['svn_list', {}],
  ['svn_cat', { target: 'a.txt' }],
  ['svn_diff', {}],
  ['svn_blame', { path: 'a.txt' }],
  ['svn_proplist', { path: 'a.txt' }],
  ['svn_cleanup', {}],
];

const results = new Map();
for (const [name, args] of cases) {
  const tool = toolByName.get(name);
  if (tool === undefined) {
    check(false, name + ' is registered');
    continue;
  }
  let value;
  try {
    value = await tool.execute(args, exec);
  } catch (error) {
    check(false, name + ' executes', error.message);
    continue;
  }
  results.set(name, value);
  const snapshot = snapshotJsonValue(value);
  check(snapshot !== undefined, name + ' survives the lossless-JSON snapshot');
  if (snapshot !== undefined) {
    check(JSON.stringify(snapshot) === JSON.stringify(value), name + ' has no JSON round-trip loss');
  }
}

// ------------------------------------------------------- parser-level pins
const info = results.get('svn_info') || {};
check(typeof info.repositoryUuid === 'string' && /^[0-9a-f-]{36}$/i.test(info.repositoryUuid),
  'svn_info reads <repository><uuid> out of the nested element', JSON.stringify(info.repositoryUuid));
check(info.repositoryRoot !== undefined && info.workingCopyRoot !== undefined,
  'svn_info still carries root + working copy root');

const status = results.get('svn_status') || {};
const unversioned = (status.entries || []).find((e) => e.status === '?');
check(unversioned !== undefined, 'svn_status lists the unversioned file');
check(unversioned !== undefined && !('revision' in unversioned) && !('lastChangedAuthor' in unversioned),
  'an unversioned entry omits absent fields instead of emitting undefined');
const modified = (status.entries || []).find((e) => e.status === 'M');
check(modified !== undefined && modified.revision !== undefined, 'a modified entry keeps its revision');

const log = results.get('svn_log') || {};
check(Array.isArray(log.entries) && log.entries.length > 0, 'svn_log returns entries');
check((log.entries || []).every((e) => !('paths' in e)),
  'svn_log without -v omits the absent paths field');

const list = results.get('svn_list') || {};
check(Array.isArray(list.entries), 'svn_list returns an entries array');
if (fixture !== null) {
  // `svn list <wc path>` lists the directory at its own BASE revision, which is
  // the revision the directory itself last changed at — for a freshly created
  // trunk that is r1, i.e. empty. The repository URL is the reliable form.
  let dirEntry;
  try {
    const byUrl = await toolByName.get('svn_list').execute({ target: fixture.url }, exec);
    const snapshot = snapshotJsonValue(byUrl);
    check(snapshot !== undefined, 'svn_list by repository URL survives the lossless-JSON snapshot');
    dirEntry = (byUrl.entries || []).find((e) => e.kind === 'dir');
    check(dirEntry !== undefined, 'svn_list lists the directory entry');
    check(dirEntry !== undefined && !('size' in dirEntry),
      'a directory entry omits the absent size field');
  } catch (error) {
    check(false, 'svn_list by repository URL executes', error.message);
  }
}

const cat = results.get('svn_cat') || {};
check(typeof cat.content === 'string' && cat.content.includes('line1'), 'svn_cat reads the BASE content');
check(!('truncated' in cat), 'svn_cat omits truncated when nothing was truncated');

// ------------------------------------------------------------------ teardown
if (fixture !== null) {
  try {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    console.warn('  warn  could not remove the temporary fixture: ' + fixture.root);
  }
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL TOOL-OUTPUT CHECKS PASSED');
