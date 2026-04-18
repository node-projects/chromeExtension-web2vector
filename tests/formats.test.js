import { describe, it, expect } from 'vitest';
import { FORMATS, CATEGORIES } from '../src/shared/formats.js';

describe('FORMATS', () => {
  it('contains all ten expected format IDs', () => {
    const ids = Object.keys(FORMATS);
    expect(ids).toEqual(
      expect.arrayContaining([
        'svg', 'dxf-standard', 'dxf-acad', 'dwg', 'emf', 'emfplus',
        'pdf', 'html', 'png', 'jpeg', 'webp',
      ]),
    );
    expect(ids).toHaveLength(11);
  });

  it('every format has required properties', () => {
    for (const [id, fmt] of Object.entries(FORMATS)) {
      expect(fmt.name, `${id}.name`).toBeTruthy();
      expect(fmt.ext, `${id}.ext`).toMatch(/^\.\w+$/);
      expect(fmt.mime, `${id}.mime`).toMatch(/^[\w-]+\/[\w.+-]+$/);
      expect(['core', 'dxf', 'acad'], `${id}.bundle`).toContain(fmt.bundle);
      expect(Object.keys(CATEGORIES), `${id}.category`).toContain(fmt.category);
    }
  });

  it('both DXF exporters are present with different IDs', () => {
    expect(FORMATS['dxf-standard']).toBeDefined();
    expect(FORMATS['dxf-acad']).toBeDefined();
    expect(FORMATS['dxf-standard'].bundle).toBe('dxf');
    expect(FORMATS['dxf-acad'].bundle).toBe('acad');
  });

  it('DWG and AcadDXF share the same lazy bundle', () => {
    expect(FORMATS['dxf-acad'].bundle).toBe('acad');
    expect(FORMATS['dwg'].bundle).toBe('acad');
  });

  it('image formats share the core bundle', () => {
    for (const id of ['png', 'jpeg', 'webp']) {
      expect(FORMATS[id].bundle).toBe('core');
    }
  });
});

describe('CATEGORIES', () => {
  it('has vector, document, and image', () => {
    expect(Object.keys(CATEGORIES)).toEqual(['vector', 'document', 'image']);
  });
});
