// Multi-kind URL extractor for the url-sources pipeline. Dispatches
// on URL pattern (Reddit) and content-type (HTML / PDF) to the
// appropriate extractor. Returns a uniform shape so the pipeline
// downstream (status writes, Flash, Pro, commit) doesn't care which
// kind it was.
//
// Supported kinds (v0.3.0):
//   - reddit_thread — public .json API, no auth required
//   - pdf           — pdf-parse on application/pdf bytes
//   - web_article   — JSDOM + Mozilla Readability on text/html
//
// New kinds (youtube_video, twitter_thread, podcast_episode, etc.)
// add a detector + extractor function and a new enum value. See
// backlog → Storage → "Mixed-media URL ingestion."

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { Buffer } from 'node:buffer';
import { extractPdf } from '../uploads/extractors.js';

export type UrlSourceKind = 'web_article' | 'pdf' | 'reddit_thread';

export interface UrlExtractionResult {
  kind: UrlSourceKind;
  fetchedUrl: string;
  title: string | null;
  siteName: string | null;
  byline: string | null;
  text: string;
  byteLength: number | null;
}

const FETCH_TIMEOUT_MS = 30_000;
const MIN_EXTRACTED_TEXT_LENGTH = 100;
const USER_AGENT =
  'Mozilla/5.0 (compatible; Audri/0.3; +https://audri.ai/bot) AppleWebKit/537.36';

// ── Top-level dispatch ──────────────────────────────────────────────────

export async function fetchAndExtractUrl(url: string): Promise<UrlExtractionResult> {
  // URL-pattern dispatch first — known platforms with structured APIs
  // are handled before falling through to generic HTML extraction.
  if (isRedditUrl(url)) {
    return extractRedditThread(url);
  }

  // Generic fetch + content-type dispatch.
  const resp = await timedFetch(url, {
    Accept: 'text/html,application/xhtml+xml,application/pdf',
  });
  const contentType = resp.headers.get('content-type') ?? '';

  if (/application\/pdf/i.test(contentType)) {
    return extractPdfFromResponse(resp);
  }
  if (/text\/html|application\/xhtml/i.test(contentType)) {
    return extractHtmlFromResponse(resp);
  }
  throw new Error(
    `unsupported content-type for v0.3.0 url-sources: ${contentType || 'unknown'} (supported: text/html, application/pdf, reddit URLs)`,
  );
}

// ── Reddit thread ──────────────────────────────────────────────────────

// Match the shape `reddit.com/r/<sub>/comments/<id>/<slug?>`. Excludes
// redd.it short links (those redirect through a non-API host; add to
// backlog if shows up as a recurring frustration). Subdomain-tolerant:
// www., old., np., new. all accepted.
const REDDIT_URL_PATTERN =
  /^https?:\/\/(?:www\.|old\.|np\.|new\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+/i;

function isRedditUrl(url: string): boolean {
  return REDDIT_URL_PATTERN.test(url);
}

// Public Reddit JSON API: append `.json` to any thread URL and you
// get the post + comment tree as JSON. No auth required for read.
// Rate-limited (~60 req/min unauthenticated); fine at our scale.
async function extractRedditThread(url: string): Promise<UrlExtractionResult> {
  const jsonUrl = appendJsonSuffix(url);
  const resp = await timedFetch(jsonUrl, {
    Accept: 'application/json',
  });
  if (!resp.ok) {
    throw new Error(`Reddit JSON fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const json = (await resp.json()) as RedditListingArray;
  if (!Array.isArray(json) || json.length < 1) {
    throw new Error('Reddit response shape unexpected (not a Listing array)');
  }

  const postListing = json[0];
  const post = postListing?.data?.children?.[0]?.data as RedditPost | undefined;
  if (!post || !post.title) {
    throw new Error('Reddit post not found in response');
  }

  const comments = (json[1]?.data?.children ?? []) as Array<{
    kind?: string;
    data?: RedditCommentData;
  }>;

  const lines: string[] = [];
  lines.push(`# ${post.title}`);
  lines.push('');
  lines.push(`Posted to r/${post.subreddit} by u/${post.author ?? '[deleted]'}`);
  lines.push(`URL: ${url}`);
  lines.push('');
  if (post.selftext && post.selftext.trim().length > 0) {
    lines.push('## Post body');
    lines.push('');
    lines.push(post.selftext.trim());
    lines.push('');
  } else if (post.url && post.url !== url) {
    // Link post — there's no post body, just a link. Surface the
    // link so Pro can see the post is about an external resource.
    lines.push('## Linked URL');
    lines.push(post.url);
    lines.push('');
  }
  if (comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const c of comments) {
      appendCommentTree(c, lines, 0);
    }
  }

  const text = lines.join('\n').trim();
  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
    throw new Error('Reddit thread extracted as near-empty (no body, no comments)');
  }

  return {
    kind: 'reddit_thread',
    fetchedUrl: resp.url,
    // Reddit titles get truncated by the platform; the post.title
    // field is the full version Reddit stores.
    title: post.title.trim(),
    siteName: `r/${post.subreddit}`,
    // Author of the post. Comments authored by others are surfaced
    // inline in the text body.
    byline: post.author ? `u/${post.author}` : null,
    text,
    byteLength: null, // JSON response; not meaningful
  };
}

function appendJsonSuffix(url: string): string {
  // Trim trailing slash, drop existing query string, append `.json`.
  // Preserve query params if any (some Reddit URLs carry tracking
  // params; .json ignores them safely).
  const u = new URL(url);
  if (u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  if (!u.pathname.endsWith('.json')) u.pathname += '.json';
  return u.toString();
}

interface RedditPost {
  title?: string;
  selftext?: string;
  subreddit?: string;
  author?: string;
  url?: string;
}

interface RedditCommentData {
  author?: string;
  body?: string;
  replies?: { data?: { children?: RedditCommentChild[] } } | '';
}

interface RedditCommentChild {
  kind?: string;
  data?: RedditCommentData;
}

interface RedditListing {
  data?: {
    children?: Array<{
      kind?: string;
      data?: RedditPost | RedditCommentData;
    }>;
  };
}

type RedditListingArray = RedditListing[];

function appendCommentTree(
  node: { kind?: string; data?: RedditCommentData },
  lines: string[],
  depth: number,
): void {
  if (!node?.data) return;
  // Skip "more" placeholders (Reddit's "load more" sentinels) — kind
  // is "more", not "t1".
  if (node.kind !== 't1') return;
  const c = node.data;
  if (!c.body || c.body === '[deleted]' || c.body === '[removed]') return;

  const indent = '  '.repeat(depth);
  const author = c.author ?? '[deleted]';
  lines.push(`${indent}- u/${author}: ${c.body.replaceAll('\n', ' ').slice(0, 1000)}`);

  // Recurse into replies. `replies` is either an empty string (no
  // replies) or a nested Listing.
  const replyChildren =
    typeof c.replies === 'object' && c.replies?.data?.children
      ? c.replies.data.children
      : [];
  for (const r of replyChildren) {
    appendCommentTree(r, lines, Math.min(depth + 1, 4));
  }
}

// ── PDF at URL ─────────────────────────────────────────────────────────

async function extractPdfFromResponse(resp: Response): Promise<UrlExtractionResult> {
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const text = await extractPdf(buf);

  // PDF metadata extraction is shallow for v0.3.0 — pdf-parse can
  // return info.Title / info.Author but we'd need to thread that
  // through extractPdf's return shape. For now, derive title from
  // the URL filename if it's there, else null (Pro will name the
  // source page from the extracted text content).
  const fallbackTitle = pdfTitleFromUrl(resp.url);

  return {
    kind: 'pdf',
    fetchedUrl: resp.url,
    title: fallbackTitle,
    siteName: new URL(resp.url).host,
    byline: null,
    text,
    byteLength: buf.byteLength,
  };
}

function pdfTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() ?? '';
    if (!file.toLowerCase().endsWith('.pdf')) return null;
    return (
      decodeURIComponent(file.replace(/\.pdf$/i, '').replaceAll('_', ' ').replaceAll('-', ' ')) ||
      null
    );
  } catch {
    return null;
  }
}

// ── HTML (existing Readability path) ──────────────────────────────────

async function extractHtmlFromResponse(resp: Response): Promise<UrlExtractionResult> {
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  const fetchedUrl = resp.url;
  const contentLengthHeader = resp.headers.get('content-length');
  const byteLength = contentLengthHeader ? Number.parseInt(contentLengthHeader, 10) : null;
  const html = await resp.text();

  const dom = new JSDOM(html, { url: fetchedUrl });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    throw new Error(
      'Readability returned no article — page may have no extractable main content',
    );
  }

  const text = (article.textContent ?? '').trim();
  if (text.length < MIN_EXTRACTED_TEXT_LENGTH) {
    throw new Error(
      `extracted text too short (${text.length} chars; min ${MIN_EXTRACTED_TEXT_LENGTH}). Page may be image-only, JS-rendered, or paywalled.`,
    );
  }

  return {
    kind: 'web_article',
    fetchedUrl,
    title: article.title?.trim() || null,
    siteName: article.siteName?.trim() || null,
    byline: article.byline?.trim() || null,
    text,
    byteLength: Number.isFinite(byteLength) ? byteLength : null,
  };
}

// ── Shared fetch with timeout + UA ────────────────────────────────────

async function timedFetch(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        ...extraHeaders,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
