import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chunkPages } from '../rag/chunk.js';
import { embedTexts } from '../rag/embed.js';
import { isRagEmbeddings } from '../rag/flags.js';
import { putAttachment, getAttachmentObject } from '../infra/oss.js';
import { getRequestUserId } from '../request-context.js';
import { clean, digest, fail } from './domain.js';
const run = promisify(execFile);
const SYSTEM_FONT_DIRS = ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts'];
/** Portable fontconfig for headless conversion. Explicit FONTCONFIG_FILE always wins. */
export async function prepareSlideFonts(dir, env = process.env) {
  if (env.FONTCONFIG_FILE) return { FONTCONFIG_FILE: env.FONTCONFIG_FILE, generated: false };
  if (process.platform !== 'darwin') return { generated: false };
  const file = path.join(dir, 'fonts.conf');
  const cache = path.join(dir, 'font-cache');
  await fs.mkdir(cache, { recursive: true });
  const xml = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${SYSTEM_FONT_DIRS.map(dir => `  <dir>${dir}</dir>`).join('\n')}\n  <cachedir>${cache}</cachedir>\n</fontconfig>\n`;
  await fs.writeFile(file, xml, { mode: 0o600 });
  return { FONTCONFIG_FILE: file, generated: true };
}
export const MAX_FILE = 40 * 1024 * 1024;
export async function pdfPages(bytes) {
    const task = getDocument({ data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages > 600) throw fail('文件超过 600 页，请按章节拆分。');
    const pages = new Array(pdf.numPages);
    let cursor = 1;
    const workers = Array.from({ length: Math.min(4, pdf.numPages) }, async () => {
      while (cursor <= pdf.numPages) {
        const page = cursor;
        cursor += 1;
        const p = await pdf.getPage(page);
        const text = (await p.getTextContent()).items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('').trim();
        pages[page - 1] = { page, text };
        p.cleanup();
      }
    });
    await Promise.all(workers);
    return pages;
  } finally { await task.destroy(); }
}
export async function convertSlides(bytes, ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'daylight-slides-'));
  try {
    const input = path.join(dir, `slides.${ext}`);
    await fs.writeFile(input, bytes, { mode: 0o600 });
    const fonts = await prepareSlideFonts(dir);
    const env = { ...process.env };
    if (fonts.FONTCONFIG_FILE) env.FONTCONFIG_FILE = fonts.FONTCONFIG_FILE;
    // In-process conversion with a time limit. This is not a separate sandbox worker.
    await run(process.env.DAYLIGHT_SOFFICE || 'soffice', [`-env:UserInstallation=${new URL(`file://${dir}/profile`).href}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, input], { timeout: 90000, maxBuffer: 1024 * 1024, env });
    const output = await fs.readFile(path.join(dir, 'slides.pdf'));
    if (output.length > MAX_FILE || output.subarray(0,5).toString() !== '%PDF-') throw fail('课件转换结果无效。');
    return output;
  } catch { throw fail('PPT 预览转换失败。请检查服务端 LibreOffice，或上传由 PowerPoint 导出的 PDF；原件仍可下载。', 503); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function storeDocument(bytes, filename, projectId) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_FILE) throw fail('文件不能为空，且不能超过 40 MB。');
  filename = clean(path.basename(filename || ''), 180);
  const ext = filename.split('.').pop().toLowerCase();
  if (!['pdf','ppt','pptx','txt','md'].includes(ext)) throw fail('支持 PDF、PPT、PPTX 和文本文件。');
  if (ext === 'pdf' && bytes.subarray(0,5).toString() !== '%PDF-') throw fail('文件不是有效的 PDF。');
  if (ext === 'pptx' && bytes.subarray(0,2).toString() !== 'PK') throw fail('文件不是有效的 PPTX。');
  if (ext === 'ppt' && bytes.subarray(0,8).toString('hex') !== 'd0cf11e0a1b11ae1') throw fail('文件不是有效的 PPT。');
  const owner = getRequestUserId();
  const save = (buffer, name, type) => putAttachment({ buffer, filename: name, contentType: type, prefix: `campus/${digest(owner)}/${projectId}` });
  const original = await save(bytes, filename, ext === 'pdf' ? 'application/pdf' : 'application/octet-stream');
  const document = { id: randomUUID(), filename, hash: digest(bytes.toString('base64')), size: bytes.length, originalKey: original.key, createdAt: new Date().toISOString(), chunks: [], status: 'ready' };
  try {
    let pdf = ext === 'pdf' ? bytes : null;
    if (['ppt','pptx'].includes(ext)) {
      pdf = await convertSlides(bytes, ext);
      document.previewKey = (await save(pdf, 'preview.pdf', 'application/pdf')).key;
    } else if (ext === 'pdf') document.previewKey = original.key;
    const pages = pdf ? await pdfPages(pdf) : [{ page: 1, text: bytes.toString('utf8').slice(0, 500000) }];
    document.pageCount = pages.length;
    document.chunks = chunkPages(pages);
    document.status = document.chunks.length ? 'ready' : 'needs_ocr';
  } catch (error) { document.status = 'failed'; document.error = error.status ? error.message : '文件读取失败，可下载原件或重试。'; }
  return document;
}
export async function attachEmbeddings(document, settings) {
  document.retrieval = 'keyword';
  if (!isRagEmbeddings(settings) || !settings?.apiKey || !settings?.baseUrl || !document.chunks?.length) return document;
  const slice = document.chunks.slice(0, 40);
  try {
    const vectors = await embedTexts(settings, slice.map(c => String(c.content || '').slice(0, 1800)), { label: '校园课件索引' });
    let indexed = 0;
    slice.forEach((chunk, index) => {
      if (Array.isArray(vectors?.[index]) && vectors[index].length) { chunk.embedding = vectors[index]; indexed += 1; }
    });
    if (indexed) document.retrieval = 'hybrid';
  } catch { document.retrieval = 'keyword'; }
  return document;
}
export async function readDocumentBytes(document, preview = false) {
  const key = preview ? document.previewKey : document.originalKey;
  if (!key) throw fail('预览尚未生成，请下载原件或重试。', 409);
  const object = await getAttachmentObject(key);
  if (!object?.buffer) throw fail('文件暂时不可用。', 404);
  return object.buffer;
}
