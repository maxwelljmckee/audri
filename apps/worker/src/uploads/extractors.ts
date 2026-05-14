// Per-kind text extractors for the Storage tile's upload pipeline.
//
// Contract: each extractor takes a Buffer (the raw file contents) and
// returns the extracted plain-text payload. Errors thrown bubble up to
// the extract_upload task which records them on the uploads row.

import type { Buffer } from 'node:buffer';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export type UploadKind = 'pdf' | 'markdown' | 'plain' | 'docx';

export async function extractText(kind: UploadKind, buf: Buffer): Promise<string> {
  switch (kind) {
    case 'pdf':
      return extractPdf(buf);
    case 'docx':
      return extractDocx(buf);
    case 'markdown':
    case 'plain':
      // Passthrough — both kinds are already utf-8 text. Markdown is
      // preserved as-is (the ingestion fan-out reads markdown natively).
      return buf.toString('utf-8');
    default: {
      // exhaustive check
      const _never: never = kind;
      throw new Error(`unknown upload kind: ${_never}`);
    }
  }
}

async function extractPdf(buf: Buffer): Promise<string> {
  // pdf-parse v2 API: instantiate PDFParse, call getText(). Returns
  // a TextResult with .text (concatenated) and .pages (per-page).
  // We keep the concatenated string; pagewise citation can be added
  // later if/when fan-out wants page numbers.
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    const text = (result.text ?? '').trim();
    if (text.length === 0) {
      throw new Error('PDF extracted as empty text — image-only or DRM-locked?');
    }
    return text;
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(buf: Buffer): Promise<string> {
  // mammoth.extractRawText is the simplest path — discards styling +
  // gives a flat text stream. extractRaw also exposes messages
  // (unrecognized styles, etc.) which we surface in logs only.
  const result = await mammoth.extractRawText({ buffer: buf });
  const text = (result.value ?? '').trim();
  if (text.length === 0) {
    throw new Error('DOCX extracted as empty text');
  }
  return text;
}
