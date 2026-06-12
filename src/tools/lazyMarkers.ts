/**
 * Anti-laziness gate. Scans the ADDED lines of an apply_patch envelope for the
 * tell-tale markers of a corner-cutting / MVP / placeholder implementation. The
 * patch tool rejects any patch that trips this, forcing the model to ship the
 * complete logic instead of a stub — the goal is quality-per-token, not speed.
 *
 * Patterns are kept high-precision (the phrase signals laziness, not legitimate
 * code), and only ADDED lines are inspected, so an existing TODO in untouched
 * context never trips it.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\bin a real (implementation|app|application|scenario|production|system|world|project|setup|service|codebase)\b/i, "in a real implementation"],
  [/\bin production,? you('?d| would| can| should)?\b/i, "in production you would…"],
  [/\bfor brevity\b/i, "for brevity"],
  [/\b(the )?(rest|remainder) of (the|your|this) (code|logic|implementation|file|function|method|component|fields|cases|handlers)\b/i, "rest of the … (omitted)"],
  [/\.\.\.\s*\(?(rest|remaining|other|more|etc)\b[^\n]{0,30}(unchanged|omitted|here|same|elided|follows?)/i, "… rest unchanged/omitted"],
  [/\b(not|isn't|aren't|isnt|arent) (yet )?implemented\b/i, "not implemented"],
  [/\bTODO:?\s*(implement|add|handle|fill|complete|finish|wire|hook|build|write)\b/i, "TODO: implement"],
  [/\bFIXME\b/i, "FIXME"],
  [/\bplaceholder (implementation|logic|function|value|data|content|text|here|for)\b/i, "placeholder implementation"],
  [/\bstub(bed)?\s+(out|implementation|function|method|here|for now)\b/i, "stub implementation"],
  [/\bsimplified (for now|version|implementation|logic)\b/i, "simplified for now"],
  [/\byou (would|could|can|should|might) (typically|normally|actually|usually|likely|here|then)\b/i, "you would typically…"],
  [/\bimplement(ed)? (this|it|the rest|them)? ?(later|here|properly|fully) (if|when|as needed)?\b/i, "implement later"],
  [/\bhardcoded?\b[^\n]{0,20}\bfor (now|the demo|simplicity|testing|this example)\b/i, "hardcoded for now"],
  [/\bmock(ed)? (data|value|values|implementation|response|result) for (now|the demo|testing)\b/i, "mock data for now"],
  [/\breplace (this|these|it)? ?with (real|actual|your|the actual|proper)\b/i, "replace with real…"],
  [/\b(actual|real) (implementation|logic|code) (goes|would go|here)\b/i, "actual implementation goes here"],
  [/\b(left|leaving) (this|it|that) as an exercise\b/i, "left as an exercise"],
];

export type LazyMarker = { marker: string; line: string };

/** Returns the laziness markers found in the patch's added lines (empty = clean). */
export function findLazyMarkers(patch: string): LazyMarker[] {
  const hits: LazyMarker[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const text = raw.slice(1);
    for (const [re, label] of PATTERNS) {
      if (re.test(text)) {
        hits.push({ marker: label, line: text.trim().slice(0, 120) });
        break;
      }
    }
  }
  return hits;
}
