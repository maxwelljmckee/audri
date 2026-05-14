// URL sources REST surface — backs the Storage tile's URL-ingestion
// path. Distinct from `/uploads`: no signed-URL dance, no client
// upload; the server fetches the URL itself.
//
// Endpoints:
//   POST   /urls                     submit URL → enqueue fetch
//   POST   /urls/:id/ingest          attach to wiki page → enqueue ingestion
//   GET    /urls                     list user's URL sources
//   GET    /urls/:id                 detail incl. extracted_text + attachments
//   DELETE /urls/:id                 tombstone
//
// Lifecycle parallels uploads: fetch → succeeded → user attaches →
// per-attachment ingestion. Each attachment is its own ingestion
// lifecycle (Path B junction).

import {
  and,
  db,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  urlSourceAttachments,
  urlSources,
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
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard.js';
import { CurrentUser } from '../auth/user.decorator.js';

// ── DTOs ────────────────────────────────────────────────────────────────

interface InitiateUrlBody {
  url: string;
  // Optional client-supplied title hint (e.g. from a share-extension
  // pre-fetch). Server overwrites with the og:title / <title> after
  // its own fetch.
  title?: string;
}

interface UrlSourceAttachmentDTO {
  id: string;
  page_id: string;
  page_slug: string | null;
  status: string;
  error: string | null;
  attached_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface UrlSourceRowDTO {
  id: string;
  url: string;
  fetched_url: string | null;
  kind: 'web_article' | 'pdf' | 'reddit_thread';
  title: string | null;
  site_name: string | null;
  byline: string | null;
  folder_path: string | null;
  extraction_status: 'pending' | 'running' | 'succeeded' | 'failed';
  extraction_error: string | null;
  fetched_at: string | null;
  extracted_at: string | null;
  created_at: string;
  attachments: UrlSourceAttachmentDTO[];
}

interface UrlSourceDetailDTO extends UrlSourceRowDTO {
  extracted_text: string | null;
}

// ── Controller ──────────────────────────────────────────────────────────

@Controller('urls')
@UseGuards(SupabaseAuthGuard)
export class UrlsController {
  private readonly logger = new Logger(UrlsController.name);

  @Post()
  async initiate(
    @CurrentUser() user: { id: string },
    @Body() body: InitiateUrlBody,
  ): Promise<{ row: UrlSourceRowDTO }> {
    const url = (body.url ?? '').trim();
    const titleHint = (body.title ?? '').trim() || null;
    if (url.length === 0) throw new BadRequestException('url required');

    // Validate URL syntax + scheme. Only http(s) for v0.3.0 — no
    // file://, ftp://, etc.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('url is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException(`unsupported URL scheme: ${parsed.protocol}`);
    }

    const [inserted] = await db
      .insert(urlSources)
      .values({
        userId: user.id,
        url,
        title: titleHint,
        extractionStatus: 'pending',
      })
      .returning();
    if (!inserted) throw new Error('failed to insert url_sources row');

    // Enqueue the fetch task. No transaction needed — just an insert
    // + a job add, and at-least-once delivery is fine (the task is
    // idempotent against extraction_status).
    const payload = JSON.stringify({ urlSourceId: inserted.id, userId: user.id });
    await db.execute(sql`
      SELECT graphile_worker.add_job(
        'fetch_url',
        ${payload}::json,
        max_attempts => 3
      )
    `);

    this.logger.log(
      { userId: user.id, urlSourceId: inserted.id, host: parsed.host },
      'url source initiated; fetch enqueued',
    );
    return { row: rowToDTO(inserted, []) };
  }

  @Post(':id/ingest')
  async ingest(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
    @Body() body: { attach_to_page_id: string },
  ): Promise<{ row: UrlSourceRowDTO; attachment_id: string }> {
    const row = await loadOwn(user.id, id);
    if (row.extractionStatus !== 'succeeded' || !row.extractedText) {
      throw new BadRequestException(
        `url not ready to ingest (extraction status: ${row.extractionStatus})`,
      );
    }

    const attachPageId = (body.attach_to_page_id ?? '').trim();
    if (!attachPageId) {
      throw new BadRequestException('attach_to_page_id required');
    }
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

    const [existing] = await db
      .select()
      .from(urlSourceAttachments)
      .where(
        and(
          eq(urlSourceAttachments.urlSourceId, row.id),
          eq(urlSourceAttachments.pageId, page.id),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'running') {
      throw new BadRequestException('ingestion to this page is already in progress');
    }

    const attachmentId = await db.transaction(async (tx) => {
      let aid: string;
      if (existing) {
        await tx
          .update(urlSourceAttachments)
          .set({
            status: 'pending',
            error: null,
            startedAt: null,
            completedAt: null,
            attachedAt: new Date(),
          })
          .where(eq(urlSourceAttachments.id, existing.id));
        aid = existing.id;
      } else {
        const [inserted] = await tx
          .insert(urlSourceAttachments)
          .values({
            urlSourceId: row.id,
            pageId: page.id,
            status: 'pending',
          })
          .returning({ id: urlSourceAttachments.id });
        if (!inserted) throw new Error('failed to insert url_source_attachments row');
        aid = inserted.id;
      }

      const payload = JSON.stringify({ attachmentId: aid, userId: user.id });
      const queueName = `ingestion-${user.id}`;
      await tx.execute(sql`
        SELECT graphile_worker.add_job(
          'ingestion_url_source',
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
        urlSourceId: row.id,
        attachmentId,
        attachPageSlug: page.slug,
        retry: !!existing,
      },
      'url source ingest requested',
    );
    const fresh = await loadOwn(user.id, row.id);
    const attachmentsMap = await fetchAttachmentsForUrlSources([fresh.id]);
    return {
      row: rowToDTO(fresh, attachmentsMap.get(fresh.id) ?? []),
      attachment_id: attachmentId,
    };
  }

  @Get()
  async list(@CurrentUser() user: { id: string }): Promise<{ rows: UrlSourceRowDTO[] }> {
    const rows = await db
      .select()
      .from(urlSources)
      .where(and(eq(urlSources.userId, user.id), isNull(urlSources.tombstonedAt)))
      .orderBy(desc(urlSources.createdAt));
    const attachmentsMap = await fetchAttachmentsForUrlSources(rows.map((r) => r.id));
    return { rows: rows.map((r) => rowToDTO(r, attachmentsMap.get(r.id) ?? [])) };
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ): Promise<{ row: UrlSourceDetailDTO }> {
    const row = await loadOwn(user.id, id);
    const attachmentsMap = await fetchAttachmentsForUrlSources([row.id]);
    return {
      row: {
        ...rowToDTO(row, attachmentsMap.get(row.id) ?? []),
        extracted_text: row.extractedText,
      },
    };
  }

  @Delete(':id')
  async tombstone(@CurrentUser() user: { id: string }, @Param('id') id: string) {
    const row = await loadOwn(user.id, id);
    await db
      .update(urlSources)
      .set({ tombstonedAt: new Date() })
      .where(eq(urlSources.id, row.id));
    this.logger.log({ userId: user.id, urlSourceId: row.id }, 'url source tombstoned');
    return { ok: true };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function loadOwn(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(urlSources)
    .where(
      and(
        eq(urlSources.id, id),
        eq(urlSources.userId, userId),
        isNull(urlSources.tombstonedAt),
      ),
    )
    .limit(1);
  if (!row) throw new NotFoundException();
  return row;
}

async function fetchAttachmentsForUrlSources(
  urlSourceIds: string[],
): Promise<Map<string, UrlSourceAttachmentDTO[]>> {
  const result = new Map<string, UrlSourceAttachmentDTO[]>();
  if (urlSourceIds.length === 0) return result;
  const rows = await db
    .select({
      id: urlSourceAttachments.id,
      urlSourceId: urlSourceAttachments.urlSourceId,
      pageId: urlSourceAttachments.pageId,
      pageSlug: wikiPages.slug,
      status: urlSourceAttachments.status,
      error: urlSourceAttachments.error,
      attachedAt: urlSourceAttachments.attachedAt,
      startedAt: urlSourceAttachments.startedAt,
      completedAt: urlSourceAttachments.completedAt,
    })
    .from(urlSourceAttachments)
    .leftJoin(wikiPages, eq(wikiPages.id, urlSourceAttachments.pageId))
    .where(inArray(urlSourceAttachments.urlSourceId, urlSourceIds))
    .orderBy(desc(urlSourceAttachments.attachedAt));
  for (const r of rows) {
    const list = result.get(r.urlSourceId) ?? [];
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
    result.set(r.urlSourceId, list);
  }
  return result;
}

function rowToDTO(
  row: typeof urlSources.$inferSelect,
  attachments: UrlSourceAttachmentDTO[],
): UrlSourceRowDTO {
  return {
    id: row.id,
    url: row.url,
    fetched_url: row.fetchedUrl,
    kind: row.kind,
    title: row.title,
    site_name: row.siteName,
    byline: row.byline,
    folder_path: row.folderPath,
    extraction_status: row.extractionStatus,
    extraction_error: row.extractionError,
    fetched_at: row.fetchedAt?.toISOString() ?? null,
    extracted_at: row.extractedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    attachments,
  };
}
