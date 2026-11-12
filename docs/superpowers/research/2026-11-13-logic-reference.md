# Logic Pro (Mac) UI reference for SIANN

**Source baseline:** Apple *Logic Pro User Guide for Mac*, **version 13.0**, which the guide's version selector shows as current (checked 2026-11-13). Base URL: `https://support.apple.com/guide/logicpro/<slug>/mac`. The URLs below use that pattern. Key commands come from Apple's "Key commands for …" reference pages (the U.S. default preset) inside the same guide.

**Verification legend:** **[V]** means the 13.0 guide states it word for word, with the page cited. **[V-legacy]** means only an older Apple manual states it. **[U]** means unverified: it comes from general knowledge or the 13.0 pages contradict each other. Cubase comparisons in §9 come from general product knowledge and are **not** cited here. Check them against the Cubase research file.

**Version changes that matter (13.0 vs. the 10.x knowledge most people have):**
- **Unified Browser.** The old Library (patches) and Loop Browser are merged into one **Browser**, shortcut **B**. ([whats-new-13](https://support.apple.com/guide/logicpro/whats-new-in-logic-pro-13-lgcp4a62a494/mac), [intro-to-the-browser](https://support.apple.com/guide/logicpro/intro-to-the-browser-lgcp9d7845e1/mac))
- **Smart Controls moved to Y.** The old mapping was B; the brief's "Y = Library, B = Smart Controls" is **out of date**. The 13.0 global table says `Show/Hide Smart Controls = Y` and `Show/Hide Browser = B`. [V] ([global-commands](https://support.apple.com/guide/logicpro/global-commands-lgcp02bf31b6/mac))
- **Streamlined inspector.** Region and track parameters now sit in one consolidated inspector, and the Region inspector gains Position and Length fields.
- **Liquid Glass visual design.**
- **Mixer track-stack view can be unlinked from the Tracks area.**
- From 12.0, all "Advanced" features are always on (the Advanced settings pane is gone). From 12.3, grid lines can be drawn over regions. ([whats-new-12](https://support.apple.com/guide/logicpro/whats-new-in-logic-pro-12-lgcp022a8b80/mac))

---

## 1. Main window anatomy

Sources:
- [main-window-interface](https://support.apple.com/guide/logicpro/main-window-interface-lgcpe9cc403a/mac)
- [tracks-area-interface](https://support.apple.com/guide/logicpro/tracks-area-interface-lgcpe9cc3f60/mac)
- [inspector-interface](https://support.apple.com/guide/logicpro/inspector-interface-lgcpe9cc3b1d/mac)
- [browser-interface](https://support.apple.com/guide/logicpro/browser-interface-lgcpe9cc40af/mac)
- [mixer-interface](https://support.apple.com/guide/logicpro/mixer-interface-lgcpe9cc43f6/mac)
- [smart-controls-interface](https://support.apple.com/guide/logicpro/smart-controls-interface-lgcp91601243/mac)
- [move-and-resize-windows](https://support.apple.com/guide/logicpro/move-and-resize-windows-lgcp5cbf1551/mac)
- [open-and-close-windows](https://support.apple.com/guide/logicpro/open-and-close-windows-lgcp5cbf18ca/mac)
- [customize-the-control-bar](https://support.apple.com/guide/logicpro/customize-the-control-bar-lgcp5bdd6d9d/mac)

**Single main window.** The window is made of areas. Control-bar buttons toggle each area, and most areas can also open as a separate window. More than one main window can be open at once (Cmd-1). [V]

| Area | Position / role | Toggle (in main window) | Separate window |
|---|---|---|---|
| **Control bar** | Top strip. View buttons for Browser, Inspector, Smart Controls, Mixer, Editors and others, plus transport, mode buttons (Cycle, Autopunch, Replace, Metronome, Count-in), the central **LCD/Display** and Master Volume *or* an output meter. Fully customizable via "Customize Control Bar and Display". | View menu | n/a |
| **Toolbar** | Optional second row of buttons under the control bar. | Ctrl-Opt-Cmd-T [V] | n/a |
| **Browser** (unified) | Left. Sidebar with All / Loops & One-Shots / Instruments / Effects / Plug-in Presets / Sound Library / Locations / Smart Searches, plus a search field (natural language), filters and a results list. *Link to Selection* makes it follow the selected track, and *Replace Mode* loads a patch onto the selected track. | **B** [V] | n/a |
| **Inspector** | Left. In 13.0 one consolidated inspector shows **Region inspector**, **Track inspector** and **two inspector channel strips**. The left strip is the selected track. The right strip is that track's output, or whatever is Shift-clicked on the left strip (Output slot shows the output, a Send slot shows the aux, the VCA slot shows the VCA master). For a stack subtrack, the right strip is the stack's main track. | **I** [V] | Region inspector float: Opt-Shift-R [V] |
| **Tracks area** | Centre. Local menu bar (Edit/Functions/View menus, tool menus, Show Automation and Show Flex buttons, Catch, Snap, Drag, Waveform Zoom, zoom sliders), **ruler**, **track headers**, **workspace** (lanes) and **playhead**. | always present | Cmd-1 (Open Main Window) |
| **Smart Controls** | Bottom pane. Macro screen controls for the selected track's patch, plus a Smart Control inspector for layout, mapping and hardware learn. | **Y** [V] | Window > Open Smart Controls |
| **Mixer** | Bottom pane. Single / Tracks / All view buttons and channel-strip-type filter buttons. | **X** [V] | Cmd-2 [V] |
| **Editors** | Bottom pane. Audio Track Editor, Piano Roll, Score, Step Editor, Audio File Editor and Session Player Editor, with a tab per type. | **E** (Show/Hide Editor) [V]; P = Piano Roll, N = Score, W = Audio File Editor [V] | Piano Roll Cmd-4, Score Cmd-5, Audio File Editor Cmd-6, Step Sequencer Cmd-3 [V] |
| **List Editors** | Right. Event, Marker, Tempo and Signature lists, used for numeric editing. | **D** [V] | Event List Cmd-7, Tempo List Opt-Shift-T [V] |
| **Note Pad** | Right. Project and track notes. | Ctrl-Shift-P [V] | n/a |
| **Project Files** | Right. Project Audio browser and All Files browser. | **O** [V] (in 10.x, O was the Loop Browser) | Project Audio Cmd-8 [V] |
| **Live Loops grid** | Left of the tracks, or replacing them. | L toggles Live Loops / Tracks; Opt-L shows both [V] | n/a |
| Play Surface (new in 13) | Onscreen keyboard, chord strips and pads. | Cmd-K [V] | n/a |

**Layout rule (inferred from the docs).** The Browser and Inspector sit on the left. List Editors, Note Pad and Project Files share the right side. Mixer, Editors and Smart Controls share **one bottom slot**, so only one is visible at a time. Their toggles are mutually exclusive in practice. [U: the exclusive bottom slot is long-standing Logic behaviour, but this page does not state it outright]

**Resizing.** Drag the divider between the Tracks area and the bottom editor vertically. *"The vertical height of the Mixer is independent of the height you set for the editors."* Any element with a resize bar can be dragged. [V]

**Key focus.** Only one area has key focus, shown by a **blue frame**. Key commands go only to the focused area. **Tab / Shift-Tab** cycle focus through the working areas. [V]

**Screensets.** Number keys **1–9** recall screensets, and Ctrl-1…9 recall screensets 1x–9x. [V] (Logic gives up bare number keys for window layouts, where Cubase uses them for tools.)

---

## 2. Tools and editing

Sources:
- [tools-overview](https://support.apple.com/guide/logicpro/tools-overview-lgcp9b92f74c/mac)
- [assign-tools](https://support.apple.com/guide/logicpro/assign-tools-lgcp5b365bf4/mac)
- [common-tools](https://support.apple.com/guide/logicpro/common-tools-lgcp8b7459e4/mac)
- [tool-menu key commands](https://support.apple.com/guide/logicpro/tool-menu-lgcp0182c4e5/mac)
- [snap](https://support.apple.com/guide/logicpro/snap-items-to-the-grid-lgcpf7c0f66a/mac)
- [drag modes](https://support.apple.com/guide/logicpro/control-positioning-with-drag-modes-lgcpf7c0a2ec/mac)
- [move-regions](https://support.apple.com/guide/logicpro/move-regions-lgcpf7c0d489/mac)
- [resize-regions](https://support.apple.com/guide/logicpro/resize-regions-lgcpf7c0c964/mac)
- [loop-regions](https://support.apple.com/guide/logicpro/loop-regions-lgcpf7c0e0db/mac)
- [repeat-regions](https://support.apple.com/guide/logicpro/repeat-regions-lgcpe51317b6/mac)
- [split-regions](https://support.apple.com/guide/logicpro/split-regions-lgcpf7c0e886/mac)
- [fades](https://support.apple.com/guide/logicpro/create-fades-on-audio-regions-lgcpf7c0ee6c/mac)
- [gain tool](https://support.apple.com/guide/logicpro/change-gain-audio-regions-tracks-area-lgcp8e4c781d/mac)
- [comping-overview](https://support.apple.com/guide/logicpro/comping-overview-lgcp317d758e/mac)
- [create-and-save-comps](https://support.apple.com/guide/logicpro/create-and-save-comps-lgcpb193382e/mac)
- [edit-comps](https://support.apple.com/guide/logicpro/edit-comps-lgcpb19217b1/mac)
- [track-alternatives](https://support.apple.com/guide/logicpro/use-track-alternatives-lgcp002c4e63/mac)
- [flex overview](https://support.apple.com/guide/logicpro/flex-time-and-pitch-overview-lgcp15968647/mac)

### 2.1 The two (or three) tool model
- Each editing area has **two Tool menus: Left-click tool and Command-click tool.** Holding Cmd temporarily swaps in the second tool, and releasing Cmd reverts. [V]
- The **right mouse button** can be set to (a) a third **Right-click tool**, (b) open the Tool menu, or (c) open the shortcut menu, which is the **default**. The setting is under Settings > General > Editing. With a third tool assigned, the Cmd-click menu moves to the middle. Right-double-click resets to the Pointer. [V]
- **T** opens a floating **Tool menu at the pointer**. While it is open, single letters pick a tool. **T T** (press twice) returns to the Pointer. Opt-PageDown and Opt-PageUp step to the next or previous tool. [V]
- Tool-menu letters, active only while the menu is open [V]:

| Tool | Key | Tool | Key |
|---|---|---|---|
| Pointer | T (second press) | Pencil | P |
| Eraser | E | Scissors | I |
| Join (glue) | J | Text | Shift-T |
| Zoom | Y | Solo | S |
| Mute | M | Fade | A |
| Marquee | R | Flex | X |
| Gain | G | Automation Select | U |
| Automation Curve | W | Finger (PR/Step) | F |
| Quantize | Q | Velocity | V |
| Brush (PR) | B | Slip / Rotate / Move | unassigned |

- **Smart Pointer** (Settings > General > Editing) uses click zones. *Fade Tool Click Zones*: the upper-left and upper-right corners of a region act as the Fade tool, and Option there gives the Loop tool. *Marquee Tool Click Zones*: the lower half of a region acts as the Marquee, except at the lower corners. [V] Even without these settings, the Pointer has zones: the **bottom-left and bottom-right corners trim (resize)**, the **upper-right corner loops**, and the **upper edge at the junction of two adjacent regions gives the Junction tool**, which moves the shared boundary of both regions. [V]
- Pointer basics: click to select, Shift-drag to rubber-band, drag to move, **Option-drag to copy**. [V]
- Zoom anywhere: hold **Ctrl-Opt** and drag, or hold **Option** over an empty background. Option-click the background returns to the previous zoom. [V]

### 2.2 Snap
- The **Snap** pop-up in the Tracks area and time-based editors offers **Smart** (follows ruler division and zoom), Bar, Beat, Division, Ticks (1/3840 beat), Frames, Quarter Frames and Samples. There is a separate on/off button, and **Cmd-G** toggles Snap to Grid. [V]
- **Absolute** (the default) snaps to the grid line. **Relative** keeps the item's offset from the grid, so 2.1.1.16 moved one beat lands on 2.2.1.16. [V]
- **Override.** Hold **Ctrl** while dragging to move in division steps, or in finer steps when zoomed in. Hold **Ctrl-Shift** to move by ticks (zoomed out) or samples (zoomed in). Ctrl-Shift breaks the 1:1 relationship between mouse and object. When zoomed so far out that the snap value would cause huge jumps, the Snap menu dims and Smart snap takes over automatically. [V]
- Alignment guides: Opt-Cmd-G toggles them. [V]

### 2.3 Drag modes (Drag pop-up)
| Mode | Behaviour [V] |
|---|---|
| Overlap | Keeps both region borders. Only the **later** audio region is heard where they overlap. |
| No Overlap | The earlier region is shortened by the overlap. |
| X-Fade | Audio overlaps are crossfaded. |
| Shuffle R / Shuffle L | Moving, resizing or deleting closes gaps to the right or left. Dragging one region over another swaps them. Opt-] and Opt-[ shuffle right and left. |

### 2.4 Region operations (verified)
- **Move.** Drag. Audio regions can only go to audio tracks, and MIDI to instrument tracks. **Nudge** with **Opt-←/→** by the nudge value, which is set with Ctrl-Opt-M (bar), B (beat), D (division), T (tick), F (frame), S (sample), 1 (1 ms) and 0 (10 ms). **Pickup Clock** (`;`) moves to the playhead. **Slip** (Ctrl-Opt-←/→) moves content inside a fixed region. **Rotate** (Ctrl-Opt-Cmd-←/→) wraps content around. Edit > Move > To Recorded Position: Opt-Shift-Cmd-R. [V]
- **Copy.** Option-drag. Opt-Shift-drag creates an alias of a MIDI region or folder. Shift-drag restricts movement to one axis. Cmd-drag between track headers creates new tracks. [V]
- **Resize (trim).** Drag the bottom corners. Option-Shift resizes the whole selection to the same absolute length. **Option on a region border turns Resize into Stretch** (time-stretch). Cmd-[ and Cmd-] set start or end to the playhead. `\` removes overlaps. Shift-\ trims the region end to the next region. Opt-\ fills within locators. Cmd-\ crops outside locators or the marquee. [V]
- **Loop.** Drag the upper-right corner, which shows notches at each repetition, or tick **Loop** in the Region inspector to loop until the next region or the project end. Key: the region-loop command is **Ctrl-L** (*Loop Regions/Cells/Folder On/Off*) in the key-command table. The loop-regions page says **"Press L"**, but L is listed as *Switch between Live Loops Grid and Tracks View*. **[U: the 13.0 guide contradicts itself. Trust the key-command table (Ctrl-L).]** Loops to Regions: Ctrl-Cmd-L. [V]
- **Repeat.** **Cmd-R** repeats regions, cells or events, placing copies right after the original. *Repeat Multiple* has a count, a grid adjustment and copies-vs-aliases. [V]
- **Split.** **Cmd-T** splits at the playhead (selected regions only). **Opt-Cmd-T** splits at the locators or marquee. The **Scissors** tool cuts all selected regions at the help-tag position. **Option+Scissors** splits into equal-length pieces. [V]
- **Join.** **Cmd-J** joins regions or notes. **J** joins regions per track. The Join tool joins a selection, and clicking a looped region with it shortens the loop. [V]
- **Fades.** The Fade tool (A) drags over a region start or end, or over a junction to make a crossfade (works even across a gap). The Region inspector has Fade In / Fade Out plus curve and type (Out, EqP Crossfade and others). *Apply Last Fade or Fade Marquee Selection* infers fade-in, fade-out or equal-power crossfade from the marquee. Opt-click with the Fade tool deletes a fade. **Ctrl-Shift + scroll** at the top corners of a region creates a fade-in or fade-out, and scrolling horizontally across a junction creates a crossfade. Default crossfade: Ctrl-Opt-X. [V]
- **Clip gain.** The **Gain tool** (G in the Tool menu) shows a yellow line and a dB readout, and you drag vertically. On a marquee selection it splits at the marquee borders first. Opt-click resets to 0 dB. Normalize region gain: Ctrl-Opt-G. The Region inspector also has a Gain parameter. [V]
- **Marquee.** Selects part of a region. Selection-based processing works on it, and edits, splits, fades and gain respect it. Cmd-Opt-click a region marquees the whole region. Shift-click adjusts the nearest edge. [V]

### 2.5 Takes and comping (Quick Swipe Comping)
- Overlapping recordings become a **take folder** when Settings > Recording > Overlapping Track Recordings is set to *Create Take Folder*. The folder holds a comp lane on top and take lanes below. [V]
- **Quick Swipe Comping (QSC)** is a per-folder mode toggled by the button at the top-left of the folder, the Take Folder menu, or **Opt-Q**. It works for **audio take folders only**. **QSC off** turns the folder into an ordinary cut, drag and move container. [V]
- With QSC on, **drag across a take with the Pointer or Pencil** to make it the active section. The same time range is deselected automatically in every other take, so a comp **cannot overlap and cannot have gaps** unless you ask for one. [V]
  - Drag a section edge to extend it and shorten its neighbours. **Shift-drag an edge** shortens it and leaves silence.
  - Drag the middle of a selection with the two-headed arrow to slide the comp window.
  - Click an unselected area to swap that range to this take.
  - Shift-click a section removes it. Shift-click a take header removes the whole take.
  - Opt-click a take lane selects the entire take. [V]
- Comps are **named and saved**: *Duplicate Comp* and *Create New Comp* are in the Take Folder menu. Any later edit **auto-creates a new comp**. Shift-Cmd-↑/↓ step through takes and comps. Shift-T renames. Opt-Shift-Delete deletes a take or comp. [V]
- Folder ops: **Flatten** (Opt-Shift-U), **Flatten and Merge** (Opt-U), **Pack Take Folder** (Ctrl-Shift-Cmd-F), **Unpack** to existing tracks (Ctrl-Cmd-U) or new tracks (Ctrl-Shift-Cmd-U), **disclose / undisclose** (Opt-F). [V]
- With *Quick Swipe and Take Editing click zones* on, comp gestures happen in the **bottom half** of a take region and the top half behaves like a normal region. [V]

### 2.6 Track alternatives (playlists)
- Each track has alternatives A, B, C, and so on. They share **one channel strip and its plug-ins** but hold different regions. Apple calls them *"like playlists for individual tracks."* [V]
- Managed from a **Track Alternatives pop-up in the track header** (enable it in Configure Track Header): New, Duplicate, Rename, Rename by Region, Show Inactive, Delete Inactive. [V]
- **Show Inactive** lists inactive alternatives under the active one, where they can be edited like normal tracks. Each inactive one's On/Off button **auditions** it in place of the active one, and an up-arrow promotes it to active. Move or copy selected regions to the active alternative by key command. This gives a comping workflow for MIDI or across whole tracks. [V]
- Keys: New Ctrl-Opt-Cmd-N; Duplicate Ctrl-Opt-Cmd-D; Show/Hide Inactive Ctrl-Opt-A; Next/Previous Ctrl-Opt-↑/↓. [V]
- Recording settings can auto-create alternatives for overlapping recordings. [V]

### 2.7 Flex Time (brief)
- Logic's elastic audio. Per audio track there is a **Track Flex button** and a **Flex Mode** menu: Flex Pitch or one of the Flex Time algorithms. Hold Shift to apply a mode to all audio tracks. [V]
- Transients are detected automatically. **Flex markers** added on the waveform stretch audio between markers. The **Flex tool** (X) works without switching to Flex view. Flex Pitch editing happens in the Audio Track Editor. [V]
- Show Flex in the Tracks area: **F** per the key-command table; the overview page says **Cmd-F**. **[U: contradiction. Cmd-F is "Search in Browser" in the global table, so F is probably right.]**
- Integrated with Smart Tempo through per-region Flex checkbox, Smart Tempo menu and File Tempo (12.3). [V]

---

## 3. Track headers, stacks, colours, heights

Sources:
- [track-header-overview](https://support.apple.com/guide/logicpro/track-header-overview-lgcpe53c68af/mac)
- [track-stacks-overview](https://support.apple.com/guide/logicpro/track-stacks-overview-lgcp9bc4b63d/mac)
- [change-track-colors](https://support.apple.com/guide/logicpro/change-track-colors-lgcp7a5a5423/mac)
- [zoom-tracks](https://support.apple.com/guide/logicpro/zoom-tracks-lgcpc79f5bcd/mac)
- [scroll-and-zoom](https://support.apple.com/guide/logicpro/scroll-and-zoom-in-the-tracks-area-lgcpf7c0b924/mac)
- [main-window-tracks key commands](https://support.apple.com/guide/logicpro/main-window-tracks-lgcpb99be9c5/mac)
- [tracks-area pointer shortcuts](https://support.apple.com/guide/logicpro/tracks-area-lgcpea796663/mac)

- **Header contents.** Name and icon, with **Mute, Solo, Record Enable and Input Monitoring** shown by default. Optional items: On/Off, Hide, volume and pan (the pan knob can be repurposed as a send level), an additional name column, Track Numbers, **Color Bars**, Groove Track indicator, Track Icons, Track Alternatives and control-surface bars. Configure Track Header is **Opt-T** or Ctrl-click > Configure Track Header. User configurations can be stored and applied to all tracks. [V]
- **Header width.** Drag the divider between the headers and the lanes. [V]
- **Header modifiers.**
  - Opt-click Solo or Mute is exclusive (only this track).
  - Cmd-click Solo or Mute affects all tracks.
  - Ctrl-click Solo sets Solo Safe.
  - Opt-click Record Enable on an instrument track is exclusive.
  - Opt-click the header selects the track without changing the region selection.
  - Double-click the track icon shows the Smart Controls pane if a patch is loaded, or the Library/Browser if not. [V]
- **Stacks.** Two kinds. [V]

| Type | Routing | Main track | Key |
|---|---|---|---|
| **Folder stack** | Routing unchanged | The main track's strip is a **stack master that behaves like a VCA**: volume, mute and solo only. No regions on the main track. When closed it shows an overview of the subtracks. Muting the master keeps the subtracks' own mute and solo states. | Shift-Cmd-F |
| **Summing stack** | Subtracks are routed to a bus, and the main track is the aux (a real audio subgroup with plug-ins and sends) | MIDI recorded on the main track plays every instrument subtrack (layering, MOSI drum kits). Patches can capture the whole stack. | Shift-Cmd-G |

  - Both open and close with a disclosure arrow; Ctrl-Cmd-→/← also open and close. Flatten Stack is Shift-Cmd-U. A folder stack can convert to a summing stack, with VCA automation converted to aux volume automation (12.0).
  - There are also legacy **region folders** (a folder region on a folder track); the [folders overview](https://support.apple.com/guide/logicpro/folders-overview-lgcpf7c0f14e/mac) covers them. Shift-Cmd-D is "Create Track Stack", which opens a dialog to choose the type. [V]
- **Colours.** Default track colour depends on track type (audio) or default region type (instruments). **Opt-C** opens the colour palette. A track colour also colours its mixer strip. Opt-Shift-C colours regions by track colour, and Opt-Shift-Cmd-C colours tracks by region colour. Cmd-click a palette colour colours only the tracks, not selected regions. Region colours are independent of track colours. [V]
- **Heights.**
  - Drag the **bottom-left corner** of a track for individual track zoom. **Cmd-drag** zooms all tracks of the same type. Shift-drag or Shift-click the divider resets.
  - **Control-Z** zooms the focused track to fill.
  - Opt-Cmd-↑/↓ is individual zoom out/in. Opt-Cmd-Z toggles individual zoom.
  - Option + vertical scroll zooms all tracks proportionally.
  - Global vertical zoom uses Cmd-↑/↓ or the slider. Waveform amplitude zoom uses Cmd-= and Cmd-−. [V]
- **Hide.** Ctrl-H hides the selected tracks (with Hide buttons). **H** toggles hide view. Ctrl-Shift-H unhides all. [V]

---

## 4. Transport

Sources:
- [global-commands](https://support.apple.com/guide/logicpro/global-commands-lgcp02bf31b6/mac)
- [cycle](https://support.apple.com/guide/logicpro/use-the-cycle-area-lgcp59e41e86/mac)
- [punch](https://support.apple.com/guide/logicpro/punch-in-and-out-of-audio-recordings-lgcpb19bfd0d/mac)
- [metronome](https://support.apple.com/guide/logicpro/use-the-metronome-lgcp0534986f/mac)
- [display mode](https://support.apple.com/guide/logicpro/change-the-display-mode-in-logic-pro-for-mac-lgcp127f51bc/mac)
- [tempo](https://support.apple.com/guide/logicpro/set-the-project-tempo-lgcpce0ff024/mac)
- [time signature](https://support.apple.com/guide/logicpro/set-the-project-time-signature-lgcpce102b95/mac)
- [catch](https://support.apple.com/guide/logicpro/control-windows-using-catch-modes-lgcp5cbf1727/mac)
- [transport key commands](https://support.apple.com/guide/logicpro/use-transport-key-commands-lgcp2814a670/mac)
- [control-bar pointer shortcuts](https://support.apple.com/guide/logicpro/control-bar-lgcp2a46feca/mac)

- **Cycle.**
  - Toggle with **C**, the Cycle button, or a click on the cycle strip in the ruler.
  - Drag in the upper ruler to set the range; this also enables Cycle. The range is yellow when on and grey when off. The left and right **locators** are the cycle bounds.
  - **Skip cycle**: drag right-to-left, or Cmd-click the range, to skip a passage.
  - **U** sets rounded locators from the selection or marquee and enables cycle. **Cmd-U** does the same unrounded.
  - Shift-Cmd-. and Shift-Cmd-, shift the cycle by its length. Opt-Shift-Cmd-. doubles it, and Opt-Shift-Cmd-, halves it.
  - **Auto Set Locators** (Ctrl-click Cycle): the cycle follows the marquee, region, note, marker or chord selection. [V]
- **Punch.**
  - **Quick Punch-In** is on by default. It records in the background from the start of playback, which needs twice the channel strips, so Record Toggle punches in on the fly with no gap.
  - **Autopunch** has a red strip in the middle third of the ruler with its own punch-in and punch-out locators. Toggle with Ctrl-Opt-Cmd-P, the Autopunch button (not in the default control bar), or Opt-Cmd-click the ruler. Drag the cycle area into it to match.
  - **Auto Input Monitoring** is on by default: you hear the input only while punched in.
  - **Replace** mode: numeric keypad `/`. [V]
- **Metronome and count-in.**
  - **K** toggles the click. **Shift-K** toggles the count-in. Count-in length (bars or beats) is under Record > Count-in or Project Settings > Recording, and a Pre-roll setting overrides it.
  - Ctrl-click Metronome for modes: *Simple Mode*, *Click While Recording* (purple outline), *only During Count-In*, *Click While Playing*.
  - The click comes from the **Klopfgeist** instrument and follows the tempo map, including Smart Tempo. [V]
- **Tempo and signature.**
  - Tempo range **5–990 bpm**. Set it in the LCD (Beats & Project mode, drag or double-click), the Tempo List, or the Tempo track. Tap Tempo has no default key.
  - Time signature is set in the LCD, the Signature List or the Signature track.
  - **Division** (default 1/16, range 1/4–1/192) is the third field of positions and the basis of the grid. The LCD tempo always refers to quarter notes. [V]
- **LCD (Display) modes.** Click the arrow on the right of the LCD. [V]
  - **Beats & Project**: bars/beats plus tempo, key and time signature.
  - **Beats & Time**
  - **Beats**
  - **Time**
  - **Custom**: beats and time plus tempo, key, project end, locators, MIDI In/Out, CPU and HD meters. Double-clicking the performance meter opens a standalone meter.
  - Giant Beats and Giant Time displays open as floating windows.
- **Catch / autoscroll.**
  - The **Catch** button in each Tracks or editor menu bar makes the view follow the playhead (page-style). Combined with **View > Scroll in Play**, the playhead stays centred and the background scrolls.
  - Settings: "Catch when starting playback" and "Catch when moving playhead".
  - **Content Catch** (Catch + Link) makes linked editors follow the region under the playhead.
  - **`` ` ``** (grave accent) runs Catch Playhead Position. [V]
- **Locate keys.**
  - **Return** goes to the beginning. Opt-Return goes to the end of the last region.
  - `,` / `.` rewind and forward; Shift-`,` / Shift-`.` fast rewind and fast forward.
  - Ctrl-`,` / Ctrl-`.` move by transient.
  - **`/`** opens Go to Position.
  - Ctrl-Shift-`,` / Ctrl-Shift-`.` go to the left or right locator.
  - Shift-Space plays from the selection. Shift-Enter plays from the left window edge. Cmd-. discards the recording and returns. [V]

---

## 5. Mixer

Sources:
- [mixer-interface](https://support.apple.com/guide/logicpro/mixer-interface-lgcpe9cc43f6/mac)
- [channel-strip-controls](https://support.apple.com/guide/logicpro/channel-strip-controls-lgcpbc219210/mac)
- [change-the-mixer-view](https://support.apple.com/guide/logicpro/change-the-mixer-view-lgcp583779d6/mac)
- [sends](https://support.apple.com/guide/logicpro/route-audio-via-send-effects-lgcp8ea0091c/mac)
- [VCA](https://support.apple.com/guide/logicpro/use-vca-groups-lgcp4d50f425/mac)
- [groups](https://support.apple.com/guide/logicpro/groups-overview-lgcp8e7ab0b8/mac)
- [pre-fader metering](https://support.apple.com/guide/logicpro/set-pre-fader-metering-in-logic-pro-for-mac-lgcpe21609ef/mac)
- [mixer settings](https://support.apple.com/guide/logicpro/mixer-settings-lgcp50b91186/mac)
- [mixer key commands](https://support.apple.com/guide/logicpro/mixer-lgcp2dc3f212/mac)
- [mixer pointer shortcuts](https://support.apple.com/guide/logicpro/mixer-lgcpce71eefd/mac)

**Channel strip, top to bottom** (audio and instrument strip; component visibility set via Configure Channel Strip Components, Opt-X) [V]:

1. Optional audio-device controls: input gain −12…+12, input type, phantom power, low-cut, phase invert, direct monitoring.
2. **Setting** button (channel strip presets).
3. **Gain-reduction meter.** Click inserts or opens a Compressor; Cmd-click removes it.
4. **EQ thumbnail.** Click inserts or opens Channel EQ; Shift-click gives Linear Phase EQ.
5. (Instrument strip) **MIDI FX** slot.
6. **Input / Instrument** slot.
7. **Channel Mode** (mono/stereo; long-click for the full format list).
8. **Audio FX** inserts.
9. **Sends**: up to **12** per strip, each **Post Pan / Post Fader / Pre Fader**.
10. **Output** slot.
11. **Group** slot.
12. **Automation Mode**.
13. Track icon.
14. **Pan/Balance knob**: mono strips pan, stereo strips balance. It becomes a surround or 3D object panner in surround or Atmos projects.
15. **VCA** slot.
16. **Peak display**: red means clipping above 0 dB; orange means above 0 dB but not clipping, thanks to floating point.
17. Fader value field.
18. **Volume fader + level meter.**
19. Record, Input Monitoring, Bounce (on output strips), **Mute, Solo**, Dim (master, up to −30 dB).
20. **Name field** with track colour.

- **Fader scale / top value.** The maximum is **+6 dB**. That is **[V-legacy]**: the Logic Pro 9 and Logic Pro 7 manuals say *"The maximum boost is +6 dB"* ([Logic 9 manual p.767](https://www.manualsdir.com/manuals/547962/apple-logic-pro-9.html?page=767)). The 13.0 guide **does not state the ceiling**, so treat +6 dB as current but not re-verified. **Option-click resets a fader (or any parameter) to its default, 0 dB** [V] ([pointer shortcuts](https://support.apple.com/guide/logicpro/various-windows-lgcp77b30381/mac); 10.4.5 guide: "Option-click the Volume fader to return it to a neutral level (0 dB gain)"). Shift-drag gives fine resolution. Long Faders: Ctrl-Shift-L. Narrow and wide strip buttons. [V]
- **Meters.** Post-fader and pre-pan by default. **Pre-Fader Metering** (Mix menu) measures after inserts and before fader and pan. Record-enabled or input-monitored strips meter **pre-inserts**. Colour: amber and yellow are safe, red means clipping or near it. Mixer settings give peak-hold and decay rates (for example IEC Type II/EBU 8.6 dB/s, up to Very Fast 50 dB/s). [V]
- **Pan.** Mono pan and stereo balance, with a surround or 3D object panner. Cmd-click the stereo pan knob swaps left and right. Send panning can be adjusted independently. [V]
- **Sends** go to buses, which feed **aux** strips. Shift-click a send flashes its destination aux, and in the inspector it shows the aux on the right strip. *Select Channels with Same Destination* exists. Cmd-click a send or plug-in removes it. Mixer view filters include *Channels with Sends Only*. *Sends on Faders* (Ctrl-Opt-Cmd-S) cycles through sends. [V]
- **VCA.** VCA strips control the volume of members routed to **different outputs**. They are cheaper than an aux, and post-fader sends follow the VCA. Create via Options > Create New VCA (for Selected Channel Strips). Assign via the VCA slot. Show or hide the VCA slot with Ctrl-Shift-V. Folder-stack masters are VCA-type. [V]
- **Groups.** **Up to 64**. A strip can be in **several groups**. The Group Settings window chooses the linked parameters (volume, pan, mute, solo, sends, track alternatives, editing and so on). Shift-G enables or disables all groups. Ctrl-Cmd-G creates a group from the selection. Opt-click the Group slot assigns to the last group. Shift-drag or Shift-click adjusts one member **without** affecting the group. [V]
- **Views.** Single / Tracks / **All** (Shift-X cycles), strip-type filter buttons (Opt-click shows one type only), plus Shift-A/S/F/O/E select audio, instrument, aux, output and MIDI strips. [V]
- **Solo, mute and plug-in modifiers.** Opt-click Solo or Mute is exclusive. Cmd-click affects all. Ctrl-click Solo sets Solo Safe. Opt-click the plug-in slot centre bypasses. Option-drag a plug-in between strips copies it. [V]

---

## 6. Automation modes

Sources:
- [choose-automation-modes](https://support.apple.com/guide/logicpro/choose-automation-modes-lgcpb1a6ab26/mac)
- [global-commands](https://support.apple.com/guide/logicpro/global-commands-lgcp02bf31b6/mac)

| Mode | Behaviour [V] |
|---|---|
| **Off** | Automation ignored (but kept). |
| **Read** | Plays automation. Moving controls does not write. Region (MIDI) data can still record. |
| **Touch** | Reads, and writes while a control is held. After release it **returns to the existing automation**. |
| **Latch** | Like Touch, but after release the **last value keeps replacing** existing automation until stop. |
| **Write** | Erases existing automation as the playhead passes and writes the current control state, deleting it if you do nothing. |
| **Trim** | A modifier on Touch or Latch, shown as **T-Touch / T-Latch**. It offsets existing Volume, Pan and Send automation by the fader move. The fader jumps to centre and goes transparent. |
| **Relative** | A modifier on Touch, Latch or Write (R-Touch / R-Latch / R-Write). It writes a **separate secondary offset curve** for Volume, Pan or Send. Both curves can be edited, and *Consolidate* merges them. |

- Set per track from the header's Automation Mode menu (with automation shown) or on the channel strip. Choose with several tracks selected to set them all. Opt-click a strip's Automation Mode button applies it to all strips. [V]
- Keys: **A** shows or hides automation. Ctrl-Cmd-O toggles Off/Read on the selection. Ctrl-Cmd-A toggles Latch/Read. Ctrl-Shift-Cmd-O/R/T/L set all tracks to Off/Read/Touch/Latch. Ctrl-Opt-Cmd-A toggles Automation Quick Access. Ctrl-Cmd-E opens the track automation event list. [V]
- Separate **track automation** and **region automation**, with move/convert commands between them (Ctrl-Cmd-↑/↓ and variants). Region automation records even in Read mode by default. [V]

---

## 7. Default key commands (macOS, U.S. preset, Logic Pro 13.0)

Sources:
- [Global Commands](https://support.apple.com/guide/logicpro/global-commands-lgcp02bf31b6/mac)
- [Main Window Tracks](https://support.apple.com/guide/logicpro/main-window-tracks-lgcpb99be9c5/mac)
- [Main Window Tracks and Various Editors](https://support.apple.com/guide/logicpro/main-window-tracks-and-various-editors-lgcpe8314fe2/mac)
- [Various Windows](https://support.apple.com/guide/logicpro/various-windows-lgcp665bbccc/mac)
- [Tool Menu](https://support.apple.com/guide/logicpro/tool-menu-lgcp0182c4e5/mac)
- [Mixer](https://support.apple.com/guide/logicpro/mixer-lgcp2dc3f212/mac)

The tables are scoped by area: a key applies only when that area has focus. "Keypad" means the numeric-keypad key (𝍖 in Apple's tables). Everything below is **[V]** unless marked otherwise.

### Transport
| Function | Key |
|---|---|
| Play / Stop | **Space** |
| Play | Keypad Enter |
| Stop | Keypad 0 |
| Pause | Keypad . |
| Record | **R** |
| Record / Record Toggle | Keypad * |
| Flashback Capture as Recording | Shift-R |
| Discard recording and return | Cmd-. |
| Go to Beginning | **Return** |
| Go to end of last region | Opt-Return |
| Rewind / Forward | `,` / `.` |
| Fast Rewind / Fast Forward | Shift-`,` / Shift-`.` |
| Play from Selection | Shift-Space |
| Play from left window edge | Shift-Enter |
| Go to Position | `/` |
| Toggle Cycle | **C** |
| Set rounded locators by selection + cycle | **U** (Cmd-U unrounded) |
| Skip Cycle | Keypad = |
| Toggle Autopunch | Ctrl-Opt-Cmd-P |
| Toggle Replace | Keypad / |
| Metronome | **K** |
| Count-in | **Shift-K** |
| Go to marker 1–9 | Keypad 1–9 |
| Create marker | Opt-' |
| Next / previous marker (set locators) | Opt-. / Opt-, |
| Solo / Mute selected | **S** / **M** |
| Input monitoring | Ctrl-I |
| Track record enable | Ctrl-R |

### Tools
| Function | Key |
|---|---|
| Show Tool Menu | **T** |
| Pointer (with the menu open) | **T** |
| Pencil, Eraser, Scissors, Join, Fade, Marquee, Gain, Flex, Zoom (with the menu open) | P, E, I, J, A, R, G, X, Y |
| Next / previous tool | Opt-PageDown / Opt-PageUp |
| Toggle Snap to Grid | Cmd-G |
| Toggle alignment guides | Opt-Cmd-G |

### Editing
| Function | Key |
|---|---|
| Undo / Redo | **Cmd-Z** / **Shift-Cmd-Z** |
| Undo History | Ctrl-Opt-Cmd-Z |
| Cut / Copy / Paste | Cmd-X / C / V |
| Paste Replace | Shift-Cmd-V |
| Select All / Deselect All / Invert | Cmd-A / Shift-D / Shift-I |
| Select all following | Shift-F |
| Select inside locators | Shift-L |
| Select equal / similar / same colour / muted | Shift-E / Shift-S / Shift-C / Shift-M |
| **Repeat regions** | **Cmd-R** |
| **Split at playhead** | **Cmd-T** |
| Split at locators / marquee | Opt-Cmd-T |
| Join regions | Cmd-J |
| Join per track | J |
| Delete | Delete |
| Mute regions | Ctrl-M |
| Loop regions on/off | Ctrl-L (see the §2.4 contradiction) |
| Quantize | Q |
| Dequantize | Opt-Cmd-Q |
| Nudge position left / right | Opt-← / Opt-→ |
| Nudge length | Opt-Shift-← / Opt-Shift-→ |
| Transpose ±1 semitone | Opt-↑ / Opt-↓ |
| Transpose ±12 semitones | Opt-Shift-↑ / Opt-Shift-↓ |
| Move to playhead (Pickup Clock) | ; |
| Set start / end to playhead | Cmd-[ / Cmd-] |
| Remove overlaps | \ |
| Crop outside locators / marquee | Cmd-\ |
| Shuffle left / right | Opt-[ / Opt-] |
| Bounce regions in place / tracks in place | Ctrl-B / Ctrl-Cmd-B |
| Bounce project | Cmd-B |
| Normalize region gain | Ctrl-Opt-G |
| Rename region / track | Shift-N / Shift-Return |
| Quick Swipe Comping toggle | Opt-Q |
| Flatten / Flatten and Merge take folder | Opt-Shift-U / Opt-U |
| New track | Opt-Cmd-N |
| New audio / instrument track | Opt-Cmd-A / Opt-Cmd-S |
| Duplicate track | Cmd-D |
| Duplicate track with content | Opt-Shift-Cmd-D |
| Delete track | Cmd-Delete |
| Create track stack (dialog) / folder stack / summing stack | Shift-Cmd-D / Shift-Cmd-F / Shift-Cmd-G |
| Track colour palette | Opt-C |

### Zoom
| Function | Key |
|---|---|
| Zoom horizontal out / in | **Cmd-←** / **Cmd-→** |
| Zoom vertical out / in | **Cmd-↑** / **Cmd-↓** |
| Toggle zoom to fit selection / all | **Z** |
| Zoom to fit locators | Ctrl-Shift-Z |
| Zoom focused track | Ctrl-Z |
| Individual track zoom in / out | Opt-Cmd-↓ / Opt-Cmd-↑ |
| Toggle individual track zoom | Opt-Cmd-Z |
| Navigation back / forward (zoom history) | Opt-Z / Opt-Shift-Z |
| Store navigation snapshot | Shift-Z |
| Save / recall zoom 1–3 | Ctrl-Opt-Shift-Cmd-1…3 / Ctrl-Opt-Cmd-1…3 |
| Waveform vertical zoom in / out | Cmd-= / Cmd-− |

### Navigation and selection
| Function | Key |
|---|---|
| Select previous / next track | ↑ / ↓ |
| Extend track selection | Shift-↑ / Shift-↓ |
| Select previous / next region | ← / → |
| Page up / down / left / right | PageUp / PageDown / Home / End |
| Scroll to selection | Shift-` |
| Catch playhead | ` |
| Go to selection start / end | Ctrl-Home / Ctrl-End |
| Previous / next transient | Ctrl-, / Ctrl-. |

### Windows and areas
| Function | Key |
|---|---|
| **Mixer** (pane / window) | **X** / Cmd-2 |
| **Editor** | **E** |
| **Inspector** | **I** |
| Local inspector | Opt-Shift-I |
| **Browser** (unified; formerly Library + Loops) | **B** |
| **Smart Controls** | **Y** |
| **Piano Roll** (pane / window) | **P** / Cmd-4 |
| Score Editor | N |
| Audio File Editor | W |
| List Editors | D |
| Project Files | O |
| Note Pad | Ctrl-Shift-P |
| Show / hide automation | A |
| Show / hide flex | F (see the §2.7 contradiction) |
| Show all plug-in windows | V |
| Live Loops / Tracks | L |
| Play Surface | Cmd-K |
| Key Command Assignments | Opt-K |
| Toolbar | Ctrl-Opt-Cmd-T |
| Configure track header | Opt-T |
| Screensets 1–9 | 1–9 |
| Cycle focus between areas | Tab / Shift-Tab |
| Main window | Cmd-1 |
| Project Settings / Settings | Opt-P / Cmd-, |

**Brief-vs-guide corrections:**
- **Y ≠ Library**: Y is Smart Controls.
- **B ≠ Smart Controls**: B is the unified Browser.
- The old **F = Browser** and **O = Loop Browser** no longer hold: F is Flex and O is Project Files.
- Bare **I** is the Inspector, but **I inside the Tool menu** is Scissors.
- **Tools have no direct one-key shortcuts** outside the T menu. T then letter is a two-key chord, unlike Cubase's 1–0. [V]

---

## 8. Mouse and trackpad conventions

Sources:
- [various-windows pointer shortcuts](https://support.apple.com/guide/logicpro/various-windows-lgcp77b30381/mac)
- [tracks-area pointer shortcuts](https://support.apple.com/guide/logicpro/tracks-area-lgcpea796663/mac)
- [mixer pointer shortcuts](https://support.apple.com/guide/logicpro/mixer-lgcpce71eefd/mac)
- [piano-roll-editor-interface](https://support.apple.com/guide/logicpro/piano-roll-editor-interface-lgcpc788b136/mac)
- [flex overview](https://support.apple.com/guide/logicpro/flex-time-and-pitch-overview-lgcp15968647/mac)
- [scroll-and-zoom](https://support.apple.com/guide/logicpro/scroll-and-zoom-in-the-tracks-area-lgcpf7c0b924/mac)

| Gesture | Result [V] |
|---|---|
| **Option-drag** region, event or segment | **Copy** |
| Opt-Shift-drag (MIDI region or folder) | Alias |
| Shift-drag | Constrain to the first drag direction |
| Ctrl-drag / Ctrl-Shift-drag | Bypass the grid: divisions / ticks or samples |
| Shift-click | Add to or remove from the selection |
| Shift-double-click a region | Select all regions on that lane |
| **Double-click MIDI region** | Opens the **Piano Roll** in the bottom editor pane. This is configurable in Settings > General. |
| **Double-click audio region** | Opens the **Audio Track Editor** |
| Option-double-click a region | Opens the editor as a standalone window (MIDI: Piano Roll; audio: Audio File Editor) |
| Option-click a parameter / fader | **Reset to default** (0 dB for faders) |
| Option-drag or Shift-drag a numeric value | Finer / coarser increments |
| Opt-Shift-drag several selected items | Set them all to the same value |
| Option-drag the background | Zoom to the dragged area. Option-click the background returns to the previous zoom. |
| **Ctrl-Opt + scroll** | Zoom in or out |
| **Trackpad pinch** | Horizontal zoom anchored at the pointer. With mouse or trackpad zoom, the anchor is the pointer, or the playhead when the pointer is near it. |
| Trackpad two-finger swipe | Scroll, or fine control movement on a dragged control |
| Option + vertical scroll in Tracks | Proportional vertical zoom of all tracks |
| Ctrl-Shift + scroll at a region's top corner | Create a fade-in or fade-out |
| Shift-click the track lane | Move the playhead there |
| Shift-click the ruler | Playhead plus a cycle over the marker |
| Shift-double-click the header background | Play from the click |
| Opt-Cmd-click the ruler | Toggle autopunch |
| Cmd-click the cycle range | Skip cycle |
| Option on a region border while resizing | Time-stretch instead of trim |
| Option-click a disclosure arrow | Expand or collapse all of the same type |
| Right-click | Shortcut menu (default). Configurable as a third tool or as the Tool menu. |

---

## 9. Logic vs. Cubase: decisions SIANN must make, and ideas worth borrowing

Cubase facts here come from general knowledge **[U]**; cross-check them against the Cubase research file.

### 9.1 Divergences that force a decision
1. **Tool selection model.**
   - Logic: two concurrent tools, Left-click and **Cmd-click** (plus an optional right-click tool), chosen from a pop-up summoned by **T**. A smart Pointer handles trim, loop, fade, marquee and junction by click zone.
   - Cubase [U]: one active tool picked by **number keys 1–0** on the toolbar. Its Object Selection tool has Normal, Sizing Moves Contents and Sizing Applies Time Stretch variants, and Smart Tool mode adds zones.
   - Decision: number-key tools (Cubase, the primary reference) vs. a hold-modifier secondary tool (Logic). The two are not exclusive. SIANN can ship Cubase number keys **plus** a Logic-style "hold modifier = secondary tool."
2. **Bare number keys.** Logic uses 1–9 for **screensets** (window layouts), and keypad 1–9 for markers. Cubase uses 1–0 for tools and the numpad for transport and markers [U]. Pick one meaning for the top-row digits.
3. **Single-letter window toggles.**
   - Logic: X Mixer, E Editor, I Inspector, B Browser, Y Smart Controls, P Piano Roll, D Lists, O Files, A Automation.
   - Cubase [U]: F3 MixConsole, Alt+F7 Lower Zone and similar, with letters spent on edit ops (S solo, M mute, C/X/G/H zoom/crossfade/zoom).
   - Decision: the letter namespace collides directly. Cubase being primary implies Cubase letters, with Logic letters available as an alternative preset.
4. **Split and repeat.** Logic: **Cmd-T** split at playhead, **Cmd-R** repeat, **Cmd-J** join. Cubase [U]: **Alt+X** split at cursor, **Ctrl+D** duplicate, **K** repeat… Cubase's "K" is Logic's metronome. Ship per-DAW keymap presets rather than one hybrid.
5. **Return-to-zero and cycle.** Logic: Return goes to start, **C** toggles cycle, cycle range in the ruler with yellow strip on / grey off. Cubase [U]: numpad / for cycle, numpad , or Home to zero, and the cycle range is the left/right locator band. Similar models with different keys.
6. **Bottom-pane exclusivity.** Logic's Mixer, Editor and Smart Controls share **one bottom slot** [U, inferred]. Cubase's Lower Zone has tabs (MixConsole, Editor, Sampler Control, Chord Pads) [U]. Both are tabbed in effect. Decide whether the bottom zone is tabbed or stacked.
7. **Inspector shape.** Logic (13.0) has a single consolidated inspector with **two channel strips** (track plus output, or the Shift-clicked send/VCA target). Cubase's Inspector is a collapsible section stack (Routing, Inserts, EQ, Sends, Notepad…) [U]. The two-strip "follow the signal" idea is unique to Logic.
8. **Folder semantics.** Logic splits **folder stack** (VCA-like master, no routing change) from **summing stack** (real bus/aux subgroup). Cubase separates folder tracks (organisational only) from group channels and VCA faders [U]. SIANN must decide whether a "folder" can carry audio. Logic's explicit two-type choice is clearer.
9. **Comping model.**
   - Logic: a **take folder** with a comp lane plus **Quick Swipe** (swiping a range auto-deselects it in other takes, so a comp has no overlaps by construction), named saved comps, and auto new comp on edit.
   - Cubase [U]: lanes inside the track, Comp tool, "Cycle Record Mode: Create Events/Lanes."
   - Logic's version-able comps map well onto SIANN's journaled, reviewable edit model.
10. **Playlists.** Logic **track alternatives** share the channel strip and are per-track playlists. Cubase **Track Versions** are the equivalent [U]. Same concept; adopt it with the shared-strip semantic.
11. **Automation modes.** Logic: Off, Read, Touch, Latch, Write, plus **Trim** and **Relative** as *modifiers* (T-Touch, R-Latch). Relative keeps a separate offset curve. Cubase [U]: Touch, Auto-Latch, Cross-Over, Overwrite, Trim, plus Write/Read buttons. Decide between a modifier model (Logic) and flat modes (Cubase). Logic's Relative second curve is non-destructive and fits SIANN's rollback ethos.
12. **Fader ceiling.** Logic **+6 dB** [V-legacy]. Cubase also +6 dB [U]. No conflict: choose +6 dB.
13. **Snap granularity.** Logic has "Smart" snap that is zoom-dependent and falls back automatically when zoomed out, plus Relative vs Absolute snap. Cubase has Grid / Grid Relative / Events / Shuffle / Magnetic Cursor modes plus quantize-based grid [U]. Logic's **Shuffle is a drag mode**, while Cubase's Shuffle is a **snap type** [U]. SIANN must decide which axis owns "shuffle."
14. **Right-click.** Logic defaults to the shortcut menu (configurable as a tool). Cubase defaults to a context menu with a toolbox on modifier [U]. Similar.

### 9.2 Logic ideas worth borrowing
- **Quick Swipe Comping.** Swipe a range on a take to make it active and automatically deselect it elsewhere. Edge-drag adjusts neighbours, and **Shift-edge-drag** leaves deliberate silence. There is a per-folder on/off (Opt-Q) so the folder can also behave as a plain container.
- **Saved, named comps with auto-versioning on edit.** This is a natural fit for SIANN's plan, approve and journal lifecycle: each comp is a hashable artefact.
- **Track alternatives** that share one strip, with inline audition of inactive alternatives (On/Off button) and an up-arrow to promote. Comping across alternatives works for MIDI too.
- **Smart Pointer click zones**: corner trim, top-right loop, top-corner fade, lower-half marquee, junction drag on the shared edge, with an Option escape hatch. Fewer tool switches.
- **Hold-modifier secondary tool** (Cmd-click tool) as an optional layer over Cubase-style number keys.
- **Two inspector channel strips** that follow the signal. Shift-click Output, Send or VCA shows the destination strip.
- **Folder vs. summing stack** as an explicit choice when grouping.
- **Relative automation** as a separate, editable offset curve, plus Trim as a modifier.
- **Gain tool on a marquee** that auto-splits at the marquee and applies clip gain, with Option-click to reset.
- **Apply Last Fade / Fade Marquee**: one key infers fade-in, fade-out or crossfade from the marquee geometry.
- **Snap overrides** with Ctrl (division) and Ctrl-Shift (tick/sample), and automatic Smart fallback when zoomed out.
- **Zoom navigation history** (Opt-Z back, Opt-Shift-Z forward, Shift-Z snapshot) and **Z** to toggle between fitting the selection and fitting everything.
- **Content Catch**: linked editors follow the region under the playhead.
- **Auto Set Locators**: the cycle follows the marquee, region or marker selection.
- **Key-focus blue frame** with **Tab** to cycle focus between areas. Area-scoped key commands remove ambiguity.

---

### Open items / unverified
- The +6 dB fader ceiling is confirmed only in the Logic 7 and Logic 9 Apple manuals, not restated in 13.0.
- Loop-region key: L or Ctrl-L. The 13.0 guide contradicts itself.
- Show-Flex key: F or Cmd-F. The 13.0 guide contradicts itself.
- Bottom-pane exclusivity of Mixer, Editor and Smart Controls is inferred, not stated in the 13.0 pages read.
- The Tracks-area pointer-shortcut page still says "Show/hide the Library" on a track-icon double-click, which is stale after the 13.0 unified Browser.
- Trackpad gesture specifics beyond pinch and two-finger swipe (for example, swipe to scroll in the Tracks area) were not checked page by page.
