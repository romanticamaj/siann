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

// A name inside a sentence (follow-up to #123): the sentence is isolated as a
// whole, but a track, clip, plugin, media or session name interpolated into
// it is the agent's or the user's text, so each is its own isolate, U+2068
// FIRST STRONG ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE, and an RLO or an
// unclosed embedding in it ends at the PDI instead of reordering the words
// around it ("Set <name> volume to -6.0 dB" keeps that order). The describe
// layer (describe.ts, card.ts, diff.ts) wraps every name it interpolates; a
// catalog word standing for an unknown entity ("a track") is not a name and
// is not wrapped. The isolate controls inside the name (LRI, RLI, FSI, PDI)
// are dropped, since one of them could close the isolate early or leave one
// open past it; the engine refuses them in stored names anyway
// (docs/schemas/protocol-engine-v0.md, "Names").
export const FSI = '\u2068';
export const PDI = '\u2069';

export function isolateName(name: string): string {
  return FSI + name.replace(/[\u2066-\u2069]/g, '') + PDI;
}
