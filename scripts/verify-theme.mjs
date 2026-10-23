/**
 * Regression check for the panel's theme contract.
 *
 * Two failure modes already shipped once and are pinned here:
 *
 *  1. **Lost scope** (v0.13.8): the local colour variables were declared on
 *     `.dsh-svn` only, but the plugin also renders through two host-owned roots
 *     (`div.dsh-svn-set` for the settings card, `svg.dsh-svn-icon` for the
 *     sidebar tab). Their `var()` references then had no value at all, so the
 *     icon turned black and the settings hairlines vanished. The declaration
 *     must cover all three roots.
 *  2. **Missing optional tokens** (older 0.1.x hosts): `--dsw-radius-*`,
 *     `--dsw-focus-ring-*` and `--dsw-alias-file-diff-*` are not exported by
 *     every host build. A bare `var(--token)` in a shorthand makes the whole
 *     declaration invalid (square corners, no focus ring, untinted diff rows),
 *     so each of those tokens must be read with an inline fallback.
 *
 * It also keeps the "no colour literals" rule and catches typos in the private
 * `--dsh-svn-*` variables by matching every use against the declarations.
 *
 * Usage:  node scripts/verify-theme.mjs
 * Exit code 0 = all checks passed.
 */
import { readFileSync } from 'node:fs';

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail));
  }
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const start = source.indexOf('var CSS = [');
const end = source.indexOf('].join("")', start);
if (start < 0 || end < 0) {
  console.error('cannot locate the CSS block in lib/client.js');
  process.exit(2);
}
const css = source.slice(start, end);

// ------------------------------------------------------- variable scope
const scopeRule = css.match(/\.dsh-svn[^{]*\{--dsh-svn-tone-accent/);
check(scopeRule !== undefined, 'one declaration block owns the local semantic colours');
const scopeSelector = scopeRule === undefined ? '' : scopeRule[0].split('{')[0];
for (const root of ['.dsh-svn', '.dsh-svn-set', '.dsh-svn-icon']) {
  check(scopeSelector.includes(root), 'the local variables are declared on ' + root);
}

// --------------------------------------------- declared vs used variables
const declared = new Set();
for (const m of css.matchAll(/(--dsh-svn-[a-z0-9-]+)\s*:/g)) declared.add(m[1]);
const used = new Set();
for (const m of css.matchAll(/var\(\s*(--dsh-svn-[a-z0-9-]+)/g)) used.add(m[1]);
const undeclared = [...used].filter((name) => !declared.has(name));
check(undeclared.length === 0, 'every --dsh-svn-* reference is declared', undeclared.join(', '));

// ------------------------------------------- optional host tokens + fallback
const optionalTokens = [
  '--dsw-radius-xs', '--dsw-radius-sm', '--dsw-radius-md', '--dsw-radius-lg',
  '--dsw-focus-ring-width', '--dsw-focus-ring-color',
  '--dsw-alias-file-diff-added-bg', '--dsw-alias-file-diff-deleted-bg',
  '--dsw-alias-file-diff-added-marker', '--dsw-alias-file-diff-deleted-marker',
];
let remaining = css;
for (const token of optionalTokens) {
  // Drop every occurrence that carries a fallback (`var(--token, …)`), then the
  // token must not appear any more.
  remaining = remaining.replace(new RegExp(`var\\(\\s*${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`, 'g'), 'var(FALLBACK');
}
const unguarded = optionalTokens.filter((token) => remaining.includes(token));
check(unguarded.length === 0, 'optional host tokens are always read with a fallback', unguarded.join(', '));

// ------------------------------------------------------- no colour literals
const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
check(literals === null, 'the stylesheet contains no colour literals', literals === null ? '' : literals.join(', '));

// ------------------------------------------------------------ icon wiring
check(/\.dsh-svn-icon-bg\{fill:var\(--dsh-svn-tone-icon\)\}/.test(css),
  'the sidebar icon background uses the local icon tone');
check(declared.has('--dsh-svn-tone-icon'), 'the icon tone is declared with the other local colours');
check(/\.dsh-svn-icon-fg\{[^}]*stroke:var\(--dsw-alias-label-primary-foreground\)/.test(css),
  'the sidebar icon glyph uses the theme foreground');

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL THEME CHECKS PASSED');
