// URL-source ingestion task. Parallel to apps/worker/src/tasks/
// ingestion-upload.ts; runs against url_source_attachments rows
// instead of upload_attachments.
//
// Per-attachment lifecycle: each url_source_attachments row drives
// one ingestion run scoped to that attachment's page_id subtree. A
// single URL can have N attachments over time.
//
// Pipeline:
//   1. Load url_source_attachments → url_sources + scope page
//   2. Spend-cap pre-flight
//   3. Flash candidate retrieval (URL-aware, scoped)
//   4. Noteworthiness gate
//   5. Fetch fully-joined candidate pages
//   6. Pro fan-out (URL-aware, scoped)
//   7. commitUrlSourceFanOut → wiki_section_url_sources cites
//
// Queue: same `ingestion-${user_id}` per-user FIFO queue.

import {
  db,
  eq,
  urlSourceAttachments,
  urlSources as urlSourcesTable,
  wikiPages,
} from '@audri/shared/db';
import { capture, isFeatureEnabled } from '@audri/shared/posthog';
import { checkSpendCap } from '@audri/shared/usage';
import type { Task } from 'graphile-worker';
import { fetchCandidatePages } from '../ingestion/candidate-pages.js';
import { logger } from '../logger.js';
import { commitUrlSourceFanOut } from '../url-sources/commit.js';
import {
  FLASH_URL_SOURCE_CANDIDATE_RETRIEVAL_MODEL,
  retrieveUrlSourceCandidates,
} from '../url-sources/flash-retrieval.js';
import { PRO_URL_SOURCE_FAN_OUT_MODEL, runUrlSourceFanOut } from '../url-sources/fan-out.js';
import { fetchScopedWikiIndex } from '../uploads/scoped-wiki-index.js';
import { recordInferenceUsage } from '../usage/record-inference.js';

export interface IngestionUrlSourcePayload {
  attachmentId: string;
  userId: string;
}

export const ingestionUrlSource: Task = async (payload, helpers) => {
  const p = payload as IngestionUrlSourcePayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, attachmentId: p.attachmentId, ...extra }, msg);

  const ingestEnabled = await isFeatureEnabled('ingestion_enabled', p.userId);
  if (ingestEnabled === false) {
    log('ingestion disabled by feature flag — skip');
    capture(p.userId, 'ingestion_url_source.skipped_by_flag', {
      attachmentId: p.attachmentId,
    });
    return;
  }

  const [joined] = await db
    .select({
      attachment: urlSourceAttachments,
      urlSource: urlSourcesTable,
      pageSlug: wikiPages.slug,
    })
    .from(urlSourceAttachments)
    .innerJoin(urlSourcesTable, eq(urlSourcesTable.id, urlSourceAttachments.urlSourceId))
    .innerJoin(wikiPages, eq(wikiPages.id, urlSourceAttachments.pageId))
    .where(eq(urlSourceAttachments.id, p.attachmentId))
    .limit(1);
  if (!joined) {
    logger.warn({ attachmentId: p.attachmentId }, 'url_source_attachments row not found — skip');
    return;
  }
  const { attachment, urlSource, pageSlug } = joined;

  if (urlSource.tombstonedAt) {
    log('url source tombstoned — skip');
    return;
  }
  if (urlSource.extractionStatus !== 'succeeded' || !urlSource.extractedText) {
    logger.warn(
      {
        attachmentId: p.attachmentId,
        urlSourceId: urlSource.id,
        extractionStatus: urlSource.extractionStatus,
        hasText: !!urlSource.extractedText,
      },
      'url source not ready for ingestion — skip',
    );
    return;
  }
  if (attachment.status === 'succeeded') {
    log('attachment already ingested — skip');
    return;
  }

  capture(p.userId, 'ingestion_url_source.started', {
    attachmentId: p.attachmentId,
    urlSourceId: urlSource.id,
    pageId: attachment.pageId,
    jobId: helpers.job.id,
  });

  const cap = await checkSpendCap(p.userId);
  if (cap.overCap) {
    log('skipping ingestion — user over monthly spend cap', {
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    await db
      .update(urlSourceAttachments)
      .set({
        status: 'skipped_over_cap',
        error:
          'Monthly spending cap exceeded — raise the limit in Account → Usage to ingest this URL.',
      })
      .where(eq(urlSourceAttachments.id, attachment.id));
    capture(p.userId, 'ingestion_url_source.skipped_over_cap', {
      attachmentId: attachment.id,
      urlSourceId: urlSource.id,
    });
    return;
  }

  await db
    .update(urlSourceAttachments)
    .set({ status: 'running', error: null, startedAt: new Date() })
    .where(eq(urlSourceAttachments.id, attachment.id));

  try {
    const wikiIndex = await fetchScopedWikiIndex(p.userId, attachment.pageId);
    log(`wiki index size = ${wikiIndex.length}`, {
      scopeRootSlug: pageSlug,
      scopeRootPageId: attachment.pageId,
    });

    if (wikiIndex.length === 0) {
      throw new Error(
        `scoped wiki index empty — scope page ${attachment.pageId} not found or has no descendants`,
      );
    }

    const articleMetadata = {
      url: urlSource.fetchedUrl ?? urlSource.url,
      kind: urlSource.kind,
      title: urlSource.title,
      siteName: urlSource.siteName,
      byline: urlSource.byline,
    };

    const flashResult = await retrieveUrlSourceCandidates(
      urlSource.extractedText,
      articleMetadata,
      wikiIndex,
      pageSlug,
    );
    void recordInferenceUsage({
      userId: p.userId,
      eventKind: 'ingestion_prefilter',
      model: FLASH_URL_SOURCE_CANDIDATE_RETRIEVAL_MODEL,
      usage: flashResult.usage,
    });
    log(
      `flash candidates: touched=${flashResult.candidates.touched_pages.length}, new=${flashResult.candidates.new_pages.length}`,
    );

    if (flashResult.candidates.dump) {
      log('flash dumped url source — no fan-out', {
        reason: flashResult.candidates.dump.reason,
      });
      await markSucceeded(attachment.id);
      capture(p.userId, 'ingestion_url_source.dumped', {
        attachmentId: attachment.id,
        reason: flashResult.candidates.dump.reason,
      });
      return;
    }

    if (
      flashResult.candidates.touched_pages.length === 0 &&
      flashResult.candidates.new_pages.length === 0
    ) {
      log('noteworthiness gate failed — no fan-out');
      await markSucceeded(attachment.id);
      capture(p.userId, 'ingestion_url_source.gate_negative', {
        attachmentId: attachment.id,
      });
      return;
    }

    const touchedSlugs = flashResult.candidates.touched_pages.map((tp) => tp.slug);
    const candidatePages = await fetchCandidatePages(p.userId, touchedSlugs);
    log(`fetched ${candidatePages.length}/${touchedSlugs.length} candidate pages`);

    const fanOutReturn = await runUrlSourceFanOut({
      articleText: urlSource.extractedText,
      articleMetadata,
      newPages: flashResult.candidates.new_pages,
      touchedPages: candidatePages,
      scopeRootSlug: pageSlug,
    });
    void recordInferenceUsage({
      userId: p.userId,
      eventKind: 'ingestion',
      model: PRO_URL_SOURCE_FAN_OUT_MODEL,
      usage: fanOutReturn.usage,
    });
    log(
      `pro fan-out: creates=${fanOutReturn.result.creates.length}, updates=${fanOutReturn.result.updates.length}, skipped=${fanOutReturn.result.skipped.length}`,
    );

    const commitResult = await commitUrlSourceFanOut({
      userId: p.userId,
      urlSourceId: urlSource.id,
      attachmentId: attachment.id,
      fanOut: fanOutReturn.result,
      candidatePages,
    });
    log('url-source commit complete', { ...commitResult });

    capture(p.userId, 'ingestion_url_source.succeeded', {
      attachmentId: attachment.id,
      urlSourceId: urlSource.id,
      ...commitResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);
    logger.error(
      { err, attachmentId: attachment.id, urlSourceId: urlSource.id, isLastAttempt },
      'url-source ingestion failed',
    );

    if (isLastAttempt) {
      await db
        .update(urlSourceAttachments)
        .set({ status: 'failed', error: message, completedAt: new Date() })
        .where(eq(urlSourceAttachments.id, attachment.id));
      capture(p.userId, 'ingestion_url_source.failed', {
        attachmentId: attachment.id,
        urlSourceId: urlSource.id,
        attempts: helpers.job.attempts ?? 1,
        error: message.slice(0, 200),
      });
    }
    throw err;
  }
};

async function markSucceeded(attachmentId: string): Promise<void> {
  await db
    .update(urlSourceAttachments)
    .set({ status: 'succeeded', error: null, completedAt: new Date() })
    .where(eq(urlSourceAttachments.id, attachmentId));
}
