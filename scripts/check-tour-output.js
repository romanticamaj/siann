#!/usr/bin/env node
'use strict';

// Checks the UX tour's output after the nightly tour job's runs of
// app/test/e2e/ux-tour.spec.ts (m5b-nightly-quality, acceptance item 1): each
// locale folder <root>/<locale>/ has an index.json listing the states, every
// captured state's PNG is there and not empty, and every locale captured the
// same states. A state with `file: null` is one the window has no surface for
// (noted, not captured) and needs no PNG.
//
//   node scripts/check-tour-output.js <root> [--locales en,zh-Hant,zh-Hans]
//
// Exits 1 with one line per problem.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCALES = ['en', 'zh-Hant', 'zh-Hans'];

function readIndex(dir, locale, errors) {
  const file = path.join(dir, 'index.json');
  if (!fs.existsSync(file)) {
    errors.push(`${locale}: no index.json in ${dir}`);
    return null;
  }
  let shots;
  try {
    shots = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${locale}: index.json is not JSON (${error.message})`);
    return null;
  }
  const valid = Array.isArray(shots) && shots.every((s) => s && typeof s.state === 'string'
    && (s.file === null || typeof s.file === 'string'));
  if (!valid) {
    errors.push(`${locale}: index.json is not a list of {file, state, notes}`);
    return null;
  }
  if (shots.length === 0) {
    errors.push(`${locale}: index.json lists no state`);
    return null;
  }
  return shots;
}

function checkTourOutput(root, locales = DEFAULT_LOCALES) {
  const errors = [];
  const states = new Map();
  let captured = null;
  for (const locale of locales) {
    const dir = path.join(root, locale);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      errors.push(`${locale}: no folder ${dir}`);
      continue;
    }
    const shots = readIndex(dir, locale, errors);
    if (!shots) continue;
    for (const shot of shots) {
      if (shot.file === null) continue;
      const png = path.join(dir, shot.file);
      if (!fs.existsSync(png)) errors.push(`${locale}: ${shot.file} ("${shot.state}") is missing`);
      else if (fs.statSync(png).size === 0) errors.push(`${locale}: ${shot.file} ("${shot.state}") is empty`);
    }
    states.set(locale, shots.map((s) => s.state));
    const count = shots.filter((s) => s.file !== null).length;
    if (captured === null) captured = count;
  }
  // Every locale against the first one that has an index.
  const [first] = states.keys();
  if (first !== undefined) {
    const reference = states.get(first);
    for (const [locale, list] of states) {
      if (locale === first) continue;
      for (const state of reference) if (!list.includes(state)) errors.push(`${locale}: no state "${state}" (${first} has it)`);
      for (const state of list) if (!reference.includes(state)) errors.push(`${locale}: state "${state}" that ${first} does not have`);
      if (list.join('\n') !== reference.join('\n') && list.length === reference.length
        && list.every((s) => reference.includes(s))) {
        errors.push(`${locale}: the states are in another order than ${first}'s`);
      }
    }
  }
  return { errors, captured: captured ?? 0, locales: [...states.keys()] };
}

function main(argv) {
  const args = [...argv];
  let locales = DEFAULT_LOCALES;
  const at = args.indexOf('--locales');
  if (at >= 0) {
    locales = (args[at + 1] ?? '').split(',').filter(Boolean);
    args.splice(at, 2);
  }
  const [root] = args;
  if (!root || locales.length === 0) {
    console.error('usage: node scripts/check-tour-output.js <root> [--locales en,zh-Hant,zh-Hans]');
    return 2;
  }
  const result = checkTourOutput(path.resolve(root), locales);
  for (const error of result.errors) console.error(error);
  if (result.errors.length > 0) return 1;
  console.log(`UX tour: ${result.captured} states captured in each of ${result.locales.join(', ')}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { checkTourOutput, DEFAULT_LOCALES };
