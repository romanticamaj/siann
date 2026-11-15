// Bidi isolation for text an agent can influence (plan titles and intents,
// agent names, rejection notes, step text built from track names): spread on
// the element that shows it. dir="auto" takes the text's own direction from
// its first strong character, and unicode-bidi: isolate keeps any bidi
// formatting inside (an RLO U+202E, an unclosed isolate) from reordering the
// text around the element. The engine refuses those characters in plan titles
// and intents and strips them from agent names (docs/schemas/plan-v1.md,
// "Metadata"); this is the renderer's second line. Inline, so it holds
// whatever the stylesheet says.

export const ISOLATE = { dir: 'auto', style: { unicodeBidi: 'isolate' } } as const;
