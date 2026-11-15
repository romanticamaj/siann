---
name: siann-intake
description: Use when a user gives audio files, folders, zip packs, placement notes, cue sheets, or natural-language arrangement instructions and wants a Cubase-importable DAWproject or SIANN session. The skill converts arbitrary input into a SIANN manifest, then triggers deterministic SIANN bridge/export commands.
---

# SIANN Intake

This skill is the AI-facing front half of SIANN. It handles nondeterministic
input interpretation. The SIANN CLI, command bridge, exporters, and engine
handle deterministic execution.

Use this skill when the user asks to:

- Turn audio files plus placement notes into a DAW session.
- Convert a zip/folder of audio into a Cubase-importable `.dawproject`.
- Arrange clips from filenames, cue sheets, transcripts, markdown, CSV, or
  natural-language instructions.
- Produce a SIANN manifest for later preview, render, export, or rollback.

## Boundary

The AI may inspect files and infer intent, but must cross into SIANN execution
as structured JSON.

```text
raw audio + notes + user intent
-> AI intake reasoning
-> siann.import_pack.v0 manifest
-> deterministic SIANN CLI / bridge / engine / exporter
```

Do not ask the audio engine to interpret vague user intent. Do not directly
mutate engine/session files. Write a manifest first, validate it, then call the
SIANN CLI.

## Required Workflow

1. Identify the source input.

   Accept folders, zip files, individual audio files, and context documents. If
   the user gives a zip, extract it into an isolated temp directory, such as
   `/tmp/siann-intake-<short-name>/source` on macOS/Linux or
   `%TEMP%\siann-intake-<short-name>\source` on Windows.

2. Inventory the input.

   List audio files and relevant text files. Prefer commands like:

   ```sh
   find <source> -maxdepth 4 -type f | sort
   ```

3. Infer the arrangement.

   Use all available evidence: filenames, folder names, cue numbers, timecodes,
   placement notes, markdown tables, user instructions, and audio metadata.
   Fixed layouts such as `_DAW/` and `_SpliceSFX/` are examples, not
   requirements.

4. Write `manifest.json`.

   The manifest must use `siann.import_pack.v0`:

   ```json
   {
     "schemaVersion": "siann.import_pack.v0",
     "session": {
       "dir": "<workdir>/Session",
       "name": "SIANNIntakeSession",
       "sampleRate": 48000
     },
     "tracks": [
       { "name": "BGM01", "inputChannels": 2, "outputChannels": 2 }
     ],
     "assets": [
       {
         "id": "bgm01",
         "path": "/absolute/path/to/audio.wav",
         "trackName": "BGM01",
         "regionName": "BGM01",
         "start": "5",
         "sourceStart": "0",
         "duration": "52"
       }
     ],
     "preview": {
       "outputPath": "<workdir>/preview.wav",
       "sampleRate": 48000,
       "bitDepth": "16"
     }
   }
   ```

   Use absolute media paths. `start`, `sourceStart`, and `duration` are seconds
   as strings. Omit `sourceStart` or `duration` only when unknown or not needed.

5. Write an intake report.

   Create `intake-report.json` next to the manifest with:

   - `assumptions`
   - `needsReview`
   - `evidence`
   - `manifestPath`
   - `confidence`

   If important placements are ambiguous, add `needsReview` instead of guessing
   silently.

6. Validate deterministic output.

   At minimum, run:

   ```sh
   node bin/siann.js export dawproject <manifest.json> --out <session.dawproject> --copy-media --json
   unzip -t <session.dawproject>
   ```

   If `xmllint` is available, validate `project.xml` and
   `metadata.xml` against the DAWproject XSDs:

   ```sh
   tmp=$(mktemp -d)
   unzip -q <session.dawproject> -d "$tmp/pkg"
   curl -fsSL https://raw.githubusercontent.com/bitwig/dawproject/main/Project.xsd -o "$tmp/Project.xsd"
   curl -fsSL https://raw.githubusercontent.com/bitwig/dawproject/main/MetaData.xsd -o "$tmp/MetaData.xsd"
   xmllint --noout --schema "$tmp/Project.xsd" "$tmp/pkg/project.xml"
   xmllint --noout --schema "$tmp/MetaData.xsd" "$tmp/pkg/metadata.xml"
   ```

7. Optionally render a SIANN preview with the native engine.

   If the user wants audio or visual verification, run:

   ```sh
   node bin/siann.js live import-pack <manifest.json> --device fake --json
   ```

8. Report paths and review points.

   Return the `.dawproject` path, manifest path, report path, and any
   `needsReview` items. Keep engine/export logs concise.

## Deterministic Helpers

Use these only after AI intake has decided the mapping:

- `node bin/siann.js export dawproject <manifest.json> --out <file.dawproject> --copy-media --json`
- `node bin/siann.js live import-pack <manifest.json> --device fake --json`
- `node bin/siann.js plan intake <source-dir> --out <intake-plan.json> --json`

`plan intake` is a deterministic helper for known fixtures and regression
coverage. It is not the primary AI-native planner.

## Success Criteria

- A valid `siann.import_pack.v0` manifest exists.
- A `.dawproject` file exists and passes `unzip -t`.
- The package includes copied audio media unless the user explicitly asks for
  external references.
- The final response tells the user where the `.dawproject` is.
- Ambiguity is captured in `needsReview`, not hidden.
