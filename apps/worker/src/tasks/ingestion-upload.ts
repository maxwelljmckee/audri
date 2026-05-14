// Upload-ingestion task. Mirrors apps/worker/src/tasks/ingestion.ts
// structurally but runs on uploaded documents instead of call
// transcripts.
//
// Per-attachment lifecycle: each `upload_attachments` row drives one
// ingestion run scoped to that attachment's `page_id` subtree. A
// single upload can have N attachments over time (different
// contextual relevance to different subtrees); each fires its own
// instance of this task.
//
// Pipeline:
//   1. Load upload_attachments row → upload + scope page
//   2. Spend-cap pre-flight (mark skipped_over_cap on the attachment)
//   3. Flash candidate retrieval (doc-aware prompt, scope-aware)
//   4. If both arrays empty → noteworthiness gate fails, mark succeeded
//   5. Fetch fully-joined candidate pages
//   6. Pro fan-out (doc-aware prompt, scope-aware)
//   7. commitUploadFanOut — writes to wiki + wiki_section_uploads
//      junctions + flips upload_attachments.status='succeeded'
//
// Queue: same `ingestion-${user_id}` queue as the transcript pipeline
// (per-user FIFO across both source kinds).

import {
  db,
  eq,
  uploadAttachments,
  uploads as uploadsTable,
  wikiPages,
} from '@audri/shared/db';
import { capture, isFeatureEnabled } from '@audri/shared/posthog';
import { checkSpendCap } from '@audri/shared/usage';
import type { Task } from 'graphile-worker';
import { fetchCandidatePages } from '../ingestion/candidate-pages.js';
import { logger } from '../logger.js';
import { commitUploadFanOut } from '../uploads/commit.js';
import {
  FLASH_UPLOAD_CANDIDATE_RETRIEVAL_MODEL,
  retrieveUploadCandidates,
} from '../uploads/flash-retrieval.js';
import { PRO_UPLOAD_FAN_OUT_MODEL, runUploadFanOut } from '../uploads/fan-out.js';
import { fetchScopedWikiIndex } from '../uploads/scoped-wiki-index.js';
import { recordInferenceUsage } from '../usage/record-inference.js';

export interface IngestionUploadPayload {
  attachmentId: string;
  userId: string;
}

export const ingestionUpload: Task = async (payload, helpers) => {
  const p = payload as IngestionUploadPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, attachmentId: p.attachmentId, ...extra }, msg);

  // Kill switch — same `ingestion_enabled` flag covers both pipelines.
  const ingestEnabled = await isFeatureEnabled('ingestion_enabled', p.userId);
  if (ingestEnabled === false) {
    log('ingestion disabled by feature flag — skip');
    capture(p.userId, 'ingestion_upload.skipped_by_flag', { attachmentId: p.attachmentId });
    return;
  }

  // Load the attachment + its upload + its scope page in one round trip.
  const [joined] = await db
    .select({
      attachment: uploadAttachments,
      upload: uploadsTable,
      pageSlug: wikiPages.slug,
    })
    .from(uploadAttachments)
    .innerJoin(uploadsTable, eq(uploadsTable.id, uploadAttachments.uploadId))
    .innerJoin(wikiPages, eq(wikiPages.id, uploadAttachments.pageId))
    .where(eq(uploadAttachments.id, p.attachmentId))
    .limit(1);
  if (!joined) {
    logger.warn({ attachmentId: p.attachmentId }, 'upload_attachments row not found — skip');
    return;
  }
  const { attachment, upload, pageSlug } = joined;

  if (upload.tombstonedAt) {
    log('upload tombstoned — skip');
    return;
  }
  if (upload.extractionStatus !== 'succeeded' || !upload.extractedText) {
    logger.warn(
      {
        attachmentId: p.attachmentId,
        uploadId: upload.id,
        extractionStatus: upload.extractionStatus,
        hasText: !!upload.extractedText,
      },
      'upload not ready for ingestion (extraction not succeeded) — skip',
    );
    return;
  }
  if (attachment.status === 'succeeded') {
    log('attachment already ingested — skip (idempotent re-fire)');
    return;
  }

  capture(p.userId, 'ingestion_upload.started', {
    attachmentId: p.attachmentId,
    uploadId: upload.id,
    pageId: attachment.pageId,
    jobId: helpers.job.id,
  });

  // Spend cap.
  const cap = await checkSpendCap(p.userId);
  if (cap.overCap) {
    log('skipping ingestion — user over monthly spend cap', {
      currentSpendCents: cap.currentSpendCents,
      limitCents: cap.limitCents,
    });
    await db
      .update(uploadAttachments)
      .set({
        status: 'skipped_over_cap',
        error:
          'Monthly spending cap exceeded — raise the limit in Account → Usage to ingest this upload.',
      })
      .where(eq(uploadAttachments.id, attachment.id));
    capture(p.userId, 'ingestion_upload.skipped_over_cap', {
      attachmentId: attachment.id,
      uploadId: upload.id,
    });
    return;
  }

  // Mark in-flight.
  await db
    .update(uploadAttachments)
    .set({ status: 'running', error: null, startedAt: new Date() })
    .where(eq(uploadAttachments.id, attachment.id));

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

    // Flash candidate retrieval.
    const flashResult = await retrieveUploadCandidates(
      upload.extractedText,
      { filename: upload.originalFilename, kind: upload.kind },
      wikiIndex,
      pageSlug,
    );
    void recordInferenceUsage({
      userId: p.userId,
      eventKind: 'ingestion_prefilter',
      model: FLASH_UPLOAD_CANDIDATE_RETRIEVAL_MODEL,
      usage: flashResult.usage,
    });
    log(
      `flash candidates: touched=${flashResult.candidates.touched_pages.length}, new=${flashResult.candidates.new_pages.length}`,
    );

    if (flashResult.candidates.dump) {
      log('flash dumped upload — no fan-out', {
        reason: flashResult.candidates.dump.reason,
      });
      await markSucceeded(attachment.id);
      capture(p.userId, 'ingestion_upload.dumped', {
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
      capture(p.userId, 'ingestion_upload.gate_negative', { attachmentId: attachment.id });
      return;
    }

    const touchedSlugs = flashResult.candidates.touched_pages.map((tp) => tp.slug);
    const candidatePages = await fetchCandidatePages(p.userId, touchedSlugs);
    log(`fetched ${candidatePages.length}/${touchedSlugs.length} candidate pages`);

    const fanOutReturn = await runUploadFanOut({
      documentText: upload.extractedText,
      documentMetadata: { filename: upload.originalFilename, kind: upload.kind },
      newPages: flashResult.candidates.new_pages,
      touchedPages: candidatePages,
      scopeRootSlug: pageSlug,
    });
    void recordInferenceUsage({
      userId: p.userId,
      eventKind: 'ingestion',
      model: PRO_UPLOAD_FAN_OUT_MODEL,
      usage: fanOutReturn.usage,
    });
    log(
      `pro fan-out: creates=${fanOutReturn.result.creates.length}, updates=${fanOutReturn.result.updates.length}, skipped=${fanOutReturn.result.skipped.length}`,
    );

    const commitResult = await commitUploadFanOut({
      userId: p.userId,
      uploadId: upload.id,
      attachmentId: attachment.id,
      fanOut: fanOutReturn.result,
      candidatePages,
    });
    log('upload commit complete', { ...commitResult });

    capture(p.userId, 'ingestion_upload.succeeded', {
      attachmentId: attachment.id,
      uploadId: upload.id,
      ...commitResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);
    logger.error(
      { err, attachmentId: attachment.id, uploadId: upload.id, isLastAttempt },
      'upload ingestion failed',
    );

    if (isLastAttempt) {
      await db
        .update(uploadAttachments)
        .set({ status: 'failed', error: message, completedAt: new Date() })
        .where(eq(uploadAttachments.id, attachment.id));
      capture(p.userId, 'ingestion_upload.failed', {
        attachmentId: attachment.id,
        uploadId: upload.id,
        attempts: helpers.job.attempts ?? 1,
        error: message.slice(0, 200),
      });
    }
    throw err;
  }
};

async function markSucceeded(attachmentId: string): Promise<void> {
  await db
    .update(uploadAttachments)
    .set({ status: 'succeeded', error: null, completedAt: new Date() })
    .where(eq(uploadAttachments.id, attachmentId));
}
