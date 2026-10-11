// ---------------------------------------------------------------------------
// Document Preview & Editing — PDF, DOCX, DOC conversion endpoints
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const ALLOWED_ROOTS = ['/data'];

function isAllowedAbsPath(p: string): boolean {
  const resolved = resolve(p);
  // realpathSync resolves symlinks for accurate containment check
  let realPath: string;
  try { realPath = realpathSync(resolved); } catch { return false; }
  return ALLOWED_ROOTS.some(root => realPath.startsWith(root + '/') || realPath === root);
}

// ── Read request body ──
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString());
  } catch {
    return {};
  }
}

// ── Escape HTML ──
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Strip HTML tags to get plain text ──
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── DOCX → HTML using mammoth ──
async function convertDocxToHtml(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const buf = readFileSync(filePath);
  const result = await mammoth.convertToHtml({ buffer: buf });
  if (result.messages.length > 0) {
    const warns = result.messages.map((m: any) => m.message).join('; ');
    console.log(`[documents] mammoth warnings for ${filePath}: ${warns}`);
  }
  return result.value;
}

// ── PDF → HTML using pdf-parse v2 ──
async function convertPdfToHtml(filePath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const buf = readFileSync(filePath);

  const parser = new PDFParse({ data: buf });
  let text = '';
  let title = '';

  try {
    const textResult = await parser.getText();
    text = textResult.text || '';
  } catch {
    // Fallback: try to get text page by page
    text = '[PDF text extraction failed]';
  }

  try {
    const infoResult = await parser.getInfo();
    title = (infoResult as any).info?.Title || '';
  } catch { /* metadata optional */ }

  const escaped = escapeHtml(text);
  const paragraphs = escaped
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
${title ? `<title>${escapeHtml(title)}</title>` : ''}
<style>
  body { font-family: system-ui, sans-serif; padding: 24px; max-width: 800px; margin: 0 auto; line-height: 1.6; color: #222; }
  h1 { font-size: 1.5em; margin-top: 0.5em; }
  p { margin: 0.5em 0; }
</style>
</head>
<body>
${title ? `<h1>${escapeHtml(title)}</h1>` : ''}
${paragraphs}
</body>
</html>`;
}

// ── DOC → HTML (via libreoffice or antiword) ──
async function convertDocToHtml(filePath: string): Promise<string> {
  // Attempt to convert DOC → DOCX → HTML using libreoffice if available
  try {
    const tmpDir = '/tmp/doc-convert-' + Date.now();
    mkdirSync(tmpDir, { recursive: true });
    execSync(`libreoffice --headless --convert-to docx --outdir "${tmpDir}" "${filePath}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });
    const { readdirSync: rdSync } = await import('node:fs');
    const files = rdSync(tmpDir);
    const docxFile = files.find(f => f.endsWith('.docx'));
    if (docxFile) {
      const docxPath = resolve(tmpDir, docxFile);
      const html = await convertDocxToHtml(docxPath);
      try { execSync(`rm -rf "${tmpDir}"`); } catch { /* ignore */ }
      return html;
    }
  } catch {
    // libreoffice not available, try antiword
    try {
      const result = execSync(`antiword "${filePath}"`, { timeout: 10000, stdio: 'pipe' }).toString();
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:24px;max-width:800px;margin:0 auto;line-height:1.6;color:#222} pre{white-space:pre-wrap;font-family:inherit}</style></head><body><pre>${escapeHtml(result)}</pre></body></html>`;
    } catch { /* fall through */ }
  }

  throw new Error(
    'DOC files require libreoffice or antiword for conversion. ' +
    'Please install one of these tools, or convert the file to DOCX format first.'
  );
}

// ── HTML → DOCX (simplified: text + basic formatting) ──
async function convertHtmlToDocx(html: string): Promise<Buffer> {
  const docxModule = await import('docx');

  // Extract body content
  let bodyHtml = html;
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) bodyHtml = bodyMatch[1];

  // Strip scripts and styles
  bodyHtml = bodyHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  bodyHtml = bodyHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Parse into block-level elements
  const blocks: string[] = [];
  // Split on block-level tags
  const splitRe = /(<\/?(?:h[1-6]|p|div|li|td|th|tr|table|ul|ol|br)[^>]*>)/gi;
  const parts = bodyHtml.split(splitRe);

  let currentBlock = '';
  let headingLevel = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Check if it's a block tag
    const hOpen = part.match(/^<h([1-6])[^>]*>/i);
    const hClose = /^<\/h[1-6]>/i.test(part);
    const pOpen = /^<p[^>]*>/i.test(part);
    const pClose = /^<\/p>/i.test(part);
    const brTag = /^<br[^>]*>/i.test(part);
    const liTag = /^<li[^>]*>/i.test(part) || /^<\/li>/i.test(part);

    if (hOpen) {
      if (currentBlock.trim()) { blocks.push(currentBlock.trim()); currentBlock = ''; }
      headingLevel = parseInt(hOpen[1]);
      currentBlock = `h${headingLevel}:`;
    } else if (hClose) {
      if (currentBlock.trim()) { blocks.push(currentBlock.trim()); currentBlock = ''; }
      headingLevel = 0;
    } else if (pOpen || liTag) {
      if (currentBlock.trim()) { blocks.push(currentBlock.trim()); currentBlock = ''; }
      currentBlock = '';
    } else if (pClose) {
      if (currentBlock.trim()) { blocks.push(currentBlock.trim()); currentBlock = ''; }
    } else if (brTag) {
      if (currentBlock.trim()) { blocks.push(currentBlock.trim()); currentBlock = ''; }
    } else if (part) {
      currentBlock += part;
    }
  }
  if (currentBlock.trim()) { blocks.push(currentBlock.trim()); }

  // Convert blocks to docx children
  const docChildren: any[] = [];

  for (const block of blocks) {
    const text = stripHtml(block);
    if (!text) continue;

    // Check for heading prefix
    const hMatch = text.match(/^h([1-6]):(.*)/);
    if (hMatch) {
      const level = parseInt(hMatch[1]);
      const headingText = hMatch[2].trim();
      if (headingText) {
        docChildren.push(new docxModule.Paragraph({
          text: headingText,
          heading: (docxModule as any).HeadingLevel?.[`HEADING_${level}`] || `Heading${level}`,
        }));
      }
      continue;
    }

    // Regular paragraph
    docChildren.push(new docxModule.Paragraph({
      children: [new docxModule.TextRun({ text })],
    }));
  }

  if (docChildren.length === 0) {
    docChildren.push(new docxModule.Paragraph({
      children: [new docxModule.TextRun({ text: stripHtml(html) || ' ' })],
    }));
  }

  const doc = new docxModule.Document({
    sections: [{
      properties: {},
      children: docChildren,
    }],
  });

  const uint8 = await docxModule.Packer.toBuffer(doc);
  return Buffer.from(uint8);
}

// ── HTML → PDF using html-pdf-node ──
async function convertHtmlToPdf(html: string): Promise<Buffer> {
  const pdfModule = await import('html-pdf-node');
  const options = { format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' } };
  const file = { content: html };
  const result = await pdfModule.generate(file, options);
  return Buffer.from(result);
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/v1/documents/convert
// Body: { path: string, format?: "html" }
// Returns: { html: string, originalFormat: string, path: string }
// ════════════════════════════════════════════════════════════════════════════
async function convertDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const filePath = typeof body.path === 'string' ? body.path : '';

  if (!filePath) {
    sendError(res, 400, 'Missing "path" field in request body');
    return;
  }

  const resolved = resolve(filePath);
  if (!isAllowedAbsPath(resolved)) {
    sendError(res, 403, 'Path traversal blocked — must be under /data');
    return;
  }

  if (!existsSync(resolved)) {
    sendError(res, 404, 'File not found');
    return;
  }

  const stat = statSync(resolved);
  if (stat.size > MAX_FILE_SIZE) {
    sendError(res, 413, `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
    return;
  }

  const ext = extname(resolved).toLowerCase();

  let html: string;
  let originalFormat: string;

  try {
    switch (ext) {
      case '.docx':
        html = await convertDocxToHtml(resolved);
        originalFormat = 'docx';
        break;
      case '.pdf':
        html = await convertPdfToHtml(resolved);
        originalFormat = 'pdf';
        break;
      case '.doc':
        html = await convertDocToHtml(resolved);
        originalFormat = 'doc';
        break;
      default:
        sendError(res, 400, `Unsupported document format: ${ext}. Supported: .docx, .doc, .pdf`);
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Conversion failed';
    console.error(`[documents] convert error for ${filePath}:`, msg);
    sendError(res, 500, `Document conversion failed: ${msg}`);
    return;
  }

  sendJson(res, 200, {
    html,
    originalFormat,
    path: filePath,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/v1/documents/export
// Body: { html: string, outputPath: string, format: "docx" | "pdf" }
// Returns: { path: string, size: number, format: string }
// ════════════════════════════════════════════════════════════════════════════
async function exportDocument(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  const html = typeof body.html === 'string' ? body.html : '';
  const outputPath = typeof body.outputPath === 'string' ? body.outputPath : '';
  const format = typeof body.format === 'string' ? body.format.toLowerCase() : 'docx';

  if (!html) {
    sendError(res, 400, 'Missing "html" field in request body');
    return;
  }

  if (!outputPath) {
    sendError(res, 400, 'Missing "outputPath" field in request body');
    return;
  }

  if (!['docx', 'pdf'].includes(format)) {
    sendError(res, 400, 'Unsupported output format. Use "docx" or "pdf"');
    return;
  }

  const resolved = resolve(outputPath);
  if (!isAllowedAbsPath(resolved)) {
    sendError(res, 403, 'Path traversal blocked — must be under /data');
    return;
  }

  const { dirname: pathDirname } = await import('node:path');
  const dir = pathDirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    let buffer: Buffer;
    if (format === 'pdf') {
      buffer = await convertHtmlToPdf(html);
    } else {
      buffer = await convertHtmlToDocx(html);
    }

    writeFileSync(resolved, buffer);
    const finalStat = statSync(resolved);

    sendJson(res, 200, {
      path: outputPath,
      size: finalStat.size,
      format,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Export failed';
    console.error(`[documents] export error:`, msg);
    sendError(res, 500, `Document export failed: ${msg}`);
  }
}

export function createDocumentRoutes() {
  return {
    convertDocument,
    exportDocument,
  };
}
