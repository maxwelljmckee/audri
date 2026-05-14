// extract_upload graphile task — runs after the client POSTs
// /uploads/:id/finalize. Downloads the file from Supabase Storage,
// dispatches to the per-kind extractor, persists the resulting text
// onto the uploads row.
//
// On success: flips extraction_status='succeeded' + sets extractedAt.
// **Does NOT auto-enqueue ingestion.** Uploads sit in Storage until the
// user explicitly attaches one to a wiki page via POST /uploads/:id/
// ingest, which triggers `ingestion_upload` subtree-scoped to that
// page. Mental model: a transcript is "this is already in my brain;
// please record it"; an upload is "I want this in my brain, but
// deferred until I tell you where." Live-agent surfaces unused docs
// to nudge the user when inertia hits.
//
// On failure: flips extraction_status='failed' + records the error
// string. Graphile retries up to max_attempts; the final attempt's
// state is what sticks.

import { db, eq, uploads } from '@audri/shared/db';
import { Buffer } from 'node:buffer';
import type { Task } from 'graphile-worker';
import { logger } from '../logger.js';
import { getSupabaseAdmin } from '../supabase-admin.js';
import { extractText } from '../uploads/extractors.js';

const BUCKET = 'audri_storage';

interface ExtractUploadPayload {
  uploadId: string;
}

export const extractUpload: Task = async (payload, helpers) => {
  const p = payload as ExtractUploadPayload;
  const log = (msg: string, extra: Record<string, unknown> = {}) =>
    logger.info({ jobId: helpers.job.id, uploadId: p.uploadId, ...extra }, msg);

  const [row] = await db
    .select()
    .from(uploads)
    .where(eq(uploads.id, p.uploadId))
    .limit(1);
  if (!row) {
    logger.warn({ uploadId: p.uploadId }, 'extract_upload: row not found — skip');
    return;
  }
  if (row.tombstonedAt) {
    log('upload tombstoned — skip extraction');
    return;
  }
  if (row.extractionStatus === 'succeeded') {
    log('already extracted — skip');
    return;
  }

  // Mark running on this attempt — graphile retries land here too,
  // each pass re-flipping to running.
  await db
    .update(uploads)
    .set({ extractionStatus: 'running' })
    .where(eq(uploads.id, row.id));

  try {
    log('extract_upload starting', { kind: row.kind, sizeBytes: row.sizeBytes });

    // Download from Supabase Storage. Service-role client bypasses RLS;
    // we just looked up the row by id so we already know it's a valid
    // path. `download()` returns a Blob (or Buffer-ish stream on
    // Node — the SDK polyfills it via fetch).
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(BUCKET).download(row.storagePath);
    if (error || !data) {
      throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
    }
    const buf = Buffer.from(await data.arrayBuffer());

    const text = await extractText(row.kind, buf);

    await db
      .update(uploads)
      .set({
        extractionStatus: 'succeeded',
        extractedText: text,
        extractionError: null,
        extractedAt: new Date(),
      })
      .where(eq(uploads.id, row.id));

    log('extract_upload complete', { textLength: text.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLastAttempt = (helpers.job.attempts ?? 1) >= (helpers.job.max_attempts ?? 1);
    logger.error({ err, uploadId: row.id, isLastAttempt }, 'extract_upload failed');

    if (isLastAttempt) {
      await db
        .update(uploads)
        .set({
          extractionStatus: 'failed',
          extractionError: message.slice(0, 2000),
        })
        .where(eq(uploads.id, row.id));
    } else {
      // Reset to pending so the next attempt's "if status=running" log
      // line reads naturally. Don't write extractionError on
      // non-final attempts — only the final wins.
      await db
        .update(uploads)
        .set({ extractionStatus: 'pending' })
        .where(eq(uploads.id, row.id));
    }
    throw err;
  }
};
