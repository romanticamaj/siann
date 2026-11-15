'use strict';

// m5b-protocol-parity (docs/harness/test-matrix.md, section 4; rule 2 of
// section 8). The methods the native engine serves (kMethods,
// native/libs/protocol/src/protocol_server.cpp), the MCP tool table and the
// methods without a tool (kTools and kNotMcp, mcp_adapter.cpp) are read from the
// C++ sources, with no build, and held against the protocol docs
// (docs/schemas/protocol-*.md), the MCP doc's tables and the app's capabilities
// fixtures. Every check is a pure function returning [{name, place}] failures,
// so the self-test at the end can plant an extra or a missing entry into a copy
// of the real data and see the check name it. The native protocol_parity_test
// holds kMethods against the same two tables on every OS.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER_CPP = 'native/libs/protocol/src/protocol_server.cpp';
const ADAPTER_CPP = 'native/libs/protocol/src/mcp_adapter.cpp';
const SCHEMAS = 'docs/schemas';
const EVENTS_DOC = 'docs/schemas/protocol-events-v1.md';
const MCP_DOC = 'docs/schemas/protocol-mcp-v0.md';
const FULL = 'app/test/unit/fixtures/capabilities-full.json';
const REDUCED = 'app/test/unit/fixtures/capabilities-reduced.json';
const DOCS_PLACE = 'docs/schemas/protocol-*.md';

const DOTTED = /^[a-z_]+\.[a-z_]+$/;

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

// ---- Extractors (pure: text in, data out) --------------------------------

// The brace-enclosed initialiser of `const std::vector<Type> name = { ... };`.
function initializer(text, type, name) {
  const head = new RegExp(`const std::vector<${type}> ${name} = \\{`).exec(text);
  if (!head) return null;
  const start = head.index + head[0].length;
  const end = text.indexOf('\n};', start);
  return end < 0 ? null : text.slice(start, end);
}

function stringLiterals(text) {
  return [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

function extractMethods(serverText) {
  const body = initializer(serverText, 'std::string_view', 'kMethods');
  return body === null ? null : stringLiterals(body);
}

function extractTools(adapterText) {
  const body = initializer(adapterText, 'McpTool', 'kTools');
  if (body === null) return null;
  return [...body.matchAll(/\{\s*"([a-z_]+)",\s*"([a-z_.]+)",\s*McpScope::([a-z]+),/g)].map(
    ([, name, method, scope]) => ({ name, method, scope }),
  );
}

// {"method", "reason" "continued"}: adjacent literals are one string, as in C++.
function extractExclusions(adapterText) {
  const body = initializer(adapterText, 'McpExclusion', 'kNotMcp');
  if (body === null) return null;
  return [...body.matchAll(/\{\s*"([a-z_.]+)",\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\}/g)].map(([, method, reason]) => ({
    method,
    reason: stringLiterals(reason).join(''),
  }));
}

// Lines outside fenced code blocks.
function proseLines(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
}

function isHeading(line) {
  return /^#{1,6}\s/.test(line);
}

// Dotted names in a heading: `session.undo`, `session.redo` or plugin.registry, plugin.approve.
function headingNames(line) {
  return (line.match(/[A-Za-z0-9_./-]+/g) || []).filter((token) => DOTTED.test(token));
}

function cells(line) {
  return line
    .replace(/\\\|/g, '\u0000')
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.replace(/\u0000/g, '|').trim());
}

// Every markdown table of a text: {header: [cells], rows: [[cells]]}.
function tables(text) {
  const out = [];
  let current = null;
  for (const line of proseLines(text)) {
    if (line.startsWith('|')) {
      if (!current) {
        current = { header: cells(line), rows: [] };
        out.push(current);
      } else if (!/^\|[\s:|-]+\|?$/.test(line)) {
        current.rows.push(cells(line));
      }
    } else {
      current = null;
    }
  }
  return out;
}

function backticked(cell) {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// The table "Methods without a tool" (Method, Reason) lists kNotMcp; it does not
// document a method, so it is left out of the doc scan's "documented".
function isExclusionTable(table) {
  return table.header.length === 2 && table.header[0] === 'Method' && table.header[1] === 'Reason';
}

// The MCP tool table of protocol-mcp-v0.md (Tool, Method, Scope, ...) maps a tool
// to its method and carries none of the method's params, result or errors, so it
// is left out of "documented" too: a tool row alone documents nothing.
function isToolTable(table) {
  return table.header[0] === 'Tool' && table.header[1] === 'Method' && table.header[2] === 'Scope';
}

// docs: [{file, text}]. documented: method -> file, for a heading that names it
// or a table row with a cell that starts with it backticked, in any table but
// the two MCP mapping tables above. named: every dotted name in a heading or in
// a column whose header is Method.
function scanDocs(docs) {
  const headings = []; // {file, names}
  const rowStarts = []; // {file, name}
  const named = []; // {name, place}
  for (const { file, text } of docs) {
    for (const line of proseLines(text)) {
      if (!isHeading(line)) continue;
      const names = headingNames(line);
      headings.push({ file, names });
      for (const name of names) named.push({ name, place: file });
    }
    for (const table of tables(text)) {
      const methodColumn = table.header.indexOf('Method');
      for (const row of table.rows) {
        if (!isExclusionTable(table) && !isToolTable(table)) {
          for (const cell of row) {
            const first = /^`([^`]+)`/.exec(cell);
            if (first) rowStarts.push({ file, name: first[1] });
          }
        }
        if (methodColumn >= 0 && row[methodColumn] !== undefined) {
          for (const name of backticked(row[methodColumn])) {
            if (DOTTED.test(name)) named.push({ name, place: file });
          }
        }
      }
    }
  }
  return {
    documents(method) {
      return (
        headings.some((heading) => heading.names.includes(method)) || rowStarts.some((row) => row.name === method)
      );
    },
    named,
  };
}

// The events: dotted names in the headings of protocol-events-v1.md between
// "## Event envelope" and "## Methods".
function extractEvents(eventsText) {
  const lines = proseLines(eventsText);
  const start = lines.indexOf('## Event envelope');
  const end = lines.indexOf('## Methods');
  if (start < 0 || end < start) return null;
  return lines.slice(start, end).filter(isHeading).flatMap(headingNames);
}

// The tool table of protocol-mcp-v0.md (columns Tool, Method, Scope).
function extractDocTools(mcpText) {
  const table = tables(mcpText).find(isToolTable);
  if (!table) return null;
  return table.rows.map((row) => ({
    name: (backticked(row[0])[0] || row[0]).trim(),
    method: (backticked(row[1])[0] || row[1]).trim(),
    scope: row[2].trim(),
  }));
}

// The table "Methods without a tool" of protocol-mcp-v0.md (Method, Reason).
function extractDocExclusions(mcpText) {
  const table = tables(mcpText).find(isExclusionTable);
  if (!table) return null;
  return table.rows.map((row) => ({ method: (backticked(row[0])[0] || row[0]).trim(), reason: row[1].trim() }));
}

// ---- Checks (pure: data in, [{name, place}] out) ---------------------------

// (a) every method has a section or table row in a protocol doc.
function checkDocumented(world) {
  const scan = scanDocs(world.docs);
  return world.methods.filter((method) => !scan.documents(method)).map((name) => ({ name, place: DOCS_PLACE }));
}

// (b) every method or event name the protocol docs use exists.
function checkNamedExist(world) {
  const known = new Set([...world.methods, ...world.events]);
  const failures = [];
  const seen = new Set();
  for (const { name, place } of scanDocs(world.docs).named) {
    const key = `${name} ${place}`;
    if (known.has(name) || seen.has(key)) continue;
    seen.add(key);
    failures.push({ name, place });
  }
  return failures;
}

// (c) capabilities-full.json lists exactly kMethods.
function checkFullFixture(world) {
  const full = new Set(world.full);
  const methods = new Set(world.methods);
  return [
    ...world.methods.filter((m) => !full.has(m)).map((name) => ({ name, place: 'capabilities-full.json (missing)' })),
    ...world.full.filter((m) => !methods.has(m)).map((name) => ({ name, place: 'capabilities-full.json (not served)' })),
  ];
}

// (d) capabilities-reduced.json is a subset of the full fixture.
function checkReducedSubset(world) {
  const full = new Set(world.full);
  return world.reduced.filter((m) => !full.has(m)).map((name) => ({ name, place: 'capabilities-reduced.json' }));
}

// (e) the tool table of protocol-mcp-v0.md equals kTools: names in tools/list
// order, each with its method and scope.
function checkToolDoc(world) {
  const failures = [];
  const doc = world.docTools;
  const length = Math.max(doc.length, world.tools.length);
  for (let i = 0; i < length; i += 1) {
    const code = world.tools[i];
    const row = doc[i];
    if (!row) {
      failures.push({ name: code.name, place: `protocol-mcp-v0.md tool table (row ${i + 1} missing)` });
    } else if (!code) {
      failures.push({ name: row.name, place: `protocol-mcp-v0.md tool table (row ${i + 1}, no such tool)` });
    } else if (row.name !== code.name || row.method !== code.method || row.scope !== code.scope) {
      failures.push({
        name: code.name,
        place: `protocol-mcp-v0.md tool table row ${i + 1}: ${row.name} ${row.method} ${row.scope}, the code has ${code.name} ${code.method} ${code.scope}`,
      });
    }
  }
  return failures;
}

// (f) kMethods is the union of the tool methods and kNotMcp, the two are
// disjoint, nothing repeats and every exclusion has a reason (the Node mirror
// of protocol_parity_test).
function checkUnion(world) {
  const failures = [];
  const toolMethods = world.tools.map((tool) => tool.method);
  const excluded = world.exclusions.map((entry) => entry.method);
  const methods = new Set(world.methods);
  const covered = new Set([...toolMethods, ...excluded]);
  for (const method of world.methods) {
    if (!covered.has(method)) failures.push({ name: method, place: 'kNotMcp (neither a tool nor excluded)' });
  }
  for (const method of covered) {
    if (!methods.has(method)) failures.push({ name: method, place: 'kMethods (a tool or exclusion of no method)' });
  }
  const tools = new Set(toolMethods);
  for (const method of excluded) {
    if (tools.has(method)) failures.push({ name: method, place: 'kNotMcp and kTools (both)' });
  }
  for (const [list, place] of [
    [world.methods, 'kMethods (twice)'],
    [toolMethods, 'kTools (twice)'],
    [world.tools.map((tool) => tool.name), 'kTools names (twice)'],
    [excluded, 'kNotMcp (twice)'],
  ]) {
    const seen = new Set();
    for (const name of list) {
      if (seen.has(name)) failures.push({ name, place });
      seen.add(name);
    }
  }
  for (const entry of world.exclusions) {
    if (!entry.reason.trim()) failures.push({ name: entry.method, place: 'kNotMcp (no reason)' });
  }
  return failures;
}

// (g) the MCP doc's "Methods without a tool" table lists kNotMcp, in order.
function checkExclusionDoc(world) {
  const failures = [];
  const doc = world.docExclusions.map((entry) => entry.method);
  const code = world.exclusions.map((entry) => entry.method);
  for (const method of code) {
    if (!doc.includes(method)) failures.push({ name: method, place: 'protocol-mcp-v0.md "Methods without a tool" (missing)' });
  }
  for (const method of doc) {
    if (!code.includes(method)) failures.push({ name: method, place: 'protocol-mcp-v0.md "Methods without a tool" (not in kNotMcp)' });
  }
  if (failures.length === 0 && doc.join() !== code.join()) {
    failures.push({ name: doc.find((m, i) => m !== code[i]), place: 'protocol-mcp-v0.md "Methods without a tool" (order)' });
  }
  for (const entry of world.docExclusions) {
    if (!entry.reason) failures.push({ name: entry.method, place: 'protocol-mcp-v0.md "Methods without a tool" (no reason)' });
  }
  return failures;
}

// (h) acceptance item 3: plan.list and plan.preview each have a section (a
// heading that names the method) in a protocol doc whose body, up to the next
// heading, gives the params, the result and the errors.
const SECTION_METHODS = ['plan.list', 'plan.preview'];

function sectionBodies(docs, method) {
  const bodies = [];
  for (const { text } of docs) {
    let body = null;
    for (const line of proseLines(text)) {
      if (isHeading(line)) {
        if (body !== null) bodies.push(body.join('\n'));
        body = headingNames(line).includes(method) ? [] : null;
      } else if (body !== null) {
        body.push(line);
      }
    }
    if (body !== null) bodies.push(body.join('\n'));
  }
  return bodies;
}

const SECTION_PARTS = [
  ['params', /\bParams\b/],
  ['result', /\bResult\b/],
  ['errors', /\b(?:Errors?|error)\b/],
];

function checkSections(world) {
  const failures = [];
  for (const method of SECTION_METHODS) {
    const bodies = sectionBodies(world.docs, method);
    if (bodies.length === 0) {
      failures.push({ name: method, place: `${DOCS_PLACE} (no section)` });
      continue;
    }
    for (const [part, pattern] of SECTION_PARTS) {
      if (!bodies.some((body) => pattern.test(body))) {
        failures.push({ name: method, place: `${DOCS_PLACE} (section without ${part})` });
      }
    }
  }
  return failures;
}

// ---- The real data ---------------------------------------------------------

function protocolDocs() {
  return fs
    .readdirSync(path.join(ROOT, SCHEMAS))
    .filter((name) => /^protocol-.*\.md$/.test(name))
    .sort()
    .map((name) => ({ file: `${SCHEMAS}/${name}`, text: read(`${SCHEMAS}/${name}`) }));
}

function realWorld() {
  const server = read(SERVER_CPP);
  const adapter = read(ADAPTER_CPP);
  const mcp = read(MCP_DOC);
  return {
    methods: extractMethods(server),
    tools: extractTools(adapter),
    exclusions: extractExclusions(adapter),
    docs: protocolDocs(),
    events: extractEvents(read(EVENTS_DOC)),
    docTools: extractDocTools(mcp),
    docExclusions: extractDocExclusions(mcp),
    full: JSON.parse(read(FULL)).methods,
    reduced: JSON.parse(read(REDUCED)).methods,
  };
}

function report(failures) {
  return failures.map(({ name, place }) => `${name}: ${place}`).join('\n');
}

test('the extractors find the C++ tables and the doc tables', () => {
  const world = realWorld();
  assert.ok(Array.isArray(world.methods), `kMethods found in ${SERVER_CPP}`);
  assert.ok(world.methods.length >= 40 && world.methods.includes('session.inspect'), 'kMethods has its known entries');
  assert.ok(Array.isArray(world.tools), `kTools found in ${ADAPTER_CPP}`);
  assert.ok(world.tools.length >= 25, 'kTools has its entries');
  assert.deepEqual(world.tools[0], { name: 'list_commands', method: 'command.list', scope: 'propose' });
  assert.ok(world.tools.some((tool) => tool.scope === 'trusted'), 'a trusted tool is read');
  assert.ok(world.tools.every((tool) => tool.scope === 'propose' || tool.scope === 'trusted'), 'every scope is read');
  assert.ok(Array.isArray(world.exclusions), `kNotMcp found beside the tool table in ${ADAPTER_CPP}`);
  assert.ok(world.exclusions.length >= 10, 'kNotMcp has its entries');
  assert.ok(world.exclusions.some((entry) => entry.method === 'engine.about'), 'kNotMcp has engine.about');
  assert.ok(Array.isArray(world.events) && world.events.includes('session.changed'), 'the events are read');
  assert.ok(Array.isArray(world.docTools) && world.docTools.length >= 25, `the tool table of ${MCP_DOC} is read`);
  assert.ok(Array.isArray(world.docExclusions), `the table "Methods without a tool" of ${MCP_DOC} is read`);
  assert.ok(world.docs.length >= 5, 'the protocol docs are read');
});

const CHECKS = {
  a: { title: 'every method has a section or table row in a protocol doc', run: checkDocumented },
  b: { title: 'every method the protocol docs name exists', run: checkNamedExist },
  c: { title: 'capabilities-full.json lists exactly kMethods', run: checkFullFixture },
  d: { title: 'capabilities-reduced.json is a subset of capabilities-full.json', run: checkReducedSubset },
  e: { title: 'the MCP tools documented in protocol-mcp-v0.md equal the tool table, with their scope', run: checkToolDoc },
  f: { title: 'kMethods is exactly the tool methods and kNotMcp, disjoint, each exclusion with a reason', run: checkUnion },
  g: { title: 'protocol-mcp-v0.md "Methods without a tool" lists kNotMcp', run: checkExclusionDoc },
  h: { title: 'plan.list and plan.preview have a protocol doc section with params, result and errors', run: checkSections },
};

for (const [key, { title, run }] of Object.entries(CHECKS)) {
  test(`(${key}) ${title}`, () => {
    const failures = run(realWorld());
    assert.deepEqual(failures, [], report(failures));
  });
}

// ---- Self-test: each check fails on a planted extra or missing entry --------

function clone(world) {
  return structuredClone(world);
}

// Drops every heading and table row of the protocol docs that names `method`.
// Drops the sections (heading and body, up to the next heading) whose heading
// names `method`; every table row stays, the MCP tool row included.
function dropSection(world, method) {
  for (const doc of world.docs) {
    const out = [];
    let dropping = false;
    for (const line of doc.text.split('\n')) {
      if (isHeading(line)) dropping = headingNames(line).includes(method);
      if (!dropping) out.push(line);
    }
    doc.text = out.join('\n');
  }
}

// Deletes what `pattern` matches from the bodies of the sections naming `method`.
function stripFromSection(world, method, pattern) {
  for (const doc of world.docs) {
    let inside = false;
    doc.text = doc.text
      .split('\n')
      .map((line) => {
        if (isHeading(line)) {
          inside = headingNames(line).includes(method);
          return line;
        }
        return inside ? line.replace(pattern, '') : line;
      })
      .join('\n');
  }
}

// As undocument, but keeps the MCP tool row (Method in its second cell).
function undocumentButTool(world, method) {
  const toolRow = (line) => line.startsWith('|') && cells(line)[1] === `\`${method}\``;
  for (const doc of world.docs) {
    doc.text = doc.text
      .split('\n')
      .filter((line) => {
        if (isHeading(line)) return !headingNames(line).includes(method);
        return !(line.startsWith('|') && line.includes(`\`${method}\``)) || toolRow(line);
      })
      .join('\n');
  }
}

function undocument(world, method) {
  const mentions = (line) =>
    (isHeading(line) && headingNames(line).includes(method)) || (line.startsWith('|') && line.includes(`\`${method}\``));
  for (const doc of world.docs) {
    doc.text = doc.text
      .split('\n')
      .filter((line) => !mentions(line))
      .join('\n');
  }
}

const PLANTS = [
  {
    check: 'a',
    plant: 'a method served but in no protocol doc',
    name: 'transport.rewind',
    place: DOCS_PLACE,
    apply: (w) => w.methods.push('transport.rewind'),
  },
  {
    check: 'a',
    plant: 'a method whose doc row is removed',
    name: 'session.inspect',
    place: DOCS_PLACE,
    apply: (w) => undocument(w, 'session.inspect'),
  },
  {
    check: 'a',
    plant: 'a method whose section is removed while its MCP tool row stays',
    name: 'plan.list',
    place: DOCS_PLACE,
    apply: (w) => dropSection(w, 'plan.list'),
  },
  {
    check: 'a',
    plant: 'a method whose only row left is its MCP tool row',
    name: 'command.list',
    place: DOCS_PLACE,
    apply: (w) => undocumentButTool(w, 'command.list'),
  },
  {
    check: 'h',
    plant: 'plan.preview without its section',
    name: 'plan.preview',
    place: `${DOCS_PLACE} (no section)`,
    apply: (w) => dropSection(w, 'plan.preview'),
  },
  {
    check: 'h',
    plant: 'plan.list whose section gives no errors',
    name: 'plan.list',
    place: `${DOCS_PLACE} (section without errors)`,
    apply: (w) => stripFromSection(w, 'plan.list', /\b(?:Errors?|error)\b/g),
  },
  {
    check: 'b',
    plant: 'a doc section for a method the engine does not serve',
    name: 'transport.rewind',
    place: `${SCHEMAS}/protocol-engine-v0.md`,
    apply: (w) => {
      w.docs.find((d) => d.file.endsWith('protocol-engine-v0.md')).text += '\n## transport.rewind\n';
    },
  },
  {
    check: 'b',
    plant: 'a documented method removed from kMethods',
    name: 'engine.devices',
    place: `${SCHEMAS}/protocol-engine-v0.md`,
    apply: (w) => {
      w.methods = w.methods.filter((m) => m !== 'engine.devices');
    },
  },
  {
    check: 'b',
    plant: 'a Method table row naming a method that does not exist',
    name: 'gesture.squeeze',
    place: `${SCHEMAS}/protocol-gestures-v0.md`,
    apply: (w) => {
      w.docs.find((d) => d.file.endsWith('protocol-gestures-v0.md')).text = w.docs
        .find((d) => d.file.endsWith('protocol-gestures-v0.md'))
        .text.replace('| `gesture.begin`', '| `gesture.squeeze` | x | x | x |\n| `gesture.begin`');
    },
  },
  {
    check: 'c',
    plant: 'an extra fixture method',
    name: 'transport.rewind',
    place: 'capabilities-full.json (not served)',
    apply: (w) => w.full.push('transport.rewind'),
  },
  {
    check: 'c',
    plant: 'a fixture missing a served method',
    name: 'media.import',
    place: 'capabilities-full.json (missing)',
    apply: (w) => {
      w.full = w.full.filter((m) => m !== 'media.import');
    },
  },
  {
    check: 'd',
    plant: 'a reduced method outside full',
    name: 'transport.rewind',
    place: 'capabilities-reduced.json',
    apply: (w) => w.reduced.push('transport.rewind'),
  },
  {
    check: 'd',
    plant: 'a reduced method missing from full',
    name: 'plan.reject',
    place: 'capabilities-reduced.json',
    apply: (w) => {
      w.full = w.full.filter((m) => m !== 'plan.reject');
    },
  },
  {
    check: 'e',
    plant: 'a tool row with the wrong scope',
    name: 'execute',
    place: 'protocol-mcp-v0.md tool table row',
    apply: (w) => {
      w.docTools.find((t) => t.name === 'execute').scope = 'propose';
    },
  },
  {
    check: 'e',
    plant: 'a missing tool row',
    name: 'import_media',
    place: 'protocol-mcp-v0.md tool table',
    apply: (w) => {
      w.docTools = w.docTools.filter((t) => t.name !== 'import_media');
    },
  },
  {
    check: 'e',
    plant: 'an extra tool row',
    name: 'rewind',
    place: 'no such tool',
    apply: (w) => w.docTools.push({ name: 'rewind', method: 'transport.rewind', scope: 'propose' }),
  },
  {
    check: 'f',
    plant: 'a method with neither a tool nor an exclusion',
    name: 'transport.rewind',
    place: 'kNotMcp (neither a tool nor excluded)',
    apply: (w) => w.methods.push('transport.rewind'),
  },
  {
    check: 'f',
    plant: 'an exclusion of a method the engine does not serve',
    name: 'transport.rewind',
    place: 'kMethods (a tool or exclusion of no method)',
    apply: (w) => w.exclusions.push({ method: 'transport.rewind', reason: 'none' }),
  },
  {
    check: 'f',
    plant: 'an empty reason',
    name: 'engine.about',
    place: 'kNotMcp (no reason)',
    apply: (w) => {
      w.exclusions.find((e) => e.method === 'engine.about').reason = '';
    },
  },
  {
    check: 'f',
    plant: 'a method in both tables',
    name: 'command.list',
    place: 'kNotMcp and kTools (both)',
    apply: (w) => w.exclusions.push({ method: 'command.list', reason: 'planted' }),
  },
  {
    check: 'g',
    plant: 'an exclusion with no doc row',
    name: 'engine.about',
    place: '"Methods without a tool" (missing)',
    apply: (w) => {
      w.docExclusions = w.docExclusions.filter((e) => e.method !== 'engine.about');
    },
  },
  {
    check: 'g',
    plant: 'a doc row for a method kNotMcp does not hold',
    name: 'transport.rewind',
    place: '"Methods without a tool" (not in kNotMcp)',
    apply: (w) => w.docExclusions.push({ method: 'transport.rewind', reason: 'planted' }),
  },
];

test('self-test: every check fails on a planted extra or missing entry and names it', () => {
  const real = realWorld();
  for (const key of Object.keys(CHECKS)) {
    assert.ok(PLANTS.filter((p) => p.check === key).length >= 2, `check (${key}) has an extra and a missing plant`);
  }
  for (const { check, plant, name, place, apply } of PLANTS) {
    const world = clone(real);
    apply(world);
    const failures = CHECKS[check].run(world);
    assert.ok(
      failures.some((failure) => failure.name === name && failure.place.includes(place)),
      `(${check}) ${plant}: expected a failure naming ${name} at ${place}, got:\n${report(failures) || '(none)'}`,
    );
  }
});

