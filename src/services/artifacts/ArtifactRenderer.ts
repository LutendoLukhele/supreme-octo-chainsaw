import fs from 'fs/promises';
import path from 'path';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import { ArtifactSpec } from '@aso/workflow-contracts';

export interface ArtifactRenderResult {
  path: string;
  byteLength: number;
  filename: string;
  previewRows?: string[][];
  previewText?: string;
}

export interface ArtifactRenderer {
  supports(spec: ArtifactSpec): boolean;
  render(spec: ArtifactSpec, data: unknown): Promise<ArtifactRenderResult>;
}

abstract class BaseRenderer {
  protected async ensureOutputDir(): Promise<string> {
    const outputDir = path.join(process.cwd(), '.data', 'artifacts');
    await fs.mkdir(outputDir, { recursive: true });
    return outputDir;
  }

  protected flattenRows(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : { value: item }));
    }
    if (data && typeof data === 'object') {
      const obj = data as Record<string, any>;
      if (Array.isArray(obj.records)) return this.flattenRows(obj.records);
      if (Array.isArray(obj.data)) return this.flattenRows(obj.data);
      return [obj];
    }
    return [{ value: data }];
  }

  protected buildPreviewRows(rows: Record<string, unknown>[], maxRows = 5): string[][] {
    const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    if (keys.length === 0) return [];
    return [
      keys,
      ...rows.slice(0, maxRows).map((row) => keys.map((key) => this.stringifyCell(row[key]))),
    ];
  }

  protected buildPreviewText(spec: ArtifactSpec, rows: Record<string, unknown>[], maxRows = 5): string {
    const lines = rows.slice(0, maxRows).map((row) =>
      Object.entries(row)
        .map(([key, value]) => `${key}: ${this.stringifyCell(value)}`)
        .join(' • '),
    );
    return [spec.title, ...lines].filter(Boolean).join('\n');
  }

  protected stringifyCell(value: unknown): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }
}

export class XlsxArtifactRenderer extends BaseRenderer implements ArtifactRenderer {
  supports(spec: ArtifactSpec): boolean {
    return spec.format === 'xlsx';
  }

  async render(spec: ArtifactSpec, data: unknown): Promise<ArtifactRenderResult> {
    const outputDir = await this.ensureOutputDir();
    const rows = this.flattenRows(data);
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
    const filepath = path.join(outputDir, `${spec.id}.xlsx`);
    XLSX.writeFile(workbook, filepath);
    const stat = await fs.stat(filepath);
    return {
      path: filepath,
      byteLength: stat.size,
      filename: path.basename(filepath),
      previewRows: this.buildPreviewRows(rows),
    };
  }
}

export class PdfArtifactRenderer extends BaseRenderer implements ArtifactRenderer {
  supports(spec: ArtifactSpec): boolean {
    return spec.format === 'pdf';
  }

  async render(spec: ArtifactSpec, data: unknown): Promise<ArtifactRenderResult> {
    const outputDir = await this.ensureOutputDir();
    const filepath = path.join(outputDir, `${spec.id}.pdf`);
    const rows = this.flattenRows(data);
    const lines = [
      spec.title,
      '',
      ...rows.slice(0, 20).map((row, index) => `${index + 1}. ${JSON.stringify(row)}`),
    ];
    const pdf = this.buildMinimalPdf(lines);
    await fs.writeFile(filepath, pdf);
    return {
      path: filepath,
      byteLength: pdf.byteLength,
      filename: path.basename(filepath),
    };
  }

  private buildMinimalPdf(lines: string[]): Buffer {
    const escapedLines = lines.map((line) =>
      line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'),
    );
    const textOps = escapedLines
      .map((line, index) => `BT /F1 12 Tf 50 ${760 - index * 18} Td (${line}) Tj ET`)
      .join('\n');
    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${Buffer.byteLength(textOps)} >> stream\n${textOps}\nendstream endobj`,
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    ];
    let body = '%PDF-1.4\n';
    const offsets = [0];
    for (const object of objects) {
      offsets.push(Buffer.byteLength(body));
      body += `${object}\n`;
    }
    const xrefOffset = Buffer.byteLength(body);
    body += `xref\n0 ${objects.length + 1}\n`;
    body += '0000000000 65535 f \n';
    offsets.slice(1).forEach((offset) => {
      body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    });
    body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(body);
  }
}

export class DocxArtifactRenderer extends BaseRenderer implements ArtifactRenderer {
  supports(spec: ArtifactSpec): boolean {
    return spec.format === 'docx';
  }

  async render(spec: ArtifactSpec, data: unknown): Promise<ArtifactRenderResult> {
    const outputDir = await this.ensureOutputDir();
    const filepath = path.join(outputDir, `${spec.id}.docx`);
    const rows = this.flattenRows(data);
    const previewText = this.buildPreviewText(spec, rows);
    const docx = await this.buildMinimalDocx(spec, rows);
    await fs.writeFile(filepath, docx);
    return {
      path: filepath,
      byteLength: docx.byteLength,
      filename: path.basename(filepath),
      previewText,
    };
  }

  private async buildMinimalDocx(spec: ArtifactSpec, rows: Record<string, unknown>[]): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
    );
    zip.folder('_rels')?.file(
      '.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    );
    zip.folder('word')?.file('document.xml', this.buildDocumentXml(spec, rows));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  private buildDocumentXml(spec: ArtifactSpec, rows: Record<string, unknown>[]): string {
    const paragraphs = [
      this.paragraph(spec.title, true),
      ...rows.slice(0, 20).map((row) =>
        this.paragraph(
          Object.entries(row)
            .map(([key, value]) => `${key}: ${this.stringifyCell(value)}`)
            .join(' • '),
        ),
      ),
    ].join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;
  }

  private paragraph(text: string, bold = false): string {
    const runProperties = bold ? '<w:rPr><w:b/></w:rPr>' : '';
    return `<w:p><w:r>${runProperties}<w:t>${this.escapeXml(text)}</w:t></w:r></w:p>`;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

export class ArtifactRendererRegistry {
  constructor(private readonly renderers: ArtifactRenderer[] = [
    new PdfArtifactRenderer(),
    new XlsxArtifactRenderer(),
    new DocxArtifactRenderer(),
  ]) {}

  getRenderer(spec: ArtifactSpec): ArtifactRenderer {
    const renderer = this.renderers.find((candidate) => candidate.supports(spec));
    if (!renderer) throw new Error(`No renderer available for artifact format ${spec.format}`);
    return renderer;
  }
}
