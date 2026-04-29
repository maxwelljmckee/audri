import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
  // Redact fields that commonly carry user content. Pino's wildcard paths
  // match any nesting level. The list is conservative — false positives are
  // cheap (a redacted "summary" field in a non-PII context still serializes
  // its sibling fields), false negatives (PII slipping through) are not.
  // Redact fields that commonly carry user content. Pino's `*.foo` matches
  // any depth-1 path (e.g. `req.foo`, `user.foo`), so we list both the bare
  // path AND the wildcard form to cover top-level + nested occurrences.
  redact: {
    paths: [
      'password', '*.password',
      'token', '*.token',
      'api_key', '*.api_key',
      // User-content fields.
      'transcript', '*.transcript',
      'content', '*.content',
      'query', '*.query',
      'summary', '*.summary',
      'payload', '*.payload',
      'snippets', '*.snippets',
      'snippet', '*.snippet',
      'text', '*.text',
      'findings', '*.findings',
      'notes_for_user', '*.notes_for_user',
      'context_summary', '*.context_summary',
    ],
    remove: true,
  },
});
