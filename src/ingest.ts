// Reference-material extraction: UTF-8 Markdown/text and PDFs with a text layer. Content is
// treated purely as data: PDF.js (v6 contains no eval/new Function) runs without XFA or fonts, scripts/links/attachments are never
// followed, and nothing in the text is interpreted as an instruction. Pages without extractable
// text and suspicious extractions are reported instead of silently counted as imported.

export interface Chunk {
  section: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
}

export interface ExtractionReport {
  format: 'markdown' | 'text' | 'pdf';
  pages: number | null;
  characters: number;
  chunks: number;
  empty_pages: number[];
  suspicious_pages: { page: number; reason: string }[];
  possible_tables: number[];
  warnings: string[];
}

export interface Extraction {
  chunks: Chunk[];
  report: ExtractionReport;
}

const CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 200;
const MAX_CHUNKS = 5000;

export function detectFormat(filename: string, bytes: Buffer): 'markdown' | 'text' | 'pdf' | null {
  const lower = filename.toLowerCase();
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (lower.endsWith('.pdf')) return null; // claims PDF but is not one
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

export function decodeUtf8Strict(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    throw new Error('File is not valid UTF-8 text');
  }
}

/** Splits a long text into overlapping chunks, preferring paragraph and sentence boundaries. */
export function splitText(text: string, max = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
      if (para > max * 0.5) end = start + para;
      else if (sentence > max * 0.5) end = start + sentence + 1;
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

export function extractMarkdown(text: string, format: 'markdown' | 'text'): Extraction {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections: { heading: string | null; body: string[] }[] = [{ heading: null, body: [] }];
  const stack: string[] = [];
  for (const line of lines) {
    const m = format === 'markdown' ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m) {
      const level = m[1]!.length;
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = m[2]!.trim();
      sections.push({ heading: stack.filter(Boolean).join(' > '), body: [] });
    } else {
      sections[sections.length - 1]!.body.push(line);
    }
  }
  const chunks: Chunk[] = [];
  for (const s of sections) {
    for (const piece of splitText(s.body.join('\n'))) {
      chunks.push({ section: s.heading ? s.heading.slice(0, 200) : null, page_start: null, page_end: null, text: piece });
    }
  }
  const warnings: string[] = [];
  if (chunks.length > MAX_CHUNKS) warnings.push(`truncated to ${MAX_CHUNKS} sections`);
  if (/�/.test(text)) warnings.push('contains replacement characters; some text may be garbled');
  const tableLines = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
  if (tableLines > 0) warnings.push(`${tableLines} table rows found; check that tables read correctly`);
  return {
    chunks: chunks.slice(0, MAX_CHUNKS),
    report: {
      format,
      pages: null,
      characters: text.length,
      chunks: Math.min(chunks.length, MAX_CHUNKS),
      empty_pages: [],
      suspicious_pages: [],
      possible_tables: [],
      warnings,
    },
  };
}

const HEADING_LINE = /^(?:(?:\d+(?:\.\d+)*|[IVXLC]+\.)\s+[A-Z][^.!?]{2,60}|[A-Z][A-Z0-9 ,'’&:-]{3,60})$/;

/** Extracts per-page text with PDF.js. Never evaluates embedded scripts or fetches resources. */
export async function extractPdf(bytes: Buffer): Promise<Extraction> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const chunks: Chunk[] = [];
  const empty: number[] = [];
  const suspicious: { page: number; reason: string }[] = [];
  const tables: number[] = [];
  let characters = 0;
  let currentSection: string | null = null;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
      }
      text = text.replace(/[ \t]+/g, ' ').trim();
      page.cleanup();
      characters += text.length;
      if (text.replace(/\s/g, '').length < 20) {
        empty.push(p);
        continue;
      }
      const letters = (text.match(/\p{L}/gu) ?? []).length;
      if (/�/.test(text) || letters / text.length < 0.4) {
        suspicious.push({ page: p, reason: /�/.test(text) ? 'unreadable glyphs' : 'few letters (stat block, table, or bad encoding?)' });
      }
      const lines = text.split('\n');
      if (lines.filter((l) => (l.match(/\d+/g) ?? []).length >= 3).length >= 5) tables.push(p);
      const heading = lines.map((l) => l.trim()).find((l) => HEADING_LINE.test(l));
      if (heading) currentSection = heading.slice(0, 200);
      for (const piece of splitText(text)) {
        chunks.push({ section: currentSection, page_start: p, page_end: p, text: piece });
      }
      if (chunks.length > MAX_CHUNKS) break;
    }
  } finally {
    await task.destroy();
  }
  const warnings: string[] = [];
  if (empty.length) warnings.push(`${empty.length} page(s) have no text layer (scanned or image-only); they were NOT imported: ${summarizePages(empty)}`);
  if (suspicious.length) warnings.push(`${suspicious.length} page(s) look garbled or tabular; review them: ${summarizePages(suspicious.map((s) => s.page))}`);
  if (tables.length) warnings.push(`possible tables/stat blocks on page(s) ${summarizePages(tables)}; extraction order may be wrong`);
  if (characters === 0) warnings.push('no extractable text at all; OCR is not performed automatically');
  return {
    chunks: chunks.slice(0, MAX_CHUNKS),
    report: {
      format: 'pdf',
      pages: doc.numPages,
      characters,
      chunks: Math.min(chunks.length, MAX_CHUNKS),
      empty_pages: empty,
      suspicious_pages: suspicious,
      possible_tables: tables,
      warnings,
    },
  };
}

function summarizePages(pages: number[]): string {
  if (pages.length <= 12) return pages.join(', ');
  return `${pages.slice(0, 12).join(', ')} … (+${pages.length - 12} more)`;
}

export async function extractFile(filename: string, bytes: Buffer): Promise<Extraction> {
  const format = detectFormat(filename, bytes);
  if (!format) throw new Error('Unsupported file type: upload .md, .txt, or a PDF with a text layer');
  if (format === 'pdf') return extractPdf(bytes);
  return extractMarkdown(decodeUtf8Strict(bytes), format);
}
