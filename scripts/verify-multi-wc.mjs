/**
 * Regression check for multi / nested working copies (issue #4).
 *
 * What it pins down:
 *   1. `wcs` lists every watched working copy with its own info + status, and a
 *      nested checkout is NOT reported as an unversioned change of its parent;
 *   2. `watch add` normalises a path to its working-copy root and the list
 *      survives a fresh plugin instance (it is keyed by the session workspace,
 *      not by a checkout);
 *   3. writes route to the selected working copy: `status`/`commit` with
 *      `wc: <nested>` act on the nested checkout only, and the parent's changes
 *      stay untouched;
 *   4. a commit that mixes working copies is refused with a readable message
 *      instead of half-committing;
 *   5. the last remaining working copy cannot be removed.
 *
 * Usage:  node scripts/verify-multi-wc.mjs
 * Exit code 0 = all checks passed, 2 = prerequisites (svn/svnadmin) missing.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
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
const nestedWc = path.join(wc, 'nested');

function makeRepo(repo, name, file) {
  run(SVNADMIN, ['create', repo]);
  const url = fileUrl(repo);
  run(SVN, ['mkdir', `${url}/trunk`, '-m', 'init', '--non-interactive']);
  return `${url}/trunk`;
}

const mainUrl = makeRepo(mainRepo, 'main', 'a.txt');
run(SVN, ['checkout', mainUrl, wc, '--non-interactive']);
writeFileSync(path.join(wc, 'a.txt'), 'line1\n');
run(SVN, ['add', path.join(wc, 'a.txt'), '--non-interactive']);
run(SVN, ['commit', wc, '-m', 'add a', '--non-interactive']);

// A second, independent repository checked out INSIDE the first working copy:
// that is the Unity layout the issue describes (not svn:externals).
const nestedUrl = makeRepo(nestedRepo, 'nested', 'n.txt');
run(SVN, ['checkout', nestedUrl, nestedWc, '--non-interactive']);
writeFileSync(path.join(nestedWc, 'n.txt'), 'n1\n');
run(SVN, ['add', path.join(nestedWc, 'n.txt'), '--non-interactive']);
run(SVN, ['commit', nestedWc, '-m', 'add n', '--non-interactive']);

// Local changes on both sides.
appendFileSync(path.join(wc, 'a.txt'), 'line2\n');
writeFileSync(path.join(wc, 'root-new.txt'), 'new\n');
appendFileSync(path.join(nestedWc, 'n.txt'), 'n2\n');
writeFileSync(path.join(nestedWc, 'nested-new.txt'), 'new\n');

console.log('working copy: ' + wc);
console.log('nested:       ' + nestedWc);

// ------------------------------------------------------------ tool harness
function makeCall() {
  let handler;
  const ctx = {
    tools: { register() {} },
    webServer: { register(o) { handler = o.handler; } },
    sessions: { get: () => ({ header: { cwd: wc } }) },
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

// ------------------------------------------------------ 1) initial listing
console.log('single working copy (seeded from the session workspace):');
const seeded = await call('wcs', { sessionId: 'verify' });
check(seeded.wcs.length === 1, 'one working copy is followed before anything is added', String(seeded.wcs.length));
check(samePath(seeded.wcs[0].path, wc), 'the session checkout is the seeded entry');
check(seeded.wcs[0].entries.some((e) => samePath(e.path, path.join(wc, 'root-new.txt'))), 'the unversioned root file is listed');
check(!seeded.wcs[0].entries.some((e) => samePath(e.path, nestedWc)),
  'the nested checkout is not listed as a change of its parent');

// --------------------------------------------------------- 2) watch add
console.log('watch add (normalised to the working-copy root):');
const added = await call('watch', { sessionId: 'verify', action: 'add', path: path.join(wc, 'nested', 'n.txt') });
check(added.added === true, 'add reports success');
check(samePath(added.path, nestedWc), 'a file inside a checkout is normalised to that checkout', added.path);
const again = await call('watch', { sessionId: 'verify', action: 'add', path: nestedWc });
check(again.added === false && again.reason === 'already-watched', 'adding the same working copy twice is a no-op');

const list = await call('wcs', { sessionId: 'verify' });
check(list.wcs.length === 2, 'both working copies are listed');
const parent = list.wcs.find((w) => samePath(w.path, wc));
const child = list.wcs.find((w) => samePath(w.path, nestedWc));
check(parent !== undefined && child !== undefined, 'the list carries both roots');
check(child.count === 2, 'the nested checkout reports its own two changes', String(child.count));
check(child.entries.every((e) => samePath(e._wc, nestedWc)), 'every nested entry is attributed to the nested checkout');
check(parent.entries.every((e) => samePath(e._wc, wc)), 'every parent entry is attributed to the parent');
check(list.totalChanges === parent.count + child.count, 'the total counts both working copies');

// ------------------------------------------------------- 3) write routing
console.log('routing (explicit wc outranks the session workspace):');
const childStatus = await call('status', { sessionId: 'verify', wc: nestedWc });
check(childStatus.entries.length === 2, 'status with wc: nested returns the nested changes');
check(!childStatus.entries.some((e) => samePath(e.path, path.join(wc, 'a.txt'))), 'status with wc: nested does not leak the parent tree');

const foreign = await callFails('commit', {
  sessionId: 'verify', wc, message: 'should not cross',
  paths: [path.join(nestedWc, 'n.txt')],
});
check(foreign.failed === true, 'a cross-working-copy commit is refused');
check(/其他工作副本/.test(foreign.message || ''), 'the refusal names the problem', foreign.message);

const committed = await call('commit', {
  sessionId: 'verify', wc: nestedWc, message: 'nested only',
  paths: [path.join(nestedWc, 'n.txt'), path.join(nestedWc, 'nested-new.txt')],
});
check(typeof committed.revision === 'number' && committed.revision > 0, 'the nested commit succeeds', String(committed.revision));
const childAfter = await call('status', { sessionId: 'verify', wc: nestedWc });
check(childAfter.entries.length === 0, 'the nested checkout is clean after its commit', String(childAfter.entries.length));
const parentAfter = await call('status', { sessionId: 'verify', wc });
check(parentAfter.entries.some((e) => samePath(e.path, path.join(wc, 'a.txt'))), 'the parent checkout is untouched by the nested commit');

// ------------------------------------------------------ 4) persistence
console.log('persistence (keyed by the session workspace):');
const callAgain = makeCall();
const reloaded = await callAgain('wcs', { sessionId: 'another-session' });
check(reloaded.wcs.length === 2, 'a fresh plugin instance still sees both working copies', String(reloaded.wcs.length));
check(samePath(reloaded.workspace, wc), 'the list is stored for the session workspace');

// ------------------------------------------------------ 5) removal guard
console.log('watch remove:');
const removed = await call('watch', { sessionId: 'verify', action: 'remove', path: nestedWc });
check(removed.removed === true, 'the nested working copy can be removed');
const lastOne = await callFails('watch', { sessionId: 'verify', action: 'remove', path: wc });
check(lastOne.failed === true && /至少保留一个工作副本/.test(lastOne.message || ''),
  'the last working copy cannot be removed', lastOne.message);

// ------------------------------------------------------------ teardown
try {
  const key = createHash('sha1').update(path.resolve(wc).toLowerCase()).digest('hex');
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const file = path.join(base, 'dsh-svn-tools', 'watched', `${key}.json`);
  if (existsSync(file)) unlinkSync(file);
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
