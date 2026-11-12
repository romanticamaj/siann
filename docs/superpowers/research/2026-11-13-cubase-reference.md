# Cubase Pro as the primary UI reference for SIANN

Research date: 2026-11-13. Purpose: extract what a DAW must have and exactly how Cubase does it, to drive SIANN UI design decisions.

## 0. Sources and how to read this file

**Primary source:** Steinberg's official online help, *Cubase Pro Help 15.0.30* (en-US), at `https://www.steinberg.help/r/cubase-pro/15.0/en/...`. The site is a JavaScript single-page app, so the topic text was pulled through the site's own public content API (the same content the pages render) and read as plain text. Every URL below is the public page for the topic that was read.

**Version coverage:**

- All statements are from the **15.0** manual unless marked otherwise.
- The **default key command tables were diffed between 14.0.30 and 15.0.30**: identical bindings. The only differences are labels (`Play Selection` became `Play Selection Range`, `Open Tempo Track` became `Open Tempo Track Editor`) and v15 listing `Page Up` / `Page Down` in the Navigate category.
- A **Cubase Pro 16.0** manual already exists on steinberg.help. It was not read. Anything here may have shifted in 16.
- No secondary sources were needed; the official pages all loaded via the API.

**Confidence marks:**

| Mark | Meaning |
|---|---|
| (none) | Read directly in the official 14/15 manual. |
| **[U]** | Unverified: long-standing Cubase behaviour from product knowledge, not found verbatim in the pages read. Confirm in a running Cubase before relying on it. |
| **[14+]** / **[15]** | Feature introduced or changed in that version, per the manual's own notes. |

**Modifier convention:** Steinberg writes `Ctrl/Cmd` and `Alt/Opt`. In this file, Windows keys are given; the Mac equivalent is always Ctrl→Cmd and Alt→Opt unless a row says otherwise. `Num` = numeric keypad.

URL base used in citations: `B = https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics`

---

## 1. Project window anatomy

Cubase has **one Project window per project**. It is a fixed five-region layout: a central **project zone** that can never be hidden, surrounded by four optional regions.

```
+--------------------------------------------------------------------------------+
| Toolbar  [left-locked tools | centre tools (collapse first) | right-locked]    |
| Status line (optional)                                                         |
| Info line (optional)                                                           |
| Overview line (optional)                                                       |
+---------+----------+---------------------------------------------+-------------+
| Channel | LEFT     | Global track controls | Ruler               | RIGHT ZONE  |
| tab     | ZONE     |-----------------------+---------------------| VSTi        |
| (one    | Inspector| Track list            | Event display       | Media       |
| mixer   |  Track / |                       |                     | CR          |
| strip)  |  Editor  |                       |                     | Meter       |
|         | Visibil. |                       |                     | Automation  |
|         |          +---------------------------------------------+             |
|         |          | LOWER ZONE: Chord Pads | Editor | Sampler   |             |
|         |          | Control | MixConsole | Drum Machine | MIDI  |             |
|         |          | Remote | Modulators                         |             |
+---------+----------+---------------------------------------------+-------------+
| Transport Bar (optional, integrated)                                           |
+--------------------------------------------------------------------------------+
```

### 1.1 Zones

| Zone | Contents | Show/hide |
|---|---|---|
| **Project zone** | Toolbar, track list, event display, ruler; optional status line, info line, overview line, Transport Bar. "The heart of the Project window and cannot be hidden." | Always shown |
| **Channel tab** | One MixConsole-style channel (sections + fader) for the selected track. Empty if the track has no channel or is disabled. Topmost selected track wins on multi-select. | `Ctrl+Alt+C` |
| **Left zone** | **Inspector** with two tabs at the bottom: **Track** (settings of the selected track) and **Editor** (settings for the editor open in the lower zone). Plus a **Visibility** tab at the top. | `Ctrl+Alt+L` or `Alt+I` |
| **Lower zone** | Tabs: Chord Pads, Editor, Sampler Control, MixConsole, Drum Machine, MIDI Remote, Modulators. Described as "an integrated and fixed zone... useful on single screen systems and notebooks". | `Ctrl+Alt+E` or `Ctrl+Alt+B` |
| **Right zone** | Tabs: VSTi rack, Media rack, CR (Control Room), Meter, and Automation [15]. | `Ctrl+Alt+R` |

Zone behaviour worth copying:

- **Four toolbar buttons at the far right** toggle Channel / Left / Lower / Right, next to a **Set up Window Layout** button. That button opens a pane with checkboxes for Status Line, Info Line, Overview, Transport Bar and Channel.
- **Tabs are user-configurable.** Right-click a lower-zone or right-zone tab to open *Set up Tabs*: tick to show or hide, drag to reorder, save as a preset.
- **Resizing is by dragging dividers.** Confirmed for the Channel tab's right divider, the Inspector's right divider, and the divided track list. The lower zone's top edge and the right zone's left edge drag the same way **[U]**.
- **Tab and page navigation by key:** `Ctrl+Alt+Left/Right` = previous/next tab; `Ctrl+Alt+Up/Down` (or `Page Up/Down`) = previous/next page.
- **Keyboard focus is per zone.** The focused zone gets a highlighted border (colour set in Preferences). `Tab` / `Shift+Tab` cycle zones; clicking a zone focuses it. Key commands act on the focused zone. The project zone and the lower zone have **separate toolbars and info lines**; using one focuses its zone.
- The lower-zone editor takes focus automatically when you double-click an event, or select one and press `Return`.

### 1.2 Toolbar

Right-click an empty area to choose visible tool groups (*Show All* at the bottom). Two **dividers** pin groups to the left and right ends; everything between them collapses progressively as the window narrows.

Default groups, left to right:

1. Open Hub; Activate Project (only when more than one project is open)
2. Project History (Undo / Redo)
3. Constrain Delay Compensation
4. *Left divider*
5. Media & MixConsole Windows (MediaBay, Pool, MixConsole, Control Room, Direct Offline Processing)
6. Track Visibility Configurations, Visibility Agents, Track Type Filter
7. **State Buttons**: Deactivate All Mute / Solo / Listen states; global Read / Write; Suspend All Read/Write Automation
8. Automation Mode (Automation Follows Events, Global Automation Mode, Open Automation Panel)
9. Auto-Scroll, plus its settings menu
10. Locators (go-to buttons and position fields), Locator Range Duration
11. Transport Controls; Time Displays (primary and secondary, each with a format selector)
12. Markers (Jump to Marker, Open Markers Window)
13. **Tool Buttons** (see section 2.1)
14. Color Menu
15. Nudge (settings, then start-left/right, move-left/right, end-left/right)
16. Project Root Key
17. **Snap** (On/Off, Snap Type, Snap to Zero Crossing), **Grid Type**
18. **Quantize** (Apply, Presets, Soft Quantize, AudioWarp Quantize, Open Quantize Panel)
19. Audio Alignment; Audio Performance Meter; Quick Audio Export; MIDI Remote Mapping Assistant
20. *Right divider*
21. Window Zone Controls (Channel, Left, Lower, Right, Set up Window Layout)

**Toolbox:** with *Show Toolbox on Right-Click* enabled (Preferences > Editing > Tools), right-click in the event display pops the tool palette at the pointer instead of the context menu. Any modifier + right-click gives the other one.

### 1.3 Lines above the event display

- **Status line**: Audio Inputs, Audio Outputs, Control Room connection state; Max. Record Time; Record Format (sample rate and bit depth); Project Frame Rate; Project Pan Law; External Sync State; Buffer Size. Each field is clickable and opens the relevant dialog.
- **Info line**: shows and **edits** the selected event or part (start, end, length, offset, volume, fades, mute, lock, transpose and so on).
  - With several events selected, the values of the first are shown in another colour.
  - Edits apply **relatively** to all selected events. Hold `Ctrl` while editing to apply the **absolute** value to all.
  - With the Range Selection tool active it shows Range Start / End / Length and Top / Bottom Track.
  - Toggle: `Ctrl+I`.
- **Overview line**: miniature of the whole project with a rectangle for the visible section. Drag the rectangle to navigate; drag its edges to zoom. Toggle: `Alt+O`.

### 1.4 Ruler

- **Upper half = locators and cycle.** Click-drag draws the locator range; clicking the range toggles cycle; a hand cursor moves the range.
- **Lower half = project cursor.** Click sets the cursor. Drag down to zoom in, drag up to zoom out.
- **Time format menu** (arrow at the right end, or right-click): Bars+Beats, Seconds, Timecode, Samples, fps (User). The ruler format also drives the info line and tooltips. `Ctrl` + selecting a format in any ruler sets it globally.
- **Ruler modes**: Time Linear, or Bars+Beats Linear (equal bar widths through tempo changes).
- Extra rulers come from **Ruler tracks**, each with its own format.

### 1.5 Track list and event display

- **Global track controls** sit above the track list: Add Track (`+`), Use Track Preset, a visible/hidden track count, Visibility Agents, Track Type Filter, Find Tracks (search).
- **Divide Track List**: a button at the top right below the ruler splits the list into upper and lower lists with independent scroll and zoom. Video, marker and arranger tracks move to the upper list automatically. The focused half has a solid frame, the other a dashed frame.
- **Bottom-right corner controls**: horizontal zoom slider with a zoom-preset menu; vertical zoom slider with a Track Height Presets menu; a waveform-zoom slider at the top right of the event display.
- **Cross-hair cursor**: appears while moving or sizing with the Object Selection tool, and on hover with the Split tool. Configurable colours and width.

### 1.6 Transport: three surfaces

- **Transport Bar**: integrated strip in the Project window. Toggle `Ctrl+Alt+T`.
- **Transport panel**: floating window. Toggle `F2`.
- **Transport Controls** group on the toolbar.
- **Transport pop-up window**: appears when a transport key command is pressed while all of the above are hidden (for example `Shift+P` to type a cursor position). `Esc` closes it.

All transport surfaces are configured by right-click > tick sections.

### 1.7 Workspaces

A workspace stores size, position and layout of the Project window, MixConsole, Transport panel and similar windows.

- **Global** workspaces (marked G) apply to all projects on the machine. **Project** workspaces (marked P) are saved in the project.
- A project reopens in its last saved **view**, which may or may not be a workspace.
- Workspaces menu: Add Workspace, Update Workspace, Organize, No Workspace.
- Keys: `Alt+Num 1..9` recall, `Alt+U` update, `Ctrl+Num 0` new, `Alt+Num 0` no workspace.

**Setup panes** are the general customisation pattern: every toolbar, info line, transport surface and Inspector has a right-click *Set up...* pane with show/hide, drag-reorder, presets, Show All and Reset All.

Sources: `B/project_window/project_window_overview_r.html`, `.../project_window_showing_hiding_sections_t.html`, `.../project_window_toolbar_r.html`, `.../project_window_toolbox_c.html`, `.../project_window_ruler_c.html`, `.../project_window_status_line_r.html`, `.../project_window_info_line_c.html`, `.../project_window_overview_line_c.html`, `.../project_window_transport_r.html`, `.../project_window_channel_inspector_r.html`, `.../project_window_inspector_r.html`, `.../project_window_lower_zone_c.html`, `.../project_window_right_zone_c.html`, `.../project_window_zones_keyboard_focus_c.html`, `B/customizing/customizing_workspaces_c.html`, `B/key_commands/key_commands_window_zones_category_c.html`

---

## 2. Tools and editing

### 2.1 Tools

| Tool | Key | What it does | Modifier behaviour (defaults) |
|---|---|---|---|
| **Object Selection** | `1` | Select, move, resize events. Three sizing modes chosen by clicking the tool button again: **Normal Sizing**, **Sizing Moves Contents**, **Sizing Applies Time Stretch**. | `Alt`-click an event = split. `Alt`-drag = copy. `Alt+Shift`-drag = shared copy. `Ctrl`-drag = constrain direction. `Ctrl+Alt`-drag inside an event = slip content. `Shift+Alt`-click = set project cursor. |
| **Range Selection** | `2` | Time-and-track range, independent of event boundaries. | Double-click an event = range around it. `Shift`+double-click extends. Double-click between events = the gap. `Ctrl+Alt`-drag = slip range content. `Ctrl+Shift` = audio segment editing. `Ctrl`-click a track includes or excludes it. |
| **Combine Selection Tools** | `Alt+Shift+1` | Upper half of each track acts as Range tool, lower half as Object Selection. Needs track height of at least 2 rows. | |
| **Split** | `3` | Click to split. | `Alt`-click = split repeatedly into equal pieces. |
| **Glue** | `4` | Click an event to glue it to the next. | `Alt`-click = glue all following events. |
| **Erase** | `5` | Click to delete. | `Alt`-click = delete later events too. |
| **Zoom** | `6` | Click to zoom in; drag a rectangle. | `Alt`-click = zoom out. Double-click = undo zoom. `Alt`+double-click = redo zoom. |
| **Mute** | `7` | Click or drag a rectangle to mute events. | |
| **Draw** | `8` | Draw parts, automation points, event volume curve points. | `Shift` = rename marker event. |
| **Play** (Audition / Scrub) | `9` | Hold to audition from the click point. Scrub is a sub-mode. | |
| **Drumstick** | `0` | Drum Editor. | |
| **Comp** | none | Assemble takes across lanes. | `Ctrl` = Speaker (audition). `Shift`-click = select a take. |
| **Time Warp** | none | Drag musical positions to time positions (edits tempo). | `Shift` = adjust or delete. `Alt` = no correction. |
| **Line** | none | Line, Parabola and other curve shapes for automation and controllers. | |
| **Color** | none | Click events to colour them. | `Alt`-click = pick up colour. `Ctrl`-click = colour picker. Wheel over the tool steps colours. |

- `F9` / `F10` = previous / next tool.
- Pressing a tool's number key again cycles that tool's sub-modes **[U]**.
- All modifiers are remappable in Preferences > Editing > Tool Modifiers.

### 2.2 Snap and grid

Snap on/off: `J`. Snap affects moving, copying, drawing, sizing, splitting and range selection.

**Snap Type** (what positions are magnetic):

| Snap type | Behaviour |
|---|---|
| **Grid** | Positions come from the Grid Type menu. |
| **Grid Relative** | Events keep their offset from the grid; the grid sets the step size. An event at 3.04.01 with a Bar grid moves to 4.04.01, 5.04.01. Only applies to dragging existing events; creating new ones behaves like Grid. |
| **Events** | Starts and ends of other events are magnetic, plus audio snap points and markers. |
| **Shuffle** | Dragging an event past its neighbour swaps their order. |
| **Cursor** | The project cursor is magnetic ("Magnetic Cursor" in older versions). |
| **Grid + Cursor**, **Events + Cursor**, **Events + Grid + Cursor** | Combinations. |

**Grid Type** depends on the primary time format:

| Time format | Grid types |
|---|---|
| Bars+Beats | Bar, Beat, **Use Quantize** (follows the quantize preset), **Adapt to Zoom** (bars when zoomed out, down to 1/64 when zoomed in) |
| Seconds | 1, 10, 100, 1000 ms |
| Timecode / fps (User) | Subframe, 1/4 frame, 1/2 frame, 1 frame, 2 frames, 1 second (80 subframes per frame) |
| Samples | 1, 10, 100, 44100 samples |

Other snap facts:

- **Snap to Zero Crossing** is a separate toggle for audio splits and resizes.
- **Snap point**: each audio event has a movable snap point (*Audio > Snap Point to Cursor*), shown as a vertical line; that is what snaps.
- **Nudge has its own grid**: *Link to Grid* (default), *Link to Primary Time Format*, or fully independent. So mouse editing can be musical while nudging is in milliseconds.
- **Quantize**: `Q` applies the current preset. `Shift+Q` = Auto-Grid. Presets are note values with triplet and dotted variants. *Reset Quantize* restores original positions, because quantize is always calculated from the original position. The Quantize Panel adds swing, catch range and groove quantize.

### 2.3 Event operations

| Operation | How Cubase does it |
|---|---|
| **Select** | Click; `Shift`-click adds **[U]**; rubber-band drag. Arrow keys step to adjacent events and tracks. `Ctrl+A` all, `Ctrl+Shift+A` none. Edit > Select: Invert, In Loop, From Start to Cursor, From Cursor to End, All on Selected Tracks, Events under Cursor. |
| **Move** | Drag. Same track type only. `Ctrl` constrains to horizontal or vertical. A **Drag Delay** preference prevents accidental moves. Edit > Move: Event Start to Cursor (`Ctrl+L`), Event End to Cursor, to Origin, to Selected Track, to Front (`U`), to Back. |
| **Copy** | `Alt`-drag. `Alt+Shift`-drag makes a **shared copy** (edits propagate; shown by an icon; *Convert to Real Copy* breaks the link). |
| **Duplicate** | `Ctrl+D`: copy placed immediately after the original. Multiple selections duplicate as one unit. |
| **Repeat** | `Ctrl+K` opens a dialog (Count, Shared Copies). By mouse: hover the **middle of the right border** until a pointing hand appears, then drag right; `Shift` makes shared copies. Needs track height of at least 2 rows. |
| **Fill Loop** | Edit > Functions > Fill Loop fills the locator range with copies. |
| **Resize** | Drag the **lower-left or lower-right corner**. Sizing mode comes from the Object Selection sub-mode. `Ctrl+Alt` = size with fade (fades scale). `Ctrl` = disable snapping. `Alt` = repeat event. |
| **Split** | Split tool; `Alt`-click with Object Selection; **`Alt+X` Split at Cursor** (selected events, or all tracks under the cursor if nothing is selected); **`Shift+X` Split Range**; Split Loop at the locators. |
| **Glue** | Glue tool, or Edit > Glue on a selection. |
| **Delete** | `Delete` or `Backspace`. |
| **Mute event** | `Shift+M` mute, `Shift+U` unmute, `Alt+M` toggle. Muted events are greyed out. |
| **Lock** | `Ctrl+Shift+L` lock, `Ctrl+Shift+U` unlock. Lockable attributes: Position, Length, Other. |
| **Group** | `Ctrl+G` / `Ctrl+U`. Also **Group Editing** on folder tracks (`K`): events with the same start, end and priority are edited together. |
| **Slip content** | `Ctrl+Alt`-drag inside an event moves the audio under a fixed event window. Limited by the clip length. Key commands *Slip Event Content Left/Right* exist but are unassigned. |
| **Nudge position** | `Ctrl+Left/Right` moves by the nudge grid. |
| **Nudge edges** | `Alt+Left` = start left; `Alt+Shift+Right` = start right; `Alt+Shift+Left` = end left; `Alt+Right` = end right. |
| **Paste variants** | `Ctrl+V` paste at cursor; `Alt+V` Paste at Origin; `Shift+V` Paste Relative to Cursor; Paste to Matching Track Name. Audio pastes with its snap point at the cursor. |
| **Rename** | `F2` renames selected events. |
| **Cut Head / Cut Tail** | Edit > Range: delete everything left or right of the cursor within the event. |

Relevant preferences (Preferences > Editing): Auto Select Events under Cursor; Track Selection Follows Event Selection; Select Track on Background Click; Delete Overlaps (`Shift` overrides); Parts Get Track Names; Cycle Follows Range Selection; Range Tool Splits Partly Selected Events; Automation Follows Events.

### 2.4 Fades, crossfades, event volume

- **Event handles** appear on hover or selection:
  - Triangular **fade-in and fade-out handles** in the upper-left and upper-right corners. Drag to set fade length. With several events selected, the same fade applies to all.
  - An **event volume control** at the bottom left **[14+]**. Click and hold to get a small fader; `Shift` for fine steps; the delta is shown in brackets. Older versions used a square handle at the top centre.
  - The waveform redraws to reflect fades and gain.
- **Fades are event-based and real-time.** Double-clicking a fade opens the Fade dialog for curve shape **[U]**. Clip-based (destructive) fades exist separately.
- **By range**: *Adjust Fades to Range* (`A`), Fade In to Range Start, Fade Out from Range End.
- **Crossfade**: `X` on two selected overlapping events, or on a range across a boundary. Default shape is linear and symmetric. If only the clips overlap, the events are resized to overlap. The Crossfade editor sets shape and length.
- **Auto Fades**: global or per-track fades of 1 to 500 ms on every event edge to kill clicks. They are not drawn.
- **Event volume curves** **[14+]**: Draw tool on an audio event adds curve points with bezier segments. The envelope travels with the event.
- Optional preference: *Use Mouse Wheel for Event Volume and Fades* (wheel = volume; `Shift`+wheel = fade, left or right half of the event picks in or out).

### 2.5 Range operations

With a selection range:

- Move content by dragging; duplicate by `Alt`-drag or `Ctrl+D`.
- `Delete` leaves a gap. **Delete Time** (`Shift+Backspace`) closes the gap.
- `Ctrl+X` cut. **Cut Time** (`Ctrl+Shift+X`) cuts and closes. **Paste Time** (`Ctrl+Shift+V`) inserts and pushes later material right. **Insert Silence** (`Ctrl+Shift+E`).
- **Split** at range edges (`Shift+X`); **Crop** (trim events to the range); Fill Range from Clipboard.
- `E` / `D` move the left / right range side to the cursor.
- Events crossing a range edge are split automatically when the content is moved.
- Ranges persist after edits and persist when switching tools.
- Range edges can be dragged, including vertically to add or remove tracks.

### 2.6 Cycle and locators

- The **left and right locators** are a persistent pair shown as flags in the ruler. The range between them is highlighted in the ruler and the event display.
- Locators serve as cycle range, punch range, export range and "In Loop" selection scope all at once.
- Setting them:

| Action | Gesture |
|---|---|
| Set left locator | `Ctrl`-click in the upper ruler, or `Ctrl+Num 1` (to cursor) |
| Set right locator | `Alt`-click in the upper ruler, or `Ctrl+Num 2` (to cursor) |
| Draw the range | Drag in the upper ruler |
| Both to nearest snap position | `Ctrl+Alt`-click in the upper ruler |
| **Locators to selection** | `P` |
| Loop the selection (set locators, cycle and play) | `Alt+P` |
| Type positions | `Shift+L`, `Shift+R`; `Shift+D` for the range duration |
| Recall | Double-click a cycle marker |

- **Cycle on/off**: `Num /`, or click the locator range in the upper ruler.
- If the right locator is before the left with cycle on, the range is **skipped** during playback.

### 2.7 Markers and arranger

- **Marker track(s)**, up to 10, one active at a time.
- **Position markers** (numbered vertical lines) and **cycle markers** (two markers joined by a bar; they store a locator pair).
- Adding on the marker track: `Alt`-click = position marker; `Ctrl`-drag = cycle marker; add `Shift` to rename immediately.
- Keys: `Insert` adds a position marker at the cursor on the active marker track. `Ctrl+1..9` set markers 1 to 9. `Shift+1..9` go to markers 1 to 9. `Shift+N` / `Shift+B` next / previous marker. `Shift+Num 1..9` recall cycle markers. `Ctrl+M` opens the Markers window (a list editor).
- Marker lines can be drawn through all tracks. `Alt`+double-click a cycle marker zooms to it. Cycle markers also appear in the zoom presets menu.
- **Arranger track** (one per project): draw arranger events (auto-named A, B, C) over sections, then order them with repeat counts in an **arranger chain** in the Arranger Editor. Activate Arranger Mode for non-linear playback. *Flatten* renders the chain to a linear project.

### 2.8 Undo and history

- `Ctrl+Z` undo, `Ctrl+Shift+Z` redo. **Not** `Ctrl+Y`.
- **Edit > History** (Edit History dialog): columns Action, Time, State, Details (editable note). Drag a **separator line** up to undo several steps, down to redo. Maximum Undo Steps is in Preferences > General.
- **MixConsole has a separate undo stack**: `Alt+Z` / `Alt+Shift+Z`, with its own History tab. Mixer parameter moves do not pollute the edit history.
- **Zoom has its own undo/redo** (Edit > Zoom > Undo Zoom / Redo Zoom).
- Sampler Control and Drum Machine each keep their own history.

Sources: `B/project_window/project_window_toolbar_r.html`, `.../project_window_snap_types_r.html`, `.../project_window_grid_types_r.html`, `.../project_window_edit_history_dialog_r.html`, `B/parts_events/parts_and_events_editing_techniques_c.html`, `.../parts_and_events_resizing_c.html`, `.../parts_and_events_splitting_t.html`, `.../parts_and_events_gluing_t.html`, `.../parts_and_events_duplicating_t.html`, `.../parts_and_events_repeating_t.html`, `.../parts_and_events_sliding_the_contents_t.html`, `B/range_editing/range_editing_selection_range_creating_t.html`, `.../range_editing_selection_ranges_editing_c.html`, `B/fades_crossfades_and_envelopes/fades_event_based_handles_c.html`, `.../fades_crossfades_c.html`, `.../fades_event_envelopes_c.html`, `B/playback/playback_left_and_right_locator_c.html`, `B/markers/markers_c.html`, `B/arranger_track/arranger_track_c.html`, `B/quantizing_midi_audio/quantizing_quantize_functions_r.html`, `B/preferences/preferences_editing_r.html`, `B/preferences/preferences_editing_tool_modifiers_r.html`, `B/track_handling/track_handling_lanes_working_with_c.html`

---

## 3. Tracks

### 3.1 Track types (Cubase Pro 15)

| Group | Types |
|---|---|
| With a mixer channel | **Audio**, **Instrument**, **Sampler**, **Drum** **[14+]**, **MIDI**, **Group Channel**, **Effect (FX) Channel**, **VCA Fader** |
| Organisational / global | **Folder**, **Marker**, **Ruler**, **Tempo**, **Signature**, **Arranger**, **Transpose**, **Chord**, **Video** |

Input and output busses appear as channels in the MixConsole, not as tracks, though they can be given automation tracks.

**Adding tracks:**

- `T` or the `+` button opens the Add Track dialog: type, count, configuration (mono, stereo, surround), routing, name.
- Double-click empty space in the track list: adds a MIDI track if nothing is selected, or a track of the same type and routing as the selected track.
- Drag files from MediaBay.
- *Use Track Preset*.

### 3.2 Track header controls

Configurable per track type in the **Track Controls Settings dialog** (right-click the track list, or the button at its bottom-right corner). Controls can be added, removed, reordered and grouped so they stay adjacent. **Mute and Solo are the only controls that cannot be removed.**

| Control | Label | Key | Notes |
|---|---|---|---|
| Mute | **M** | `M` | |
| Solo | **S** | `S` | `Ctrl`-click = exclusive solo. `Alt`-click or click-and-hold = Solo Defeat. |
| Record Enable | red dot | `R` | Preference: auto-enable on track selection (separate for audio and MIDI). |
| Monitor | speaker | none by default | Routes input to output. |
| Read Automation | **R** | `Alt+R` = all tracks | |
| Write Automation | **W** | `W`; `Alt+W` = all tracks | Colour shows state, see section 6. |
| Edit Channel Settings | **e** | | Opens the Channel Settings window. |
| Lock | padlock | | Locks all events on the track. |
| Show Lanes | | | Expands take lanes under the track. |
| Switch Time Base | note / clock | | Musical or linear. |
| Freeze Channel | snowflake | | |
| Channel Configuration | | | Mono / stereo indicator. |
| Inserts State, Bypass EQs, Bypass Sends, Modulators State | | | Indicator and bypass buttons. |
| Listen | **L** | | Control Room. |
| Volume, Pan | mini controls | | Optional in the header. |
| Instrument tracks | Edit Instrument, Instrument selector, Programs, Drum Map, Edit In-Place | | |
| Folder tracks | Expand/Collapse, Group Editing, Phase-Coherent AudioWarp | | |
| Marker tracks | Add Position Marker, Add Cycle Marker, Locate / Cycle / Zoom menus, Activate Track | | |

- Track name: double-click to rename, `Return` to confirm. Any modifier + `Return` also renames all events on the track. `Alt+F2` renames the first selected track.
- Automation: an arrow at the **lower-left corner of the track** on hover (Show/Hide Automation), and a `+` on an automation track to append another.

### 3.3 Inspector (Track tab)

Sections, shown or hidden via right-click > Set up Sections; click a section name to open or close it; *Expand Sections Exclusively* is optional.

- Sections: Basics, Routing, Track Versions, Chords, Notepad, Modulators, Inserts, Equalizer, Channel Strip, Sends, Cue Sends, Direct Routing, Surround Pan, Fader, Quick Controls, plus MIDI-specific ones (Expression Map, Note Expression, MIDI Inserts, MIDI Modifiers, MIDI Sends, MIDI Fader).
- **Basics for an audio track**: name (double-click to rename, `Alt`-click to colourise), e, M, S, R, W, Listen, Auto Fades Settings, Record Enable, Monitor, time base, Lock, Show Lanes, Freeze, Volume, Pan, **Delay** (track timing offset), track preset load/save, Select Extension (ARA).

### 3.4 Colours

- New tracks can be auto-coloured (a preference with several modes).
- Events follow the track colour until overridden per event (Color tool, or Select Color). *Set Event Colors to Track Colors* reverts them.
- `Alt+Shift+C` = Set Track/Event Color. `Alt+Shift+S` opens Project Colors Setup (named colour set, presets).
- Preferences hold default colours per track type.
- MixConsole: channel colour can be applied to channel controls and fader caps.

### 3.5 Track height and zoom

- Drag a track's **lower border** in the track list. `Ctrl`-drag resizes **all** tracks.
- **Track Height Presets** menu: 1, 2, 3, 4 or N rows; Zoom Tracks Full; Zoom 4, 8 or N Tracks; Zoom Tracks Minimal; Snap Track Heights.
- Height is measured in **rows**. Several features need at least 2 rows: Combine Selection Tools, drag-repeat.
- `Ctrl+Down` / `Ctrl+Up` zoom selected tracks in / out. **`Z` = Zoom Tracks Exclusive** (enlarge the selected track, minimise the rest). *Enlarge Selected Track* is an option that auto-enlarges on selection.
- `Shift+H` / `Shift+G` zoom all tracks vertically; individual height differences are preserved proportionally.

### 3.6 Folder and group tracks

- **Folder tracks** can hold any track type, including other folders. Drag tracks in or out. Expand/collapse button.
- A folder shows a summary of contained data (configurable: always, never, hide when expanded, event details). The **folder part** can be moved, cut and copied as one unit, editing all contained tracks. Double-click a folder part to open the editors.
- Folder header M, S, R, Monitor act on all children.
- Project > Track Folding: Fold, Unfold, Flip Fold States, Toggle Selected; Move Selected Tracks to New Folder.
- **Folder with group channel [15]**: *Enable Group Channel* turns a folder into a summing bus. Children are auto-routed to it, and it appears in the MixConsole. This merges the old "folder" and "group" concepts.
- **Group Channel tracks**: summing busses. They show only automation in the Project window, and a full strip in the MixConsole.
- **FX Channel tracks**: send-effect returns.
- **VCA**: see section 5.

### 3.7 Lanes, comping, track versions

- Cycle recording in *Keep History* mode stacks takes. **Show Lanes** displays each take on its own lane.
- **Comp tool**: click a take to bring it to the front; drag across lanes to cut all takes at the range and select a segment. Clean Up Lanes; Create Tracks from Lanes.
- **Track Versions**: alternative playlists per track. `Ctrl+Shift+N` new, `Ctrl+Shift+D` duplicate, `Ctrl+Shift+H` / `Ctrl+Shift+G` next / previous.

### 3.8 Presets and visibility

- **Track presets**: save and load channel settings (inserts, EQ, strip, plus instrument and sound). Multi-track presets exist. Inserts or EQ alone can be loaded from a preset.
- **Visibility** tab (left zone): a tree of all tracks with checkboxes to show or hide; folders collapse; drag to reorder.
- Supporting features: Track Visibility Configurations (saved sets); **Visibility Agents** (Show All; Show Only Selected; Hide Selected; with Data; with Data at the Cursor Position; with Data between the Locators; Connected to the First Selected Channel; plus undo/redo of visibility changes); Track Type Filter; Find Track (`Ctrl+F`).
- Project and MixConsole visibility can be synchronised.
- **Disable Track**: unloads processing and hides the channel. Different from mute.

Sources: `B/tracks_about/tracks_about_about_tracks_c.html`, `.../tracks_about_customizing_track_controls_r.html`, `.../tracks_about_track_controls_r.html`, `B/track_handling/track_handling_setting_the_track_height_c.html`, `.../track_handling_organizing_tracks_in_folder_tracks_c.html`, `.../track_handling_lanes_working_with_c.html`, `.../track_handling_trackversions_c.html`, `.../track_handling_track_presets_c.html`, `B/project_window/project_window_visibility_r.html`, `B/project_window/project_window_color_handling_c.html`, `B/key_commands/key_commands_edit_category_c.html`

---

## 4. Transport

### 4.1 Controls and sections

- **Main buttons**: Go to Previous Marker/Zero, Go to Next Marker/Project End, Rewind, Forward, Cycle, Stop, Start, Record.
- **Other sections** (each can be shown or hidden): Audio Performance Meter; Common / Audio / MIDI Record Modes; MIDI Auto Quantize; Locators; Locator Range Duration; Punch Points; Time Display (primary and secondary); Markers; Pre-roll & Post-roll; Tempo & Time Signature (with Tap Tempo); External Sync; Click, Count-in and Click Pattern; Input/Output Activity; Level Control.

**Start modes** (Transport menu): Start from Project Cursor Position; from Cycle Start; from Selection; from Selection or Cycle Start. Plus **Return to Start Position on Stop**.

Stop behaviour **[U]**: pressing Stop (`Num 0`) again while stopped steps the cursor back to the previous start position, then to the project start.

**Play Project Range commands**: Play from Selection Start / End; Play until Selection Start / End (2 s pre-roll); Play until Next Marker; Play Selection Range (`Alt+Space`); Loop Selection (`Alt+P`); Play Selection Solo (`Ctrl+Alt+Space`); Loop Selection Solo (`Alt+Shift+P`).

### 4.2 Record, punch, pre-roll

- **Record**: `Num *`. Common Record Modes: Punch In/Out; Start Recording at Project Cursor Position; at Left Locator/Punch In Position; at Selection.
- **Audio record modes**: Keep History, Cycle History + Replace, Replace. MIDI has Merge, Replace, Stacked, Mix-Stacked and similar.
- **Punch In** `I`, **Punch Out** `O`. Punch points are **locked to the locators by default** (*Lock Punch Points to Locators*). Unlock to get independent punch handles in the ruler and editable fields (`Shift+I`, `Shift+O`).
- **Pre-roll / Post-roll**: toggles plus amounts on the transport. Post-roll only applies after an automatic punch out, when *Stop after Automatic Punch Out* is enabled.
- **Retrospective MIDI record**: `Shift+Num *`.

### 4.3 Metronome

- Toggle click: `C`.
- **Metronome Setup, General tab**: MIDI click and/or audio click; click output bus; Click while Recording; Click while Playing; Click during Count-In; Number of Bars in Count-In; count-in signature (at record start, at project position, or custom).
- **Click Sounds tab**: custom sounds and levels per accent.
- **Click Patterns**: per-signature accent patterns with an editor.
- *Create Click Track* renders the click to audio or MIDI.

### 4.4 Tempo and signature

- Two modes, toggled by *Activate Tempo Track* on the transport: **Fixed Tempo** (one rehearsal tempo) or **Tempo Track**.
- Defaults: 120 BPM, 4/4.
- **Tempo track** and **Signature track** can live in the track list. The **Tempo Track Editor** (`Ctrl+T`) is a separate curve editor (tempo events as a curve, ramp or jump types **[U]**; time signature events; Process Tempo; Process Bars).
- `Shift+T` type tempo. `Shift+C` type time signature. `Shift+Space` tap tempo.
- **Track time base** is per track: Musical (events follow tempo changes) or Linear (events fixed in time).
- The Time Warp tool drags bar lines to audio.

### 4.5 Time display

- Formats: **Bars+Beats** (bar.beat.sixteenth.tick, 120 ticks per sixteenth by default), **Seconds** (h:m:s.ms), **Timecode** (h:m:s:f, optional subframes), **Samples**, **fps (User)**.
- **Primary time format** is global: rulers, info line and position fields all follow it. A **secondary display** is independent.
- `.` (period) = Exchange Time Formats (swap primary and secondary).
- A separate floating Time Display window exists (large readout).
- The grid options depend on the primary format (section 2.2).

### 4.6 Position jumps and follow

| Action | Key |
|---|---|
| Go to left / right locator | `Num 1` / `Num 2` |
| Go to project start | `Num .` (also `Num ,`) |
| Rewind / Forward | `Num -` / `Num +` |
| Fast rewind / forward | `Shift+Num -` / `Shift+Num +` |
| Nudge cursor left / right | `Ctrl+Num -` / `Ctrl+Num +` |
| Locate selection start | `L` |
| Next / previous event on the selected track | `N` / `B` |
| Next / previous marker | `Shift+N` / `Shift+B` |
| Next / previous hitpoint | `Alt+N` / `Alt+B` |
| Type a cursor position | `Shift+P` |

- Set the cursor by clicking the lower ruler, or `Shift+Alt`-click in the event display.
- **Auto-Scroll** `F`. Modes: **Page Scroll** (page-turn) or **Stationary Cursor** (`Alt+C`; cursor fixed mid-screen, content scrolls).
- **Suspend Auto-Scroll When Editing**: clicking in the event display during playback pauses following until stop. The button changes colour.

Sources: `B/playback/playback_transport_panel_sections_r.html`, `.../playback_transport_menu_functions_r.html`, `.../playback_transport_r.html`, `.../playback_setting_the_project_cursor_t.html`, `.../playback_autoscroll_r.html`, `.../playback_time_formats_r.html`, `.../playback_preroll_and_postroll_c.html`, `.../playback_punch_in_and_punch_out_c.html`, `.../playback_metronome_setup_r.html`, `.../playback_metronome_basics_tab_r.html`, `B/recording/recording_common_record_modes_r.html`, `B/recording/recording_audio_record_modes_r.html`, `B/editing_tempo_and_signature/editing_tempo_tempo_track_c.html`, `B/key_commands/key_commands_transport_category_c.html`

---

## 5. MixConsole

### 5.1 Where it lives

- Separate window: `F3`. Up to several MixConsole windows, each with its own visibility.
- Lower zone of the Project window: `Alt+F3`. This is a reduced variant: no left zone, no channel overview, no meter bridge. It follows **Project-window** track visibility, not the MixConsole window's.
- The **Channel tab** (one strip beside the Inspector) and the **Channel Settings window** (the `e` button: full single-channel editor with inserts, strip, EQ, sends, fader) are the single-channel views.

### 5.2 Window layout (top to bottom)

1. **Toolbar**: mixer Undo / Redo; Save Snapshot and Snapshot Functions; Find Track/Channel; Channel Visibility Configurations; Visibility Agents; Channel Type Filter; locators, transport controls, time displays and markers (the same groups as the Project toolbar); state buttons (clear all M / S / L, global R / W, Suspend automation); **bypass-all buttons** for Modulators, Inserts, EQs, Channel Strip and Sends of all visible channels; link controls (Link/Unlink, Edit Link Group Settings, Sus, Abs, Q-Link); **zoom palette** (Reduce / Increase Channel Width, Set Number of Channels, Reduce / Increase Section Height); Audio Performance Meter; Functions menu; Show/Hide Left Zone, Show/Hide Right Zone, Set up Window Layout.
2. **Channel Overview**: every channel as a small box, for navigation. Window only.
3. **Meter Bridge**: PPM or Wave mode. Window only.
4. **Equalizer Curve**: thumbnail per channel. Click to open a larger editable view.
5. **Channel sections ("racks")**, each a collapsible band across all channels, shown or hidden via the *Racks* / Set up Window Layout menu: Hardware, **Routing**, **Pre** (HC/LC filters, gain, phase), Modulators **[14+]**, **Inserts**, **EQ**, **Strip** (Gate, Compressor, EQ position, Tools, Sat, Limit), **Sends**, Cue Sends, Direct Routing, Quick Controls, Device Panel.
6. Pictures, Notepad, Channel Latency (optional rows).
7. **Fader section**.

Left zone tabs: Visibility (Channel and Zones sub-tabs), History, Snapshots. Right zone tabs: CR, Meter, Automation.

**Zones tab**: lock channels to the **left or right edge** so they never scroll, for example outputs pinned right and a vocal pinned left.

### 5.3 A channel strip in the fader section (top to bottom)

1. Link group display line (group number and name)
2. **Pan control**
3. **M**, **S**, **L** (Listen), **e** (Edit Channel Settings)
4. **Fader** with a **level meter** beside it
5. Below the fader: numeric **fader level** and **Meter Peak Level** value. Clicking the peak value resets it.
6. **R / W** automation buttons; **Monitor** and **Record Enable** on recordable channels
7. Channel type icon, **channel name** (double-click to rename), **channel colour** strip

Channel order equals track-list order. Reordering one reorders the other.

### 5.4 Fader, level and meters

- **Maximum fader level is +6 dB by default.** It is a per-project setting, *Project Setup > Volume Max*. Confirmed wording: "Allows you to specify the maximum fader level. By default, this is set to +6 dB." The alternative value is +12 dB **[U]**.
- The fader bottom is minus infinity **[U]**. The scale is non-linear with more resolution around 0 dB **[U]**.
- MIDI channels show 0 to 127.
- Mouse conventions:
  - `Shift`-drag = fine adjustment.
  - `Ctrl`-click = reset to default (0 dB).
  - Double-click the value field to type **[U]**.
  - The wheel changes values, subject to the **Mouse Wheel Mode** preference: Enable, Disable in Scrollable Areas, Disable.
  - Slider behaviour is a preference: **Jump, Touch, Ramp, Relative**. Knob behaviour: **Circular, Relative Circular, Linear**.
- **Meters**:
  - Channel meters use the **+3 dB Digital Scale**. Colours are configurable, with thresholds as draggable handles (Preferences > Metering > Appearance).
  - **Global Meter Settings** (right-click a meter): Hold Peaks; Hold Forever (otherwise hold time is 500 to 30000 ms); position **Input**, **Post-Fader** or **Post-Panner**; Reset Meters.
  - **Clipping indicators** are on **input and output channels**.
  - **Master Meter** (right zone): true peak, with scales Digital, DIN, EBU, British, Nordic, K-20, K-14, K-12, +3 / +6 / +12 dB Digital.
  - **Loudness meter**: EBU R 128 (Integrated, Short-Term, Momentary, Range, True Peak).

### 5.5 Pan

- **Stereo Balance Panner** is the default for stereo channels.
- **Stereo Combined Panner** (via context menu): independent left and right pan handles that keep their distance. `Alt`-drag moves one side. Crossing them reverses the image, shown by a colour change.
- Mono channels get a simple pan. Surround gets a miniature VST MultiPanner.
- `Shift` = fine. `Ctrl`-click = centre. Double-click = type a value.
- **Pan Bypass**: `Ctrl+Alt+Shift`-click.
- **Stereo Pan Law** is a per-project setting (Project Setup) and is shown on the status line. The manual describes it as attenuating centre-panned signals, with a 0 dB option that turns off constant-power panning, and Equal Power. Value list **[U]**: Equal Power, -6 dB, -4.5 dB, -3 dB (default), 0 dB.

### 5.6 Solo, mute, listen

- **M** mutes. **S** solos (mutes all others).
- `Ctrl`-click S = **exclusive solo**.
- `Alt`-click S, or click-and-hold = **Solo Defeat**: the channel is never muted by other solos. Typical use: FX returns.
- Toolbar: Deactivate All Mute / Solo / Listen states.
- **Listen (L)**: AFL/PFL to the Control Room without disturbing the mix. Requires Control Room to be active.
- Preferences: Select Channel/Track on Solo; Enable Solo on Selected Track.

### 5.7 Linking and VCA

- **Link groups**: select channels, then *Link*. The dialog chooses what is linked: Volume, Pan, EQ, Dynamics, Sends, Inserts, Mute/Solo/Listen, Automation R/W, Routing, Selection, Record Enable/Monitor. Defaults: volume, sends, routing, selection.
- **Sus** (or hold `Alt`) suspends the link for an individual tweak. **Abs** makes changes absolute instead of relative.
- **Q-Link**: a toggle, or hold `Shift+Alt`. Any parameter touched is applied to all **selected** channels.
- `Shift+Alt` while choosing a routing bus applies it to all selected channels.
- **VCA faders**: a fader with no audio path that offsets the levels (in dB) of a link group. Also controls mute, solo, listen, monitor and record. Shows a summed peak meter and the group name instead of a panner. VCA automation can be combined with or coexist with channel automation. Created by right-click > Add VCA Track.

### 5.8 Sections in detail

- **Inserts**: slots with a movable **pre/post-fader divider**. Each slot has on/bypass and open-editor controls. Drag to move; `Alt`-drag to copy between slots and channels. FX Chain presets. Slot count is 16 **[U]**.
- **EQ**: built-in parametric with **up to 4 bands**, each 20 Hz to 20 kHz with a selectable filter type. Curve display; double-click a point to deactivate the band; presets. `Alt`-click the bypass button to reset.
- **Sends**: slot = destination plus level slider plus on/off, with a pre/post switch. 8 sends **[U]**. Up to 4 cue sends. Up to 8 Direct Routing destinations. Up to 8 modulators per channel.
- **Drag and drop** copies or moves whole sections between channels.
- **History and snapshots**: every mixer parameter change is logged and undoable separately. Up to 10 **snapshots** per project store full mixer states, with recall settings.

### 5.9 Keyboard in the MixConsole

- `Tab` / `Shift+Tab` cycle focus between the left zone, channel sections and fader section.
- Arrow keys move a red focus rectangle between controls.
- `Return` toggles a switch or opens a slot. `Esc` closes.
- `Ctrl+Alt+Return` enables or disables the focused plug-in.
- `Left` / `Right` arrows select the previous / next channel **[U]**.

Sources: `B/mixconsole/mixconsole_c.html`, `.../mixconsole_mixconsole_window_r.html`, `.../mixconsole_set_up_window_layout_pane_r.html`, `.../mixconsole_fader_section_c.html`, `.../mixconsole_setting_pan_c.html`, `.../mixconsole_using_solo_and_mute_c.html`, `.../mixconsole_listen_mode_c.html`, `.../mixconsole_setting_volume_c.html`, `.../mixconsole_channel_meter_options_r.html`, `.../mixconsole_linking_channels_c.html`, `.../mixconsole_using_quick_link_t.html`, `.../mixconsole_keyboard_navigation_c.html`, `B/vca_faders/vca_faders_c.html`, `B/loudness/loudness_master_meter_r.html`, `B/project_handling/project_handling_project_setup_dialog_r.html`, `B/preferences/preferences_editing_controls_r.html`

---

## 6. Automation

### 6.1 Read and write

- **R** and **W** buttons per track and channel. The track-list buttons and the MixConsole buttons are the same state.
- Enabling W auto-enables R.
- **W colour states [15]**:

| Colour | Meaning |
|---|---|
| No colour | Write off |
| Red | Write armed |
| Orange | Currently writing |
| Orange inverted | Writing a plug-in parameter only |

- Global R / W / Suspend buttons are on the Project toolbar, the MixConsole toolbar and the Automation panel. `Alt+R` / `Alt+W` toggle all tracks.
- Writing happens **during playback** when a control is touched. Record mode is not needed.

### 6.2 Modes (global; punch-out behaviour differs)

| Mode | Behaviour |
|---|---|
| **Touch** | Writes only while the control is held. On release it returns to the existing curve over the *Return Time*. |
| **Auto-Latch** | Keeps writing the last value after release, until stop or W is turned off. On/off switches always use this mode. |
| **Cross-Over** | Like latch, but punches out automatically when the control is moved back across the original curve. |
| **Trim** (a modifier, for volume and cue send level) | A relative trim curve sits in the middle of the lane and offsets the existing automation. *Freeze Trim* merges it: on pass end, on leaving trim, or manually. |

- General punch-out conditions: stop, clicking W, wind, reaching the right locator in cycle, relocating by clicking the ruler.
- **Fill options**: To Punch, To Start, To End, Loop, Gaps. They write the held value across a region.
- **Suspend Read / Suspend Write** work per parameter or parameter group, with *Set All*. Group list **[U]**: Volume, Pan, EQ, Sends, Inserts, Mute, Others. The manual's own example is suspending write for Mute, so that muting tracks while mixing does not get recorded.
- **Automation panel**: `F6`. Floating, or in the right zone. Horizontal or vertical layout **[15]**.

### 6.3 Automation tracks (lanes)

- Each automated parameter gets an **automation track** indented under its parent track.
- Open the first lane with the arrow at the track's lower-left corner on hover. `+` on a lane appends another.
- Click the parameter name to open a searchable parameter selector. An asterisk marks parameters that have hidden data. Changing the shown parameter is non-destructive.
- *Show All Used Automation*. *Show Only Automation Tracks of <plug-in>*. *Remove Unused Parameters*.
- Per-lane controls: R / W, **Mute Automation**, lock.
- **Static value line**: with no events, a dotted horizontal line shows the current value. With R off, an existing curve is greyed out and the static line applies.
- **Virgin Territory** (optional): gaps with no automation, where the parameter is free. **Terminator points** end a region.
- Folder tracks with a group channel can show automation on the folder **[15]**.

### 6.4 Editing curves

- Two curve kinds: **ramp** (continuous) and **step** (on/off, for example mute).
- **Object Selection**: click the line to add a point; drag points; `Alt`-drag to draw many; rubber-band or `Shift`-click to multi-select.
- **Draw** draws freehand and is thinned afterwards by the *Reduction Level*. **Line** tool modes: Line, Parabola, Sine, Triangle, Square.
- **Bezier segments**: hover a ramp segment to get a mid handle; drag to bend; double-click the handle to reset to linear.
- **Automation Event Editor**: selecting several points on a ramp shows a box with smart handles: Tilt Left / Right, Compress Left / Right (`Alt`), Scale Vertically, Move Vertically, Scale Around Absolute / Relative Centre, Stretch.
- **Quick vertical scaling**: a handle on the lane's upper border, above a segment.
- `Ctrl`-drag constrains direction. A delta indicator shows deviation while writing.
- `Delete` removes selected points. `Alt`-drag a selection copies it.
- **Automation Follows Events** (toolbar toggle and preference): automation moves and copies with events.
- **Copy Automation** between tracks over the locator range (all tracks, selected tracks, or selected parameters) **[15]**.

Sources: `B/automation/automation_c.html`, `.../automation_editing_automation_data_c.html`, `.../automation_automation_tracks_c.html`, `.../automation_automation_panel_r.html`, `.../automation_automation_modes_c.html`, `.../automation_trim_c.html`

---

## 7. Default key commands

**All rows below are verified** against the official Default Key Commands tables for Cubase Pro 15.0.30 and are identical in 14.0.30, unless marked **[U]**.

- Mac: replace `Ctrl` with `Cmd` and `Alt` with `Opt`. The exception is the MediaBay `Ctrl-Alt/Opt-Num` set, where Ctrl stays Ctrl on Mac.
- `Num` keys need a numeric keypad. Laptops without one lose most transport defaults, which is a known Cubase pain point.
- While the On-Screen Keyboard is shown (`Alt+K`), most keys are blocked. Still active: `Ctrl+S`, `Num *`, `Space`, `Num 1`, `Delete`, `Num /`, `F2`, `Alt+K`.

### 7.1 Transport

| Command | Windows | Mac |
|---|---|---|
| Start/Stop | `Space` | same |
| Start | `Enter` (numpad) | same |
| Stop | `Num 0` | same |
| Record | `Num *` | same |
| Cycle on/off | `Num /` | same |
| Rewind / Forward | `Num -` / `Num +` | same |
| Fast Rewind / Fast Forward | `Shift+Num -` / `Shift+Num +` | same |
| Nudge Cursor Left / Right | `Ctrl+Num -` / `Ctrl+Num +` | `Cmd+...` |
| Go to Left / Right Locator | `Num 1` / `Num 2` | same |
| Go to Project Start | `Num .` (or `Num ,` / `Num ;`) | same |
| Set Left / Right Locator to cursor | `Ctrl+Num 1` / `Ctrl+Num 2` | `Cmd+...` |
| Locators to Selection | `P` | same |
| Loop Selection | `Alt+P` | `Opt+P` |
| Loop Selection Solo | `Alt+Shift+P` | `Opt+Shift+P` |
| Play Selection Range | `Alt+Space` | `Opt+Space` |
| Play Selection Solo | `Ctrl+Alt+Space` | `Cmd+Opt+Space` |
| Locate Selection Start | `L` | same |
| Locate Next / Previous Event | `N` / `B` | same |
| Locate Next / Previous Marker | `Shift+N` / `Shift+B` | same |
| Locate Next / Previous Hitpoint | `Alt+N` / `Alt+B` | `Opt+...` |
| Metronome on/off | `C` | same |
| Punch In / Punch Out | `I` / `O` | same |
| Enter Project Cursor Position | `Shift+P` | same |
| Enter Left / Right Locator | `Shift+L` / `Shift+R` | same |
| Enter Locator Range Duration | `Shift+D` | same |
| Enter Punch In / Out Position | `Shift+I` / `Shift+O` | same |
| Enter Tempo / Time Signature | `Shift+T` / `Shift+C` | same |
| Tap Tempo | `Shift+Space` | same |
| Exchange Time Formats | `.` | same |
| Activate External Sync | `Alt+Shift+T` | `Opt+Shift+T` |
| MIDI Retrospective Record | `Shift+Num *` | same |
| Auto-Scroll on/off | `F` | same |
| Stationary Cursor | `Alt+C` | `Opt+C` |
| Transport panel show/hide | `F2` | same |

Not in the default tables (no default key): Go to Project End, Monitor toggle, pre-roll and post-roll toggles.

### 7.2 Markers and cycle markers

| Command | Windows | Mac |
|---|---|---|
| Add Position Marker on active marker track | `Insert` | same |
| Set Marker 1 to 9 | `Ctrl+1` ... `Ctrl+9` (3 to 9 also `Ctrl+Num 3..9`) | `Cmd+...` |
| To Marker 1 to 9 | `Shift+1` ... `Shift+9` (3 to 9 also `Num 3..9`) | same |
| Recall Cycle Marker 1 to 9 | `Shift+Num 1..9` | same |
| Open Markers window | `Ctrl+M` | `Cmd+M` |

Markers 1 and 2 are conventionally the left and right locators, which is why `Num 1` / `Num 2` go to the locators and `Num 3..9` go to markers **[U]**.

### 7.3 Tools

| Tool | Key |
|---|---|
| Object Selection | `1` |
| Range Selection | `2` |
| Split | `3` |
| Glue | `4` |
| Erase | `5` |
| Zoom | `6` |
| Mute | `7` |
| Draw | `8` |
| Play | `9` |
| Drumstick | `0` |
| Previous / Next Tool | `F9` / `F10` |
| Combine Selection Tools on/off | `Alt+Shift+1` |

Comp, Time Warp, Line and Color have no default key.

### 7.4 Editing

| Command | Windows | Mac |
|---|---|---|
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z` | `Cmd+...` |
| Cut / Copy / Paste | `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | `Cmd+...` |
| Paste at Origin | `Alt+V` | `Opt+V` |
| Paste Relative to Cursor | `Shift+V` | same |
| Delete | `Delete` or `Backspace` | same |
| Select All / None | `Ctrl+A` / `Ctrl+Shift+A` | `Cmd+...` |
| Invert Selection | `Ctrl+Alt+I` | `Cmd+Opt+I` |
| **Duplicate** | `Ctrl+D` | `Cmd+D` |
| **Repeat** | `Ctrl+K` | `Cmd+K` |
| **Split at Cursor** | `Alt+X` | `Opt+X` |
| **Split Range** | `Shift+X` | same |
| Cut Time / Paste Time | `Ctrl+Shift+X` / `Ctrl+Shift+V` | `Cmd+...` |
| Delete Time | `Shift+Backspace` | same |
| Insert Silence | `Ctrl+Shift+E` | `Cmd+Shift+E` |
| Left / Right Selection Side to Cursor | `E` / `D` | same |
| Move Event Start / Range Start to Cursor | `Ctrl+L` | `Cmd+L` |
| Move Events to Front | `U` | same |
| Mute Events / Unmute Events / toggle | `Shift+M` / `Shift+U` / `Alt+M` | `Opt+M` for toggle |
| Lock / Unlock | `Ctrl+Shift+L` / `Ctrl+Shift+U` | `Cmd+...` |
| Group / Ungroup | `Ctrl+G` / `Ctrl+U` | `Cmd+...` |
| Group Editing on Selected Tracks | `K` | same |
| Snap on/off | `J` | same |
| Quantize | `Q` | same |
| Auto-Grid | `Shift+Q` | same |
| Crossfade | `X` | same |
| Adjust Fades to Range | `A` | same |
| Nudge Left / Right | `Ctrl+Left` / `Ctrl+Right` | `Cmd+...` |
| Nudge Start Left / Start Right | `Alt+Left` / `Alt+Shift+Right` | `Opt+...` |
| Nudge End Left / End Right | `Alt+Shift+Left` / `Alt+Right` | `Opt+...` |
| Rename Selected Events | `F2` | same |
| Rename First Selected Track | `Alt+F2` | `Opt+F2` |
| Open (editor) | `Ctrl+E` | `Cmd+E` |
| Open/Close Editor | `Return` | same |
| Edit In-Place | `Ctrl+Shift+I` | `Cmd+Shift+I` |
| Activate/Deactivate Focused Object | `Alt+A` | `Opt+A` |
| Expand/Reduce | `Alt+E` | `Opt+E` |
| Find Track/Channel | `Ctrl+F` | `Cmd+F` |
| Set Track/Event Color | `Alt+Shift+C` | `Opt+Shift+C` |

There is a naming conflict in the tables: `F2` is listed both as Rename Selected Events (Edit category) and, in the On-Screen Keyboard note, as Show/Hide Transport panel. In practice it depends on focus and selection **[U]**.

The Nudge table as published lists "Nudge Start Right = `Alt+Shift+Right`" and "Nudge End Right = `Alt+Right`", while the range-editing page lists "Nudge Start Right: `Alt+Right`". The manual is internally inconsistent here; confirm in the application.

### 7.5 Track state

| Command | Windows | Mac |
|---|---|---|
| Add Track | `T` | same |
| Mute | `M` | same |
| Solo | `S` | same |
| Record Enable | `R` | same |
| Write | `W` | same |
| Read / Write automation for all tracks | `Alt+R` / `Alt+W` | `Opt+...` |
| Remove Selected Tracks | `Shift+Delete` | same |
| Track Versions: New / Duplicate / Next / Previous | `Ctrl+Shift+N` / `D` / `H` / `G` | `Cmd+Shift+...` |

### 7.6 Zoom

| Command | Windows | Mac |
|---|---|---|
| Zoom In / Out (horizontal) | `H` / `G` | same |
| Zoom In / Out Vertically | `Shift+H` / `Shift+G` | same |
| Zoom In / Out on Waveform Vertically | `Alt+H` / `Alt+G` | `Opt+...` |
| Zoom In / Out Tracks (selected) | `Ctrl+Down` / `Ctrl+Up` | `Cmd+...` |
| Zoom Tracks Exclusive | `Z` | same |
| Zoom Full | `Shift+F` | same |
| Zoom to Selection | `Alt+S` | `Opt+S` |
| Zoom to Event | `Shift+E` | same |

### 7.7 Navigation

| Command | Key |
|---|---|
| Select next / previous event; step tracks | Arrow keys |
| Extend selection | `Shift+Arrow` |
| Top / Bottom track in the track list | `Home` / `End` |
| Toggle Selection | `Ctrl+Space` |
| Next / Previous zone (focus) | `Tab` / `Shift+Tab` |
| Page Up / Page Down | `Page Up` / `Page Down` |

`Home` and `End` select tracks. They do **not** move the cursor to project start or end.

### 7.8 Windows, zones, mixer

| Command | Windows | Mac |
|---|---|---|
| MixConsole (window) | `F3` | same |
| MixConsole in Project window (lower zone) | `Alt+F3` | `Opt+F3` |
| Audio Connections | `F4` | same |
| MediaBay / Search MediaBay | `F5` / `Shift+F5` | same |
| Automation panel | `F6` | same |
| Direct Offline Processing | `F7` | same |
| Video Player | `F8` | same |
| VST Instruments | `F11` | same |
| Audio Performance Monitor | `F12` | same |
| On-Screen Keyboard | `Alt+K` | `Opt+K` |
| Show/Hide Left Zone | `Ctrl+Alt+L` or `Alt+I` | `Cmd+Opt+L` or `Opt+I` |
| Show/Hide Right Zone | `Ctrl+Alt+R` | `Cmd+Opt+R` |
| Show/Hide Lower Zone | `Ctrl+Alt+E` or `Ctrl+Alt+B` | `Cmd+Opt+...` |
| Show/Hide Channel | `Ctrl+Alt+C` | `Cmd+Opt+C` |
| Show/Hide Transport Zone | `Ctrl+Alt+T` | `Cmd+Opt+T` |
| Show/Hide Info Line | `Ctrl+I` | `Cmd+I` |
| Show/Hide Overview | `Alt+O` | `Opt+O` |
| Previous / Next Tab | `Ctrl+Alt+Left` / `Right` | `Cmd+Opt+...` |
| Previous / Next Page | `Ctrl+Alt+Up` / `Down` | `Cmd+Opt+...` |
| Show/Hide Chord Pads | `Ctrl+Shift+C` | `Cmd+Shift+C` |
| Show/Hide Controller Lanes | `Alt+L` | `Opt+L` |
| Undo / Redo MixConsole step | `Alt+Z` / `Alt+Shift+Z` | `Opt+...` |
| Open Pool | `Ctrl+P` | `Cmd+P` |
| Open Tempo Track Editor | `Ctrl+T` | `Cmd+T` |
| Open Score Editor | `Ctrl+R` | `Cmd+R` |
| Project Setup | `Shift+S` | same |
| Project Colors | `Alt+Shift+S` | `Opt+Shift+S` |
| Workspace 1 to 9 | `Alt+Num 1..9` | `Opt+...` |
| Update Workspace | `Alt+U` | `Opt+U` |
| New Workspace / No Workspace | `Ctrl+Num 0` / `Alt+Num 0` | |

### 7.9 File

`Ctrl+N` new, `Ctrl+O` open, `Ctrl+S` save, `Ctrl+Shift+S` Save As, **`Ctrl+Alt+S` Save New Version** (incremental save), `Ctrl+W` close, `Ctrl+Q` quit.

### 7.10 Things with no default key

Edit History, Go to Project End, Monitor, Slip Event Content Left/Right, the grid types, the automation modes, Link Project and Lower Zone Editor Cursors, Punch Out of Latch Automation. Cubase lets every one of these be bound in Edit > Key Commands, a searchable tree of commands by category with macros. Tool modifiers are a separate page in Preferences.

Sources: `B/key_commands/key_commands_default_c.html` and its category pages: `.../key_commands_transport_category_c.html`, `.../key_commands_edit_category_c.html`, `.../key_commands_tool_category_c.html`, `.../key_commands_zoom_category_c.html`, `.../key_commands_navigate_category_c.html`, `.../key_commands_nudge_category_c.html`, `.../key_commands_window_zones_category_c.html`, `.../key_commands_workspaces_category_c.html`. The 14.0 equivalents are at the same paths under `/r/cubase-pro/14.0/en/`.

---

## 8. Mouse and gesture conventions

### 8.1 Wheel

| Gesture | Result | Status |
|---|---|---|
| Wheel over the event display | Vertical scroll of tracks | **[U]** |
| `Shift`+wheel | Horizontal scroll (an *Invert Direction for Horizontal Scrolling* preference exists **[15]**) | Preference verified, binding **[U]** |
| `Ctrl`+wheel | **Horizontal zoom** | Verified |
| `Ctrl+Shift`+wheel | **Vertical zoom** | Verified |
| Wheel over a fader, knob or value field | Changes the value, subject to Mouse Wheel Mode | Verified |
| Wheel over an event, with the preference on | Event volume; `Shift`+wheel = fade length | Verified |
| Wheel over the Color tool button | Steps through colours | Verified |

### 8.2 Ruler

| Gesture | Result |
|---|---|
| Click in the lower half | Set the project cursor |
| Drag vertically in the lower half | Zoom: down = in, up = out |
| Drag in the upper half | Draw the locator range |
| Click the locator range (upper half) | Toggle cycle |
| Drag the locator range (hand cursor) | Move the range |
| `Ctrl`-click upper half | Set left locator |
| `Alt`-click upper half | Set right locator |
| `Ctrl+Alt`-click upper half | Both locators to nearest snap position |
| Right-click, or the arrow at the right end | Time format menu; `Ctrl`+select = set globally |

### 8.3 Event display

| Gesture | Result |
|---|---|
| Click an event | Select |
| Drag | Move (after the Drag Delay) |
| `Ctrl`-drag | Constrain to horizontal or vertical |
| `Alt`-drag | Copy |
| `Alt+Shift`-drag | Shared copy |
| `Alt`-click an event (Object Selection) | Split there |
| `Ctrl+Alt`-drag inside an event | Slip content |
| `Shift+Alt`-click | Set project cursor |
| `Shift` while moving | Override Delete Overlaps |
| Drag lower corner | Resize; `Ctrl` = no snap; `Ctrl+Alt` = scale fades; `Alt` = repeat |
| Drag middle of right border (pointing hand) | Repeat copies; `Shift` = shared |
| Drag upper corner triangle | Fade in / fade out |
| Click and hold bottom-left volume control | Event gain fader; `Shift` = fine |
| **Double-click an event** | Open its editor in the **lower zone** (Sample Editor, Audio Part Editor, or default MIDI editor). `Return` does the same. A preference can switch this to a separate window. |
| Double-click empty space on a MIDI or instrument track | Create an empty one-bar MIDI part |
| Double-click between the locators on a track | Create a part spanning the locator range |
| Double-click a folder part | Open editors for the contained events |
| Double-click with Range tool | Range around the event; `Shift` extends; between events selects the gap |
| Double-click a cycle marker | Set locators to it; `Alt`+double-click zooms to it |
| Right-click | Context menu, or the Toolbox if enabled; a modifier gives the other one |
| Click empty background | Deselect; optionally select the track (*Select Track on Background Click*) |

### 8.4 Track list and Inspector

| Gesture | Result |
|---|---|
| Click / `Ctrl`-click / `Shift`-click | Select / toggle / range-select tracks; `Shift`-click a selected track deselects it |
| Drag a track (green insertion line) | Reorder; drop on a folder to nest |
| Drag the lower border | Resize height; `Ctrl` = all tracks |
| Double-click the name | Rename |
| Double-click empty space in the track list | Add a track |
| `Alt`-click the Inspector track name | Colourise |
| Right-click | Context menu (Track Controls Settings, automation, folding and so on) |

### 8.5 Value controls (the general Cubase rule)

| Gesture | Result |
|---|---|
| **`Ctrl`-click** | **Reset to default.** This is the modifier assigned to "Controls > Reset to Default Value" in Tool Modifiers. |
| **`Shift`-drag** | Fine adjustment |
| Double-click a value | Type it; `Return` confirms, `Esc` cancels **[U]** for the general case; verified for pan and info line |
| `Alt`-click Solo | Solo Defeat |
| `Ctrl`-click Solo | Exclusive solo |
| `Alt`-click an EQ or Strip bypass button | Reset that section |
| `Shift+Alt` while adjusting | Temporary Q-Link across selected channels |
| `Alt` while adjusting a linked channel | Temporarily suspend the link |
| `Ctrl+Alt+Shift`-click pan | Pan bypass |
| `Ctrl`-click a filter button (track type filter) | Reset the filter |
| Info line edit | Relative across the selection; `Ctrl` = absolute |

Sources: `B/project_window/project_window_zooming_c.html`, `B/project_window/project_window_ruler_c.html`, `B/playback/playback_left_and_right_locator_c.html`, `B/playback/playback_setting_the_project_cursor_t.html`, `B/preferences/preferences_editing_r.html`, `B/preferences/preferences_editing_controls_r.html`, `B/preferences/preferences_editing_tool_modifiers_r.html`, `B/parts_events/parts_and_events_editing_techniques_c.html`, `B/track_handling/track_handling_setting_the_track_height_c.html`, `B/project_window/project_window_lower_zone_c.html`

---

## 9. What SIANN needs

### 9.1 Ranked must-haves (top 40)

Ranking is by how quickly a working session breaks without the feature, then by how strongly a Cubase user expects the exact Cubase form.

| # | Must-have | Cubase reference |
|---|---|---|
| 1 | Play/stop on `Space`, with a visible project cursor | `Space` Start/Stop; `Num 0` stop, `Enter` start |
| 2 | Timeline with tracks, events, and a ruler split into locator half and cursor half | Upper ruler = locators and cycle; lower ruler = cursor and drag-zoom |
| 3 | Object Selection tool: select, move, resize from the lower corners | Tool `1`; lower-corner handles; three sizing modes |
| 4 | Undo/redo with a visible history list | `Ctrl+Z` / `Ctrl+Shift+Z`; Edit History with a draggable separator |
| 5 | Snap toggle and a snap type menu, with Grid and Events at minimum | `J`; Grid, Grid Relative, Events, Shuffle, Cursor and combinations |
| 6 | Grid type tied to the time format, including Adapt to Zoom | Bar, Beat, Use Quantize, Adapt to Zoom |
| 7 | Split at cursor and split tool | `Alt+X`; tool `3`; `Alt`-click with the select tool |
| 8 | Copy by `Alt`-drag, duplicate, repeat | `Alt`-drag; `Ctrl+D`; `Ctrl+K` |
| 9 | Horizontal and vertical zoom on keys and on the wheel | `H` / `G`; `Shift+H` / `Shift+G`; `Ctrl`+wheel; `Ctrl+Shift`+wheel |
| 10 | Zoom Full and Zoom to Selection | `Shift+F`; `Alt+S` |
| 11 | Left and right locators with cycle | `Num /`; `P` locators to selection; `Num 1` / `Num 2` |
| 12 | Track header with M, S, record enable, monitor, and name | M and S are non-removable in Cubase; `M`, `S`, `R` keys |
| 13 | MixConsole reachable in the lower zone and as a window | `Alt+F3`; `F3` |
| 14 | Channel strip: pan, M, S, e, fader, meter, peak value, name, colour | Fader section layout, section 5.3 |
| 15 | Fader with +6 dB top, `Ctrl`-click reset, `Shift` fine | Project Setup > Volume Max, default +6 dB |
| 16 | Peak-hold meters with a clickable peak readout and clip indication | Global Meter Settings; click the peak value to reset |
| 17 | Info line that shows and edits the selection numerically | `Ctrl+I`; relative edits, `Ctrl` for absolute |
| 18 | Inspector for the selected track | Left zone, Track tab, collapsible sections |
| 19 | Zones that show and hide independently, with toolbar buttons and keys | `Ctrl+Alt+L` / `R` / `E` / `C` |
| 20 | Editor in the lower zone on double-click | Double-click or `Return` opens the editor in the lower zone |
| 21 | Fade handles and event gain directly on events | Corner triangles; bottom-left volume control |
| 22 | Crossfade on overlapping events | `X` |
| 23 | Range Selection tool with range operations | Tool `2`; Delete Time, Cut Time, Insert Silence, Crop, Split |
| 24 | Time display with switchable formats, primary and secondary | Bars+Beats, Seconds, Timecode, Samples; `.` swaps |
| 25 | Record with punch in/out and pre-roll | `Num *`; `I` / `O`; punch locked to locators by default |
| 26 | Metronome with count-in | `C`; Metronome Setup General tab |
| 27 | Tempo and time signature, fixed or track-based | Activate Tempo Track toggle; `Ctrl+T` editor |
| 28 | Markers and cycle markers with number-key recall | Marker track; `Shift+1..9`; `Insert` |
| 29 | Automation R/W per track, with lanes under the track | R / W buttons; lower-left arrow opens lanes |
| 30 | Automation curve editing with points and segments | Click to add; bezier mid-handle; event editor box |
| 31 | Automation write modes | Touch, Auto-Latch, Cross-Over, Trim |
| 32 | Inserts, EQ and sends as collapsible sections on every channel | Channel sections ("racks"); pre/post divider on inserts |
| 33 | Folder tracks, and group channels for summing | Folder with optional group channel [15] |
| 34 | Track height per track and globally, with presets | Drag lower border; `Ctrl`-drag for all; `Z` |
| 35 | Track colours inherited by events and channels | Auto-colour modes; `Alt+Shift+C` |
| 36 | Track visibility and filtering, synced with the mixer | Visibility tab; agents; type filter; `Ctrl+F` |
| 37 | Auto-scroll with page and stationary modes, suspended while editing | `F`; `Alt+C`; Suspend Auto-Scroll When Editing |
| 38 | Solo variants: exclusive and solo defeat | `Ctrl`-click S; `Alt`-click S |
| 39 | Nudge of position and edges on a separate nudge grid | `Ctrl+Left/Right`; `Alt`+arrows; Nudge Settings |
| 40 | Fully rebindable key commands and tool modifiers | Edit > Key Commands; Preferences > Editing > Tool Modifiers |

Close behind, in rough order: Glue / Erase / Mute tools (`4`, `5`, `7`); slip content (`Ctrl+Alt`-drag); quantize (`Q`); link groups, Q-Link and VCA; take lanes and the Comp tool; track versions; overview line; workspaces; separate MixConsole undo; mixer snapshots; Combine Selection Tools; Toolbox on right-click; arranger track; status line.

### 9.2 Cubase idioms a Cubase user would miss immediately

These are habits, not features. Getting them wrong makes the application feel foreign even when the feature exists.

**Keyboard**

- **Numpad transport**: `Num 0` stop, `Num *` record, `Num /` cycle, `Num 1` / `Num 2` to locators, `Num .` to start, `Num +` / `Num -` wind. `Enter` on the numpad starts.
- **`G` and `H` to zoom.** Not `Ctrl +/-`, not `+`/`-`.
- **Number-row tools `1` to `9`**, and the fact that `1` is always "get me back to the arrow".
- **`P` = locators to selection**, then `Num /` or `Alt+P` to loop it. This is the main way a Cubase user sets a loop.
- **`L` = cursor to selection start**; `N` / `B` step between events.
- **`J`** for snap, **`F`** for auto-scroll, **`C`** for click, **`Q`** for quantize, **`X`** for crossfade, **`Z`** to blow up the selected track.
- **`E` and `D`** to pull the range edges to the cursor.
- **`M`, `S`, `R`, `W`** act on the selected track with no modifier.
- **Redo is `Ctrl+Shift+Z`.**
- **`Ctrl+Alt+S` Save New Version.**
- **`F3` mixer**, `F2` transport, `F4` connections, `F11` instruments.
- **`Shift`+letter opens a type-in field**: `Shift+P` position, `Shift+L` / `Shift+R` locators, `Shift+T` tempo.

**Mouse**

- **Ruler split**: top half is the loop, bottom half is the cursor, and dragging down in the bottom half zooms in.
- **`Ctrl`-click resets any control. `Shift` is fine adjust.** Many other DAWs use double-click or `Alt`-click for reset; Cubase uses `Alt` for "copy" and for alternate tool actions.
- **`Alt` = copy while dragging**, `Ctrl` = constrain axis.
- **`Alt`-click with the arrow tool splits.** No tool switch needed.
- **Resize from the lower corners, fade from the upper corners, gain from the bottom-left control.** All visible on hover.
- **Repeat by dragging the middle of the right edge.**
- **Double-click opens the editor in the lower zone**, keeping the arrangement visible.
- **`Ctrl`-click left locator, `Alt`-click right locator** in the ruler.

**Structure and concepts**

- **Locators are a persistent object**, separate from the selection, and double as the cycle range, punch range and export range.
- **Events versus parts versus clips**: an audio event is a window onto a clip; a part is a container. Slipping content and "Sizing Moves Contents" rely on this.
- **Snap Type and Grid Type are two separate menus.** Grid Relative and Shuffle are expected to exist.
- **The lower zone / left zone / right zone vocabulary** and the four toggle buttons at the toolbar's right end.
- **The Inspector's accordion sections**, with the same sections available as racks in the mixer and in the Channel tab.
- **`e` button = Edit Channel Settings.** A lowercase "e" is recognisably Cubase.
- **R and W buttons** as lettered toggles, with W turning red.
- **Tracks and mixer channels are the same order**, and visibility can sync between them.
- **Mixer undo is separate from edit undo.**
- **Everything is configurable by right-click > Set up...**: toolbars, transport, info line, Inspector, track controls.
- **The info line** as the precise numeric editor for whatever is selected.
- **Musical versus linear time base per track.**
- **Fader tops out at +6 dB**, and channel meters read on a +3 dB digital scale.
- **Solo Defeat on FX returns**, and Listen as a separate bus.

### 9.3 Things in Cubase SIANN may choose not to copy

Noted so the decision is deliberate.

- **Numpad dependence.** Laptops have no numpad, and the defaults offer no fallback for stop, record, cycle or locator jumps.
- **Three overlapping transport surfaces** (bar, floating panel, toolbar group) plus a pop-up.
- **`Home` / `End` select the top and bottom track** instead of moving the cursor.
- **`F2` has two meanings** depending on context.
- **Inconsistent nudge-edge bindings** between the key table and the range-editing page.
- **Two visibility systems** (Project window and MixConsole window) that are independent unless synced, and a lower-zone mixer that follows the first.
- **Monitor, Go to Project End and Edit History have no default key.**

---

## 10. Open items to confirm in a running Cubase

1. Stereo Pan Law value list and default (-3 dB).
2. Volume Max alternative value (+12 dB) and the fader's lower limit and scale markings.
3. Plain wheel = vertical scroll and `Shift`+wheel = horizontal scroll in the event display.
4. Insert slot count (16) and send count (8) in Pro 15.
5. Stop pressed twice returning to the previous start position, then project start.
6. Number key pressed twice cycling a tool's sub-modes.
7. Which nudge-edge bindings are correct (section 7.4 note).
8. Whether any of sections 1 to 8 changed in Cubase Pro 16.
