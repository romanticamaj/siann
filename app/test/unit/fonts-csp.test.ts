// Bundled fonts and the CSP (m5-ui-shell; UI redesign spec 1.3 and 5.7):
// Inter and JetBrains Mono ship as .woff2 files in app/renderer/fonts with
// their OFL texts beside them, every @font-face in the renderer's CSS loads
// a relative URL, and the page's CSP allows fonts from 'self' only and no
// remote source for fonts, styles or the default. No stylesheet is imported
// or linked from another origin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// dist/test/unit -> app/renderer
const STATIC = path.resolve(__dirname, '..', '..', '..', 'renderer');
const FONTS = path.join(STATIC, 'fonts');

function cssFiles(): string[] {
  return fs
    .readdirSync(STATIC)
    .filter((f) => f.endsWith('.css'))
    .map((f) => path.join(STATIC, f));
}

test('Inter and JetBrains Mono are .woff2 files with their OFL texts beside them', () => {
  const files = fs.readdirSync(FONTS);
  for (const family of ['Inter', 'JetBrainsMono']) {
    const fonts = files.filter((f) => f.startsWith(family) && f.endsWith('.woff2'));
    assert.ok(fonts.length > 0, `${family} .woff2 in ${FONTS}`);
    for (const font of fonts) {
      const bytes = fs.readFileSync(path.join(FONTS, font));
      assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2', `${font} is WOFF2`);
    }
    const licence = files.find((f) => f.startsWith(family) && /OFL\.txt$/.test(f));
    assert.ok(licence, `${family} OFL text`);
    assert.match(fs.readFileSync(path.join(FONTS, licence), 'utf8'), /SIL Open Font License,\s+Version 1\.1/);
  }
});

test('every @font-face url() is relative and names a bundled file', () => {
  const faces: string[] = [];
  for (const file of cssFiles()) {
    const css = fs.readFileSync(file, 'utf8');
    for (const face of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
      for (const match of face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
        const url = match[1]!;
        faces.push(url);
        assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//') && !url.startsWith('/'), `${url} is relative`);
        assert.ok(fs.existsSync(path.resolve(STATIC, url)), `${url} exists`);
      }
    }
  }
  for (const family of ['InterVariable', 'JetBrainsMono']) {
    assert.ok(faces.some((u) => u.includes(family)), `an @font-face loads ${family}`);
  }
});

test('the CSP allows fonts from self only and no remote font, style or default source', () => {
  const html = fs.readFileSync(path.join(STATIC, 'index.html'), 'utf8');
  const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html);
  assert.ok(meta, 'a CSP meta element');
  const directives = new Map<string, string[]>();
  for (const part of meta[1]!.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) directives.set(name, values);
  }
  assert.deepEqual(directives.get('font-src'), ["'self'"]);
  assert.deepEqual(directives.get('worker-src'), ["'self'"]);
  for (const name of ['font-src', 'style-src', 'default-src']) {
    const values = directives.get(name) ?? [];
    assert.ok(values.length > 0, `${name} is set`);
    assert.deepEqual(values.filter((v) => /^(https?:|\*|data:|blob:)/i.test(v) || v.includes('.')), [], name);
  }
  // No inline <style> block: the CSS lives in files.
  assert.doesNotMatch(html, /<style[\s>]/i);
  for (const href of html.matchAll(/<link[^>]+href="([^"]+)"/gi)) {
    assert.ok(!/^(https?:)?\/\//i.test(href[1]!), `${href[1]} is local`);
  }
  for (const file of cssFiles()) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /@import/, path.basename(file));
  }
  assert.ok(cssFiles().some((f) => f.endsWith('tokens.css')) && cssFiles().some((f) => f.endsWith('shell.css')));
  for (const css of ['tokens.css', 'shell.css']) assert.match(html, new RegExp(`<link rel="stylesheet" href="${css}">`));
});
