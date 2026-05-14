// Storage tile REST surface — uploaded files (PDF / markdown / plain
// text / DOCX, with image + audio reserved as future kinds).
//
// Endpoints:
//   POST   /uploads                  initiate upload (returns signed PUT URL)
//   POST   /uploads/:id/finalize     confirm file landed; enqueues extraction
//   GET    /uploads                  list user's uploads
//   GET    /uploads/:id              detail incl. extracted_text + download URL
//   DELETE /uploads/:id              tombstone + remove Storage object
//
// Upload flow:
//   1. Client POSTs metadata → server inserts row (extraction_status =
//      'awaiting_upload') and asks Supabase Storage for a signed
//      upload URL/token. Returns both to the client.
//   2. Client PUTs the file directly to Supabase Storage (no proxy
//      through the API server — avoids doubling bandwidth + memory
//      on large files).
//   3. Client POSTs /finalize → server verifies the object exists,
//      flips status to 'pending', enqueues `extract_upload`. Worker
//      picks it up, extracts text per upload kind, writes
//      extracted_text + status='succeeded', then enqueues ingestion
//      fan-out treating the upload as a new source.
//
// Why a separate /finalize step (vs. extraction triggered by Storage
// webhook): keeps the lifecycle visible inside our own DB without
// depending on Supabase's webhook reliability. The mobile client knows
// when its upload completed; one round-trip cost.
//
// Naming: route + table = `uploads` (what the data IS); plugin tile +
// module = `Storage` (UI-facing name); bucket = `audri_storage`.
// URL ingestion lives separately under `url_sources` / `/urls`.

import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  uploadAttachments,
  uploads,
  wikiPages,
} from '@audri/shared/db';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { getSupabaseAdmin } from '../auth/supabase.client.js';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

// ── Config ──────────────────────────────────────────────────────────────

const BUCKET = 'audri_storage';
// Cap upload size to avoid runaway storage + extraction cost. 50MB
// fits the long-tail of personal-doc uploads (large PDFs are ~20MB);
// raise later if needed.
const MAX_SIZE_BYTES = 50 * 1024 * 1024;
// Signed download URL TTL for the detail view. Short-lived; client
// re-fetches the URL when it opens the detail page.
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60; // 1h

type UploadKind = 'pdf' | 'markdown' | 'plain' | 'docx';

interface KindMapEntry {
  kind: UploadKind;
  mimePattern: RegExp;
}

// MIME → upload_kind. Listed in priority order; first match wins.
// Some clients send 'application/octet-stream' for known kinds — fall
// back to filename extension matching for those cases.
const KIND_MAP: KindMapEntry[] = [
  { kind: 'pdf', mimePattern: /^application\/pdf$/ },
  { kind: 'markdown', mimePattern: /^text\/(markdown|x-markdown)$/ },
  { kind: 'plain', mimePattern: /^text\/plain$/ },
  {
    kind: 'docx',
    mimePattern: /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
  },
];

const EXT_MAP: Record<string, UploadKind> = {
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'plain',
  text: 'plain',
  docx: 'docx',
};

// ── DTOs ────────────────────────────────────────────────────────────────

interface InitiateUploadBody {
  original_filename: string;
  mime_type: string;
  size_bytes: number;
}

interface UploadAttachmentDTO {
  id: string;
  page_id: string;
  page_slug: string | null;
  status: string;
  error: string | null;
  attached_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface UploadRowDTO {
  id: string;
  kind: UploadKind;
  original_filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  folder_path: string | null;
  extraction_status: 'awaiting_upload' | 'pending' | 'running' | 'succeeded' | 'failed';
  extraction_error: string | null;
  extracted_at: string | null;
  uploaded_at: string | null;
  created_at: string;
  // Per-attachment lifecycle. Empty = unused (live agent can surface
  // these). Populated rows show "this doc has been folded into N
  // subtrees, here's the status of each."
  attachments: UploadAttachmentDTO[];
}

interface UploadDetailDTO extends UploadRowDTO {
  extracted_text: string | null;
  download_url: string | null;
}

// ── Controller ──────────────────────────────────────────────────────────

@Controller('uploads')
@UseGuards(SupabaseAuthGuard)
export class StorageController {
  private readonly logger = new Logger(StorageController.name);

  @Post()
  async initiate(
    @CurrentUser() user: { id: string },
    @Body() body: InitiateUploadBody,
  ): Promise<{
    upload_id: string;
    storage_path: string;
    upload_url: string;
    upload_token: string;
  }> {
    const filename = (body.original_filename ?? '').trim();
    const mimeType = (body.mime_type ?? '').trim();
    const sizeBytes = Number(body.size_bytes);

    if (filename.length === 0) throw new BadRequestException('original_filename required');
    if (mimeType.length === 0) throw new BadRequestException('mime_type required');
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      throw new BadRequestException('size_bytes must be a positive integer');
    }
    if (sizeBytes > MAX_SIZE_BYTES) {
      throw new BadRequestException(
        `file too large; max ${Math.floor(MAX_SIZE_BYTES / 1024 / 1024)} MB`,
      );
    }

    const kind = resolveKind(filename, mimeType);
    if (!kind) {
      throw new BadRequestException(
        `unsupported file type. Allowed: PDF, markdown, plain text, DOCX. (got mime=${mimeType})`,
      );
    }

    // Insert the row first to mint the upload id (which becomes the
    // middle segment of the storage path). Storage path embedded with
    // the upload id avoids collisions on same-named uploads + ties the
    // object uniquely to its DB row.
    const safeName = sanitizeFilename(filename);
    const [inserted] = await db
      .insert(uploads)
      .values({
        userId: user.id,
        kind,
        originalFilename: filename,
        mimeType,
        sizeBytes,
        // Placeholder storage_path. We update it immediately below
        // because we need the upload id to construct the final path.
        storagePath: 'pending',
        extractionStatus: 'awaiting_upload',
      })
      .returning({ id: uploads.id });
    if (!inserted) throw new Error('failed to create uploads row');

    const storagePath = `${user.id}/${inserted.id}/${safeName}`;
    await db
      .update(uploads)
      .set({ storagePath })
      .where(eq(uploads.id, inserted.id));

    // Ask Supabase Storage for a signed upload URL. The client PUTs
    // directly to this URL — no proxy through our API.
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (error || !data) {
      // Clean up the row so we don't leak ghost uploads.
      await db.delete(uploads).where(eq(uploads.id, inserted.id));
      throw new Error(
        `failed to create signed upload URL: ${error?.message ?? 'unknown'}`,
      );
    }

    this.logger.log(
      { userId: user.id, uploadId: inserted.id, kind, sizeBytes },
      'upload initiated',
    );
    return {
      upload_id: inserted.id,
      storage_path: storagePath,
      upload_url: data.signedUrl,
      upload_token: data.token,
    };
  }

  @Post(':id/finalize')
  async finalize(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ): Promise<{ row: UploadRowDTO }> {
    const row = await loadOwn(user.id, id);
    if (row.extractionStatus !== 'awaiting_upload') {
      throw new BadRequestException(
        `upload not in awaiting_upload state (current: ${row.extractionStatus})`,
      );
    }

    // Verify the object actually landed in Storage. Cheap HEAD via
    // signed download URL is overkill; the SDK's list() on the prefix
    // is fine since each prefix only ever contains one object.
    const supabase = getSupabaseAdmin();
    const prefix = `${user.id}/${row.id}`;
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 5 });
    if (error) {
      throw new Error(`failed to verify upload: ${error.message}`);
    }
    const found = data?.some((o) => `${prefix}/${o.name}` === row.storagePath);
    if (!found) {
      throw new BadRequestException(
        'upload not found in storage. Did the PUT complete before /finalize?',
      );
    }

    // Flip to pending + enqueue the worker extraction job. Single
    // transaction so the job can't fire before the row update commits.
    await db.transaction(async (tx) => {
      await tx
        .update(uploads)
        .set({
          extractionStatus: 'pending',
          uploadedAt: new Date(),
        })
        .where(eq(uploads.id, row.id));

      const payload = JSON.stringify({ uploadId: row.id });
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'extract_upload',
          ${payload}::json,
          max_attempts => 3
        )
      `);
    });

    this.logger.log(
      { userId: user.id, uploadId: row.id },
      'upload finalized; extraction enqueued',
    );
    const fresh = await loadOwn(user.id, row.id);
    return { row: rowToDTO(fresh, []) };
  }

  @Post(':id/ingest')
  async ingest(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: { attach_to_page_id: string },
  ): Promise<{ row: UploadRowDTO; attachment_id: string }> {
    const row = await loadOwn(user.id, id);
    if (row.extractionStatus !== 'succeeded' || !row.extractedText) {
      throw new BadRequestException(
        `upload not ready to ingest (extraction status: ${row.extractionStatus})`,
      );
    }

    const attachPageId = (body.attach_to_page_id ?? '').trim();
    if (!attachPageId) {
      throw new BadRequestException('attach_to_page_id required');
    }
    // Verify the page belongs to the user + is active.
    const [page] = await db
      .select({ id: wikiPages.id, slug: wikiPages.slug })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.id, attachPageId),
          eq(wikiPages.userId, user.id),
          eq(wikiPages.scope, 'user'),
          isNull(wikiPages.tombstonedAt),
        ),
      )
      .limit(1);
    if (!page) {
      throw new BadRequestException('attach_to_page_id is not a valid wiki page');
    }

    // Look for an existing attachment for this (upload, page) pair.
    // Allowed retry path: pending/failed/succeeded → reset and re-fire.
    // Blocked: running (already in flight) — return current state.
    const [existing] = await db
      .select()
      .from(uploadAttachments)
      .where(
        and(
          eq(uploadAttachments.uploadId, row.id),
          eq(uploadAttachments.pageId, page.id),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'running') {
      throw new BadRequestException(
        'ingestion to this page is already in progress',
      );
    }

    const attachmentId = await db.transaction(async (tx) => {
      let aid: string;
      if (existing) {
        // Retry — reset status, drop prior error, clear timestamps.
        await tx
          .update(uploadAttachments)
          .set({
            status: 'pending',
            error: null,
            startedAt: null,
            completedAt: null,
            attachedAt: new Date(),
          })
          .where(eq(uploadAttachments.id, existing.id));
        aid = existing.id;
      } else {
        const [inserted] = await tx
          .insert(uploadAttachments)
          .values({
            uploadId: row.id,
            pageId: page.id,
            status: 'pending',
          })
          .returning({ id: uploadAttachments.id });
        if (!inserted) throw new Error('failed to insert upload_attachments row');
        aid = inserted.id;
      }

      const payload = JSON.stringify({
        attachmentId: aid,
        userId: user.id,
      });
      // Same per-user FIFO queue as transcript ingestion.
      const queueName = `ingestion-${user.id}`;
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'ingestion_upload',
          ${payload}::json,
          queue_name => ${queueName},
          max_attempts => 2
        )
      `);

      return aid;
    });

    this.logger.log(
      {
        userId: user.id,
        uploadId: row.id,
        attachmentId,
        attachPageSlug: page.slug,
        retry: !!existing,
      },
      'upload ingest requested',
    );
    const fresh = await loadOwn(user.id, row.id);
    const attachmentsMap = await fetchAttachmentsForUploads([fresh.id]);
    return {
      row: rowToDTO(fresh, attachmentsMap.get(fresh.id) ?? []),
      attachment_id: attachmentId,
    };
  }

  @Get()
  async list(@CurrentUser() user: { id: string }): Promise<{ rows: UploadRowDTO[] }> {
    const rows = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.userId, user.id), isNull(uploads.tombstonedAt)))
      .orderBy(desc(uploads.createdAt));
    const attachmentsMap = await fetchAttachmentsForUploads(rows.map((r) => r.id));
    return { rows: rows.map((r) => rowToDTO(r, attachmentsMap.get(r.id) ?? [])) };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ): Promise<{ row: UploadDetailDTO }> {
    const row = await loadOwn(user.id, id);
    const attachmentsMap = await fetchAttachmentsForUploads([row.id]);
    const attachments = attachmentsMap.get(row.id) ?? [];

    // Generate a short-lived signed download URL. Client uses this to
    // render the original file (e.g. PDF preview). Null when the
    // upload hasn't landed yet.
    let downloadUrl: string | null = null;
    if (row.extractionStatus !== 'awaiting_upload') {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(row.storagePath, DOWNLOAD_URL_TTL_SECONDS);
      if (!error) downloadUrl = data?.signedUrl ?? null;
    }

    return {
      row: {
        ...rowToDTO(row, attachments),
        extracted_text: row.extractedText,
        download_url: downloadUrl,
      },
    };
  }

  @Delete(':id')
  async tombstone(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const row = await loadOwn(user.id, id);

    // Soft-delete the row + hard-delete the Storage object. Keeping
    // the row preserves any wiki_section_uploads junction cites
    // (the upload FK has ON DELETE CASCADE, which would wipe those
    // if we hard-deleted). Source attribution outlives the file.
    await db
      .update(uploads)
      .set({ tombstonedAt: new Date() })
      .where(eq(uploads.id, row.id));

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(BUCKET).remove([row.storagePath]);
    if (error) {
      // Storage cleanup is best-effort. The row is tombstoned;
      // orphaned objects will collect in a periodic sweep (TODO:
      // hygiene-sweep extension).
      this.logger.warn(
        { uploadId: row.id, error: error.message },
        'tombstone: storage object removal failed (will sweep later)',
      );
    }

    this.logger.log({ userId: user.id, uploadId: row.id }, 'upload tombstoned');
    return { ok: true };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadOwn(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.id, id),
        eq(uploads.userId, userId),
        isNull(uploads.tombstonedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException();
  return row;
}

function resolveKind(filename: string, mimeType: string): UploadKind | null {
  for (const entry of KIND_MAP) {
    if (entry.mimePattern.test(mimeType)) return entry.kind;
  }
  // Fallback: trailing extension. Some pickers send octet-stream.
  const ext = filename.toLowerCase().split('.').pop();
  if (ext && ext in EXT_MAP) return EXT_MAP[ext] ?? null;
  return null;
}

// Filter unsafe filename characters. charCodeAt-based to satisfy
// biome's noControlCharactersInRegex without disabling the rule;
// also strips path separators + leading dots and caps length.
function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) continue; // control chars
    if (ch === '/' || ch === '\\') {
      out += '_';
      continue;
    }
    out += ch;
  }
  return out.replace(/^\.+/, '').slice(0, 240) || 'unnamed';
}

function rowToDTO(
  row: typeof uploads.$inferSelect,
  attachments: UploadAttachmentDTO[] = [],
): UploadRowDTO {
  return {
    id: row.id,
    kind: row.kind,
    original_filename: row.originalFilename,
    storage_path: row.storagePath,
    mime_type: row.mimeType,
    size_bytes: row.sizeBytes,
    folder_path: row.folderPath,
    extraction_status: row.extractionStatus,
    extraction_error: row.extractionError,
    extracted_at: row.extractedAt?.toISOString() ?? null,
    uploaded_at: row.uploadedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    attachments,
  };
}

// Fetch the per-upload attachments map for a set of uploads. Joins to
// wiki_pages to surface the attached page's slug (UI-friendly).
async function fetchAttachmentsForUploads(
  uploadIds: string[],
): Promise<Map<string, UploadAttachmentDTO[]>> {
  const result = new Map<string, UploadAttachmentDTO[]>();
  if (uploadIds.length === 0) return result;
  const rows = await db
    .select({
      id: uploadAttachments.id,
      uploadId: uploadAttachments.uploadId,
      pageId: uploadAttachments.pageId,
      pageSlug: wikiPages.slug,
      status: uploadAttachments.status,
      error: uploadAttachments.error,
      attachedAt: uploadAttachments.attachedAt,
      startedAt: uploadAttachments.startedAt,
      completedAt: uploadAttachments.completedAt,
    })
    .from(uploadAttachments)
    .leftJoin(wikiPages, eq(wikiPages.id, uploadAttachments.pageId))
    .where(inArray(uploadAttachments.uploadId, uploadIds))
    .orderBy(desc(uploadAttachments.attachedAt));
  for (const r of rows) {
    const list = result.get(r.uploadId) ?? [];
    list.push({
      id: r.id,
      page_id: r.pageId,
      page_slug: r.pageSlug,
      status: r.status,
      error: r.error,
      attached_at: r.attachedAt.toISOString(),
      started_at: r.startedAt?.toISOString() ?? null,
      completed_at: r.completedAt?.toISOString() ?? null,
    });
    result.set(r.uploadId, list);
  }
  return result;
}
