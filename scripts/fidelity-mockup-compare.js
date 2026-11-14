#!/usr/bin/env node
'use strict';

// The mockup before and after a change that must not move anything it draws
// (m5-ui-tokens-spacing: the shared stylesheets' and the mockup script's
// literals become tokens; docs/harness/agent-rules.md, "UI fidelity"). It
// measures the mockup with the gate's own collector, on the base commit and
// on this checkout, and compares the two exactly: every part's box and listed
// computed styles, the canvas parts and masks, the window's and every
// region's image, in every locale of app/test/fidelity/manifest.json.
//
//   node scripts/fidelity-mockup-compare.js [--base <ref>] [--out <dir>]
//        [--twice] [--base-from <dir>] [--keep-base]
//
//   --base <ref>       the commit to compare with (default: the merge-base
//                      with origin/main)
//   --out <dir>        where the measurements and compare.md/compare.json go
//                      (default app/test-results/fidelity-mockup)
//   --twice            measure the base twice first and fail unless the two
//                      agree, which proves the measurement deterministic
//   --base-from <dir>  reuse a base measurement written by an earlier run
//                      (its <dir>/base) instead of measuring the base again
//
// The base is checked out with `git worktree add --detach` into a scratch
// directory and removed afterwards. Both runs use this checkout's spec and
// manifest (app/test/e2e/mockup-fidelity.spec.ts, SIANN_FIDELITY_MOCKUP_ONLY=1)
// and open the mockup of the checkout under SIANN_FIDELITY_MOCKUP_ROOT. The
// comparison is compareMockupMeasurements (app/test/e2e/support/
// fidelity-core.ts), from the app's build: run `npm run build` in app first.
// Exits 1 on any difference.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const CORE = path.join(APP, 'dist', 'test', 'e2e', 'support', 'fidelity-core.js');
const isWindows = process.platform === 'win32';

function option(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function git(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

// One measurement of the mockup of the checkout at `root`, into `out`.
function measure(root, out) {
  fs.rmSync(out, { recursive: true, force: true });
  const env = {
    ...process.env,
    SIANN_FIDELITY: '1',
    SIANN_FIDELITY_MOCKUP_ONLY: '1',
    SIANN_FIDELITY_MOCKUP_ROOT: root,
    SIANN_FIDELITY_OUT: out,
  };
  const args = ['playwright', 'test', '--project', 'fidelity'];
  const result = isWindows
    ? spawnSync('cmd.exe', ['/d', '/c', 'npx', ...args], { cwd: APP, env, encoding: 'utf8', windowsHide: true })
    : spawnSync('npx', args, { cwd: APP, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`measuring the mockup of ${root} failed:\n${result.stdout}\n${result.stderr}`);
  return out;
}

// A measurement as compareMockupMeasurements takes it, per locale.
function load(core, dir, manifest) {
  const out = {};
  for (const locale of Object.keys(manifest.locales)) {
    const at = path.join(dir, locale);
    const json = JSON.parse(fs.readFileSync(path.join(at, 'mockup-parts.json'), 'utf8'));
    const images = { window: core.decodePng(fs.readFileSync(path.join(at, 'mockup.png'))) };
    for (const region of manifest.regions) images[region] = core.decodePng(fs.readFileSync(path.join(at, `${region}.mockup.png`)));
    out[locale] = { parts: json.parts, masks: json.masks, images };
  }
  return out;
}

function compare(core, before, after) {
  const result = {};
  for (const locale of Object.keys(before)) {
    const a = before[locale];
    const b = after[locale];
    result[locale] = {
      parts: a.parts.length,
      styles: a.parts.filter((part) => part.styles).length,
      masks: a.masks.length,
      images: Object.keys(a.images).length,
      differences: b ? core.compareMockupMeasurements(a, b) : [{ kind: 'part', id: '*', detail: `no measurement of ${locale} after` }],
    };
  }
  return result;
}

function markdown(title, rows) {
  const lines = [`# ${title}`, ''];
  for (const row of rows) {
    lines.push(`## ${row.name}`, '', `- before: ${row.before}`, `- after: ${row.after}`, '');
    lines.push('| Locale | Parts (with styles) | Canvas masks | Images | Differences |', '|---|---|---|---|---|');
    for (const [locale, r] of Object.entries(row.result)) lines.push(`| ${locale} | ${r.parts} (${r.styles}) | ${r.masks} | ${r.images} | ${r.differences.length} |`);
    lines.push('');
    const all = Object.entries(row.result).flatMap(([locale, r]) => r.differences.map((d) => ({ locale, ...d })));
    if (all.length === 0) lines.push('Identical: equal boxes, equal style strings, equal masks, byte-equal decoded images.', '');
    else {
      lines.push('| Locale | Kind | Id | Detail |', '|---|---|---|---|');
      for (const d of all.slice(0, 200)) lines.push(`| ${d.locale} | ${d.kind} | \`${d.id}\` | ${d.detail.replace(/\|/g, '\\|')} |`);
      if (all.length > 200) lines.push('', `… and ${all.length - 200} more (compare.json).`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  if (!fs.existsSync(CORE)) {
    console.error(`${path.relative(ROOT, CORE)} is missing: run npm run build in app first`);
    return 2;
  }
  const core = require(CORE);
  const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'test', 'fidelity', 'manifest.json'), 'utf8'));
  const out = path.resolve(option(argv, '--out') || path.join(APP, 'test-results', 'fidelity-mockup'));
  const baseRef = option(argv, '--base') || git(['merge-base', 'origin/main', 'HEAD']);
  const baseCommit = git(['rev-parse', '--short', baseRef]);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--', 'app/renderer', 'docs/superpowers/specs/2026-11-13-siann-ui-redesign']) !== '';
  const branchLabel = `this checkout (${head}${dirty ? ' with uncommitted changes' : ''})`;
  fs.mkdirSync(out, { recursive: true });

  const reuse = option(argv, '--base-from');
  const rows = [];
  let baseDir = path.join(out, 'base');
  if (reuse) {
    baseDir = path.join(path.resolve(reuse), 'base');
    if (!fs.existsSync(baseDir)) throw new Error(`${baseDir} is missing`);
  } else {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'siann-mockup-base-'));
    const tree = path.join(scratch, 'base');
    git(['worktree', 'add', '--detach', tree, baseRef]);
    try {
      measure(tree, baseDir);
      if (argv.includes('--twice')) {
        const again = measure(tree, path.join(out, 'base-again'));
        rows.push({ name: 'The base against itself (determinism)', before: `${baseCommit}, run 1`, after: `${baseCommit}, run 2`, result: compare(core, load(core, baseDir, manifest), load(core, again, manifest)) });
      }
    } finally {
      git(['worktree', 'remove', '--force', tree]);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  const branchDir = measure(ROOT, path.join(out, 'branch'));
  rows.push({ name: 'The base against the branch', before: `base ${baseCommit}`, after: branchLabel, result: compare(core, load(core, baseDir, manifest), load(core, branchDir, manifest)) });

  const report = { generated: new Date().toISOString(), base: baseCommit, head, dirty, platform: `${process.platform} ${os.release()}`, rows };
  fs.writeFileSync(path.join(out, 'compare.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'compare.md'), markdown(`The mockup before and after (${process.platform})`, rows));
  const differences = rows.reduce((n, row) => n + Object.values(row.result).reduce((m, r) => m + r.differences.length, 0), 0);
  console.log(`${differences === 0 ? 'identical' : `${differences} differences`}: ${path.join(out, 'compare.md')}`);
  return differences === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { markdown };
