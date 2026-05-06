// PII redaction for the claim-level audit dump persisted on
// call_transcripts.pro_fan_out_response. Walks any JSON value recursively and
// applies regex-based redaction to string fields.
//
// What's redacted: high-risk PII patterns (emails, phone numbers, SSN, common
// credit-card patterns). What's NOT redacted: names of people, places, project
// titles, general claim content. Redacting names would gut the debugging value
// (the 2026-05-02 incident was about "Pro skipped my Audri's backlog request"
// — solving it requires seeing the actual claim text). Fuller redaction (NER-
// based name removal, address scrubbing) is deferred to V1+ if/when this
// audit data leaves the developer's eyeline.

const PATTERNS: Array<readonly [RegExp, string]> = [
  // Email — RFC-loose; catches the common shape without being pedantic.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[EMAIL]'],
  // SSN — must come before generic phone since the digit count overlaps.
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  // US phone — common forms with optional country code, area code grouping,
  // hyphen / dot / space separators. Conservative on international.
  [/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]'],
  // Credit card — 13–19 digits with optional separators. Form anchors on a
  // leading and trailing digit so the regex doesn't consume a trailing
  // separator (e.g. "Order 1234567890123456 was…" should leave the space
  // after the digits intact).
  [/\b\d(?:[ -]?\d){12,18}\b/g, '[CARD]'],
];

export function redactString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Walk any JSON-shaped value and redact string leaves. Preserves object key
// names (those are usually our schema, not user content). Returns a new value;
// does not mutate the input.
export function redactJsonPii(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactJsonPii);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJsonPii(v);
    }
    return out;
  }
  return value;
}
