/**
 * Check the package against everything the plugin market's CI checks.
 *
 * The catalog's gate is mechanical, so it can be run here instead of after a
 * pull request: the `dsh.bundle` manifest has to exist (declaring only
 * `dsh.client` is the single most common reason a submission is rejected), the
 * bundle patch has to insert an entry whose package name resolves, the
 * repository coordinates have to be filled in, and the published files have to
 * be the real ones.
 *
 *   npm run release:check
 *
 * It cannot check the one thing that needs the network — that the repository is
 * at least a day old — and it will not pretend to.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function ok(condition, message) {
  if (condition) {
    process.stdout.write(`ok    ${message}\n`);
    return true;
  }
  problems.push(message);
  process.stdout.write(`FAIL  ${message}\n`);
  return false;
}

function note(message) {
  notes.push(message);
  process.stdout.write(`note  ${message}\n`);
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// --- the manifest the catalog installs from -------------------------------
ok(typeof manifest.name === 'string' && manifest.name !== '', 'package.json has a name');
ok(manifest.private !== true, 'package.json is not private (it has to be installable)');
ok(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version), 'version looks published');
ok(manifest.type === 'module', 'package is ESM');

const bundle = manifest.dsh?.bundle;
ok(bundle !== undefined, 'dsh.bundle is declared (dsh.client alone is not installable)');
if (bundle !== undefined) {
  const patchPath = join(root, String(bundle.patch ?? '').replace(/^\.\//, ''));
  if (ok(existsSync(patchPath), `dsh.bundle.patch exists (${bundle.patch})`)) {
    const patch = readFileSync(patchPath, 'utf8');
    ok(patch.includes(manifest.name), `cordis.patch.yml inserts ${manifest.name}`);
    ok(/-\s*insert:/.test(patch), 'cordis.patch.yml uses an insert list');
    // An entry name may be YAML-quoted, and a scoped package name (`@scope/name`)
    // *must* be: `@` is a reserved indicator at the start of a scalar. Compare
    // the unquoted value, or a correctly quoted entry reads as a mismatch.
    const nameLine = patch.match(/^[ \t]*name:[ \t]*['"]?([^'"\s#]+)['"]?[ \t]*$/m);
    ok(
      nameLine === null || nameLine[1] === manifest.name,
      'the patched entry name matches the package name',
    );

    // This file decides whether the plugin loads at all, and every way it can be
    // wrong is silent: a tab in the indentation (YAML forbids them) or a key at
    // the wrong depth makes the document unparseable, the loader drops the
    // insert without a word, and the plugin simply never appears. No error, no
    // entry, nothing to look at. Both of those shipped once and cost several
    // restarts to find, so they are checked mechanically here.
    if (ok(!/\t/.test(patch), 'cordis.patch.yml contains no tab characters (YAML forbids tab indentation)')) {
      const lines = patch.split(/\r?\n/);
      const insertAt = lines.findIndex(line => /^-\s*insert:\s*$/.test(line));
      const entryAt = lines.findIndex((line, index) => index > insertAt && /^\s*-\s*id:\s*\S/.test(line));
      if (ok(insertAt >= 0, 'cordis.patch.yml has a top-level insert list')) {
        if (ok(entryAt > insertAt, 'the insert list contains an entry')) {
          const entryIndent = lines[entryAt].match(/^\s*/)[0].length;
          for (let index = entryAt + 1; index < lines.length; index += 1) {
            const line = lines[index];
            if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
            const indent = line.match(/^\s*/)[0].length;
            // Back at or above the entry's own indent means the entry ended; the
            // walk is over. Anything deeper belongs to this entry and must not
            // start with a tab — already handled above, but the depth matters
            // because `config:` with no children is a different document.
            if (indent <= entryIndent) break;
            if (/^\s*config:\s*$/.test(line)) {
              const next = lines.slice(index + 1).find(l => l.trim() !== '' && !l.trimStart().startsWith('#'));
              if (next !== undefined && next.match(/^\s*/)[0].length <= indent) {
                problems.push('cordis.patch.yml: `config:` has no children (the keys after it are siblings, not settings)');
              }
            }
          }
        }
      }
    }
  }
}

// --- the repository coordinates -------------------------------------------
const repositoryUrl = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
ok(typeof repositoryUrl === 'string' && repositoryUrl !== '', 'repository is declared');
if (typeof repositoryUrl === 'string') {
  ok(!repositoryUrl.includes('OWNER'), 'repository no longer contains the OWNER placeholder');
  ok(
    repositoryUrl.replace(/^git\+/, '').startsWith('https://github.com/'),
    'repository is a GitHub https URL (that is what the catalog reads)',
  );
  const home = String(manifest.homepage ?? '');
  if (home.includes('OWNER')) problems.push('homepage still contains the OWNER placeholder');
  const bugs = String(manifest.bugs?.url ?? manifest.bugs ?? '');
  if (bugs.includes('OWNER')) problems.push('bugs still contains the OWNER placeholder');
}
if (readFileSync(join(root, 'README.md'), 'utf8').includes('OWNER')) {
  problems.push('README.md still contains the OWNER placeholder');
}

// The account name is repeated in four places — package.json, the catalog entry
// filename, the entry's own `url`, and the submission guide's copy-pasteable
// commands. Only the first is generated; the guide is prose, so a single wrong
// digit there turns into a push against somebody else's repository. Comparing
// all four against package.json is the cheapest way to catch that.
const slug = typeof repositoryUrl === 'string' ? repositoryUrl.replace(/^git\+/, '').replace(/\.git$/, '') : '';
// Repositories these documents are *supposed* to reference: the catalog they are
// submitted to and the harness whose API they depend on. Anything else is a
// mistake, but a legitimate upstream link is not.
const UPSTREAM = new Set([
  'https://github.com/awesome-dsh-plugin/awesome-dsh-plugin',
  'https://github.com/awesome-dsh-plugin/dsh-find-plugin',
  'https://github.com/deepseek-ai/deepseek-harness',
  'https://github.com/dsh-market/dsh-market',
]);
// A repository URL is written both ways in prose — `git remote add origin
// https://github.com/me/repo.git` and a plain browse link — and the two are the
// same repository. Comparing the raw text flagged the `.git` form of a URL that
// was already allowed, which is a false alarm that hides the real mistakes this
// check exists to catch. Normalize before comparing, both sides.
const canonical = url => url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
// The catalog's fork is a link this document is *supposed* to contain: the guide
// tells the reader to push there. Derived from our own slug so it follows an
// `--owner` change instead of naming an account.
const forkOfCatalog = canonical(slug).replace(/\/([^/]+)$/, '/awesome-dsh-plugin');
const ALLOWED = new Set([
  canonical(slug),
  forkOfCatalog,
  ...[...UPSTREAM].map(canonical),
]);
for (const guide of ['release/HOW-TO-SUBMIT.md', 'README.md']) {
  const guidePath = join(root, guide);
  if (!existsSync(guidePath)) continue;
  const text = readFileSync(guidePath, 'utf8');
  const linked = text.match(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/g) ?? [];
  const strangers = [...new Set(linked.map(canonical))].filter(url => !ALLOWED.has(url));
  if (strangers.length > 0) {
    problems.push(`${guide} links a repository that is neither ours nor a known upstream: ${strangers.join(', ')}`);
  }
}

if (existsSync(join(root, 'release', 'awesome-dsh-plugin'))) {
  const entries = readdirSync(join(root, 'release', 'awesome-dsh-plugin'));
  // `owner__repo.yml`, the name the catalog's CI expects.
  const expectedEntry = `${slug.replace('https://github.com/', '').replace('/', '__')}.yml`;
  for (const entry of entries) {
    const text = readFileSync(join(root, 'release', 'awesome-dsh-plugin', entry), 'utf8');
    if (text.includes('OWNER')) problems.push(`release/awesome-dsh-plugin/${entry} still contains OWNER`);
    if (!text.includes('category: notify')) {
      note(`${entry}: the Notifications & Integrations category key is 'notify'`);
    }
    const entryUrl = text.match(/^url:\s*(\S+)\s*$/m)?.[1];
    if (entryUrl !== undefined && entryUrl !== slug) {
      problems.push(`${entry}: url is ${entryUrl}, but package.json says ${slug}`);
    }
    if (entry !== expectedEntry) {
      problems.push(`${entry}: filename should be ${expectedEntry} to match package.json`);
    }
  }
} else {
  note('no catalog entry yet — run prepare-release.mjs --owner <account>');
}

// --- what actually ships ---------------------------------------------------
const declared = new Set(manifest.files ?? []);
for (const required of ['lib', 'cordis.patch.yml', 'LICENSE']) {
  ok(declared.has(required), `files[] includes ${required}`);
}

const forbidden = ['.js.map', '.ts', '.tgz'];
const shipped = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      walk(full);
      continue;
    }
    shipped.push(relative(root, full).split('\\').join('/'));
  }
}
for (const top of declared) {
  const full = join(root, top);
  if (!existsSync(full)) {
    problems.push(`files[] names ${top}, which does not exist`);
    continue;
  }
  if (statSync(full).isDirectory()) walk(full);
  else shipped.push(top);
}
ok(shipped.length > 0, 'the published file list is not empty');
for (const pattern of forbidden) {
  const found = shipped.filter(file => file.endsWith(pattern));
  if (found.length > 0) problems.push(`published files include ${found.join(', ')}`);
}
note(`ships ${shipped.length} files: ${shipped.join(', ')}`);

// --- runnable --------------------------------------------------------------
const entry = join(root, 'lib', 'index.js');
ok(existsSync(entry), 'lib/index.js exists');
ok(!existsSync(join(root, 'lib', 'types')), 'no build output is claimed that is not there');
ok(existsSync(join(root, 'test')), 'tests are present (the reviewer checks the code, not the README)');

// --- what this script cannot check ----------------------------------------
note('cannot check: the repository being at least 1 day old (catalog CI does)');
note('cannot check: the dsh-plugin topic being set on the repository');
note('remember: publish to npm only after the repository exists, so repository resolves');

process.stdout.write(`\n${problems.length === 0 ? 'ready' : `${problems.length} problem(s)`}\n`);
for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
process.exit(problems.length === 0 ? 0 : 1);
