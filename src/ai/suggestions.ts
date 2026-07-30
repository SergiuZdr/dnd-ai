// Out-of-band suggested actions: the three tappable "what could I do here"
// chips the web client shows under the prose.
//
// Why a trailing sentinel rather than a tool call: suggestions are pure UI
// garnish with no mechanical effect, and every backend (Agent SDK, OpenAI-
// compatible, dual referee+narrator) already streams text through one place.
// A sentinel costs no extra round trip and works identically on all three,
// whereas a tool would need the narrator half of the dual backend to have
// tools at all -- which it deliberately does not.
//
// The contract is deliberately NOT a prose menu. dmSystemPrompt/
// narratorSystemPrompt still forbid lettered or numbered choice lists inside
// the narration ("A)... B)... C)..."), because being handed a menu is exactly
// what makes a text RPG feel like a form. The prose still ends on an open
// "What do you do?"; this line comes after it, is machine-read, and is
// stripped before the text reaches the player's screen, the story log, or the
// transcript.

/**
 * The marker that opens the trailer. Matched case-sensitively and without the
 * closing `]]` so the STREAM can start hiding text the moment the marker
 * begins to arrive -- see visibleStreamText.
 */
export const SUGGEST_MARKER = '[[SUGGEST';

/**
 * Hard caps. A chip is a glance, not a sentence, and three is what fits one
 * phone row. 40 chars is what two lines of a chip can actually show at its
 * 24ch max-width -- clamping here rather than letting CSS hide the overflow
 * means the player never sees a label whose end was silently cut off.
 */
const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_CHARS = 40;

/** Matches a whole trailer: `[[SUGGEST: a | b | c]]`, tolerating case, missing colon, and stray whitespace. */
const TRAILER_RE = /\[\[\s*SUGGEST\s*:?\s*([\s\S]*?)\]\]/i;

export interface SplitSuggestions {
  /** The narration with the trailer removed and trailing whitespace trimmed. */
  text: string;
  /** 0-3 short action labels. Empty when the DM emitted no trailer (always valid -- chips are optional). */
  suggestions: string[];
}

/**
 * Splits a completed DM turn into the prose the player reads and the
 * suggested actions. A turn with no trailer comes back with its text
 * untouched and no suggestions, which is the normal fallback whenever the
 * model forgets or a smaller model mangles the format.
 */
export function splitSuggestions(text: string): SplitSuggestions {
  const match = TRAILER_RE.exec(text);
  if (!match) return { text, suggestions: [] };

  const suggestions = match[1]
    .split('|')
    .map((part) => cleanSuggestion(part))
    .filter((part) => part.length > 0)
    .slice(0, MAX_SUGGESTIONS);

  // Remove the trailer wherever it landed (normally the last line, but a model
  // that puts it first shouldn't leave the marker sitting in the prose), then
  // tidy the seam it left behind.
  const stripped = text.replace(TRAILER_RE, '');
  return { text: stripped.replace(/\s+$/, '').replace(/^\s+/, ''), suggestions };
}

/**
 * One chip's label: collapse whitespace, drop the decorations models like to
 * add (surrounding quotes, a leading bullet/dash, a trailing period) and clamp
 * the length. Never returns something long enough to break the chip row.
 */
function cleanSuggestion(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const undecorated = collapsed
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/^["'"']|["'"']$/g, '')
    .replace(/\.$/, '')
    .trim();
  return undecorated.length > MAX_SUGGESTION_CHARS
    ? `${undecorated.slice(0, MAX_SUGGESTION_CHARS - 1).trimEnd()}…`
    : undecorated;
}

/**
 * The part of an in-flight stream buffer that is safe to show. Cuts at the
 * marker once it appears, and -- crucially -- also holds back any trailing
 * text that is merely a PREFIX of the marker, so a player never watches
 * "[[SUGG" type itself out on screen and then vanish. Whatever is held back
 * is never lost: handleTurnComplete re-splits the full final text.
 */
export function visibleStreamText(buffer: string): string {
  const at = buffer.indexOf(SUGGEST_MARKER);
  if (at !== -1) return buffer.slice(0, at);

  // Longest suffix of `buffer` that is a prefix of the marker, checked longest
  // first so `[[S` is held as three chars rather than one.
  const maxOverlap = Math.min(SUGGEST_MARKER.length - 1, buffer.length);
  for (let len = maxOverlap; len > 0; len--) {
    if (buffer.endsWith(SUGGEST_MARKER.slice(0, len))) {
      return buffer.slice(0, buffer.length - len);
    }
  }
  return buffer;
}
