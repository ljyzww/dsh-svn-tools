/**
 * Regression check for multi / nested working copies and scoped project
 * directories (issue #4).
 *
 * What it pins down:
 *   1. the panel DEFAULTS to the session workspace (the project directory), not
 *      to the enclosing checkout root — `D:\Work\HoloX\XCC-Deluxe` inside a
 *      `HoloX` checkout starts scoped to `XCC-Deluxe`;
 *   2. `wcs` lists every watched directory with its own info + status, and a
 *      nested checkout is NOT reported as an unversioned change of its parent;
 *   3. `watch add` keeps the requested directory as the scope (a project
 *      subdirectory can be followed on its own; a nested checkout is its own
 *      working copy), and the list survives a fresh plugin instance;
 *   4. writes route to the selected scope: `status`/`commit` with `wc: <proj>`
 *      act on that subtree only, and the rest of the checkout stays untouched;
 *   5. commits that mix working copies or step outside the selected scope are
 *      refused with a readable message instead of committing the wrong tree;
 *   6. the last remaining directory cannot be removed.
 *
 * Usage:  node scripts/verify-multi-wc.mjs
 * Exit code 0 = all checks passed, 2 = prerequisites (svn/svnadmin) missing.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync,
} from 'node:fs';
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

function run(binary, args, opts = {}) {
  return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function fileUrl(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}
function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

try {
  run(SVNADMIN, ['--version', '--quiet']);
} catch {
  console.error('svnadmin is not available; this check needs a local Subversion install');
  process.exit(2);
}

// ---------------------------------------------------------------- fixture
const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-svn-multi-wc-'));
const mainRepo = path.join(root, 'main-repo');
const nestedRepo = path.join(root, 'nested-repo');
const wc = path.join(root, 'wc');
const proj = path.join(wc, 'proj');
const nestedWc = path.join(wc, 'nested');

function makeRepo(repo) {
  run(SVNADMIN, ['create', repo]);
  const url = fileUrl(repo);
  run(SVN, ['mkdir', `${url}/trunk`, '-m', 'init', '--non-interactive']);
  return `${url}/trunk`;
}

const mainUrl = makeRepo(mainRepo);
run(SVN, ['checkout', mainUrl, wc, '--non-interactive']);
writeFileSync(path.join(wc, 'a.txt'), 'line1\n');
run(SVN, ['add', path.join(wc, 'a.txt'), '--non-interactive']);
run(SVN, ['commit', wc, '-m', 'add a', '--non-interactive']);

// A project subdirectory inside the checkout (the XCC-Deluxe case): it is NOT
// a working copy of its own, it is a scope inside `wc`.
mkdirSync(proj, { recursive: true });
writeFileSync(path.join(proj, 'p.txt'), 'p1\n');
run(SVN, ['add', proj, '--non-interactive']);
run(SVN, ['commit', wc, '-m', 'add proj', '--non-interactive']);

// A second, independent repository checked out INSIDE the first working copy:
// the Unity layout (not svn:externals).
const nestedUrl = makeRepo(nestedRepo);
run(SVN, ['checkout', nestedUrl, nestedWc, '--non-interactive']);
writeFileSync(path.join(nestedWc, 'n.txt'), 'n1\n');
run(SVN, ['add', path.join(nestedWc, 'n.txt'), '--non-interactive']);
run(SVN, ['commit', nestedWc, '-m', 'add n', '--non-interactive']);

// Local changes on all three scopes.
appendFileSync(path.join(wc, 'a.txt'), 'line2\n');
writeFileSync(path.join(wc, 'root-new.txt'), 'new\n');
appendFileSync(path.join(proj, 'p.txt'), 'p2\n');
writeFileSync(path.join(proj, 'extra.txt'), 'new\n');
appendFileSync(path.join(nestedWc, 'n.txt'), 'n2\n');
writeFileSync(path.join(nestedWc, 'nested-new.txt'), 'new\n');

console.log('working copy: ' + wc);
console.log('project:      ' + proj);
console.log('nested:       ' + nestedWc);

// ------------------------------------------------------------ tool harness
function makeCall(sessionCwd = wc) {
  let handler;
  const ctx = {
    tools: { register() {} },
    webServer: { register(o) { handler = o.handler; } },
    sessions: { get: () => ({ header: { cwd: sessionCwd } }) },
    agents: {},
    llm: {},
    effect(fn) { return fn(); },
    inject() { return { dispose() {} }; },
  };
  apply(ctx, {});
  return async function call(method, payload) {
    const req = {
      method: 'POST',
      url: `/svn/api/${method}`,
      headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' },
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(payload ?? {})));
        if (ev === 'end') fn();
        return this;
      },
      destroy() {},
    };
    return await new Promise((resolve, reject) => {
      const res = {
        status: 0,
        writeHead(s) { this.status = s; },
        end(b) {
          const parsed = JSON.parse(b);
          if (this.status !== 200 || parsed.ok !== true) reject(new Error(parsed?.error?.message || b.slice(0, 200)));
          else resolve(parsed.value);
        },
      };
      handler(req, res).catch(reject);
    });
  };
}

const call = makeCall();
async function callFails(method, payload) {
  try { return { failed: false, value: await call(method, payload) }; }
  catch (e) { return { failed: true, message: e.message }; }
}

// ------------------------------------- 1) default is the session workspace
console.log('default scope is the session workspace:');
const seeded = await call('wcs', { sessionId: 'verify' });
check(seeded.wcs.length === 1, 'one directory is followed before anything is added', String(seeded.wcs.length));
check(samePath(seeded.wcs[0].path, wc), 'a session opened at the checkout root is scoped to it');
check(seeded.wcs[0].entries.some((e) => samePath(e.path, path.join(wc, 'root-new.txt'))), 'the unversioned root file is listed');
check(!seeded.wcs[0].entries.some((e) => samePath(e.path, nestedWc)),
  'the nested checkout is not listed as a change of its parent');

const projectCall = makeCall(proj);
const projectSeed = await projectCall('wcs', { sessionId: 'project-session' });
check(projectSeed.wcs.length === 1, 'a session opened in a project directory follows that directory');
check(samePath(projectSeed.wcs[0].path, proj), 'the default scope is the project path, not the checkout root', projectSeed.wcs[0].path);
check(projectSeed.wcs[0].label === 'proj', 'the chip is labelled after the project directory');
check(/\/proj$/.test(String(projectSeed.wcs[0].url || '')), 'the reported URL is the project URL', String(projectSeed.wcs[0].url));
check(projectSeed.wcs[0].entries.length === 2, 'only the project changes are listed', String(projectSeed.wcs[0].entries.length));
check(!projectSeed.wcs[0].entries.some((e) => samePath(e.path, path.join(wc, 'a.txt'))), 'changes outside the project are not listed');

// --------------------------------------------------------- 2) watch add
console.log('watch add (keeps the requested directory as the scope):');
const nestedAdded = await call('watch', { sessionId: 'verify', action: 'add', path: path.join(nestedWc, 'n.txt') });
check(nestedAdded.added === true, 'adding a nested checkout reports success');
check(samePath(nestedAdded.path, nestedWc), 'a file input is normalised to its directory', nestedAdded.path);
const projAdded = await call('watch', { sessionId: 'verify', action: 'add', path: proj });
check(projAdded.added === true, 'adding a project subdirectory reports success');
check(samePath(projAdded.path, proj), 'the project directory is kept as its own scope', projAdded.path);
check(Array.isArray(projAdded.overlaps) && projAdded.overlaps.some((p) => samePath(p, wc)),
  'overlap with the enclosing checkout is reported', JSON.stringify(projAdded.overlaps));
const again = await call('watch', { sessionId: 'verify', action: 'add', path: proj });
check(again.added === false && again.reason === 'already-watched', 'adding the same directory twice is a no-op');

const list = await call('wcs', { sessionId: 'verify' });
check(list.wcs.length === 3, 'all three scopes are listed', String(list.wcs.length));
const parent = list.wcs.find((w) => samePath(w.path, wc));
const project = list.wcs.find((w) => samePath(w.path, proj));
const child = list.wcs.find((w) => samePath(w.path, nestedWc));
check(parent !== undefined && project !== undefined && child !== undefined, 'the list carries all three scopes');
check(project.count === 2, 'the project scope reports its own two changes', String(project.count));
check(project.entries.every((e) => samePath(e._wc, proj)), 'every project entry is attributed to the project scope');
check(project.entries.every((e) => samePath(e._wcRoot, wc)), 'the project entries still know their checkout root');
check(child.count === 2, 'the nested checkout reports its own two changes', String(child.count));
check(child.entries.every((e) => samePath(e._wc, nestedWc)), 'every nested entry is attributed to the nested checkout');
check(list.totalChanges === parent.count + project.count + child.count, 'the total counts every scope');

// ------------------------------------------------------- 3) write routing
console.log('routing (explicit scope outranks the session workspace):');
const projectStatus = await call('status', { sessionId: 'verify', wc: proj });
check(projectStatus.entries.length === 2, 'status with wc: proj returns the project changes');
check(!projectStatus.entries.some((e) => samePath(e.path, path.join(wc, 'a.txt'))), 'status with wc: proj does not leak the rest of the checkout');

const crossWc = await callFails('commit', {
  sessionId: 'verify', wc, message: 'should not cross',
  paths: [path.join(nestedWc, 'n.txt')],
});
check(crossWc.failed === true, 'a cross-working-copy commit is refused');
check(/其他工作副本/.test(crossWc.message || ''), 'the refusal names the other working copy', crossWc.message);

const outsideScope = await callFails('commit', {
  sessionId: 'verify', wc: proj, message: 'outside the scope',
  paths: [path.join(wc, 'a.txt')],
});
check(outsideScope.failed === true, 'a commit outside the selected scope is refused');
check(/不在当前目录范围/.test(outsideScope.message || ''), 'the refusal names the scope', outsideScope.message);

const nestedCommit = await call('commit', {
  sessionId: 'verify', wc: nestedWc, message: 'nested only',
  paths: [path.join(nestedWc, 'n.txt'), path.join(nestedWc, 'nested-new.txt')],
});
check(typeof nestedCommit.revision === 'number' && nestedCommit.revision > 0, 'the nested commit succeeds', String(nestedCommit.revision));
const nestedAfter = await call('status', { sessionId: 'verify', wc: nestedWc });
check(nestedAfter.entries.length === 0, 'the nested checkout is clean after its commit', String(nestedAfter.entries.length));

// commit-all inside the project scope must not touch the rest of the checkout
const projectCommit = await call('commit', { sessionId: 'verify', wc: proj, message: 'project only' });
check(typeof projectCommit.revision === 'number' && projectCommit.revision > 0, 'the project commit succeeds', String(projectCommit.revision));
const projectAfter = await call('status', { sessionId: 'verify', wc: proj });
check(projectAfter.entries.length === 0, 'the project scope is clean after its commit', String(projectAfter.entries.length));
const parentAfter = await call('status', { sessionId: 'verify', wc });
check(parentAfter.entries.some((e) => samePath(e.path, path.join(wc, 'a.txt'))), 'the rest of the checkout is untouched by the project commit');

// ------------------------------------------------------ 4) persistence
console.log('persistence (keyed by the session workspace):');
const callAgain = makeCall();
const reloaded = await callAgain('wcs', { sessionId: 'another-session' });
check(reloaded.wcs.length === 3, 'a fresh plugin instance still sees all scopes', String(reloaded.wcs.length));
check(samePath(reloaded.workspace, wc), 'the list is stored for the session workspace');

// ------------------------------------------------------ 5) removal guard
console.log('watch remove:');
const removedNested = await call('watch', { sessionId: 'verify', action: 'remove', path: nestedWc });
check(removedNested.removed === true, 'a nested checkout can be removed');
const removedProject = await call('watch', { sessionId: 'verify', action: 'remove', path: proj });
check(removedProject.removed === true, 'a project scope can be removed');
const lastOne = await callFails('watch', { sessionId: 'verify', action: 'remove', path: wc });
check(lastOne.failed === true && /至少保留一个目录/.test(lastOne.message || ''),
  'the last directory cannot be removed', lastOne.message);

// ------------------------------------------------------------ teardown
try {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  for (const workspace of [wc, proj]) {
    const key = createHash('sha1').update(path.resolve(workspace).toLowerCase()).digest('hex');
    const file = path.join(base, 'dsh-svn-tools', 'watched', `${key}.json`);
    if (existsSync(file)) unlinkSync(file);
  }
} catch { /* best effort */ }
try {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
} catch {
  console.warn('  warn  could not remove the temporary fixture: ' + root);
}

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL MULTI-WORKING-COPY CHECKS PASSED');
