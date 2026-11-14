# SIANN UI proposal: a modern DAW window with plan review built in


Date: 2026-11-13 (revision 4). Tracked by the GitHub epic "UI redesign: modern DAW shell"; the phase 1 tickets are the `m5-ui-*` features in `.claude/milestones/M5.json`.

Files:

- `2026-11-13-siann-ui-redesign/mockup.html`: the proposed main window, self-contained (fonts from Google Fonts, system fallback offline). `?lang=zh-TW` renders the Traditional Chinese chrome.
- `2026-11-13-siann-ui-redesign/mockup.png` and `mockup-zh-TW.png` (1440x900): screenshots of it, the target state, not phase 1.
- `../research/2026-11-13-cubase-reference.md` (primary reference; Steinberg's Cubase Pro 15.0.30 help) and `../research/2026-11-13-logic-reference.md` (secondary; Logic Pro 13.0). Below, `research/cubase.md` and `research/logic.md` name these two files.

The mockup shows the target state, not phase 1. Things in it with no backend yet (markers, fades, record arm, automation R/W, time signature, DSP load, LUFS, insert slots, routing, the "ask the agent" box) are hidden in phase 1 by the rule in section 3.0.

What changed in revision 4:

- **Cubase is the reference** for behaviour and default key commands, because the maintainer works in Cubase. Zones, ruler, tools, event handles, mixer strip order, value-control modifiers and the default keymap now follow it (sections 2 and 3). `research/cubase.md` section 9.1's forty must-haves are audited one by one in section 3.7.
- **Key commands are a layer with presets**: "Cubase" by default, "Logic" later (3.6).
- **The loop range is saved with the session** as a revisioned, undoable document entity (engine ticket E-1).
- **Three languages from phase 1**: English, Traditional Chinese and Simplified Chinese (section 6, ticket P1-0).
- Phase 1 grew by two tickets: i18n (P1-0) and basic editing by Cubase gestures (P1-8).

## 0. The decisions in one page

1. **One window of resizable zones, no page scroll, laid out as Cubase's project window.** A project zone that is never hidden (toolbar, info line, ruler, track list, event display), a left zone (Inspector), a lower zone (MixConsole, editor) and a right zone (Plans, media, meter). Every boundary drags, every zone but the project zone collapses, sizes are remembered per user. Zones do not free-dock or float.
2. **Dark graphite theme, colour only where it carries meaning** (approved). Track colours identify tracks; green, red, yellow and blue are play, record, solo and mute; one violet is reserved for everything an agent proposes.
3. **Plan review lives inside the event display and the mixer.** A pending plan draws ghost clips, a ghost track, ghost fader caps and ghost pan markers where each change would land, numbered by step. The right zone holds the list and the decision.
4. **Cubase's hands.** Ruler upper half for locators and cycle, lower half for the cursor and drag-zoom; tools on `1`–`9`; `Ctrl`-click resets a control and `Shift` is fine adjust; `Alt`-drag copies and `Alt`-click splits; fades from the upper corners of an event, resize from the lower corners; `G`/`H` zoom; numpad transport with fallbacks for laptops.
5. **Bars+beats and snap by default**, time as the secondary display. Gain in dB with one decimal, fader top at +6 dB, pan as L35 / C / R40.
6. **English, 繁體中文 and 简体中文 from the first ticket.** Every UI string comes from a typed message catalog; tests fail on a literal or a missing key; the screenshot tour runs per locale.
7. **Rendering: React for chrome, one imperative surface for the event display, one for all meters.** Canvas2D in two layers now, hand-written WebGL2 when the 64-track target needs it; no WebGPU, no OffscreenCanvas worker, no GPU library.
8. **Dependencies:** `react-resizable-panels` now (MIT, none of its own), `@tanstack/react-virtual` in phase 4. No i18n library. Inter and JetBrains Mono bundled; Chinese text uses the system fonts.
9. **Phase 1 is ten tickets.** Eight need no protocol or engine change. Loop and metronome need one engine ticket (E-1), which is in scope.

## 1. Design language

### 1.1 Look

Dark, cool graphite, flat, with hairline separators. Depth comes from five surface steps and 1 px black dividers, not from shadows. The only raised objects are the things a hand grabs: fader caps, knobs, transport buttons. Waveforms and meters are the brightest things on screen; the chrome stays quiet around them.

### 1.2 Colour tokens

```css
:root {
  /* surfaces */
  --bg-0: #090A0D;  /* wells: lane background, meter slots */
  --bg-1: #0F1115;  /* panels */
  --bg-2: #14171D;  /* toolbars, headers */
  --bg-3: #1B1F27;  /* controls at rest */
  --bg-4: #242934;  /* buttons, hover */
  --bg-5: #2E3441;  /* pressed, selected segment */
  --line: #22262F;  --line-2: #2F3542;  --divider: #000;
  /* text: 4 steps */
  --tx-1: #E8EBF1;  --tx-2: #A3ABB9;  --tx-3: #6C7483;  --tx-4: #474E5B;
  /* state */
  --play: #3DDC84;  --rec: #FF4D57;  --solo: #FFD23F;  --mute: #5AA9FF;
  --warn: #F5A524;  --ok: #3DDC84;  --err: #FF5C66;
  /* agent proposals, and nothing else */
  --ai: #A78BFF;  --ai-2: #C4B3FF;  --ai-dim: rgb(167 139 255 / .14);
  /* user selection is white, never a hue */
  --select: #FFFFFF;
}
```

Track palette, 12 colours at equal lightness so no track shouts: `#F0675B #F2994A #E6C547 #A8D05A #57C98A #3FC4A8 #3FC4DD #5B8FF5 #7C7CF0 #B57BEA #EC6BB0 #9AA3B2`. Violet `#A78BFF` is kept out of the palette. A clip is drawn from its track colour in three tones: a title strip at 88 % colour with dark text, a body at 26 % colour over `--bg-0`, and a waveform at the colour lightened 25 % (RMS body) with a 50 % alpha peak envelope behind it.

Meters: green to -12 dB, yellow to -3 dB, red above, white 1.5 px peak-hold line, latching clip indicator.

Mute and solo follow review item A16: solo yellow, mute blue, record red. An implicitly muted track (another track is soloed) dims its lane and header to 45 %.

### 1.3 Typography

- **UI: Inter variable** (OFL-1.1), 12 px base, 500 weight, with `tnum` tabular numerals for every readout so digits do not jitter while a fader moves. Inter has `tnum`, `zero` and an optical-size axis [F1].
- **Numeric display: JetBrains Mono** (OFL-1.1), only for the transport position display and hashes.
- Scale: 10 px micro labels (uppercase, +0.1 em tracking), 11 px secondary, 12 px body, 13 px session name, 14 px plan title, 17 px transport position.
- Chinese text uses the system fonts behind Inter; section 6.4 gives the stacks and the rules for size and weight.
- Both fonts are shipped as `.woff2` in `app/renderer/fonts/`. The CSP forbids remote fonts, and a remote browser on a LAN may have no internet.
- OFL fonts may be bundled with software under other free licences; only the font itself stays under the OFL, and its licence text ships with it [F2][F3].

### 1.4 Density and sizing

- 4 px spacing grid. Control height 22–24 px in toolbars, 28 px in the transport, 18 px for M/S/R.
- Track height: 53 px default, presets (26 compact, 53 normal, 96 tall) plus free drag of the header's lower border. Track height is a view setting, not session state.
- Mixer strip: 88 px normal, 56 px narrow.
- Radii: 3 px small controls, 5 px buttons, 8 px cards and the transport display.
- Every size is a CSS custom property so a later "UI scale" setting is one multiplier.

### 1.5 Icons

Lucide (ISC), 16 px grid, 1.6 px stroke, copied as SVG files into the repo and inlined as one sprite; no icon package dependency. It has the DAW glyphs needed: `metronome`, `repeat`, `circle-dot`, `audio-waveform`, `sliders-vertical`, `headphones`, `mic` [F4]. M, S, R, W and the lowercase `e` stay letters in every language, as in Cubase. The mockup uses stand-in drawings.

### 1.6 Motion

- Nothing animates on the audio path: faders, meters, playhead and clip drags follow the pointer or the engine with no easing.
- Panels open and close in 120 ms ease-out. Toasts slide 160 ms. Ghosts fade in over 150 ms when a plan is selected.
- Meter ballistics are part of the design: instant attack, release of 20 dB in 1.7 s (the IEC 60268-18 digital PPM return rate [M1]), peak hold 1.5 s (review A17; I found no standard for hold time).
- `prefers-reduced-motion` removes the panel and ghost transitions.

## 2. Layout

Vocabulary follows Cubase: project zone, left zone, lower zone, right zone, Inspector, MixConsole, info line, event display, project cursor, locators (`research/cubase.md` 1.1).

### 2.1 Zones at 1440x900 (as in the mockup)

| Zone | Default size | Holds | Show / hide |
|---|---|---|---|
| Top bar | 48 px | Session name and menu, branch chip (`main r39`), undo/redo, transport buttons, displays (position, time, locators, tempo, signature), metronome, DSP load, the four zone buttons, Plans button with pending count | Always shown |
| **Project zone** | rest | Toolbar (tools `1`–`9`, snap type, grid type, auto-scroll, proposal pill), info line, ruler, marker track, track list (216 px), event display | Never hidden, as in Cubase |
| **Left zone** | 216 px | Inspector for the selected track: name and colour, state buttons, volume, pan, then sections (Routing, Inserts, Sends, Automation, Agent changes, Notepad). Tabs at the bottom: Track, Editor | `Ctrl+Alt+L` or `Alt+I` |
| **Lower zone** | 280 px | Tabs: MixConsole, Editor | `Ctrl+Alt+E` or `Ctrl+Alt+B`; `Alt+F3` shows it on the MixConsole tab |
| **Right zone** | 348 px | Tabs: Plans, Media, Meter | `Ctrl+Alt+R`; `Ctrl+Alt+P` shows it on the Plans tab (SIANN addition) |
| Channel tab | 96 px, off by default | One full strip for the selected track, beside the Inspector | `Ctrl+Alt+C` (phase 3) |
| Status bar | 24 px | Engine connection, device and latency, xruns, side heard, language, saved revision, and the engine's name, version, commit, licence and source link | Always shown |

- **Four zone buttons** sit at the right end of the top bar in Cubase's order: Channel, Left, Lower, Right.
- **Keyboard focus is per zone.** The focused zone has a light frame (the project zone in the mockup). Clicking a zone focuses it; key commands act on the focused zone. `Ctrl+Alt+Left/Right` step through the tabs of the focused zone.
- **Focus keys (maintainer decision, 2026-11-14).** `Tab` and `Shift+Tab` cycle the zones, as in Cubase, only while the focus is on a zone itself (its frame) or on the page. While the focus is on a control inside a zone (a button, a checkbox, a fader, a field, the zone's divider), `Tab` and `Shift+Tab` move between that zone's controls in document order and wrap at the zone's ends, so the focus stays in the zone; `Escape` returns the focus to the zone itself (in the project zone its `edit.cancel` still runs). `Enter` on a zone moves into its first control. `F6` and `Shift+F6` cycle the zones from anywhere, a text field included, as the platform convention has it. Outside the zones (top bar, status bar) `Tab` is the browser's own, and a modal dialog keeps the focus. Every stop (a zone, a control, a divider) shows a visible focus ring.
- **One transport surface.** Cubase has a transport bar, a floating panel, a toolbar group and a pop-up; SIANN has the top bar only (`research/cubase.md` 9.3 lists the overlap as something not to copy).
- **Licence line.** Built only from `engine.about` and the auth reply, never from a string in the renderer. The engine build reports `AGPL-3.0-or-later` for a JUCE desktop build and `GPL-2.0-or-later` otherwise (`native/cmake/SiannBuildInfo.cmake`). It stays visible or one click away (AGPL section 13).
- **Status bar content (P1-1).** Device, latency (input / output, ms) and xruns come from `engine.status`, which has no event: the renderer polls it once a second while connected, and only when `engine.capabilities` lists the method. The side heard is the plan store's (`plan.list` and `audition.changed`), shown only when `audition.hear` is listed and a side is known. The session id and the read model's counts (tracks, clips, syncs, connections) of the old status panel are diagnostics, not status: they move to the About panel, beside the licence line.
- The MixConsole in the lower zone lists channels in track order, left to right, with the master pinned at the right edge.

### 2.2 Why zones and not free docking

It is the layout the maintainer's DAW uses and the one the others converge on: Cubase's zones, Studio One's F2–F5 panels [D5], Live 12's mixer in the Arrangement view [D1]. It is also far less code than a docking manager: `dockview-core` is 91 kB gzipped, while `react-resizable-panels` gives resizable, collapsible splits with no dependencies [L1]. What is fixed is where a zone lives, not how big it is.

### 2.3 Resizing and collapsing (maintainer decision)

Every boundary drags, in both directions, and every zone except the project zone collapses.

| Boundary | Drag | Default | Range | Collapses |
|---|---|---|---|---|
| Left zone / project zone | left-right | 216 px | 180–420 px | Yes |
| Channel tab / Inspector | left-right | 96 px | 80–160 px | Yes |
| Track list / event display | left-right | 216 px | 140–420 px | No; at the minimum a header shows colour, name, M and S, which Cubase also never lets you remove |
| Project zone / lower zone | up-down | 280 px | 160 px up to the height that leaves the event display 320 px high | Yes, to nothing; the zone button and keys bring it back |
| Project zone / right zone | left-right | 348 px | 300–560 px | Yes; the Plans button keeps the pending count |
| Track height | up-down, on a header's lower border | 53 px | 24–240 px | Per track; `Ctrl`-drag sets all tracks, as in Cubase |
| Mixer strip width | — | 88 px | narrow 56 px / normal 88 px | — |

The Channel tab / Inspector boundary arrives with the Channel tab (phase 3). The strip width is a two-value setting owned by `m5-ui-mixer`, not a drag. The track list / event display boundary is built with the track list (`m5-ui-arrange`); `m5-ui-shell` builds the three zone boundaries (left, lower, right).

- A divider is a 1 px line with a 7 px hit area and a resize cursor. It is a `role="separator"` with `aria-orientation` and with `aria-valuenow`, `aria-valuemin` and `aria-valuemax` giving its zone's size and range in px, and it is in the `Tab` order of the zone it sizes (2.1, focus keys), with a visible focus ring. Arrow keys move it by 8 px (`Shift` + arrow: 32 px); `Home` and `End` take the zone to its minimum and maximum; `Enter` or double-click restores the default. Dragging a zone below its minimum collapses it; no key on a divider collapses.
- The event display never drops below 320 px high or 360 px wide; when the window shrinks, the lower zone gives way first, then the right zone, then the left.
- **Remembered per user, not per session.** Sizes, collapsed states, active tabs and strip width are stored under one key (`siann.layout.v1`) in the renderer's `localStorage`: the Electron profile of the OS user on the desktop, the browser's profile in a tab. They are never written to the session bundle and never become a revision. Per-track heights are kept per session id in the same store.
- Later (phase 5): named workspaces recalled with `Alt+Num 1..9`, as in Cubase.

### 2.4 Small windows

- Under 1280 px wide the right zone becomes an overlay drawer over the project zone; a pending plan shows as the badge on the Plans button and as a toast.
- Under 1100 px the left zone starts collapsed and the top bar drops the locator, tempo and signature displays.
- Under 760 px high the lower zone starts collapsed.
- The toolbar collapses as Cubase's does: the tool buttons and snap stay, the rest fold into a menu.
- Minimum window 960x600. Implemented with container queries on each zone (Chrome 106+ [C1]).

### 2.5 Second monitor

Phase 5: the MixConsole as its own window on `F3`, as in Cubase (until then `F3` shows the lower-zone MixConsole, the same as `Alt+F3`). It is a second `BrowserWindow` loading the same bundle with `?view=mixer`, with its own protocol connection and read model. The shell denies `window.open` today (`setWindowOpenHandler` in `main.ts`), so this is main-process work behind an IPC call. Plugin editors are already native windows owned by the engine.

## 3. DAW feature and interaction checklist

Status: **P1-n** = that phase 1 ticket; **P2/P3/P4/P5** = later phases of this proposal; **M6a/b/c** = arrives with that milestone; **E-n** = needs that engine ticket (section 7).

What exists today (spec and `native/libs/command`): commands `clip.place/move/trim/remove/set_gain`, `track.add/remove/rename/set_gain/set_pan/set_mute/set_solo/explode`, `media.add/remove`, `plugin.insert/remove/set_bypass`, `session.rename/set_tempo`; methods `transport.play/stop/locate`, `session.undo/redo/save`, `gesture.*`, `plan.*`, `proposal.merge/discard`, `audition.hear`, `engine.status/devices`, `plugin.open_editor`; the realtime socket carries the playhead, the playing flag and per-entity peak and RMS, including a `master` meter.

Checked in the code: `clip.place` and `clip.trim` take `sourceStart` and `length`, so split, slip and copy are compositions of existing commands; `session.fetch {refs, revision}` reads branch revisions and `proposal.changed` announces them.

Naming: the protocol says *clip* where Cubase says *event*. The UI says "clip" in English; the Chinese terms are in section 6.5.

### 3.0 One rule for controls without a backend

**A control whose method or data does not exist is not rendered.** No greyed-out placeholders, no "coming soon" tooltips, no reserved space.

- The test is `engine.capabilities`: a control is drawn only when the method or feature it needs is listed (or, for document fields, when the entity has the field).
- "Disabled with a tooltip" is reserved for a control that works in this build but not in this state (no audio device, engine disconnected, plan stale, proposal heard). The tooltip names the reason.
- Why hidden: a disabled button that can never be enabled teaches the user to ignore disabled buttons, and it makes the screenshot tour show a product that does not exist.

Applied to what the mockup shows:

| In the mockup | Phase 1 |
|---|---|
| Cycle button, locator band in the ruler, metronome button, locator display | In scope (P1-7). Rendered once the engine lists the E-1 methods; absent before that, by the same rule |
| Record button, record-enable and monitor buttons | Hidden (M6b) |
| R / W automation buttons, Automation section | Hidden (M6a) |
| Marker track | Hidden (E-8) |
| Fade handles, fade fields in the info line | Hidden (E-9) |
| Time signature display | Hidden; bars are computed as 4/4, which the tooltip of the position display states (E-10) |
| DSP load, LUFS | Hidden (E-13); the status bar shows xruns, which `engine.status` has |
| Master fader and its buttons | Hidden (E-11); the master strip is a meter with a peak value |
| Insert slots, `e` buttons, Routing and Sends sections, Notepad | Hidden in phase 1; inserts and `e` arrive in phase 3 from `plugin_slot` entities, routing and sends with M6c |
| Tools `2` and `4`–`9`; snap types other than Grid | Hidden until phase 3 implements them (renderer work, not backend). Tools `1` and `3` are in P1-8 |
| Editor tab, Media and Meter tabs | Hidden until phase 3 |
| Clip titles | The media id (the clip has no name; E-4) |
| Agent row, plan title and summary | Hidden (E-7); the card leads with the first step and "N steps" |
| "Ask the agent" box | Hidden (needs an agent runtime) |
| Track colours | Shown: assigned in the renderer from a stable hash of the track id until E-2 |

### 3.1 Transport

| Feature | Cubase convention | Status |
|---|---|---|
| Start / stop | `Space`; `Enter` (numpad) start; `Num 0` stop | P1-2 |
| Go to project start | `Num .`; laptop fallback `,` (SIANN addition) | P1-2 |
| Position display, primary and secondary format | Bars+Beats, Seconds; `.` exchanges them; `Shift+P` types a position | P1-2 |
| Set the cursor | Click in the lower half of the ruler; `Shift+Alt`-click in the event display | P1-2 |
| Auto-scroll | `F`; page mode; suspended while editing | P1-2. Stationary cursor (`Alt+C`) in phase 3 |
| Locate selection start; next / previous clip | `L`; `N` / `B` | P1-8 |
| Tempo | `Shift+T` types it | Display P1-2; edit phase 3 (`session.set_tempo`) |
| Time signature | `Shift+C` | E-10 |
| Locators and cycle | Section 3.2, "Ruler" | P1-7 on E-1 |
| Go to left / right locator | `Num 1` / `Num 2`; laptop fallback `Shift+1` / `Shift+2` | P1-7 |
| Metronome | `C` | P1-7 on E-1; count-in with M6b |
| Record, punch in / out, pre-roll | `Num *`; `I` / `O`; punch locked to the locators | M6b (`m6b-punch-loop` builds on E-1's locators) |
| Rewind / forward; nudge cursor | `Num -` / `Num +`; `Ctrl+Num -/+` | Phase 3 |
| Markers, cycle markers | Marker track; `Insert`; `Shift+1..9` | E-8 |

### 3.2 Ruler, zoom and the event display

**Ruler** (`research/cubase.md` 1.4, 2.6, 8.2):

| Gesture | Result | Status |
|---|---|---|
| Click in the lower half | Set the project cursor | P1-2 |
| Drag vertically in the lower half | Zoom: down in, up out, around the pointer | P1-3 |
| Drag in the upper half | Draw the locator range | P1-7 |
| Click the locator range | Toggle cycle | P1-7 |
| Drag the range; drag an end | Move it; adjust it | P1-7 |
| `Ctrl`-click / `Alt`-click the upper half | Set the left / right locator | P1-7 |
| Right-click | Time format menu | P1-2 |

The locator range is shown as a band with L and R flags in the ruler and a tint over the tracks; it is light when cycle is on and grey when off. If the right locator is before the left with cycle on, Cubase skips the range; SIANN refuses that order in E-1's first version.

**Zoom and scroll** (`research/cubase.md` 7.6, 8.1):

| Action | Convention | Status |
|---|---|---|
| Horizontal zoom | `H` in / `G` out; `Ctrl`+wheel at the pointer | P1-3 |
| Vertical zoom (track heights) | `Shift+H` / `Shift+G`; `Ctrl+Shift`+wheel | P1-3 |
| Zoom Full | `Shift+F` | P1-3 |
| Zoom to Selection; Zoom to Event | `Alt+S`; `Shift+E` | P1-8 |
| Zoom Tracks Exclusive | `Z` | Phase 3 |
| Vertical scroll; horizontal scroll | Wheel; `Shift`+wheel and trackpad horizontal | P1-3 |
| Zoom sliders and waveform zoom | Bottom-right of the event display | Slider P1-3; waveform zoom (`Alt+H` / `Alt+G`) phase 3 |

**Tools** (`research/cubase.md` 2.1). One active tool, chosen on the number row; `1` always returns to the arrow.

| Key | Tool | Status |
|---|---|---|
| `1` | Object Selection: select, move, resize. `Alt`-click splits, `Alt`-drag copies, `Ctrl`-drag constrains the axis, `Ctrl+Alt`-drag slips content | P1-8 (slip in phase 3) |
| `2` | Range Selection, with Delete Time, Cut Time, Insert Silence, Crop, Split Range | Phase 3 |
| `3` | Split | P1-8 |
| `4` | Glue | Phase 3, for adjacent pieces of the same media; anything else needs parts |
| `5` | Erase | Phase 3 |
| `6` | Zoom | Phase 3 |
| `7` | Mute | E-9 (`clip.set_mute`) |
| `8` | Draw (automation and volume curve points) | M6a |
| `9` | Play (audition from the click point) | Phase 3 |
| `F9` / `F10` | Previous / next tool | Phase 3 |

**Clip handles**, shown on hover or selection (`research/cubase.md` 2.3, 2.4, 8.3):

| Handle | Gesture | Status |
|---|---|---|
| Lower-left and lower-right corners | Resize; `Ctrl` disables snap | P1-8 (today's trim moves from the whole edge to the corners; the edge stays a 4 px target as well) |
| Upper-left and upper-right triangles | Fade in / fade out | E-9 |
| Volume control at the bottom left | Hold to get a small fader; `Shift` fine; the change is shown in brackets | P1-8 (`clip.set_gain`) |
| Middle of the right border | Drag right to repeat copies | Phase 3 |

**Editing** (`research/cubase.md` 2.2, 2.3, 7.4):

| Operation | Convention | Status |
|---|---|---|
| Select; add; all; none | Click; `Shift`-click; `Ctrl+A`; `Ctrl+Shift+A`; arrow keys step | P1-8 single and `Shift`; rubber band phase 3 |
| Move, also across tracks | Drag; `Ctrl` constrains | P1-3 (exists); constrain P1-8 |
| Copy | `Alt`-drag | P1-8 (`clip.place`) |
| Duplicate | `Ctrl+D` | P1-8 |
| Repeat | `Ctrl+K` | Phase 3 |
| Split at Cursor | `Alt+X`: the selected clips, or every track under the cursor when nothing is selected | P1-8 |
| Delete | `Delete` or `Backspace` | P1-3 (exists) |
| Cut / copy / paste | `Ctrl+X/C/V` at the cursor; `Alt+V` at origin | Phase 3 |
| Nudge position and edges | `Ctrl+Left/Right`; `Alt`+arrows | Phase 3 |
| Snap on / off | `J` | P1-8 |
| Snap type | Grid in P1-8; Grid Relative, Events, Shuffle, Cursor in phase 3 | |
| Grid type | Bar, Beat, Adapt to Zoom | P1-8 |
| Crossfade | `X` | E-9 |
| Mute clips | `Shift+M` / `Shift+U` / `Alt+M` | E-9 |
| Rename | `F2` | E-4 |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` | P1-2 |
| Edit history list | Edit > History | E-16 |
| Info line: show the selection's start, end, length, offset, volume | `Ctrl+I` toggles it | Read-only P1-3; editing (relative across the selection, `Ctrl` absolute) phase 3 |
| Open the editor in the lower zone | Double-click or `Return` | Phase 3 |
| Drag tooltip with the new position and delta | — | P1-3 |
| Drop audio files from the OS | — | E-5 |

### 3.3 Track list

| Feature | Cubase convention | Status |
|---|---|---|
| Header: colour, number, name, M, S, gain and pan readout, mini meter | M and S cannot be removed | P1-3 |
| `M` / `S` act on the selected track | No modifier | P1-8 |
| Exclusive solo; Solo Defeat | `Ctrl`-click S; `Alt`-click S | Exclusive phase 3 (one `command.execute`); defeat E-17 |
| Rename | Double-click the name; `Return` confirms | P1-3 (`track.rename`) |
| Add track | `T`; `+` above the list; double-click empty space | P1-3 |
| Remove selected tracks | `Shift+Delete` | P1-8, with confirmation |
| Select / toggle / range-select tracks | Click / `Ctrl`-click / `Shift`-click | P1-8 |
| Reorder by drag | Green insertion line | E-3 |
| Height | Drag the lower border; `Ctrl` = all | P1-3 |
| Colour | Inherited by clips and channels; `Alt+Shift+C` | Assigned P1-3; chosen by the user with E-2 |
| Record enable, monitor | `R` | M6b |
| Read / write automation; show lanes | R / W; arrow at the lower-left corner | M6a |
| Folder tracks, group channels | — | M6c |
| Visibility, type filter, find track | `Ctrl+F` | Phase 4, with virtualisation |

### 3.4 MixConsole

Strip order, top to bottom, as in Cubase (`research/cubase.md` 5.3): (insert rack) · pan · M S e · fader with meter · level and peak values · R W and record · name on the colour.

| Feature | Cubase convention | Status |
|---|---|---|
| Lower-zone MixConsole in track order | `Alt+F3` | P1-4 |
| Fader, -inf to +6 dB, finer near 0 dB | Volume Max defaults to +6 dB (confirmed in the Cubase manual) | P1-4 |
| Reset a control; fine adjust; type a value | `Ctrl`-click; `Shift`-drag; double-click the value | P1-4, for every value control in the app |
| Wheel over a control changes it | Subject to a preference | P1-4 (off inside scrollable areas by default) |
| Pan | Balance panner; `Ctrl`-click centres | P1-4 |
| Meter with peak hold; click the peak value to reset | Global Meter Settings | P1-4 |
| Clip indication | — | P1-4 |
| M, S shared with the track list | — | P1-4 |
| Master meter | — | P1-4 (the engine publishes `master`) |
| Master fader | — | E-11 |
| Inspector, Track tab: name, colour, M, S, volume, pan | Left zone | P1-4, drawn with the strip's own controls; sections in phase 3 |
| Inserts: slots, bypass, open editor, add, remove | Racks; `e` | Phase 3 |
| Channel tab; Channel Settings | `Ctrl+Alt+C`; `e` | Phase 3 |
| Sends, routing, groups, VCA, link groups | — | M6c |
| MixConsole window | `F3` | Phase 5 |
| Mixer undo separate from edit undo | `Alt+Z` | Not planned: SIANN has one journal, and that is the point of it |
| Loudness, DSP load | — | E-13 |

### 3.5 Automation, recording, plugins

- **Automation (M6a):** R and W on the header and strip, W red when armed; a lane opens from the arrow at the header's lower-left corner; points and segments edited with tools `1` and `8`; modes Touch, Auto-Latch, Cross-Over and Trim in an automation panel (`F6`).
- **Recording (M6b):** record enable and monitor on header and strip; a growing red clip with a live waveform; takes in lanes per cycle pass; punch at the locators; count-in. While recording, the shell holds `powerSaveBlocker('prevent-app-suspension')` [E3].
- **Plugin windows:** native editors stay engine-owned windows. The UI's part is the insert slot and later the generic parameter list.

### 3.6 Key commands: one layer, presets on top

Every command has an id (`transport.cycle`, `edit.splitAtCursor`, `zone.left.toggle`). A preset is a table from keys to command ids; menus, tooltips and the future key-command editor read the same table. Tool modifiers (`Alt` = copy, `Ctrl` = constrain) are a second small table, as in Cubase's Tool Modifiers page. The dispatcher sends a key to the focused zone first, then to the window.

- **"Cubase" is the default preset.** Its bindings are the ones in this section and in `research/cubase.md` section 7.
- **SIANN additions**, all on keys Cubase leaves free:

| Command | Key | Why |
|---|---|---|
| Go to project start | `,` | Laptop fallback for `Num .` |
| Cycle on / off | `/` | Laptop fallback for `Num /` |
| Go to left / right locator | `Shift+1` / `Shift+2` | Laptop fallback for `Num 1` / `Num 2` (Cubase's markers 1 and 2) |
| Record | `Ctrl+Shift+R` | Laptop fallback for `Num *` (M6b) |
| Show Plans | `Ctrl+Alt+P` | |
| Hear the other side while auditioning | `Shift+A` | |
| Approve the selected plan | `Ctrl+Return`, with the right zone focused | |
| Show / hide ghosts | `Ctrl+Alt+G` | |
| MixConsole | `F3` shows the lower zone until the window exists | |

- **Not copied from Cubase:** `Home` / `End` selecting the top and bottom track stays, but `F2` means only "rename" (there is no transport panel), and the nudge-edge keys follow the key-command table, not the manual's conflicting range page.
- **"Logic" preset, later.** A second table, not a hybrid, because the two sets collide. The conflicts found in `research/logic.md` section 9.1:
  1. Tools: one active tool on number keys (Cubase) against two concurrent tools chosen from a pop-up on `T` (Logic).
  2. Bare number keys: tools (Cubase) against screensets (Logic).
  3. Single letters: Cubase spends them on edit commands (`S` solo, `M` mute, `G`/`H` zoom, `X` crossfade); Logic on window toggles (`X` mixer, `E` editor, `I` inspector, `B` browser).
  4. Split and repeat: `Alt+X`, `Ctrl+D`, `Ctrl+K` against `Cmd-T`, `Cmd-R`, `Cmd-J`; Logic's `K` is the metronome.
  5. Return to zero and cycle: numpad `.` and `/` against `Return` and `C`; Cubase's `C` is the metronome.
  6. The lower pane: tabs (Cubase) against one shared slot (Logic).
  7. Inspector: a stack of sections against two channel strips that follow the signal.
  8. Folders: folder track plus group channel plus VCA against folder stack and summing stack.
  9. Comping: lanes and a Comp tool against take folders with Quick Swipe.
  10. Playlists: Track Versions against track alternatives.
  11. Automation: flat modes against modes plus Trim and Relative modifiers.
  12. Fader ceiling: +6 dB in both; no conflict.
  13. Snap: Shuffle is a snap type in Cubase and a drag mode in Logic; Logic's Smart snap follows zoom.
  14. Right-click: context menu with an optional toolbox against a shortcut menu or a third tool.

  Items 1 to 5 are pure key bindings and are what the preset changes. Items 6 to 11 are behaviour; SIANN follows Cubase there and a preset does not change them.
- A key-command editor (rebind, search, export) is phase 3; the table makes it a view, not a rewrite.
- **Focus keys** (2.1) are rows of the same table in the window scope: `Tab` / `Shift+Tab` (`focus.next` / `focus.prev`), `F6` / `Shift+F6` (`focus.nextZone` / `focus.prevZone`), `Enter` (`focus.enterZone`, on a zone only) and `Escape` (`focus.zoneRoot`, from a control only). They run before any element's own key handler, and where they do not apply (`Tab` in the top bar, `Enter` on a button) the key keeps its default. They are the only keys that act while a text field has focus, as the platform's own `Tab` and `F6` do; `Enter` is not one of them. Keys on a focused divider (arrows, `Home`, `End`, `Enter`) belong to the divider and do not reach the preset, so the track `Home` / `End` above are unaffected. `F6` is Cubase's Automation panel key (3.5): SIANN keeps `F6` for zone focus, and the Automation panel takes another chord when M6a adds it.

**Borrowed from Logic, in later phases** (`research/logic.md` 9.2):

| Idea | Where |
|---|---|
| Zoom history (back, forward) and one key that toggles between fitting the selection and fitting everything | Phase 3 |
| Cycle follows the selection (Logic's Auto Set Locators; also a Cubase preference) | Phase 3 |
| An optional hold-modifier second tool over the number-key tools | Phase 3, off by default |
| Click zones on the arrow tool (Cubase's own Combine Selection Tools is the same idea) | Phase 3 |
| One key that infers fade-in, fade-out or crossfade from the range | With E-9 |
| A gain change on a range that splits at its edges and applies clip gain | Phase 3 |
| Quick Swipe comping, and saved, named comps | M6b. A comp is a small plan: hashable, reviewable, auditioned on a branch, so an agent can propose one |
| Track alternatives sharing one strip, with inline audition | After M6b |
| Folder against summing stack as an explicit choice when grouping | M6c |
| A second inspector strip that follows the signal to the output or send target | M6c |
| Relative automation as a separate offset curve | Considered in M6a |

### 3.7 Audit against the Cubase must-haves

Every row of `research/cubase.md` section 9.1.

| # | Must-have | Where it lands |
|---|---|---|
| 1 | Play / stop on `Space`, visible project cursor | P1-2 |
| 2 | Timeline with a ruler split into locator half and cursor half | P1-3 (cursor half, drag-zoom), P1-7 (locator half) |
| 3 | Object Selection: select, move, resize from the lower corners | P1-3, P1-8. Sizing modes "moves contents" and "time stretch": phase 3 and not planned |
| 4 | Undo / redo with a visible history list | Keys and buttons P1-2; the list needs E-16 |
| 5 | Snap toggle and snap type menu | P1-8 (Grid); Events and the others phase 3 |
| 6 | Grid type tied to the time format, with Adapt to Zoom | P1-8 |
| 7 | Split at cursor and split tool | P1-8 |
| 8 | `Alt`-drag copy, duplicate, repeat | P1-8; repeat phase 3 |
| 9 | Horizontal and vertical zoom on keys and wheel | P1-3 |
| 10 | Zoom Full, Zoom to Selection | P1-3, P1-8 |
| 11 | Left and right locators with cycle | P1-7 on E-1 |
| 12 | Header with M, S, record enable, monitor, name | P1-3; record enable and monitor M6b |
| 13 | MixConsole in the lower zone and as a window | P1-4; window phase 5 |
| 14 | Strip: pan, M, S, e, fader, meter, peak value, name, colour | P1-4; `e` phase 3 |
| 15 | Fader with +6 dB top, `Ctrl`-click reset, `Shift` fine | P1-4 |
| 16 | Peak-hold meters, clickable peak readout, clip indication | P1-4 |
| 17 | Info line that shows and edits the selection | Shows P1-3; edits phase 3 |
| 18 | Inspector for the selected track | Basic P1-4; sections phase 3 |
| 19 | Zones that show and hide, with buttons and keys | P1-1 |
| 20 | Editor in the lower zone on double-click | Phase 3 |
| 21 | Fade handles and clip gain on the clip | Gain P1-8; fades E-9 |
| 22 | Crossfade on overlapping clips | E-9 |
| 23 | Range Selection tool with range operations | Phase 3 (compositions of existing commands) |
| 24 | Time display with switchable formats | P1-2 (Bars+Beats, Seconds); Samples phase 3; Timecode not planned |
| 25 | Record with punch and pre-roll | M6b |
| 26 | Metronome with count-in | P1-7 on E-1; count-in M6b |
| 27 | Tempo and time signature | Display P1-2; edit phase 3; signature E-10; tempo track later |
| 28 | Markers and cycle markers | E-8 |
| 29 | Automation R / W with lanes | M6a |
| 30 | Automation curve editing | M6a |
| 31 | Automation write modes | M6a |
| 32 | Inserts, EQ and sends as sections | Inserts phase 3; sends M6c; no built-in EQ is planned (an EQ is a plugin) |
| 33 | Folder tracks and group channels | M6c |
| 34 | Track height per track and globally | P1-3 |
| 35 | Track colours inherited by clips and channels | P1-3; user-chosen with E-2 |
| 36 | Track visibility and filtering, synced with the mixer | Phase 4 |
| 37 | Auto-scroll, suspended while editing | P1-2; stationary cursor phase 3 |
| 38 | Exclusive solo and Solo Defeat | Phase 3; defeat E-17 |
| 39 | Nudge on a separate nudge grid | Phase 3 |
| 40 | Rebindable key commands and tool modifiers | The layer and the Cubase preset P1-1; the editor phase 3 |

## 4. The AI-native parts

### 4.1 Principle

A plan is a set of changes to things the user can already see. So it is shown on those things. The right zone is for reading the plan as a whole and for deciding; the event display and the MixConsole are for judging each change in place.

### 4.2 Ghosts

Everything proposed is violet, dashed and hatched, and carries its step number.

| Change | In the event display | In the MixConsole and Inspector |
|---|---|---|
| Add track | Hatched lane and dashed header at its position | Dashed strip labelled "new" |
| Place clip | Ghost clip with waveform (the media already has peaks) | — |
| Move / trim clip | Original dims to 40 %, ghost at the new place, arrow between them | — |
| Remove clip or track | Original dims, cross-hatched in violet | Strip dims |
| Gain | Readout in the header shows `-9.0 → -6.0` | Ghost cap at the new position, joined to the real cap; the value shows both |
| Pan | — | Violet tick on the knob at the new angle |
| Mute / solo | Dashed ring on the button | Same |
| Rename | Header shows `FX → FX Riser` | Name shows both |
| Locators (with E-1) | Ghost band in the upper ruler | — |

Data: `plan.preview` already returns `{ref, before, after}` per entity against the current head. Ghosts are a pure function of that result and the snapshot, so **no protocol change is needed for ghosts**. The function lives beside `plans/describe.ts` and is unit-tested.

Linking: hovering a step highlights its ghosts and scrolls them into view; the target icon on a step row locates it. Clicking a ghost selects its step. Unticking a step removes its ghosts, so the picture always shows exactly what "Approve N of M" would do. A pill in the toolbar names the overlaid plan and toggles ghosts (`Ctrl+Alt+G`).

### 4.3 Audition

- The hearing switch (Main | Proposal) is at the top of the right zone and repeated in the status bar. `Shift+A` flips sides while a plan is auditioned. It always reflects `audition.changed`, never a guess.
- While the proposal is heard, the window gets a 2 px violet frame and a banner under the top bar: "Hearing proposal: Lift the chorus — main is unchanged. [Hear main] [Merge] [Discard]". Ghosts turn solid (they are what is playing) and the values they replace show as faint outlines.
- The branch chip in the top bar changes from `main r39` to the proposal's name.
- Branch state comes from `proposal.changed` and `session.fetch {refs, revision}` at the branch revision; both exist today.

### 4.4 Agent activity

- An agent row at the top of the Plans tab: name, transport (MCP), connected or not, and what it last did (needs E-14; until then the row shows the actor of the newest plan, and that needs E-7).
- The Inspector has an "Agent changes" section for the selected track: which applied plans touched it, and what is pending on it.
- A new plan raises a toast and the count on the Plans button. Nothing steals focus or opens by itself during playback.
- The "Ask the agent" box needs an agent runtime the architecture lists as not implemented. It is not in phases 1 to 4.

### 4.5 Answers to review section C

| | Question | Answer |
|---|---|---|
| C1 | Approval granularity; split against reject; dropped steps | Default approves the whole plan. Unticking steps turns the button into "Approve 4 of 6". The parent is shown as "Split, 4 of 6 approved", from the `parentPlan` sub-plans already carry. Dropped steps and a reason should go back to the agent (E-7) |
| C2 | Where plan review lives; notifications | Right zone, Plans tab (`Ctrl+Alt+P`), with the badge and toast of 4.4; a drawer under 1280 px |
| C3 | Proposal shown inline; branch state while auditioning | Yes to both (4.2, 4.3); no protocol change needed |
| C4 | Apply against Audition then Merge | Decided: one primary button at a time. Not auditioning: "Approve and apply" runs `plan.approve` then `plan.apply`. Auditioning: "Merge". Phase 1 chains today's methods, and the Audition button runs approve, propose, hear with the card reading "approved for audition". Auditioning without approval is E-6 |
| C5 | Editing while auditioning | Edits go to the side that is heard, as the engine already does for fader gestures; the frame and banner say so. Structural edits are disabled while a proposal is heard until `command.execute` can target the branch |
| C6 | Concurrent plans; stale approved plans | Any number may wait; one is auditioned at a time. After a merge, plans whose entities changed show "Stale" with the reason in user units and Approve disabled. An approved plan that goes stale returns to "Needs review" |
| C7 | Fader range; dB everywhere | Decided: -inf to +6 dB, 0 dB at 75 % of travel. Cubase's Volume Max defaults to +6 dB (`research/cubase.md` 5.4); Logic's maximum boost is +6 dB [M4]. A stored value above +6 dB pins the cap at the top and shows the true value in the warning colour. A +12 dB project setting, which Cubase also has, can follow |
| C8 | Restart semantics | The shell reopens the same bundle; a toast gives the recovered revision; selection is cleared. Plans live in engine memory, so a restart loses them and the panel says so (E-12 persists them) |
| C9 | Reject note to the agent | The field is labelled "Reason (sent to agent)". E-7 carries the note in plan status so the agent and every client see it |
| C10 | Seconds or bars and beats; snap | Bars+Beats primary, Seconds secondary, `.` swaps them; snap on (`J`), type Grid, grid Adapt to Zoom; `Ctrl` while resizing disables snap |

## 5. Rendering and performance architecture

### 5.1 What draws what

| Surface | Technology | Why |
|---|---|---|
| Top bar, tool row, track headers, mixer strip controls, inspector, plan panel, menus, dialogs, toasts | DOM with React 19, plain CSS files, tokens as custom properties | Text, focus, accessibility and layout are what the DOM is good at. ADR-0019 already says so |
| Event display: ruler, grid, clips, waveforms, ghosts, automation later | One imperative surface made of two stacked canvases | See 5.2 |
| Playhead, loop brace, selection, drag previews, snap guides | The overlay canvas of that surface (Canvas2D) | Moves every frame; must never re-rasterise waveforms |
| All meters in the mixer | One Canvas2D behind the strips, one draw call per frame for all channels | 64 strips with one canvas each means 64 backing stores and 64 compositor layers |
| Mini meters in the track headers | One narrow canvas down the header column | Same reason |
| Fader caps and knobs | DOM elements moved with `transform` from the gesture code, not from React state | Compositor-only movement; React renders a strip once per revision |
| Clip editor waveform (lower zone) | Same renderer class as the arrange surface | One implementation to make fast |

### 5.2 The event display surface

**One surface for the whole view, not a canvas per clip or per track.** A canvas per clip multiplies backing stores, makes cross-track drags and range selection awkward, and prevents batching. The surface is sized to the viewport, never to the session; scrolling changes a transform in the renderer, not a DOM scroll offset of a huge element.

Layers:

1. **Content layer**: grid, clips, waveforms, ghosts. Redrawn only when the snapshot, zoom, scroll, size or the selected plan changes.
2. **Overlay layer**: playhead, loop brace, selection, drag preview, snap guides. Redrawn every frame only while playing or during a gesture; otherwise the `requestAnimationFrame` loop is stopped and an idle window does no work.

**Phase 1 keeps Canvas2D for both layers.** It is the code that exists, and it is fast enough for the M5 scenario: at most one min/max column per device pixel, taken from the pyramid level whose bins are the widest that still fit a pixel (the rule the spec already states).

**Phase 4 moves the content layer to WebGL2, hand-written, with no library.**

- Clips are instanced quads: one draw call for all clip bodies, one for all title strips.
- Each media file's peak pyramid is uploaded once as an `R16I`/`RG16I` texture, one row per level. The fragment shader reads min and max for the pixel's column and fills between them, so zooming and scrolling upload nothing and cost one draw call for all visible waveforms.
- Text (clip names, ruler numbers) stays on the Canvas2D overlay. A glyph atlas is what VS Code's terminal did for a 5 to 45 times gain [R1], but a DAW shows a few hundred labels, not a screen of text; it is not worth the code yet.
- The Canvas2D content renderer is kept behind the same interface as the fallback when WebGL2 is unavailable or the context is lost. Figma's WebGPU renderer needed exactly this kind of mid-session fallback path [R2].

**Why not WebGPU.** The workload is a few thousand instanced quads and texture lookups; WebGL2 is not the limit. WebGL2 reaches 97 % of browsers [G1]. WebGPU is around 87 %, on Linux it depends on hardware and Chromium version, and Firefox has it on some platforms only [G2][G3]. The same frontend must serve a browser pointed at a Raspberry Pi class board (M7). Electron 44 ships Chromium 152 [E1], so WebGPU would work on the desktop, but a second renderer for no visible gain is not a good trade for a very small team. Revisit when a compute shader is needed (spectrograms).

**Why not a worker with OffscreenCanvas.** `transferControlToOffscreen` is broadly available [G4], but a worker-rendered canvas is not presented in step with DOM layout: track headers (DOM) and lanes (worker canvas) would drift by a frame during vertical scroll and resize [G5]. Hit-testing and gesture state would also have to cross a message boundary. The main thread is kept light instead: React does nothing per frame, and the heavy non-visual work goes to a worker (5.4). Revisit only if the budget in 5.6 fails on the reference machine after phase 4.

**`desynchronized: true`** is used on the overlay canvas only (low-latency hint for the playhead and drag previews), where tearing against the DOM does not matter. Chrome requires that a canvas with alpha has nothing above it, so toasts and menus must not overlap it or the hint is silently dropped [G6].

### 5.3 Meters at display rate without React

`SMTR` frame → `RealtimeClient` → `MeterStore`, a plain object holding `Float32Array`s for peak, RMS, hold and clip per legend index. No event is emitted to React. The mixer's meter canvas and the header meter canvas each run one `requestAnimationFrame` callback that reads the arrays, applies ballistics (`peak-hold.ts`) with the frame's time delta, and draws rectangles. The same store gives the playhead position to the arrange overlay and to the transport display, which writes its digits with `textContent` on a ref. React hears about transport only when `playing` flips.

The engine sends one frame per tick and drops frames for a congested socket; the display interpolates nothing and simply draws the newest values. When the window is hidden the loops stop.

### 5.4 Worker use

One worker, plain `postMessage` with transferables, no library:

- fetches and parses peak files (`GET /v0/peaks/<hash>`), handles the `peaks_pending` retry, and hands back `Int16Array`s per level;
- holds the LRU of parsed pyramids;
- later computes ghost waveforms and anything else that would block input.

The realtime socket stays on the main thread: its frames are a few hundred bytes and must reach the draw loop without a hop.

### 5.5 React discipline

- The read model stays the only store (`useSyncExternalStore` with selectors [X1]). A selector returns the same object when its entity did not change, so a fader commit re-renders one strip and one header.
- Lists of headers and strips are keyed by track id and wrapped in `memo`. With `@tanstack/react-virtual` (phase 4) only visible ones are mounted.
- `content-visibility: auto` on plan history rows and off-screen panels [C2].
- No React Compiler for now: it is stable [X2] but ships as a Babel plugin, and the build is esbuild plus `tsc` with no Babel step.

### 5.6 Budgets

| What | Budget | How it is measured |
|---|---|---|
| Frame time while playing, 64 tracks, 2,000 clips, meters running | 60 fps; main-thread work per frame under 4 ms at the median and under 8 ms at the 99th percentile | Playwright perf scenario reading `performance.measure` marks through the test hook |
| Scroll or zoom the event display | no frame over 16.7 ms on the reference machine (phase 4 target; phase 1 target is 32 tracks) | same |
| Fader: pointer move to cap movement | same frame | by construction (transform in the pointer handler) |
| Fader: pointer move to `gesture.update` on the wire | under 20 ms; at most one update per animation frame, latest value wins | unit test on the gesture controller's coalescing |
| Meter: frame received to drawn | under two display frames | timestamp in the test hook |
| React commits while playing with no edits | zero | React Profiler count in the perf scenario |
| Idle window (stopped, no pointer) | no `requestAnimationFrame` callbacks | test hook counter |
| Memory | parsed peaks LRU capped at 256 MB; GPU textures at 128 MB; JS heap under 300 MB on the 64-track session | `performance.memory` in the scenario |
| Cold start to first painted session | under 1.5 s after the engine is ready | e2e timing |

### 5.7 Electron settings

- Keep hardware acceleration on (default). At start, read `app.getGPUFeatureStatus()` after `gpu-info-update` and show it in About; if WebGL2 is unavailable, the renderer takes the Canvas2D path and the status bar says "software rendering" [E2].
- `webPreferences.backgroundThrottling: false` for the main window [E4], so meters and the transport display keep running when the DAW is behind a plugin editor window, which is the normal state while mixing. The draw loops still stop on `document.hidden` (minimised).
- `powerSaveBlocker.start('prevent-app-suspension')` while recording or rendering [E3].
- No undocumented Chromium switches. `ignore-gpu-blocklist`, `enable-zero-copy` and similar are not in Electron's documented list [E5] and trade crashes on bad drivers for speed on good ones. `--force_high_performance_gpu` is documented, but it costs laptop battery for a 2D workload; leave the OS choice alone.
- CSP stays as it is. Fonts are local files; add `font-src 'self'` and `worker-src 'self'` explicitly.

### 5.8 Remote browsers

Phase 1 guarantee: the renderer uses web-platform APIs only. Its single contact with Electron is the existing endpoint bridge (`window.siann.engine.current/onChange`, used in `index.tsx` to learn the engine's port and token). Phase 1 adds no other use of the preload, no IPC, and nothing from `electron`. A unit test fails if any renderer file other than `index.tsx` mentions `window.siann`, and an e2e loads the built bundle in a plain Chromium tab (Playwright's browser, not Electron) and checks that the shell renders its disconnected state without an exception.

What phase 1 does not deliver is a tab talking to a real engine. The engine accepts only the Origin `siann://app` today (`allowedOrigins` in `protocol_server.hpp`; I found no command-line option for it), and nothing serves the bundle over HTTP. Both belong to `m7-lan-mode` and are listed as E-15 in section 7. The shell-only settings of 5.7 (`backgroundThrottling`, `powerSaveBlocker`) are main-process code and have no browser counterpart to break.

Same bundle. Differences are capabilities, not forks: WebGL2 or the Canvas2D fallback; no native plugin editors (generic parameter view instead); pointer events cover touch; container queries give a tablet layout where the lower zone becomes full-screen tabs. Safari is the practical floor for iPads: WebGL2 since 15, OffscreenCanvas since 17 [G1][G4]. The CSS used here (container queries, `color-mix()`, `oklch()`, `@property`, Popover) is at or above 94 % support; CSS anchor positioning is still partial and is avoided [C1][C3].

### 5.9 Libraries

| Need | Choice | Licence | Note |
|---|---|---|---|
| Resizable zones | `react-resizable-panels` 4.x | MIT, 0 runtime dependencies [L1] | Named in ADR-0019 point 5. Keyboard-accessible dividers and persistence would be more code hand-rolled |
| Virtual lists | `@tanstack/react-virtual` 3.x, phase 4 only | MIT, 1 dependency (its own core) [L1] | Named in ADR-0019 |
| Docking | none | — | Zones with draggable boundaries (2.2, 2.3) |
| GPU drawing | none; hand-written WebGL2 | — | The renderer needs two shader programs. `regl` (38 kB gz) or `twgl.js` (23 kB gz) would save little; PixiJS (282 kB gz, 10 dependencies) and three.js are scene graphs this does not need [L2] |
| Waveforms | none; the engine's peak pyramid is the format | — | `peaks.js` and `waveform-data` are LGPL-3.0 and bring their own data format; `wavesurfer.js` (BSD-3) is a player widget, not a timeline [L3] |
| Menus, popovers, dialogs, tooltips | none; native `<dialog>`, the Popover API and a small positioning helper | — | If context menus with submenus grow past about 400 lines, adopt Base UI (`@base-ui/react`, MIT) and record it in the ADR [L4] |
| State | none; the read model | — | ADR-0019 |
| Internationalisation | none; typed catalogs and the platform's `Intl` | — | Three locales and a few hundred strings do not need i18next or FormatJS; `tsc` checks completeness (section 6) |
| Icons | Lucide SVG files copied in | ISC [F4] | No package |
| Fonts | Inter, JetBrains Mono `.woff2`; system fonts for Chinese | OFL-1.1 [F1][F2] | Licence files shipped beside them; Noto Sans TC/SC not bundled (6.4) |

All of these are compatible with GPL-2.0-or-later and with AGPLv3 distribution. No code is taken from openDAW or GridSound; both are AGPL-3.0 [L5], which would be compatible with the distributed build but would bind SIANN's own GPL-2.0-or-later frontend code to AGPL terms, and the spec already rules it out.

## 6. Internationalisation

Maintainer decision: three languages from phase 1.

### 6.1 Locales

| Locale | Tag | Chosen when the system language is |
|---|---|---|
| English | `en` | anything else |
| Traditional Chinese | `zh-Hant` (shown as 繁體中文) | `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant-*` |
| Simplified Chinese | `zh-Hans` (shown as 简体中文) | `zh-CN`, `zh-SG`, `zh-Hans-*`, bare `zh` |

- The locale follows the OS: the renderer reads `navigator.languages`, which Electron fills from the system and a browser from its own settings, so the same code serves both.
- A manual switch in the status bar (and in Settings once a Settings dialog exists) overrides it; the choice is stored per user (`siann.locale`), beside the layout. Switching is live, with no restart.
- `<html lang>` is set to `zh-TW` or `zh-CN` for the Chinese locales. This is not cosmetic: Han characters share code points, and without the language tag the system picks one regional glyph set for all of them. A Cubase 15 forum thread reports exactly that defect, Japanese UI drawn with Chinese glyph shapes [I3].

### 6.2 How strings work

- **No library.** `renderer/i18n/` holds one catalog per locale as a typed object; `en.ts` defines the type, so `tsc` refuses a catalog with a missing or extra key. Messages are strings with named placeholders, or functions where grammar needs one. Plurals use `Intl.PluralRules` (English needs them, Chinese does not), relative times `Intl.RelativeTimeFormat`.
- `t(key, params)` reads a small locale store through `useSyncExternalStore`; the canvas surfaces take the same function and redraw on a locale change.
- **Formatters are locale-aware where language is involved and fixed where it is not.** dB values, pan as `L35` / `C` / `R40`, bar.beat.tick positions, sample rates and the letters M, S, R, W, e are the same in all three locales, as they are on hardware and in Cubase. Words around them (units spelled out, "muted", "bar") come from the catalog.
- **Plan step descriptions** are built by `plans/describe.ts` from catalog entries, so "Vox BG gain −9.0 dB → −6.0 dB" and "Vox BG 音量 −9.0 dB → −6.0 dB" come from the same code path. Text an agent wrote (a plan's intent, a clip name) is shown as written and never translated. P1-0 keeps today's English wording ("Set gain of Vox BG to -9.00 dB"); the wording shown here arrives with P1-5.
- **Engine errors** are shown from their stable `code`, as a refusal line `<code>: <text>` that keeps the code in front in every locale (it is a protocol token, like `track.set_gain` in a step, and what a bug report quotes). In the Chinese locales the text of a known code comes from the catalog. In English it is the engine's own message, which is already English and names the specifics (the stale entities, the missing media); the English catalog entry is used only when the engine sent no message. This keeps today's English wording, as P1-0 does for steps (acceptance of P1-0: no English wording change in the tour). An unknown code shows the engine's message in every locale. The Chinese text does not carry the engine's specifics: the refusal sits beside the surface that shows them (a stale diff row, the clip).
- **Session content is not chrome.** Track, clip, plugin and marker names are the user's.

### 6.3 Tests

- **No literals:** a unit test walks the renderer's `.ts` and `.tsx` sources with the TypeScript compiler API (already a dev dependency) and fails on JSX text, on string literals and on the literal text of template literals in `title`, `aria-label`, `placeholder` and `alt` and in the first argument of `fillText`. An allow-list covers the fixed symbols of 6.2.
- **Catalog completeness:** `tsc` enforces the key set; a unit test adds what types cannot see: every placeholder of the English message appears in the other two, no value is empty, no Chinese catalog value is identical to the English one unless allow-listed, and `zh-Hant` contains no Simplified-only characters and the reverse (a small table of common pairs such as 轨/軌, 声/聲, 发/發, 独/獨, 静/靜, 环/環, 设/設, 档/檔).
- **Fit:** an e2e runs the shell in each locale, and in a pseudo-locale that pads every English string by 40 %, at 1440x900 and 1024x700 and asserts that no labelled control has `scrollWidth > clientWidth` and no text is clipped. Layouts are sized for the longest of the three; controls that hold words grow with their content, and only numeric fields have fixed widths.
- **The tour runs per locale:** `SIANN_UX_LOCALE=en|zh-Hant|zh-Hans` writes the states into a folder per locale. Every ticket attaches its changed states in all three.

### 6.4 Fonts for Chinese: system fonts, not bundled

Recommendation: **use the system's Chinese UI fonts; do not bundle Noto Sans TC and SC.**

```css
:root            { --font-ui: "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
:root:lang(zh-TW){ --font-ui: "Inter", "PingFang TC", "Microsoft JhengHei UI", "Noto Sans TC", "Noto Sans CJK TC", sans-serif; }
:root:lang(zh-CN){ --font-ui: "Inter", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", "Noto Sans CJK SC", sans-serif; }
```

- Inter stays first, so Latin letters and above all digits are the same in every locale and stay tabular. Han glyphs fall through to the platform font: PingFang on macOS, Microsoft JhengHei UI / YaHei UI on Windows, Noto Sans CJK on Linux.
- Why not bundle: each Noto Sans CJK family is several megabytes per weight even as `woff2`, and the UI uses three weights in two scripts. Install size does not matter here, but a remote browser on a LAN would download it before first paint, and subsetting to keep it small breaks on the first track name outside the subset. The system fonts are hinted for small sizes on their own platform, which matters at 11–12 px.
- Cost of this choice: text metrics differ per OS, so the tour is reviewed per OS for the Chinese locales, and a Linux machine without CJK fonts shows boxes. The About panel checks `document.fonts.check` for a Chinese sample and says which package to install; the M7 board image must include `fonts-noto-cjk`. Bundling one subsetted family is the fallback if that proves fragile.
- Chinese text is never set below 11 px and never letter-spaced or upper-cased; the 10 px upper-case micro labels of the English UI become 11 px plain labels. Line height is 1.4 for Chinese. JhengHei and YaHei have Regular and Bold only, so weight 500 renders as Regular and 600 as Bold; hierarchy must not depend on the difference between 500 and 600.

### 6.5 Glossary

**Status of the Cubase terms.** I could not read Cubase's Chinese interface. Retail listings say Cubase 15 ships a "Chinese" UI without saying which script [I2]. Steinberg's help site publishes no Chinese Cubase manual: its public document list has none, although the site carries a few `zh-CN` and `zh-TW` pages of other kinds [I1]. So the terms below are the ones in common professional use in each region, written to agree with Cubase's vocabulary where I know it, and **every row is to be confirmed by the maintainer against a Cubase running in Chinese** (a human gate in `features.json`). The catalogs make any correction a one-line change.

| English | 繁體中文 (zh-Hant) | 简体中文 (zh-Hans) | Note |
|---|---|---|---|
| Track | 音軌 | 音轨 | |
| Clip (Cubase: event) | 片段 | 片段 | Cubase's Chinese UI is expected to say 事件; SIANN's protocol says clip |
| Project zone / left / lower / right zone | 專案區 / 左側區 / 下方區 / 右側區 | 工程区 / 左区 / 下区 / 右区 | |
| Inspector | 檢視器 | 检查器 | |
| MixConsole (mixer) | 混音台 | 调音台 | |
| Channel | 通道 | 通道 | |
| Fader | 推桿 | 推子 | |
| Volume / level | 音量 / 電平 | 音量 / 电平 | |
| Pan | 聲相 | 声像 | |
| Mute | 靜音 | 静音 | Button stays **M** |
| Solo | 獨奏 | 独奏 | Button stays **S** |
| Record / record enable | 錄音 / 啟用錄音 | 录音 / 录音启用 | |
| Monitor | 監聽 | 监听 | |
| Insert | 插入效果 | 插入效果 | |
| Send | 傳送 | 发送 | |
| Routing | 路由 | 路由 | |
| Meter / peak / clipping | 電平表 / 峰值 / 削波 | 电平表 / 峰值 / 削波 | |
| Transport | 走帶控制 | 走带控制 | |
| Project cursor | 播放游標 | 播放光标 | |
| Cycle | 循環 | 循环 | |
| Left / right locator | 左 / 右定位點 | 左 / 右定位器 | |
| Metronome / click | 節拍器 | 节拍器 | |
| Tempo / time signature | 速度 / 拍號 | 速度 / 拍号 | |
| Bar / beat | 小節 / 拍 | 小节 / 拍 | |
| Snap / grid | 貼齊 / 格線 | 吸附 / 网格 | |
| Marker | 標記 | 标记 | |
| Tools: select / range / split / glue / erase / zoom / mute / draw / play | 選取 / 範圍 / 分割 / 黏合 / 擦除 / 縮放 / 靜音 / 繪製 / 播放 | 选择 / 范围 / 拆分 / 粘合 / 擦除 / 缩放 / 静音 / 绘制 / 播放 | |
| Fade in / fade out / crossfade | 淡入 / 淡出 / 交叉淡化 | 淡入 / 淡出 / 交叉淡化 | |
| Duplicate / repeat | 再製 / 重複 | 复制 / 重复 | |
| Undo / redo | 復原 / 重做 | 撤销 / 重做 | |
| Automation; read / write | 自動化；讀取 / 寫入 | 自动化；读 / 写 | Buttons stay **R** / **W** |
| Session (Cubase: project) | 專案 | 工程 | |
| Revision | 修訂 | 修订 | |
| Plan | 計畫 | 计划 | |
| Proposal | 提案 | 提案 | |
| Step | 步驟 | 步骤 | |
| Approve / reject | 核准 / 拒絕 | 批准 / 拒绝 | |
| Audition | 試聽 | 试听 | |
| Merge / discard | 合併 / 捨棄 | 合并 / 放弃 | |
| Needs review / applied / rejected / stale | 待審核 / 已套用 / 已拒絕 / 已過期 | 待审核 / 已应用 / 已拒绝 / 已过期 | |
| Agent | 代理 | 智能体 | |
| Main (the branch) | 主線 | 主线 | |
| Hearing | 監聽中 | 监听中 | |
| Engine connected / disconnected | 引擎已連線 / 引擎已中斷 | 引擎已连接 / 引擎已断开 | |
| Audio device / sample rate / buffer | 音訊裝置 / 取樣率 / 緩衝區 | 音频设备 / 采样率 / 缓冲区 | |
| Source (code) / licence | 原始碼 / 授權 | 源代码 / 许可证 | |

## 7. Implementation plan

Conventions for every ticket: unit tests run under `node --test` in `app/test/unit`; e2e are Playwright Electron specs in `app/test/e2e`. Existing `data-testid`s keep working or the spec that uses them changes in the same PR. Every string a ticket adds goes into the three catalogs.

**The screenshot tour is the visual gate.** `app/test/e2e/ux-tour.spec.ts` (run with `SIANN_UX_TOUR=1`) stays a scripted tour that writes one PNG per state plus `index.json`, now once per locale. Every phase 1 ticket names the tour states it changes (numbers as in the `index.json` that `ux-tour.spec.ts` writes), and its PR attaches before and after PNGs of each in all three locales. A state the ticket did not name must come out unchanged; an unnamed state that changed blocks the PR. The comparison is by eye, by the reviewer and at the end by the maintainer. Pixel assertions are not added, because font rasterisation differs between Windows, macOS and the Linux runners. New states are appended, never renumbered.

**Protocol.** P1-0 to P1-6 and P1-8 need no protocol or engine change; the "Protocol used" line lists what each one calls, all served by the engine today. P1-7 waits on E-1 and nothing else in phase 1 waits on it.

The harness entries for these tickets are in `.claude/milestones/M5.json`.

### Phase 1 — a Cubase-shaped shell for M5 exit

**P1-0 Internationalisation** (`m5-ui-i18n`)

- Scope: `renderer/i18n/` with typed catalogs for `en`, `zh-Hant`, `zh-Hans`; locale store, detection from `navigator.languages`, manual switch, `<html lang>`; `t()` for React and for the canvas surfaces; every existing renderer string moved into the catalogs; creates `plans/describe.ts` (step wording moved out of `plans/diff.ts`) and `format.ts`; adds catalog-backed message builders for toasts, engine error codes and relative times with unit tests per locale (the toast surface and the plan-card times come with P1-5 and P1-6); the switch is added to the existing `StatusPanel` (P1-1 moves it into the status bar); the `:lang(zh-TW)` and `:lang(zh-CN)` font stacks of 6.4 (the `:root` English stack and the tokens come with P1-1); the tour's per-locale run and the pseudo-locale.
- Acceptance: the no-literal test and the completeness test of 6.3 pass; switching the language changes every visible string without a reload and survives a restart; with the OS in `zh-TW` the first launch is in Traditional Chinese; numbers, dB values, pan values and M/S letters are identical in all three locales.
- Tests: unit (no literals; completeness; locale mapping for a table of system tags; step descriptions per locale; plural and relative-time helpers); e2e (switch language; fit check in three locales and the pseudo-locale).
- Tour states changed: in English, 01–22 gain only the language switch in the status panel (no English wording, order or other layout changes); adds the `zh-Hant` and `zh-Hans` sets of 01–22. The English set moves to `<SIANN_UX_OUT>/en/`.
- Protocol used: none.
- Risks: the glossary is unconfirmed (human gate `zh-glossary`); doing this first costs a few days but every later ticket would otherwise have to be retrofitted.

**P1-1 Tokens, fonts, zones and the key-command layer** (`m5-ui-shell`)

- Scope: `tokens.css`; local Inter and JetBrains Mono with licence files; the zone shell of section 2 (project zone never hidden; left, lower and right zones; the three zone boundaries of 2.3 (left zone / project zone, project zone / lower zone, project zone / right zone) draggable and collapsible with `react-resizable-panels`; `siann.layout.v1`); the zone buttons for the left, lower and right zones (the Channel button arrives with the Channel tab in phase 3, by the rule of 3.0) and `Ctrl+Alt+L` / `Alt+I`, `Ctrl+Alt+E` / `Ctrl+Alt+B` / `Alt+F3` / `F3`, `Ctrl+Alt+R`, `Ctrl+Alt+P`; zone focus with `Tab` / `Shift+Tab` and `F6` / `Shift+F6`, the in-zone `Tab` order with `Enter` and `Escape` (2.1) and the focus frame; the command registry, the "Cubase" preset table and the dispatcher of 3.6; the capability rule of 3.0 as one selector; the status bar of 2.1 (device, latency and xruns polled from `engine.status`, the side heard, the diagnostics moved to About) and About from `engine.about`; `backgroundThrottling: false`.
- Acceptance: at 1440x900 and 1024x700 nothing scrolls the page and every zone scrolls internally; the three zone boundaries of 2.3 (left zone / project zone, project zone / lower zone, project zone / right zone) each drag within their stated range, collapse below their minimum and restore, and work from the keyboard (2.1 and 2.3: reached by `Tab` from its zone, arrows 8 px, `Shift` 32 px, `Home` / `End`, `Enter` restores the default); double-click restores the default; sizes, collapsed states and tabs survive a restart and are the same for a different session; nothing about layout is sent to the engine; the project zone cannot be hidden; each zone key toggles its zone (`Alt+F3` and `F3` show the lower zone on the MixConsole tab, and hide it when it is already showing that tab), `Ctrl+Alt+P` shows the right zone on the Plans tab, and `Tab` (from a zone) and `F6` move the focus frame while `Tab` inside a zone walks its controls and stays there; a key bound in the preset reaches the focused zone first and never fires while typing in a field; the licence line shows exactly what the engine reports; only `index.tsx` references `window.siann` and the bundle renders its disconnected state in a plain Chromium tab.
- Tests: unit (layout reducer; key dispatcher with zone focus; the focus keys' moves; preset table has no duplicate binding per zone; licence line for both licence values and no licence literal in the source; `window.siann` reference check); e2e (resize, collapse, restart persistence, zone keys, focus cycle, every divider and a zone's controls reached by real key presses from the zone, plain-tab load).
- Tour states changed: all of 01–22 (every screenshot gets the new shell); the ticket's own review looks at 01, 02, 03, 05.
- Protocol used: `engine.about`, `engine.capabilities`, the auth reply.
- Risks: existing e2e selectors move; the new dependency needs the two-week-old pin rule.

**P1-2 Transport and project cursor** (`m5-ui-transport`)

- Scope: start/stop, stop, go to start in the top bar; `Space`, numpad `Enter`, `Num 0`, `Num .` and `,`; position display in Bars+Beats and Seconds, `.` to exchange, `Shift+P` to type; the project cursor on the overlay layer; click in the lower half of the ruler to locate; auto-scroll in page mode on `F`, suspended during a drag; undo and redo with `Ctrl+Z` / `Ctrl+Shift+Z`.
- Acceptance: `Space` toggles playback; the cursor and the display run at display rate with zero React commits; locating while stopped moves the cursor; at 120 BPM the display reads 3.1.000 at 4 s; with auto-scroll on, the view pages when the cursor leaves it and does not move during a clip drag; with no audio device the transport is disabled and its tooltip says why.
- Tests: unit (frames to bars.beats.ticks across a tempo change; auto-scroll paging decision); e2e (play, locate, stop on the fake device; typed position).
- Tour states changed: 04; the top bar in every state.
- Protocol used: `transport.play/stop/locate`, the realtime playhead and playing flag, `session.undo/redo`, `root.tempo`.

**P1-3 Track list and event display** (`m5-ui-arrange`)

- Scope: fixed track list (colour, number, name with rename, M, S, gain and pan readout, mini meter; `+` and `T` add a track; height by dragging the lower border, `Ctrl` for all); canvas sized to its container; content and overlay layers; Bars+Beats ruler in two halves with drag-zoom in the lower half; read-only info line; clip title strips; three-tone clips from the track colour; selection outline; drag tooltip; `H` / `G`, `Shift+H` / `Shift+G`, `Shift+F`, `Ctrl`+wheel, `Ctrl+Shift`+wheel, `Shift`+wheel, zoom slider; dimming of muted and implicitly muted lanes; empty-session guidance.
- Acceptance: track names are never covered by clips; each zoom and scroll gesture changes the view as section 3.2 says and never scrolls the page; zoom keeps the position under the pointer fixed; a frame in which only the cursor moved does not redraw the content layer; clip move, trim, place and delete still commit one revision each; the track list / event display boundary drags within 140–420 px, never collapses, moves with the arrow keys and restores 216 px on double-click, and its size is stored in `siann.layout.v1`; review items A2, A14, A15, B12, B13, B14 are closed.
- Tests: unit (geometry, zoom about a point, ruler subdivision, colour assignment, info-line values); e2e (each zoom gesture, scroll, drag with tooltip, rename, track height).
- Tour states changed: 01, 02, 06, 10, 11, 12.
- Protocol used: `command.execute` with `clip.move/trim/place/remove`, `track.rename`, `track.add`, `track.set_mute/solo`; `GET /v0/peaks/<hash>`.
- Risks: the largest ticket; may land as two PRs (track list and layers, then ruler and zoom).

**P1-4 MixConsole and Inspector basics** (`m5-ui-mixer`)

- Scope: lower-zone strips in track order with Cubase's layout (pan, M S, fader with meter, level and peak values, name on the colour); fader on `taper.ts` with its top changed from +12 to +6 dB; `Ctrl`-click reset, `Shift` fine, double-click to type, wheel, value tooltip, for every value control; one meter canvas with peak hold, clip indication, and a peak value that resets on click; meter-only master strip; the Inspector's Track tab with name, colour, M, S, volume and pan built from the same controls.
- Acceptance: one revision per fader gesture, as today, and a held fader keeps its lease; values are dB with one decimal and L/C/R; `Ctrl`-click sets 0.0 dB or C in one revision; a stored gain above +6 dB pins the cap at the top and shows the true value; meters draw at display rate with zero React commits; the Inspector and the strip of the selected track always agree; review items A3, A4, A5, A16, A17, B11, B17 are closed.
- Tests: unit (taper with the +6 dB top, format, peak hold, knob mapping); e2e (drag, `Shift`-drag, `Ctrl`-click, typed value, wheel).
- Tour states changed: 04, 07, 08, 09.
- Protocol used: `gesture.*`, `command.execute` with `track.set_gain/pan/mute/solo`, realtime meter frames, `meters.legend` including `master`.

**P1-5 Plans tab** (`m5-ui-plan-panel`)

- Scope: plan cards with first step, step count, relative time, state badge and short hash; steps in user wording, numbered from 1, with select all and none; only the actions valid in the current state, one filled primary; "Approve and apply" and "Audition" as chains of today's methods; reason field on reject; hearing switch and a persistent banner while a proposal is heard; stale badge with the reason and Approve disabled; "split" label from `parentPlan`; raw JSON behind a disclosure; toast and badge on a new plan.
- Acceptance: no milli-dB, pan units or entity ids are visible without opening a disclosure; "Approve and apply" sends `plan.approve` then `plan.apply`, and a refusal of the second leaves the plan approved and is shown; "Audition" sends approve, propose, hear and the card reads "approved for audition"; the banner is visible from the event display and the MixConsole whenever `audition.changed` reports a branch; review items A6 (banner), A7–A9, A12, A13, B4–B10 are closed.
- Tests: unit (diff, wording per locale, action set per state, chained actions with a refusal at each position, toasts); e2e (MCP submit, partial approve, reject with reason, stale).
- Tour states changed: 13–20.
- Protocol used: `plan.list/preview/status/approve/reject/apply/propose`, `audition.hear`, `proposal.merge/discard`; events `plan.changed`, `audition.changed`.

**P1-6 Connection states** (`m5-ui-connection`)

- Scope: full-width banner and inert, dimmed zones while disconnected; toast on reconnect with the recovered revision; selection cleared.
- The start: while the window waits for its first connection to the shell's engine it shows no banner, so a normal launch does not flash one. That wait is bounded: a failed launch the shell reports (its endpoint bridge announces no endpoint after an exit, a protocol error or giving up), a first connection that fails after its socket opened, or 10 s without a connection end it, and from then on the window is disconnected as above. The first connection after a failed start is no reconnect (no toast). A plain tab has no shell and is disconnected from the start.
- Acceptance: no control sends a request while disconnected; review items A10, A11 are closed.
- Tests: e2e on the existing crash scenario, and on a first launch that fails.
- Tour states changed: 21, 22.
- Protocol used: the connection state of `SessionClient`.

**E-1 Engine and protocol: locators, cycle and metronome** (`m5-ui-engine-loop-click`; engine work, its own PR series)

- Scope, for the engine's design review:
  - **Locators are session data** (maintainer decision). A document entity holds the left and right locator as audio-domain frames. A command `session.set_locators {left, right}` changes them through `command.execute`, so the change is one revision, journaled, undoable, reachable from plans and MCP, announced by `session.changed`, and restored when the session opens. Shape (gate locators-entity-shape, resolved 2026-11-13): a singleton entity `locators` with ID `locators`, `{left, right}` as decimal strings, so `changedIds` names `locators:locators`. The document format becomes `siann.session_document.v2`; a v1 bundle opens through a migration that adds nothing (no locators until first set, every recorded hash kept) and is written as v2 at its next checkpoint. `0 <= left < right <= 2^42` is enforced (`invalid_locators`).
  - **Cycle on/off is transport state**: `transport.set_cycle {enabled}`. Playback wraps from the right locator to the left sample-accurately while enabled. Not a revision, so toggling does not fill the undo history. The flag is written into the checkpoint (`transport: {cycle}`, absent means false) with every checkpoint write (`session.save` and the automatic checkpoint every 50 revisions), not when it is toggled, so a reopened session has the cycle state of its last checkpoint (open question 11's default). The engine host keeps it across device changes and takes it from the session on `session.open`.
  - **Metronome**: `transport.set_click {enabled, gainMilliDb?}`. The click is generated by the graph driver from the tempo map at the session rate, added after the graph's output (so after the master meter) and before device-side SRC, only while playing, and never reaches renders or bounces (the offline driver has no click path). Beat n starts at `TempoMap::toAudio(n * 1920)`; until E-10 the accent falls every fourth beat from tick 0. The sound is a 10 ms decaying sine, 1760 Hz accented and 880 Hz otherwise. `gainMilliDb` is an integer in [-60000, 0], default -12000; omitted keeps the current value. The click state is not stored in the bundle.
  - Cycle and click states are reported in the results of the `transport.*` methods and in `engine.status`, and a `transport.changed` event is published when either changes, whoever asked. `engine.capabilities` lists the methods and `features.locators`, `features.cycle`, `features.click`. MCP tools wrap the two transport methods in the propose scope.
  - The renderer's read model and its fixture generator learn the `locators` entity in this ticket (no visible UI; tour states unchanged), so the existing shell keeps working once any client sets locators. The same applies to the Node plan hasher's `ENTITY_TYPES` in `src/hash/plan-hash.js`.
- Acceptance: setting the locators commits one revision whose undo restores the previous pair; a session saved with locators and reopened reports the same pair; a plan step may set them and `plan.preview` shows the entity; a 4-bar cycle plays 100 passes with no gap or drift at the wrap (null test against the same audio laid end to end); the click lands on the beat within one sample across a tempo change; a render started with the click on contains no click; a second client sees `session.changed` for the locators and `transport.changed` for cycle and click.
- Tests: command tests (validation, undo, journal replay); session round trip, a literal v1 bundle, and the cycle flag across a checkpoint; engine integration on the fake device (no click in renders, cycle and click across `engine.select_device`, the cycle flag of a bundle `session.open` opens); protocol tests for the methods, error codes and events; MCP wrapper tests; the renderer read model with a `locators` ref.
- Risks: the wrap interacts with disk-stream read-ahead; `m6b-punch-loop` must reuse these locators for punch, not define another range.

**P1-7 Locators, cycle and metronome in the UI** (`m5-ui-loop-click`; depends on E-1)

- Scope: the upper half of the ruler as section 3.2 describes (draw, move, adjust, `Ctrl`-click and `Alt`-click, click to toggle cycle); the tint over the tracks; cycle button and `Num /` and `/`; `P` locators to selection and `Alt+P` loop selection; `Num 1` / `Num 2` and `Shift+1` / `Shift+2`; `Ctrl+Num 1` / `Ctrl+Num 2`; the locator display; metronome button and `C`, with a level control on right-click. All of it renders only when the engine lists the methods.
- Acceptance: the band and both buttons always show the engine's state, including changes by another client, an undo, or an agent's plan; drawing the range sends one `session.set_locators` on release, and `Ctrl+Z` restores the previous range; reopening the session shows the same range; against an engine without E-1 none of the controls is rendered and no request is sent.
- Tests: unit (band geometry, snapping, capability gate); e2e (draw, move, toggle, undo, reopen; toggle the click; the same spec against capabilities without the methods).
- Tour states changed: none of 01–22; appends 23 "locators set, cycle on" and 24 "metronome on".
- Protocol used: `command.execute` with `session.set_locators`, `transport.set_cycle`, `transport.set_click`, `transport.changed`, `engine.status`.

**P1-8 Editing by Cubase's gestures** (`m5-ui-edit-basics`)

- Scope: tools `1` and `3`; `Alt`-drag copy; `Ctrl`-drag constrain; `Alt`-click and `Alt+X` split; `Ctrl+D` duplicate; resize from the lower corners with `Ctrl` to disable snap; the clip volume control; snap on `J` with type Grid and grid types Bar, Beat and Adapt to Zoom; `Shift`-click and `Ctrl+A` selection; `L`, `N`, `B`; `Alt+S` and `Shift+E`; `M` and `S` on the selected track; track selection; `Shift+Delete` with confirmation.
- Acceptance: each operation commits exactly one revision and one undo restores the previous state; a split at bar 3 of a clip with a non-zero source offset yields two clips whose audio is continuous (the right piece's `sourceStart` is the left piece's plus its length); a duplicate of several clips lands as one unit directly after the selection; with snap on and grid Bar, a dragged clip lands on bar lines and `Ctrl` while resizing ignores the grid; Adapt to Zoom changes the grid step when zooming.
- Tests: unit (a command builder per operation, following `clip-commands.test.ts`; snap maths per grid type); e2e (each operation, asserting one revision and a correct undo).
- Tour states changed: 10, 11, 12 (handles and snapped positions); appends 25 "clip split and duplicated".
- Protocol used: `command.execute` with `clip.place/trim/move/remove/set_gain`, `track.set_mute/solo`, `track.remove`.
- Risks: the largest gesture surface in phase 1; the tool-modifier table from P1-1 keeps it in one place.

Phase 1 ends with the maintainer's review of the tour in three locales (human gate `ui-redesign-review`) and the confirmation of the glossary (`zh-glossary`).

### Phase 2 — plan review in place (no protocol change)

Harness: P2-1 and P2-2 are `m5b-ui-ghosts`, P2-3 is `m5b-ui-audition` (M5b, section "Usable release" below).

- **P2-1 Ghost model.** Pure function from `plan.preview` entities and the snapshot to ghost descriptors, filtered by ticked steps. Tests: unit per change kind.
- **P2-2 Ghosts in the event display, MixConsole and Inspector.** Drawing of 4.2; step-to-ghost hover and locate; the toolbar pill. Acceptance: unticking a step removes exactly its ghosts.
- **P2-3 Audition presentation.** Violet frame, `Shift+A`, ghosts solid while the proposal is heard, structural edits disabled then; branch snapshot from `proposal.changed` and `session.fetch`. Risk: the branch snapshot must be dropped on `proposal.closed` and on reconnect.

### Phase 3 — the rest of Cubase's editing

Harness: the part of this phase the usable release needs is in M5b (`m5b-ui-edit-more`, `m5b-ui-fades`, `m5b-ui-inserts-master`, `m5b-ui-media`, `m5b-ui-keymap`); section "Usable release" below lists what stays here.

Range Selection tool and its operations; Glue, Erase, Zoom and Play tools; snap types Events, Grid Relative, Shuffle and Cursor; repeat, cut/copy/paste and their variants; nudge; slip content; rubber-band selection; exclusive solo; info-line editing; Inspector sections and insert slots with `e`; the Channel tab; the editor in the lower zone; Media tab; stationary cursor; zoom history; context menus and the toolbox on right-click; the key-command editor. Tests: a unit per command builder and an e2e per operation asserting one revision and a correct undo.

### Phase 4 — GPU and scale (with M6c's 64-track criterion)

Peak worker and LRU; WebGL2 content layer with instanced clips and peak textures, Canvas2D kept as fallback, context-loss recovery; virtualised track list and strips with visibility and filtering; the performance scenario (a generated 64-track, 2,000-clip session, with the budgets of 5.6 as assertions on the reference machine). Risk: runners without a GPU need SwiftShader or the comparison runs on the Windows and macOS machines only.

### Phase 5 — later milestones and windows

Automation (M6a); recording, takes and comping (M6b); sends, groups, folders and VCA (M6c); generic plugin parameters; the MixConsole window on `F3`; workspaces; the "Logic" key preset; tablet layout for remote control (M7); the agent composer when an agent runtime exists.

### Engine tickets

E-1 is in scope. The others are separate tickets on the engine side; each control stays hidden (3.0) until its ticket lands. In the order they unblock UI:

| # | Ticket | Unblocks |
|---|---|---|
| E-1 | Locators as a document entity, cycle, metronome | P1-7 (in scope) |
| E-2 | `track.set_color` | User-chosen colours, shared with other clients and agents |
| E-3 | `track.move {id, index}` | Reordering tracks and channels |
| E-4 | `clip.rename`; original file name on the media entity | Clip names, `F2` |
| E-5 | `media.import` | Dropping files, the Media tab |
| E-6 | `plan.propose` on a validated plan | Audition without approval |
| E-7 | Plan metadata: title or intent, actor, rejection note in `plan.status` and `plan.changed` | Plan titles, the agent row, the reject loop |
| E-8 | Marker and cycle-marker entities with their commands | Marker track, `Shift+1..9` |
| E-9 | `clip.set_fade`, crossfades, `clip.set_mute` | Fade handles, `X`, the Mute tool |
| E-10 | Time signature map, `session.set_signature` | Signature display, correct bars, click accents |
| E-11 | Master gain in the document, with a command and a gesture target | Master fader |
| E-12 | Plans persisted in the bundle | Plans that survive a restart |
| E-13 | DSP load in `engine.status`; loudness meter | Top-bar load, Meter tab |
| E-14 | Connected MCP clients in `engine.status` | Agent presence |
| E-15 | Extra allowed Origins and HTTP serving of the bundle (`m7-lan-mode`) | A browser tab on a real engine |
| E-16 | `session.history` (revision envelopes, paged) and undo to a chosen revision | The edit history list |
| E-17 | Solo Defeat on the track entity | `Alt`-click S |

Not needed, after checking the code: `clip.split` and a slip command (compositions of `clip.trim` and `clip.place`), a master meter (published as `master`), branch read access (`session.fetch` with a branch revision plus `proposal.changed`), exclusive solo (several `track.set_solo` in one `command.execute`).

### Usable release — criteria A to I (M5b)

Goal, set by the maintainer on 2026-11-14 (GitHub #83 is the main line): a version that opens, can be used, and is operated as Cubase is. This section maps the goal's nine criteria to harness features. Phase 1 stays in M5 (`m5-ui-*`). Everything else the goal needs is the milestone **M5b "Usable release"** (`.claude/milestones/M5b.json`), which runs after M5 and before M6a.

| | Criterion | Features | Proof |
|---|---|---|---|
| A | One command or an installer opens the app on Windows; no manual preparation of the engine or the environment. The Mac is checked through `siann-macos` | `m5b-package-windows` | The `package` CI job (build, silent install, smoke run, uninstall); gates `installer-hands-on` and `macos-run` |
| B | New or open a project, import audio by drop or from the Media tab, add tracks, save, reopen: everything is still there | `m5b-engine-project-media`, `m5b-ui-project`, `m5b-ui-media`; tracks from `m5-ui-arrange` | Walkthrough step B (same document hash after the reopen) |
| C | Bars and beats ruler, grid and snap, zoom and scroll, clip move, copy, split, glue, trim, fades, clip volume, `Ctrl+D`, undo and redo, markers, a cycle range saved in the project | `m5-ui-arrange`, `m5-ui-edit-basics`, `m5-ui-transport` (undo), `m5-ui-engine-loop-click`, `m5-ui-loop-click`; `m5b-ui-edit-more` (glue and the rest), `m5b-engine-clip-fades`, `m5b-ui-fades`, `m5b-engine-markers`, `m5b-ui-markers` | Walkthrough step C |
| D | Play, stop, record, cycle, metronome, count-in, playhead and position display, numeric keypad and laptop keys | `m5-ui-transport`, `m5-ui-loop-click`; `m5b-engine-punch-count-in`, `m5b-ui-recording`, `m5b-ui-keymap` (every keypad command has a second key) | Walkthrough step D |
| E | MixConsole: vertical faders to +6 dB on a dB scale, pan, M, S, meters with peak hold and clip indication, inserts, sends, bus and master faders | `m5-ui-mixer`; `m5b-engine-master`, `m5b-ui-inserts-master`, `m5b-engine-buses-sends`, `m5b-ui-sends-buses` | Walkthrough step E |
| F | Recording: choose the input, record enable, monitor, record into a clip | `m5b-engine-record`, `m5b-engine-monitoring`, `m5b-ui-project` (Studio Setup), `m5b-ui-recording` | Walkthrough step F on the fake device; gate `audio-hardware` |
| G | Agent plans shown as ghosts in the event display and on the MixConsole; audition A/B, approve, partial approve, reject, merge | `m5-ui-plan-panel`; `m5b-ui-ghosts`, `m5b-ui-audition` | Walkthrough step G |
| H | Cubase key commands by default; English, Traditional Chinese, Simplified Chinese | `m5-ui-shell`, `m5-ui-i18n`; `m5b-ui-keymap`; every M5b UI feature adds its strings to the three catalogs | The key-command audit test and the i18n tests |
| I | A Cubase user's walkthrough passes end to end (Playwright, B to G), and the screenshot tour is complete in three languages | `m5b-cubase-walkthrough` | `cubase-walkthrough.spec.ts` in CI and against the installed build; gate `final-tour-review` |

`m5b-cubase-walkthrough` replaces the Proof column with test names when it lands, and a Node test then fails if a named test disappears.

**Order.** Engine and protocol work lands before the UI that uses it, and the manifest's waves say so:

| Wave | Engine, protocol, packaging | UI |
|---|---|---|
| 1 | `m5b-package-windows`, `m5b-engine-project-media`, `m5b-engine-record` | `m5b-ui-ghosts` |
| 2 | `m5b-engine-clip-fades`, `m5b-engine-master`, `m5b-engine-monitoring` | `m5b-ui-audition`, `m5b-ui-project` |
| 3 | `m5b-engine-markers`, `m5b-engine-buses-sends`, `m5b-engine-punch-count-in` | `m5b-ui-media`, `m5b-ui-edit-more` |
| 4 | | `m5b-ui-fades`, `m5b-ui-inserts-master`, `m5b-ui-recording` |
| 5 | | `m5b-ui-markers`, `m5b-ui-sends-buses` |
| 6 | | `m5b-ui-keymap` |
| 7 | | `m5b-cubase-walkthrough` |

**What moved between milestones (2026-11-14).**

- From M6b to M5b: monitoring modes (`m6b-monitoring` is now `m5b-engine-monitoring`), and the punch, pre-roll and count-in half of `m6b-punch-loop` (now `m5b-engine-punch-count-in`). What stays in M6b is `m6b-loop-takes` (loop record with a take per pass and playlists), `m6b-rf64`, `m6b-midi-record` and the one-hour criterion.
- From M6c to M5b: `m6c-buses-sends` is now `m5b-engine-buses-sends`. M6c keeps groups and VCAs, sidechain, bounce and the 64-track criterion.
- New in M5b, owned by no milestone before: recording through the protocol in the engine process (`m5b-engine-record`; until now only `siann-cli record` could record), and the engine tickets E-5, E-8, E-11 and parts of E-4 and E-9.
- Not moved: automation (M6a). Nothing in A to I needs it.

Where sections 3.0 to 3.7 and "Phase 5" above say M6b for record, record enable, monitor, punch, pre-roll and count-in, or M6c for sends, read M5b. Takes in lanes and comping stay M6b; routing to groups, folders and VCAs stay M6c.

**Tickets.** Acceptance is in the manifest; this is the scope each one settles. Conventions are those of phase 1 (tests, tour, strings in three catalogs, the capability rule of 3.0).

- **UR-1 Launch and installer** (`m5b-package-windows`). Two paths. From a checkout, `npm run app` at the repository root does everything: app dependencies, renderer build, engine build when missing, launch. For a user, an NSIS installer built by electron-builder (MIT; one of the two packagers the architecture spec's Libraries table names; chosen because NSIS is built in, where Electron Forge needs a maker per target) holds the app and the desktop engine. The installer is **unsigned**: no certificate is created, bought or stored, and Windows SmartScreen will warn; signing is a later decision for the maintainer. The package as a whole is AGPL-3.0-or-later because the desktop engine links JUCE (ADR-0017), and it carries the licence texts and the source offer the status bar already shows. macOS keeps `npm run app`; the signed bundle is `m0-macos-bundle` behind its gate.
- **UR-2 Create, import, names** (`m5b-engine-project-media`; E-5 and the media half of E-4). `session.create`; `media.import` as a job with offline conversion to the session rate and peaks; an optional `name` on the media entity so the UI can show file names. Formats are WAV and FLAC, as the decoder has today. Both methods touch paths on the user's disk, so the MCP propose scope does not get them.
- **UR-3 Recording through the protocol** (`m5b-engine-record`). The engine process opens device inputs; a track has an input (document) and an armed flag (engine state, like cycle); `transport.record` captures and commits one revision per stop; pending takes after a crash are offered through the protocol. Recording with cycle on runs straight through until `m6b-loop-takes`.
- **UR-4 Projects and Studio Setup** (`m5b-ui-project`). New, Open, recent, Save, a start view, and the device dialog (output, input, rate, buffer, latency). The dialogs are the shell's; the renderer's only contact with Electron stays `index.tsx`. Save is `session.save`; because every revision is journaled, closing never loses work and there is no "save changes?" prompt.
- **UR-5 Import in the UI** (`m5b-ui-media`). Drop from the OS onto the event display, and the Media tab (list, search, import, drag to the event display, rename). Clip titles become the media name.
- **UR-6 Fades** (`m5b-engine-clip-fades`, `m5b-ui-fades`). The fade half of E-9: fade in and fade out with a linear or equal-power curve. Crossfades and clip mute stay in E-9.
- **UR-7 More editing** (`m5b-ui-edit-more`). The part of phase 3 that criterion C names or that a Cubase user reaches for in the same breath: Glue and Erase tools, cut, copy and paste, repeat, nudge, rubber band, snap types Grid Relative, Events and Magnetic Cursor, an editable info line. The rest of phase 3 is not in the usable release: Range Selection, Zoom and Play tools, Shuffle, slip, zoom history, stationary cursor, the lower-zone editor, the Channel tab, context menus and the key-command editor.
- **UR-8 Recording in the UI** (`m5b-engine-monitoring`, `m5b-engine-punch-count-in`, `m5b-ui-recording`). Record enable, monitor and input on header, strip and Inspector; Record, punch, pre-roll and count-in on the transport bar; the growing red clip; recovery of pending takes.
- **UR-9 Markers** (`m5b-engine-markers`, `m5b-ui-markers`; E-8). Position and cycle markers on one marker track. `Shift+1` and `Shift+2` stay the locators (3.6); markers 3 to 9 take `Shift+3..9` and `Num 3..9`.
- **UR-10 Master, inserts, sends, buses** (`m5b-engine-master`, `m5b-ui-inserts-master`, `m5b-engine-buses-sends`, `m5b-ui-sends-buses`; E-11). The master fader; insert racks on the existing plugin methods; buses with their own strips; sends pre or post fader; output routing to a bus.
- **UR-11 Key commands** (`m5b-ui-keymap`). The Cubase preset audited row by row against `research/cubase.md` section 7; a second key for every keypad command; the application menu and tooltips read the same table; a read-only Key Commands list.
- **UR-12 Walkthrough and tour** (`m5b-cubase-walkthrough`). One Playwright scenario over B to G by real keys and pointer gestures, in three locales, in CI and against the installed build; the tour extended over every new state.

**Tour states.** Numbers are reserved here so features that run in the same wave do not collide: 26, 27 `m5b-ui-ghosts`; 28 `m5b-ui-audition`; 29, 30 `m5b-ui-project`; 31 `m5b-ui-media`; 32 `m5b-ui-edit-more`; 33 `m5b-ui-fades`; 34 `m5b-ui-inserts-master`; 35, 36 `m5b-ui-recording`; 37 `m5b-ui-markers`; 38 `m5b-ui-sends-buses`; 39 `m5b-ui-keymap`; 40 onward `m5b-cubase-walkthrough`.

**Human gates** (in the manifest): `installer-hands-on` (a clean Windows machine), `macos-run` (through `siann-macos`), `audio-hardware` (a real interface for input, monitoring and take placement), `phase2-tour-review` and `phase3-tour-review` (the maintainer reads the screenshots of each phase in three locales, as `ui-redesign-review` does for phase 1), `zh-glossary-m5b` (the Chinese terms this milestone adds), `final-tour-review`.

**Left out on purpose,** each still where it was: time signatures (E-10; bars stay 4/4), track colour and reorder (E-2, E-3), clip rename (the clip half of E-4), audition without approval (E-6), plan titles and the agent row (E-7), persisted plans (E-12), DSP load and loudness (E-13), the edit history list (E-16), Solo Defeat (E-17), automation (M6a), takes and comping (M6b), groups, folders and VCAs (M6c), phase 4.

## 8. Decisions and what is still open

Decided by the maintainer (2026-11-13):

| # | Question | Decision | Where it lands |
|---|---|---|---|
| 1 | The look, with violet reserved for agents | Approved | Section 1; P1-1 |
| 2 | Zones | No fixed sizes: every boundary drags, zones collapse, sizes are remembered per user | 2.3; P1-1 |
| 3 | Approve and audition | As recommended: phase 1 chains today's methods; auditioning a validated plan is E-6 | 4.5 C4; P1-5 |
| 4 | Fader top | +6 dB, Cubase's default | 4.5 C7; P1-4 |
| 5 | Loop and metronome | In scope; the protocol work is its own ticket | E-1, P1-7 |
| 6 | Is the loop range saved with the session? | Yes: a document entity, revisioned, undoable, restored on open | E-1 |
| 7 | Reference DAW | Cubase for behaviour and default keys; Logic as a later preset and a source of ideas | Sections 2, 3 |
| 8 | Languages | English, Traditional Chinese, Simplified Chinese from phase 1; OS locale with a manual switch | Section 6; P1-0 |

Still open, with the default taken meanwhile:

| # | Question | Default while undecided | Cost of reversing |
|---|---|---|---|
| 9 | Chinese terminology | The glossary of 6.5; the maintainer confirms it against Cubase's Chinese UI | One line per term |
| 10 | Chinese fonts | System fonts, not bundled (6.4) | A font file and one line of CSS |
| 11 | Is cycle on/off also restored on open? | Yes, kept beside the document but not as a revision | Engine-side only |
| 12 | Locators as a singleton entity or a field on `root` | Singleton entity | Engine design review decides |
| 13 | Track colours until E-2 | Assigned in the renderer from a hash of the track id | None |
| 14 | `backgroundThrottling: false` for the main window | Set it, in P1-1 | One line in `main.ts` |
| 15 | Dependencies and fonts | `react-resizable-panels` in P1-1, pinned to a release at least two weeks old; Inter and JetBrains Mono bundled; `@tanstack/react-virtual` waits for phase 4 | Small |
| 16 | Things Cubase does that SIANN does not copy | One transport surface; `F2` only renames; one undo history for edits and mixer; no built-in channel EQ | Each is a later feature if wanted |

## 9. Sources

Research was done on 2026-11-13. Ableton now lists Live 13 and Apple's guide lists Logic Pro 13; the conventions cited are from the pages as they stood on that date. Items I could not confirm in a primary source are left out; The first research pass could not open most Cubase pages; the second (`research/cubase.md`) read the 15.0.30 manual through the help site's content API, and section 3 now rests on it.

DAW conventions

- [D1] Ableton Live keyboard shortcuts — https://www.ableton.com/en/manual/live-keyboard-shortcuts/ ; Live 12 release notes (mixer in Arrangement view, themes, keyboard navigation) — https://www.ableton.com/en/release-notes/live-12/
- [D2] Bitwig Studio user guide, the Arrange view and tracks (tools 1–5, track headers) — https://www.bitwig.com/userguide/latest/the_arrange_view_and_tracks ; window anatomy — https://www.bitwig.com/userguide/latest/anatomy_of_the_bitwig_studio_window/
- [D3] Logic Pro global key commands — https://support.apple.com/guide/logicpro/global-commands-lgcp02bf31b6/mac ; main window commands — https://support.apple.com/guide/logicpro/lgcpe8314fe2/mac
- [D4] Cubase Pro 14 default key commands (Space, Num *, Num /) — https://www.steinberg.help/r/cubase-pro/14.0/en/cubase_nuendo/topics/key_commands/key_commands_default_c.html ; MixConsole in the lower zone (topic title only) — https://steinberg.help/nuendo/v12/en/cubase_nuendo/topics/project_window/project_window_lower_zone_mixconsole_opening_t.html
- [D5] Studio One Pro 7 key command sheet (F2–F5, Space, Num 0, Num /) — https://pae-web.presonusmusic.com/downloads/products/pdf/Studio_One_Pro_7_Key_Command_Sheet.pdf
- [D6] Reaper shortcut sheet (wheel conventions; a 2008 community sheet) — https://user.cockos.com/~glazfolk/ReaperKeyboardShortcuts.pdf
- [D7] FL Studio playlist manual — https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/playlist.htm
- [D8] Pro Tools shortcuts guide 2025.10 (edit modes, Smart Tool, Tab to Transient) — https://resources.avid.com/SupportFiles/PT/Pro_Tools_Shortcuts_2025.10.pdf

Faders and meters

- [M1] Peak programme meter, IEC 60268-10 and -18 return times — https://en.wikipedia.org/wiki/Peak_programme_meter
- [M2] Sound On Sound, "Are all faders created equal?" (unity near 75 % of travel, logarithmic law) — https://www.soundonsound.com/sound-advice/q-are-all-faders-created-equal
- [M3] EBU Tech 3341, loudness metering — https://tech.ebu.ch/docs/tech/tech3341.pdf
- [M4] Fader maximum. Cubase: "By default, this is set to +6 dB" (Project Setup > Volume Max, Cubase Pro 15 help, via `research/cubase.md` 5.4). Logic: "maximum boost is +6 dB" in the Logic Pro 9 manual; not restated in the 13.0 guide — https://www.manualsdir.com/manuals/547962/apple-logic-pro-9.html?page=767

Rendering

- [G1] WebGL2 support — https://caniuse.com/webgl2
- [G2] WebGPU implementation status — https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- [G3] WebGPU support — https://caniuse.com/webgpu
- [G4] OffscreenCanvas — https://caniuse.com/offscreencanvas ; https://web.dev/articles/offscreen-canvas
- [G5] Worker canvas and DOM frame synchronisation (seen as search summaries only) — https://lists.w3.org/Archives/Public/public-css-archive/2019Jun/0385.html ; https://wiki.whatwg.org/wiki/WorkerCanvas2
- [G6] Low-latency canvas, `desynchronized` — https://developer.chrome.com/blog/desynchronized
- [R1] VS Code terminal renderer — https://code.visualstudio.com/blogs/2017/10/03/terminal-renderer
- [R2] Figma rendering powered by WebGPU — https://www.figma.com/blog/figma-rendering-powered-by-webgpu/

Electron and React

- [E1] Electron releases (Electron 44 on Chromium 152) — https://releases.electronjs.org/
- [E2] `app.getGPUFeatureStatus` — https://www.electronjs.org/docs/latest/api/app
- [E3] `powerSaveBlocker` — https://www.electronjs.org/docs/latest/api/power-save-blocker
- [E4] `backgroundThrottling` — https://www.electronjs.org/docs/latest/api/browser-window
- [E5] Electron command-line switches — https://www.electronjs.org/docs/latest/api/command-line-switches
- [X1] `useSyncExternalStore` — https://react.dev/reference/react/useSyncExternalStore
- [X2] React Compiler 1.0 — https://react.dev/blog/2025/10/07/react-compiler-1

CSS

- [C1] Container queries — https://caniuse.com/css-container-queries
- [C2] `content-visibility` — https://caniuse.com/css-content-visibility
- [C3] Anchor positioning — https://caniuse.com/css-anchor-positioning ; Popover — https://caniuse.com/mdn-api_htmlelement_popover ; `color-mix()` — https://caniuse.com/mdn-css_types_color_color-mix ; `oklch()` — https://caniuse.com/mdn-css_types_color_oklch

Libraries, fonts, icons (licences and sizes from the npm registry, the repositories and bundlephobia)

- [L1] react-resizable-panels — https://github.com/bvaughn/react-resizable-panels ; dockview — https://github.com/dockview/dockview ; TanStack Virtual — https://www.npmjs.com/package/@tanstack/react-virtual
- [L2] regl — https://www.npmjs.com/package/regl ; twgl.js — https://www.npmjs.com/package/twgl.js ; PixiJS — https://www.npmjs.com/package/pixi.js ; three — https://www.npmjs.com/package/three
- [L3] peaks.js — https://www.npmjs.com/package/peaks.js ; waveform-data.js — https://github.com/bbc/waveform-data.js ; wavesurfer.js — https://www.npmjs.com/package/wavesurfer.js
- [L4] Base UI — https://github.com/mui/base-ui
- [L5] openDAW — https://github.com/andremichelle/openDAW ; GridSound — https://github.com/gridsound/daw
- [F1] Inter — https://rsms.me/inter/
- [F2] OFL FAQ — https://openfontlicense.org/ofl-faq/
- [F3] FSF licence list, SIL OFL 1.1 — https://www.gnu.org/licenses/license-list.html#SILOFL
- [F4] Lucide — https://github.com/lucide-icons/lucide ; JetBrains Mono — https://github.com/JetBrains/JetBrainsMono
Research files and internationalisation

- [R3] `research/cubase.md` — Cubase Pro 15.0.30, from Steinberg's online help at `https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/...`; the default key-command tables were checked against 14.0.30. It marks what it could not verify with **[U]**; of the conventions used here, plain wheel = vertical scroll, `Shift`+wheel = horizontal scroll and `Shift`-click to add to a selection carry that mark.
- [R4] `research/logic.md` — Logic Pro 13.0, from Apple's user guide.
- [I1] Steinberg help, content locales and document list (public API, read 2026-11-13): `https://www.steinberg.help/api/khub/locales` lists `zh-CN` (29 items) and `zh-TW` (12 items); `https://www.steinberg.help/api/khub/maps` lists no Chinese Cubase manual.
- [I2] Retail listings giving Cubase Pro 15's languages as "English, German, French, Spanish, Italian, Portuguese, Japanese, Chinese", without naming the script — https://www.sonovente.com/en-gb/steinberg-download-cubase-pro-15-licence-p115094.html ; https://www.thomannmusic.com/steinberg_cubase_pro_15_upgrade_le.htm
- [I3] Steinberg forum: Japanese UI shows Chinese-style glyph shapes in Cubase 15.0.10 on macOS — https://forums.steinberg.net/t/japanese-ui-shows-chinese-style-glyph-shapes-in-cubase-15-0-10-cubase-12-is-correct-on-macos/1025662
