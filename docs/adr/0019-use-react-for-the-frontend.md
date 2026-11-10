# ADR-0019: Use React For The Frontend

Date: 2026-11-09

Status: Accepted

Decided by: Fable (Claude), on blocking decisions delegated by the maintainer,
who may overrule this ADR. It resolves the M5 human gate `framework-choice`.

## Context

The architecture spec ("Frontend") fixes everything about the UI except the
framework: TypeScript, one codebase for the Electron renderer and remote
browsers; timeline, waveforms, automation and meters drawn with Canvas/WebGL; a
read model keyed by revision that never owns session truth; plan review as a
first-class UI. It leaves "React or Svelte" to be decided at the start of M5,
before `m5-read-model`, `m5-timeline`, `m5-mixer` and `m5-plan-review`.

What the frontend has to do, read from the protocol and the M5 manifest:

- Hold a read model keyed by revision, apply `session.changed {revision,
  changedIds}` deltas, recover with `session.sync`, and be optimistic only for
  continuous gestures (one revision per `gesture.end`).
- Draw clips from peak pyramids and meters from the binary `SMTR` frames of the
  `/v1/realtime` socket at display rate, for sessions of 64 tracks and more
  (M6c's criterion). This is Canvas/WebGL work; the framework never sees a
  meter sample.
- Render the DOM around those surfaces: track headers, mixer strips, the plan
  review (a diff of a plan against the current revision, audition, approve,
  reject, partial approve), menus and dialogs.
- Be built and verified by the same agent loop as every feature, with Playwright
  Electron tests (`app/test/e2e`) and `node --test` unit tests (`app/test/unit`),
  under `app/`'s strict `tsc -p .` build with no bundler today. `app/` carries
  its own pinned dependencies; the root package stays dependency-free.
- Run under the renderer's CSP (`script-src 'self'`, no `unsafe-eval`),
  `sandbox: true`, `contextIsolation: true`.

## Decision

1. **React** (the current major, 19) with `react-dom`, pinned in
   `app/package.json` by `m5-read-model` to a release at least two weeks old,
   as the spec's Libraries table requires of every library. MIT.
2. **The read model is framework-free.** `app/src/renderer/model/` is plain
   TypeScript with no React import: immutable snapshots keyed by revision, delta
   application, `session.sync` recovery, gesture overlays. It is unit-tested with
   `node --test` like the supervisor is. React reads it through
   `useSyncExternalStore` with selectors; each revision is a new snapshot
   object, so the store contract (stable snapshot identity, tearing-safe) falls
   out of the protocol's own design.
3. **React renders chrome only.** Timeline, waveform, automation and meter
   surfaces are imperative TypeScript classes owning a `<canvas>`, mounted
   through a ref and driven by `requestAnimationFrame`; meters subscribe to the
   realtime socket directly. No meter or playhead value passes through React
   state. A continuous gesture holds its optimistic value in the surface or in
   local component state and commits once at `gesture.end`.
4. **Build.** The renderer is bundled by esbuild (MIT; one dependency whose
   only transitive packages are its platform binaries), TSX type-checked by the
   existing strict `tsc -p .` (`"jsx": "react-jsx"`). esbuild writes one
   `renderer.js` that `renderer/index.html` already loads under the current
   CSP. No Vite, no SvelteKit, no CSS-in-JS runtime: plain CSS files.
5. **Allowed widget dependencies** are added by the feature that needs them,
   pinned, MIT or Apache-2.0, after a licence check, and only when a hand-rolled
   version would be more code than the dependency: list virtualisation
   (`@tanstack/react-virtual`), resizable panels. Drag, trim and fader gestures
   are pointer-event code on the surfaces, not a drag-and-drop library.
   openDAW and other AGPL web DAW UI code is not copied (spec, "Frontend").

## Comparison

| Criterion | React 19 | Svelte 5 | Weight for SIANN |
|---|---|---|---|
| Timeline, waveforms, meters at 60 fps | Canvas/WebGL, outside the framework | Same | Neutral: the spec already takes the hot path out of the framework |
| DOM around the surfaces (64+ track headers and strips) | VDOM diff; needs `memo` and selectors to stay cheap | Fine-grained signals, cheap by default | Svelte, mildly; React's cost is discipline the read model's selectors impose anyway |
| Revision-keyed read model with event streams | `useSyncExternalStore` is built for an external, versioned, immutable store | `$state` proxies the document, or a custom store | React: the store stays framework-free and immutable without fighting the framework |
| Large updates (`session.sync` recovery, big plans) | `startTransition` keeps input responsive during a whole-model replacement | Synchronous; fast, but no scheduling | React, slightly |
| Type checking | TSX through the existing `tsc -p .` | `.svelte` needs `svelte-check` beside `tsc` | React: one checker, already in place |
| Build | esbuild alone | Svelte compiler plus a plugin (`esbuild-svelte`, community) or Vite (large transitive tree) | React: fewer, better-maintained dependencies in a dependency-wary repo |
| Testability | Playwright for both; components in `node --test` through `react-dom/server` | Playwright for both; `svelte/server` | Neutral |
| Widgets (virtualisation, panels, diff views) | Largest ecosystem; TanStack Virtual, resizable panels, diff viewers | Smaller; TanStack has a Svelte adapter | React |
| Agent authoring reliability | Hooks API unchanged since 2019; vast corpus; mistakes are well known | Svelte 5 runes (2024) break Svelte 4 idioms; agents mix the two dialects | React, strongly: the UI is written by agents |
| Bundle size | ~45 KB gzipped runtime | A few KB | Svelte, but irrelevant for a local app or a LAN browser |
| Licence | MIT | MIT | Neutral |
| Precedent for web DAW UIs | BandLab, Soundtrap and most shipped web DAWs | Rare | React |

Svelte wins on default DOM performance and bundle size; neither matters here,
because the spec already keeps the performance-critical drawing out of the
framework and install size is irrelevant in this domain (spec, "Why Electron").
React wins where this project is weak: it is built by agents, type-checked by
`tsc`, dependency-wary, and its read model is an external immutable store. The
three strongest reasons, in order: agent authoring reliability, the toolchain
that fits `app/` as it stands, and `useSyncExternalStore` matching a
revision-keyed read model.

## Consequences

- `m5-read-model` adds `react`, `react-dom`, `@types/react`, `@types/react-dom`
  and `esbuild` to `app/package.json`, pinned, and the bundling step to
  `npm run build`; this ADR is the licence and dependency approval
  `docs/harness/agent-rules.md` asks for. Nothing else changes in that PR's
  dependency list.
- The spec's "Frontend" section and Libraries table name React and esbuild.
- `renderer.ts`'s connection code becomes the protocol client module the read
  model feeds on; the M0 status page becomes the first React component, so
  `shell.spec.ts`'s `data-testid` contract keeps passing.
- A frontend dependency outside point 5, a CSS-in-JS runtime, a state library
  (Redux, Zustand, MobX) or a second framework reopens this ADR; the read model
  is the state library.
- Reversed by the maintainer only before `m5-read-model` lands; after that a
  change of framework is a new ADR with the migration cost written down.
