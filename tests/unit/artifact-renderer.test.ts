import fs from 'fs/promises';
import { ArtifactRendererRegistry } from '../../src/services/artifacts/ArtifactRenderer';
import { ArtifactSpec } from '@aso/workflow-contracts';

describe('artifact renderers', () => {
  const now = new Date().toISOString();

  it('renders PDF, XLSX, and DOCX artifacts', async () => {
    const registry = new ArtifactRendererRegistry();
    const base: Omit<ArtifactSpec, 'id' | 'kind' | 'format' | 'title'> = {
      workflowId: 'wf_1',
      workflowStepId: 'step_1',
      sections: [],
      bindings: {},
      status: 'compiled',
      createdAt: now,
      updatedAt: now,
    };

    const pdfSpec: ArtifactSpec = {
      ...base,
      id: 'artifact_pdf_test',
      kind: 'executive_brief',
      format: 'pdf',
      title: 'PDF Test',
    };
    const xlsxSpec: ArtifactSpec = {
      ...base,
      id: 'artifact_xlsx_test',
      kind: 'report',
      format: 'xlsx',
      title: 'XLSX Test',
    };
    const docxSpec: ArtifactSpec = {
      ...base,
      id: 'artifact_docx_test',
      kind: 'summary_document',
      format: 'docx',
      title: 'DOCX Test',
    };

    const pdf = await registry.getRenderer(pdfSpec).render(pdfSpec, [{ name: 'Acme' }]);
    const xlsx = await registry.getRenderer(xlsxSpec).render(xlsxSpec, [{ name: 'Acme' }]);
    const docx = await registry.getRenderer(docxSpec).render(docxSpec, [{ name: 'Acme' }]);

    expect(pdf.path.endsWith('.pdf')).toBe(true);
    expect(xlsx.path.endsWith('.xlsx')).toBe(true);
    expect(docx.path.endsWith('.docx')).toBe(true);
    expect((await fs.stat(pdf.path)).size).toBeGreaterThan(0);
    expect((await fs.stat(xlsx.path)).size).toBeGreaterThan(0);
    expect((await fs.stat(docx.path)).size).toBeGreaterThan(0);
    expect(xlsx.previewRows).toEqual([
      ['name'],
      ['Acme'],
    ]);
    expect(docx.previewText).toContain('DOCX Test');
  });
});
