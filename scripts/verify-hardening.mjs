/**
 * Regression check for the hardening fixes found by the 2026-10 code audit.
 *
 * These are the pure parts of the fixes, so they need neither a working copy
 * nor a browser:
 *   1. `resolveTargetAbs` must pass repository URLs through untouched — the
 *      defect was that `svn://host/repo` was resolved against the workspace
 *      into `C:\…\svn:\host\repo`, breaking svn_list / svn_cat / svn_export /
 *      svn_copy / svn_move / svn_mkdir for every URL;
 *   2. `positionalArg` must refuse operands that svn's getopt would read as
 *      OPTIONS (`svn propget --version …` is accepted as an option by svn
 *      itself, so a caller-supplied `--config-dir=` could execute commands via
 *      diff-cmd/editor-cmd);
 *   3. `prepareForCommit` reports the new `failed` list, so a repair that did
 *      not happen is never reported as done;
 *   4. the plugin must stay activatable across DSH generations: its `inject`
 *      may not name `webRuntime` (removed in 0.2.x — a missing service stops
 *      cordis from ever activating the plugin), and the request fence must
 *      prefer 0.2.x's `connection.requestRejection` while still working on
 *      0.1.x's `webRuntime.trustedHosts`.
 *
 * Usage:  node scripts/verify-hardening.mjs
 * Exit code 0 = all checks passed.
 */
import { __test, apply, inject } from '../lib/index.js';

const { resolveTargetAbs, positionalArg, prepareForCommit, requestRejection } = __test;

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else { failures++; console.error('  FAIL ' + label + (detail ? ` — ${detail}` : '')); }
}
function throws(fn) {
  try { fn(); return null; } catch (error) { return error; }
}

const cwd = process.platform === 'win32' ? 'C:\\work\\proj' : '/work/proj';

// ---------------------------------------------------------- 1) URL passthrough
console.log('repository URLs are never resolved as filesystem paths:');
for (const url of [
  'svn://svn.example.com/repo/trunk',
  'svn+ssh://user@host/repo/trunk',
  'http://host/svn/repo',
  'https://host/svn/repo',
  'file:///C:/repo/trunk',
]) {
  check(resolveTargetAbs(url, cwd) === url, `passthrough ${url}`, resolveTargetAbs(url, cwd));
}
console.log('local paths still resolve as before:');
const abs = process.platform === 'win32' ? 'C:\\other\\file.txt' : '/other/file.txt';
check(resolveTargetAbs(abs, cwd) === abs, 'an absolute path passes through');
check(resolveTargetAbs('sub/file.txt', cwd) === (process.platform === 'win32' ? 'C:\\work\\proj\\sub\\file.txt' : '/work/proj/sub/file.txt'), 'a relative path resolves against the base');
check(resolveTargetAbs(undefined, cwd) === cwd, 'a missing value falls back to the base');
check(resolveTargetAbs('svn://host/repo', undefined) === 'svn://host/repo', 'a URL survives a missing base');
// The bug shape: never a Windows path that embeds the URL.
check(!resolveTargetAbs('svn://svn.svnbucket.com/smtc/x', cwd).includes('svn:\\'), 'the URL is not folded into a windows path');

// --------------------------------------------------- 2) option-injection guard
console.log('positional operands that look like svn options are refused:');
for (const bad of ['--config-dir=C:\\evil', '-R', '--targets=C:\\evil.txt', '-', '--diff-cmd=calc']) {
  const error = throws(() => positionalArg(bad, 'name'));
  check(error !== null, `refused ${JSON.stringify(bad)}`, 'accepted');
  if (error !== null) check(error.status === 400, `  …with a 400 (${JSON.stringify(bad)})`, String(error.status));
}
console.log('legitimate operands still pass:');
for (const good of ['svn:ignore', 'svn://host/repo/trunk', 'trunk', 'branches/feat-1', 'a/b/c.txt']) {
  check(positionalArg(good, 'source') === good, `accepted ${JSON.stringify(good)}`);
}
const missing = throws(() => positionalArg('', 'url'));
check(missing !== null && /required/.test(missing.message), 'an empty operand reports "required"');

// ------------------------------------------------- 3) commit-repair reporting
console.log('prepareForCommit reports the new failure channel:');
// No working copy here: the status probe fails per directory and the paths are
// treated as unversioned/missing, which is enough to assert the RESULT SHAPE —
// the behaviour against a real working copy lives in verify-settings-host.mjs.
const prepared = await prepareForCommit(cwd, []);
check(Array.isArray(prepared.added), 'added is an array');
check(Array.isArray(prepared.deleted), 'deleted is an array');
check(Array.isArray(prepared.skipped), 'skipped is an array');
check(Array.isArray(prepared.failed), 'failed is an array (a repair that did not happen is never reported as done)');

// ------------------------------- 4) activation and the cross-generation fence
console.log('inject stays compatible with both DSH generations:');
check(Array.isArray(inject), 'inject is exported as an array');
check(!inject.includes('webRuntime'), 'inject does not name webRuntime (removed in DSH 0.2.x — a missing service disables the plugin)');
for (const svc of ['tools', 'webServer', 'sessions', 'agents', 'llm']) {
  check(inject.includes(svc), `inject still requires ${svc}`);
}

// A 0.2.x-shaped composition: everything the plugin injects, plus the
// `connection` service, and NO `webRuntime`. Before the fix this was the exact
// shape that left the plugin permanently inactive after a DSH update.
console.log('the plugin activates on a 0.2.x service set (no webRuntime):');
{
  const registered = [];
  const routes = [];
  const ctx = {
    tools: { register: (def) => registered.push(def?.name) },
    webServer: { register: (options) => { routes.push(options); return () => {}; } },
    sessions: { get: () => ({ header: { cwd: process.cwd() } }) },
    agents: {},
    llm: {},
    connection: { requestRejection: () => undefined },
    effect: (fn) => (typeof fn === 'function' ? fn() : () => {}),
    inject: (_deps, cb) => { cb(ctx); return () => {}; },
  };
  await apply(ctx, {});
  check(registered.length === 33, 'registers all 33 agent tools without webRuntime', String(registered.length));
  check(routes.some((r) => r.path === '/svn/api' && r.kind === 'prefix'), 'mounts the /svn/api route');
}

console.log('request authorisation follows the running DSH generation:');
const loopbackReq = { headers: { host: '127.0.0.1:9870' } };
const crossSiteReq = { headers: { host: '127.0.0.1:9870', 'sec-fetch-site': 'cross-site' } };
// 0.2.x: the composition's connection service answers (403/401 or undefined).
check(requestRejection({ connection: { requestRejection: () => 403 } }, loopbackReq) === 403,
  'connection.requestRejection(403) is honoured');
check(requestRejection({ connection: { requestRejection: () => 401 } }, loopbackReq) === 401,
  'connection.requestRejection(401) is honoured');
check(requestRejection({ connection: { requestRejection: () => undefined } }, crossSiteReq) === undefined,
  'the connection service is authoritative when it allows the request');
// 0.1.x: no connection service, so the local fence runs with trustedHosts.
check(requestRejection({ webRuntime: { trustedHosts: [] } }, loopbackReq) === undefined,
  '0.1.x: a loopback request passes the local fence');
check(requestRejection({ webRuntime: { trustedHosts: [] } }, crossSiteReq) === 403,
  '0.1.x: a cross-site request is refused by the local fence');
check(requestRejection({}, loopbackReq) === undefined,
  'fail-open only for loopback when neither service exists (our own machine)');
check(requestRejection({}, { headers: { host: 'example.com' } }) === 403,
  'fail closed for a remote authority when neither service exists');

// The guard that broke the panel: cordis throws on `ctx.<name>` (and therefore
// on `Reflect.get(ctx, '<name>')`) for a service the plugin did not inject —
// "cannot get property X without inject". The route answered with a bare
// HTTP 400 and an empty body. `ctx.get(name, false)` is the escape hatch.
console.log('a cordis-like context (property access throws without inject):');
{
  const cordisLike = (services) => {
    const target = { get: (name, strict = true) => services[name] };
    return new Proxy(target, {
      get(inner, prop) {
        if (prop in inner) return inner[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    });
  };
  const withConnection = cordisLike({ connection: { requestRejection: () => 403 } });
  check(throws(() => withConnection.connection) !== null, 'the stand-in really throws on property access');
  check(throws(() => requestRejection(withConnection, loopbackReq)) === null,
    'requestRejection never throws on such a context');
  check(requestRejection(withConnection, loopbackReq) === 403, 'it still honours connection.requestRejection');
  const withoutConnection = cordisLike({ webRuntime: { trustedHosts: [] } });
  check(requestRejection(withoutConnection, crossSiteReq) === 403,
    'it falls back to the local fence when connection is absent');
  check(requestRejection(cordisLike({}), { headers: { host: 'example.com' } }) === 403,
    'and still refuses a remote authority with no services at all');
}
console.log('a throwing connection service does not break the route:');
{
  const broken = { connection: { requestRejection: () => { throw new Error('boom'); } } };
  check(throws(() => requestRejection(broken, crossSiteReq)) === null,
    'requestRejection swallows the service failure');
  check(requestRejection(broken, crossSiteReq) === 403,
    'and answers through the local fence (cross-site is still refused)');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nALL HARDENING CHECKS PASSED');
