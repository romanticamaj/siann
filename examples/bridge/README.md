# SIANN Bridge Examples

These fixtures are small command files for exploring the developer bridge CLI.

Run from the repository root:

```sh
npm test
node bin/siann.js run examples/bridge/create-session.command.json --device fake --json
node bin/siann.js validate-journal /tmp/siann-demo/create-session/journal.json --json
```

The CLI starts the native `siann-engine` for the run: `SIANN_ENGINE_EXE`, else
the core preset's build `native/build/dev/apps/engine/siann-engine`
(`cmake --preset dev && cmake --build --preset dev --target siann-engine` in
`native/`). The session's bundle is `sessionDir`; the journal is a
`siann.command_journal.v1` (`docs/schemas/command-journal-v1.md`).
