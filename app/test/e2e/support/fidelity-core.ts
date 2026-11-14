// The mockup fidelity gate's pure half (docs/harness/agent-rules.md, "UI
// fidelity"): who owns a part (app/test/fidelity/manifest.json), the geometry
// and computed-style comparison of the parts the mockup and the app both
// carry, a PNG reader and writer (8-bit RGB and RGBA, as Playwright's
// screenshots are; Node's zlib only), the masked pixel comparison of a
// region, and the report. No DOM and no Playwright here, so
// app/test/unit/fidelity.test.ts covers it; mockup-fidelity.spec.ts collects
// the parts and the screenshots and calls in.

import * as zlib from 'node:zlib';

// ---------------------------------------------------------------- manifest

export type GateMode = 'pending' | 'report' | 'enforce';

export interface Rule {
  readonly match: readonly string[];
  // The feature that builds the part; null for an unowned part.
  readonly feature: string | null;
  // The feature whose acceptance is "the fidelity gate passes for these parts".
  readonly gate: string | null;
  readonly unowned?: string;
}

export interface Manifest {
  readonly schemaVersion: string;
  readonly mockup: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
  readonly locales: Readonly<Record<string, { readonly query: string; readonly languages: readonly string[] }>>;
  readonly regions: readonly string[];
  readonly geometry: { readonly tolerancePx: number };
  readonly styles: readonly string[];
  readonly pixels: { readonly channelTolerance: number; readonly maxMismatch: number; readonly dynamic: readonly string[] };
  readonly gates: Readonly<Record<string, GateMode>>;
  readonly rules: readonly Rule[];
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

export function matches(globs: readonly string[], id: string): boolean {
  return globs.some((glob) => globToRegExp(glob).test(id));
}

export interface Owner {
  readonly feature: string | null;
  readonly gate: string | null;
  // unowned: no M5 or M5b feature builds the part.
  readonly mode: GateMode | 'unowned';
  readonly unowned?: string;
}

// The first rule that matches; null when no rule does (the manifest must be total).
export function ownerOf(manifest: Manifest, id: string): Owner | null {
  const rule = manifest.rules.find((entry) => matches(entry.match, id));
  if (!rule) return null;
  if (rule.gate === null) return { feature: null, gate: null, mode: 'unowned', unowned: rule.unowned ?? '' };
  const mode = manifest.gates[rule.gate];
  if (!mode) throw new Error(`manifest.gates has no entry for ${rule.gate}`);
  return { feature: rule.feature, gate: rule.gate, mode };
}

// ---------------------------------------------------------------- parts

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Part extends Rect {
  readonly id: string;
  // Computed styles by property; absent for a part drawn on a canvas.
  readonly styles?: Readonly<Record<string, string>>;
}

export type FindingKind = 'missing' | 'geometry' | 'style';

export interface Finding {
  readonly id: string;
  readonly kind: FindingKind;
  readonly feature: string | null;
  readonly gate: string | null;
  readonly mode: GateMode;
  // geometry: app minus mockup, in px.
  readonly delta?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly mockup?: Rect;
  readonly app?: Rect;
  // style: property -> [mockup, app].
  readonly styles?: Readonly<Record<string, readonly [string, string]>>;
  // A rough measure of how much of the window the mismatch changes, in px^2.
  readonly impact: number;
}

export interface Skipped {
  readonly id: string;
  readonly mode: 'pending' | 'unowned';
  readonly feature: string | null;
  readonly gate: string | null;
  readonly reason: string;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function zeroWidth(styles: Readonly<Record<string, string>>, side: string): boolean {
  return parseFloat(styles[`border-${side}-width`] ?? '0') === 0;
}

// The styles that differ. A border's colour and style say nothing while its
// width is zero on both sides.
export function styleDiff(
  mockup: Readonly<Record<string, string>>,
  app: Readonly<Record<string, string>>,
  properties: readonly string[],
): Record<string, readonly [string, string]> {
  const out: Record<string, readonly [string, string]> = {};
  for (const property of properties) {
    const side = /^border-(top|right|bottom|left)-(color|style)$/.exec(property)?.[1];
    if (side && zeroWidth(mockup, side) && zeroWidth(app, side)) continue;
    const a = mockup[property] ?? '';
    const b = app[property] ?? '';
    if (a !== b) out[property] = [a, b];
  }
  return out;
}

export interface Comparison {
  readonly findings: Finding[];
  readonly skipped: Skipped[];
  // Mockup parts no rule owns: a manifest error.
  readonly unruled: string[];
  // How many parts were compared, and how many of them matched in full.
  readonly compared: number;
  readonly matched: number;
}

// Layer 2: every mockup part whose gate is report or enforce must be in the
// app within tolerancePx on x, y, w and h, with equal computed styles.
export function compareParts(manifest: Manifest, mockup: readonly Part[], app: readonly Part[]): Comparison {
  const byId = new Map(app.map((part) => [part.id, part]));
  const findings: Finding[] = [];
  const skipped: Skipped[] = [];
  const unruled: string[] = [];
  let compared = 0;
  let matched = 0;
  for (const part of mockup) {
    const owner = ownerOf(manifest, part.id);
    if (!owner) {
      unruled.push(part.id);
      continue;
    }
    if (owner.mode === 'pending' || owner.mode === 'unowned') {
      skipped.push({
        id: part.id,
        mode: owner.mode,
        feature: owner.feature,
        gate: owner.gate,
        reason: owner.mode === 'unowned' ? (owner.unowned ?? '') : `until ${owner.gate} lands`,
      });
      continue;
    }
    compared += 1;
    const base = { id: part.id, feature: owner.feature, gate: owner.gate, mode: owner.mode };
    const rect: Rect = { x: round(part.x), y: round(part.y), w: round(part.w), h: round(part.h) };
    const other = byId.get(part.id);
    if (!other) {
      findings.push({ ...base, kind: 'missing', mockup: rect, impact: Math.round(part.w * part.h) });
      continue;
    }
    let ok = true;
    const delta = { x: round(other.x - part.x), y: round(other.y - part.y), w: round(other.w - part.w), h: round(other.h - part.h) };
    const worst = Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.w), Math.abs(delta.h));
    if (worst > manifest.geometry.tolerancePx) {
      ok = false;
      const moved = Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.w) + Math.abs(delta.h);
      findings.push({
        ...base,
        kind: 'geometry',
        delta,
        mockup: rect,
        app: { x: round(other.x), y: round(other.y), w: round(other.w), h: round(other.h) },
        impact: Math.round(Math.min(part.w * part.h, moved * Math.sqrt(Math.max(1, part.w * part.h)))),
      });
    }
    if (part.styles && other.styles) {
      const styles = styleDiff(part.styles, other.styles, manifest.styles);
      const count = Object.keys(styles).length;
      if (count > 0) {
        ok = false;
        findings.push({ ...base, kind: 'style', styles, impact: Math.round((count / manifest.styles.length) * part.w * part.h) });
      }
    }
    if (ok) matched += 1;
  }
  findings.sort((a, b) => b.impact - a.impact || a.id.localeCompare(b.id));
  return { findings, skipped, unruled, compared, matched };
}

// ---------------------------------------------------------------- PNG

export interface Image {
  readonly width: number;
  readonly height: number;
  // RGBA, 4 bytes per pixel.
  readonly data: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// A non-interlaced 8-bit RGB or RGBA PNG.
export function decodePng(file: Uint8Array): Image {
  const bytes = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const colourType = body[9];
      if (body[8] !== 8 || (colourType !== 2 && colourType !== 6) || body[12] !== 0) {
        throw new Error(`unsupported PNG (depth ${body[8]}, colour type ${colourType}, interlace ${body[12]})`);
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      const value = row[i]!;
      line[i] =
        (filter === 0 ? value : filter === 1 ? value + a : filter === 2 ? value + b : filter === 3 ? value + ((a + b) >> 1) : value + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      data[to] = line[x * channels]!;
      data[to + 1] = line[x * channels + 1]!;
      data[to + 2] = line[x * channels + 2]!;
      data[to + 3] = channels === 4 ? line[x * channels + 3]! : 255;
    }
    prev.set(line);
  }
  return { width, height, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(image: Image): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function crop(image: Image, rect: Rect): Image {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const width = Math.max(0, Math.min(image.width, Math.round(rect.x + rect.w)) - x0);
  const height = Math.max(0, Math.min(image.height, Math.round(rect.y + rect.h)) - y0);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    data.set(image.data.subarray(((y0 + y) * image.width + x0) * 4, ((y0 + y) * image.width + x0 + width) * 4), y * width * 4);
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- pixels

export interface PixelResult {
  readonly region: string;
  // Pixels of the region outside every mask.
  readonly compared: number;
  readonly masked: number;
  readonly mismatched: number;
  // mismatched / compared (0 when nothing is compared).
  readonly ratio: number;
  // The app's pixels in grey, mismatches in red, masks in blue.
  readonly diff: Image;
}

// Layer 3: the pixels of `rect` in both screenshots, outside `masks` (window
// coordinates). A pixel differs when any channel is more than
// `channelTolerance` apart, which absorbs a font rasteriser's edge values.
export function diffRegion(region: string, mockup: Image, app: Image, rect: Rect, masks: readonly Rect[], channelTolerance: number): PixelResult {
  if (mockup.width !== app.width || mockup.height !== app.height) {
    throw new Error(`screenshots differ in size: mockup ${mockup.width}x${mockup.height}, app ${app.width}x${app.height}`);
  }
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(mockup.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(mockup.height, Math.ceil(rect.y + rect.h));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const hidden = new Uint8Array(width * height);
  for (const mask of masks) {
    const mx0 = Math.max(x0, Math.floor(mask.x));
    const my0 = Math.max(y0, Math.floor(mask.y));
    const mx1 = Math.min(x1, Math.ceil(mask.x + mask.w));
    const my1 = Math.min(y1, Math.ceil(mask.y + mask.h));
    for (let y = my0; y < my1; y += 1) hidden.fill(1, (y - y0) * width + (mx0 - x0), (y - y0) * width + (mx1 - x0));
  }
  const data = new Uint8Array(width * height * 4);
  let compared = 0;
  let masked = 0;
  let mismatched = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = ((y0 + y) * mockup.width + x0 + x) * 4;
      const to = (y * width + x) * 4;
      const grey = Math.round((app.data[from]! + app.data[from + 1]! + app.data[from + 2]!) / 3 / 2) + 24;
      data[to + 3] = 255;
      if (hidden[y * width + x]) {
        masked += 1;
        data[to] = 20;
        data[to + 1] = 40;
        data[to + 2] = 90;
        continue;
      }
      compared += 1;
      const far =
        Math.abs(mockup.data[from]! - app.data[from]!) > channelTolerance ||
        Math.abs(mockup.data[from + 1]! - app.data[from + 1]!) > channelTolerance ||
        Math.abs(mockup.data[from + 2]! - app.data[from + 2]!) > channelTolerance;
      if (far) {
        mismatched += 1;
        data[to] = 255;
        data[to + 1] = 40;
        data[to + 2] = 60;
      } else {
        data[to] = grey;
        data[to + 1] = grey;
        data[to + 2] = grey;
      }
    }
  }
  return { region, compared, masked, mismatched, ratio: compared === 0 ? 0 : mismatched / compared, diff: { width, height, data } };
}

// ---------------------------------------------------------------- report

export interface RegionReport {
  readonly region: string;
  readonly feature: string | null;
  readonly gate: string | null;
  readonly mode: GateMode | 'unowned';
  readonly compared: number;
  readonly masked: number;
  readonly mismatched: number;
  readonly ratio: number;
  readonly over: boolean;
  readonly files: { readonly mockup: string; readonly app: string; readonly diff: string };
}

export interface LocaleReport {
  readonly locale: string;
  readonly comparison: Comparison;
  readonly regions: RegionReport[];
  // Parts the app carries that the mockup does not.
  readonly extra: string[];
  readonly notes: string[];
}

export interface GateReport {
  readonly generated: string;
  readonly commit: string;
  readonly platform: string;
  readonly locales: LocaleReport[];
}

// What fails the gate: findings and regions over threshold whose gate is
// `enforce`, and mockup parts no rule owns.
export function failures(report: GateReport): string[] {
  const out: string[] = [];
  for (const locale of report.locales) {
    for (const id of locale.comparison.unruled) out.push(`[${locale.locale}] ${id}: no manifest rule owns this part`);
    for (const finding of locale.comparison.findings) {
      if (finding.mode === 'enforce') out.push(`[${locale.locale}] ${finding.id}: ${finding.kind} (${finding.gate})`);
    }
    for (const region of locale.regions) {
      if (region.over && region.mode === 'enforce') {
        out.push(`[${locale.locale}] region ${region.region}: ${(region.ratio * 100).toFixed(2)} % of pixels differ (${region.gate})`);
      }
    }
  }
  return out;
}

function describe(finding: Finding): string {
  if (finding.kind === 'missing') {
    const r = finding.mockup!;
    return `not in the app (mockup: ${r.w}x${r.h} at ${r.x},${r.y})`;
  }
  if (finding.kind === 'geometry') {
    const d = finding.delta!;
    const sign = (v: number) => (v > 0 ? `+${v}` : String(v));
    return `Δx ${sign(d.x)}, Δy ${sign(d.y)}, Δw ${sign(d.w)}, Δh ${sign(d.h)} (mockup ${finding.mockup!.w}x${finding.mockup!.h} at ${finding.mockup!.x},${finding.mockup!.y}; app ${finding.app!.w}x${finding.app!.h} at ${finding.app!.x},${finding.app!.y})`;
  }
  return Object.entries(finding.styles ?? {})
    .map(([property, [a, b]]) => `${property}: \`${a}\` → \`${b}\``)
    .join('; ');
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function markdownReport(report: GateReport, manifest: Manifest, limit = Infinity): string {
  const lines: string[] = [];
  lines.push('# Mockup fidelity report', '');
  lines.push(`Commit \`${report.commit}\` on ${report.platform}, ${report.generated}. Mockup: \`${manifest.mockup}\` at ${manifest.viewport.width}x${manifest.viewport.height}, device scale factor ${manifest.viewport.deviceScaleFactor}.`, '');
  const failed = failures(report);
  lines.push(failed.length === 0 ? '**Gate: no enforced mismatch.**' : `**Gate: ${failed.length} enforced mismatches.**`, '');
  lines.push(`Gate modes: ${Object.entries(manifest.gates).map(([gate, mode]) => `\`${gate}\` ${mode}`).join(', ')}.`, '');
  for (const locale of report.locales) {
    const c = locale.comparison;
    const count = (kind: FindingKind) => c.findings.filter((f) => f.kind === kind).length;
    lines.push(`## Locale ${locale.locale}`, '');
    lines.push(
      `Parts compared: ${c.compared}; matching in full: ${c.matched}; not in the app: ${count('missing')}; geometry off by more than ${manifest.geometry.tolerancePx} px: ${count('geometry')}; computed styles differ: ${count('style')}. Skipped: ${c.skipped.filter((s) => s.mode === 'pending').length} pending, ${c.skipped.filter((s) => s.mode === 'unowned').length} unowned.`,
      '',
    );
    for (const note of locale.notes) lines.push(`- ${note}`);
    if (locale.notes.length > 0) lines.push('');
    lines.push('### Pixels by region (chrome only; waveform interiors, dynamic content and skipped parts masked)', '');
    lines.push('| Region | Differing | Compared px | Masked px | Threshold | Result | Diff |', '|---|---|---|---|---|---|---|');
    for (const region of [...locale.regions].sort((a, b) => b.mismatched - a.mismatched)) {
      lines.push(
        `| ${region.region} | ${(region.ratio * 100).toFixed(2)} % | ${region.compared} | ${region.masked} | ${(manifest.pixels.maxMismatch * 100).toFixed(1)} % | ${region.over ? 'over' : 'ok'} | [diff](${region.files.diff}) · [mockup](${region.files.mockup}) · [app](${region.files.app}) |`,
      );
    }
    lines.push('');
    const byFeature = new Map<string, number>();
    for (const finding of c.findings) byFeature.set(finding.feature ?? 'unowned', (byFeature.get(finding.feature ?? 'unowned') ?? 0) + 1);
    lines.push('### Mismatches by the feature that built the part', '');
    lines.push('| Feature | Mismatches |', '|---|---|');
    for (const [feature, total] of [...byFeature].sort((a, b) => b[1] - a[1])) lines.push(`| ${feature} | ${total} |`);
    lines.push('');
    // One line per distinct style difference: an inherited property set on the
    // body shows on every part, and is one fix.
    const styleCounts = new Map<string, { count: number; features: Set<string> }>();
    for (const finding of c.findings) {
      for (const [property, [a, b]] of Object.entries(finding.styles ?? {})) {
        const key = `${property}|${a}|${b}`;
        const entry = styleCounts.get(key) ?? { count: 0, features: new Set<string>() };
        entry.count += 1;
        entry.features.add(finding.feature ?? 'unowned');
        styleCounts.set(key, entry);
      }
    }
    lines.push('### Computed-style differences, by how many parts show them', '');
    lines.push('| Property | Mockup | App | Parts | Built by |', '|---|---|---|---|---|');
    for (const [key, entry] of [...styleCounts].sort((x, y) => y[1].count - x[1].count).slice(0, 40)) {
      const [property, a, b] = key.split('|');
      lines.push(`| ${property} | \`${cell(a ?? '')}\` | \`${cell(b ?? '')}\` | ${entry.count} | ${[...entry.features].join(', ')} |`);
    }
    if (styleCounts.size > 40) lines.push('', `${styleCounts.size - 40} more distinct differences in report.json.`);
    lines.push('');
    lines.push('### Parts, by visual impact', '');
    lines.push('| # | Part | Kind | Built by | Gate | What differs |', '|---|---|---|---|---|---|');
    c.findings.slice(0, limit).forEach((finding, index) => {
      lines.push(`| ${index + 1} | \`${finding.id}\` | ${finding.kind} | ${finding.feature} | ${finding.gate} (${finding.mode}) | ${cell(describe(finding))} |`);
    });
    if (c.findings.length > limit) lines.push('', `${c.findings.length - limit} more in report.json.`);
    lines.push('');
    if (locale.extra.length > 0) lines.push(`Parts only the app carries: ${locale.extra.map((id) => `\`${id}\``).join(', ')}.`, '');
    if (c.unruled.length > 0) lines.push(`**Mockup parts no manifest rule owns:** ${c.unruled.map((id) => `\`${id}\``).join(', ')}.`, '');
  }
  const first = report.locales[0];
  if (first) {
    lines.push('## Skipped parts', '');
    const groups = new Map<string, string[]>();
    for (const skip of first.comparison.skipped) {
      const key = skip.mode === 'unowned' ? `unowned: ${skip.reason}` : `pending: ${skip.gate}`;
      groups.set(key, [...(groups.get(key) ?? []), skip.id]);
    }
    lines.push('| Why | Parts |', '|---|---|');
    for (const [key, ids] of groups) lines.push(`| ${cell(key)} | ${ids.map((id) => `\`${id}\``).join(' ')} |`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
