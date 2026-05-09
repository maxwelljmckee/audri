// Shared lenient JSON extraction for Gemini structured-output calls. Returns
// null on any failure (empty text, missing braces, parse error) and logs a
// diagnostic record so we can tell truncation from malformed output. Each
// caller substitutes its own empty-result shape on null.

import { logger } from '../logger.js';

interface GeminiResponseLike {
  text?: string | undefined;
  usageMetadata?:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined;
  candidates?: Array<{ finishReason?: string }> | undefined;
}

// Field name `body` is intentional — `text` is on logger.ts's redact list, so
// logging under that key would silently drop the diagnostic window.
export function parseGeminiJson<T>(resp: GeminiResponseLike, context: string): T | null {
  const text = resp.text;
  const finishReason = resp.candidates?.[0]?.finishReason;
  const usage = resp.usageMetadata;

  if (!text) {
    logger.warn({ context, finishReason, usage }, 'gemini json parse: empty response text');
    return null;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    logger.warn(
      {
        context,
        finishReason,
        usage,
        length: text.length,
        body: text.slice(0, 200),
      },
      'gemini json parse: response missing JSON braces',
    );
    return null;
  }

  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const positionMatch = /position (\d+)/.exec(message);
    const position = positionMatch?.[1] ? Number(positionMatch[1]) : null;
    const window =
      position !== null
        ? slice.slice(Math.max(0, position - 80), Math.min(slice.length, position + 80))
        : slice.slice(0, 200);
    logger.warn(
      {
        context,
        finishReason,
        usage,
        length: slice.length,
        position,
        parseError: message,
        body: window,
      },
      'gemini json parse: JSON.parse failed',
    );
    return null;
  }
}
