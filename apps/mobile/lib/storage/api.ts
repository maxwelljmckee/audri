// REST client for the Storage tile. Two endpoints families wrapped:
//   - /uploads     (file-based source kinds: PDF / markdown / plain / DOCX)
//   - /urls        (URL-based source kinds: web_article / pdf / reddit_thread)
//
// Both families share the same "extracted then attached" lifecycle.
// Attachments are per-(source, page) — multi-attach to different
// subtrees is supported by both sides.

import { supabase } from '../supabase';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

// ── Shared types ────────────────────────────────────────────────────────

export type ExtractionStatus =
  | 'awaiting_upload'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface AttachmentDTO {
  id: string;
  page_id: string;
  page_slug: string | null;
  status: string;
  error: string | null;
  attached_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Uploads ─────────────────────────────────────────────────────────────

export interface UploadRow {
  id: string;
  kind: 'pdf' | 'markdown' | 'plain' | 'docx';
  original_filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  folder_path: string | null;
  extraction_status: ExtractionStatus;
  extraction_error: string | null;
  extracted_at: string | null;
  uploaded_at: string | null;
  created_at: string;
  attachments: AttachmentDTO[];
}

export interface UploadDetail extends UploadRow {
  extracted_text: string | null;
  download_url: string | null;
}

export interface InitiateUploadResult {
  upload_id: string;
  storage_path: string;
  upload_url: string;
  upload_token: string;
}

export async function initiateUpload(input: {
  filename: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<InitiateUploadResult> {
  const r = await fetch(`${API_URL}/uploads`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({
      original_filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
    }),
  });
  return handle<InitiateUploadResult>(r);
}

export async function finalizeUpload(uploadId: string): Promise<{ row: UploadRow }> {
  const r = await fetch(`${API_URL}/uploads/${uploadId}/finalize`, {
    method: 'POST',
    headers: await authHeaders(),
  });
  return handle<{ row: UploadRow }>(r);
}

export async function listUploads(): Promise<UploadRow[]> {
  const r = await fetch(`${API_URL}/uploads`, { headers: await authHeaders() });
  const { rows } = await handle<{ rows: UploadRow[] }>(r);
  return rows;
}

export async function getUpload(id: string): Promise<UploadDetail> {
  const r = await fetch(`${API_URL}/uploads/${id}`, { headers: await authHeaders() });
  const { row } = await handle<{ row: UploadDetail }>(r);
  return row;
}

export async function ingestUpload(input: {
  uploadId: string;
  attachToPageId: string;
}): Promise<{ row: UploadRow; attachment_id: string }> {
  const r = await fetch(`${API_URL}/uploads/${input.uploadId}/ingest`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ attach_to_page_id: input.attachToPageId }),
  });
  return handle<{ row: UploadRow; attachment_id: string }>(r);
}

export async function deleteUpload(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/uploads/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  await handle<{ ok: true }>(r);
}

// ── URL sources ─────────────────────────────────────────────────────────

export type UrlSourceKind = 'web_article' | 'pdf' | 'reddit_thread';

export interface UrlSourceRow {
  id: string;
  url: string;
  fetched_url: string | null;
  kind: UrlSourceKind;
  title: string | null;
  site_name: string | null;
  byline: string | null;
  folder_path: string | null;
  extraction_status: 'pending' | 'running' | 'succeeded' | 'failed';
  extraction_error: string | null;
  fetched_at: string | null;
  extracted_at: string | null;
  created_at: string;
  attachments: AttachmentDTO[];
}

export interface UrlSourceDetail extends UrlSourceRow {
  extracted_text: string | null;
}

export async function initiateUrl(input: {
  url: string;
  title?: string;
}): Promise<{ row: UrlSourceRow }> {
  const r = await fetch(`${API_URL}/urls`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ url: input.url, title: input.title }),
  });
  return handle<{ row: UrlSourceRow }>(r);
}

export async function listUrlSources(): Promise<UrlSourceRow[]> {
  const r = await fetch(`${API_URL}/urls`, { headers: await authHeaders() });
  const { rows } = await handle<{ rows: UrlSourceRow[] }>(r);
  return rows;
}

export async function getUrlSource(id: string): Promise<UrlSourceDetail> {
  const r = await fetch(`${API_URL}/urls/${id}`, { headers: await authHeaders() });
  const { row } = await handle<{ row: UrlSourceDetail }>(r);
  return row;
}

export async function ingestUrlSource(input: {
  urlSourceId: string;
  attachToPageId: string;
}): Promise<{ row: UrlSourceRow; attachment_id: string }> {
  const r = await fetch(`${API_URL}/urls/${input.urlSourceId}/ingest`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ attach_to_page_id: input.attachToPageId }),
  });
  return handle<{ row: UrlSourceRow; attachment_id: string }>(r);
}

export async function deleteUrlSource(id: string): Promise<void> {
  const r = await fetch(`${API_URL}/urls/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  await handle<{ ok: true }>(r);
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) throw new Error('not signed in');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` };
}

async function handle<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status}: ${body}`);
  }
  return (await r.json()) as T;
}
