// fetch_url graphile task — runs after POST /urls inserts a row.
// Fetches the URL, runs Readability extraction, writes results onto
// the url_sources row.
//
// On success: flips extraction_status='succeeded', sets extractedAt +
// fetchedAt, populates title/site_name/byline/fetched_url, writes
// extracted_text. Stops there — no auto-ingestion. User explicitly
// attaches via POST /urls/:id/ingest to fold the article into a wiki
// subtree.
//
// On failure: flips extraction_status='failed' + records the error
// string. Graphile retries up to max_attempts; the final attempt's
// state is what sticks.

import { db, eq, urlSources } from '@audri/shared/db';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';
import { fetchAndExtractUrl } from '../url-sources/extractor.js';

interface FetchUrlPayload {
  urlSourceId: string;
  userId: string;
}

export const fetchUrl: Task = async (payload, helpers) => {
  const p = payload as FetchUrlPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, urlSourceId: p.urlSourceId, ...extra }, msg);

  const [row] = await db
    .select()
    .from(urlSources)
    .where(eq(urlSources.id, p.urlSourceId))
    .limit(1);
  if (!row) {
    logger.warn({ urlSourceId: p.urlSourceId }, 'fetch_url: row not found — skip');
    return;
  }
  if (row.tombstonedAt) {
    log('url source tombstoned — skip fetch');
    return;
  }
  if (row.extractionStatus === 'succeeded') {
    log('already fetched — skip');
    return;
  }

  await db
    .update(urlSources)
    .set({ extractionStatus: 'running' })
    .where(eq(urlSources.id, row.id));

  try {
    log('fetch_url starting', { url: row.url });
    const result = await fetchAndExtractUrl(row.url);

    await db
      .update(urlSources)
      .set({
        extractionStatus: 'succeeded',
        extractedText: result.text,
        extractionError: null,
        fetchedUrl: result.fetchedUrl,
        kind: result.kind,
        // Title hint (if provided on POST /urls) is overwritten with
        // the canonical og:title / <title> from the page. Empty string
        // → null so the column is genuinely unset rather than a blank
        // string the UI would render.
        title: result.title || row.title,
        siteName: result.siteName,
        byline: result.byline,
        fetchedAt: new Date(),
        extractedAt: new Date(),
      })
      .where(eq(urlSources.id, row.id));

    log('fetch_url complete', {
      kind: result.kind,
      textLength: result.text.length,
      title: result.title,
      siteName: result.siteName,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);
    logger.error({ err, urlSourceId: row.id, isLastAttempt }, 'fetch_url failed');

    if (isLastAttempt) {
      await db
        .update(urlSources)
        .set({
          extractionStatus: 'failed',
          extractionError: message.slice(0, 2000),
        })
        .where(eq(urlSources.id, row.id));
    } else {
      await db
        .update(urlSources)
        .set({ extractionStatus: 'pending' })
        .where(eq(urlSources.id, row.id));
    }
    throw err;
  }
};
