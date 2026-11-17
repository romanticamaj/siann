# Bundled UI fonts

UI redesign spec 1.3: the UI font and the numeric display font ship as local
`.woff2` files (the CSP allows `font-src 'self'` only). Both are under the SIL
Open Font License 1.1; bundling them with SIANN is allowed (ADR-0019 point 5),
the fonts themselves stay under the OFL, and each licence text sits beside its
font.

| File | Font | Release | Licence |
|---|---|---|---|
| `InterVariable.woff2` | Inter, variable (weights 100-900) | [Inter 4.1](https://github.com/rsms/inter/releases/tag/v4.1), `Inter-4.1.zip` (sha256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`), `web/InterVariable.woff2` | `Inter-OFL.txt` (the release's `LICENSE.txt`) |
| `JetBrainsMono-Regular.woff2` | JetBrains Mono Regular | [JetBrains Mono 2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), `JetBrainsMono-2.304.zip` (sha256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`), `fonts/webfonts/JetBrainsMono-Regular.woff2` | `JetBrainsMono-OFL.txt` (the release's `OFL.txt`) |
| `JetBrainsMono-Medium.woff2` | JetBrains Mono Medium (500) | [JetBrains Mono 2.304](https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304), `JetBrainsMono-2.304.zip` (sha256 as above), `fonts/webfonts/JetBrainsMono-Medium.woff2` (file sha256 `086c48dfbea9ddaff1320f7e09399b8e2924e88ce67453721255db3bdbb5a353`) | `JetBrainsMono-OFL.txt` (the release's `OFL.txt`) |

JetBrains Mono Medium is bundled by decision of the maintainer (2026-11-15,
`m5-ui-alignment-chrome`): the shared rules draw the display values and the
key hints at weight 500. No other weight of the family is bundled, and no rule
asks for one (`test/ui-tokens.test.js`, `app/test/e2e/fonts.spec.ts`).

Chinese text uses the system's fonts (spec 6.4); no CJK font is bundled.
