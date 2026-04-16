/**
 * All supported export formats.
 *
 * `bundle` indicates which lazy-loaded content script chunk is required:
 *   "core"  – built-in writers (no extra dependencies)
 *   "dxf"   – DXFWriter   (pulls in @tarikjabiri/dxf)
 *   "acad"  – DWGWriter / AcadDXFWriter (pulls in @node-projects/acad-ts)
 */
export const FORMATS = {
  svg: {
    name: 'SVG',
    ext: '.svg',
    mime: 'image/svg+xml',
    bundle: 'core',
    category: 'vector',
  },
  'dxf-standard': {
    name: 'DXF (Standard)',
    ext: '.dxf',
    mime: 'application/dxf',
    bundle: 'dxf',
    category: 'vector',
  },
  'dxf-acad': {
    name: 'DXF (AutoCAD)',
    ext: '.dxf',
    mime: 'application/dxf',
    bundle: 'acad',
    category: 'vector',
  },
  dwg: {
    name: 'DWG',
    ext: '.dwg',
    mime: 'application/acad',
    bundle: 'acad',
    category: 'vector',
  },
  emf: {
    name: 'EMF',
    ext: '.emf',
    mime: 'application/octet-stream',
    bundle: 'core',
    category: 'vector',
  },
  pdf: {
    name: 'PDF',
    ext: '.pdf',
    mime: 'application/pdf',
    bundle: 'core',
    category: 'document',
  },
  html: {
    name: 'HTML',
    ext: '.html',
    mime: 'text/html',
    bundle: 'core',
    category: 'document',
  },
  png: {
    name: 'PNG',
    ext: '.png',
    mime: 'image/png',
    bundle: 'core',
    category: 'image',
  },
  jpeg: {
    name: 'JPEG',
    ext: '.jpg',
    mime: 'image/jpeg',
    bundle: 'core',
    category: 'image',
  },
  webp: {
    name: 'WebP',
    ext: '.webp',
    mime: 'image/webp',
    bundle: 'core',
    category: 'image',
  },
};

export const CATEGORIES = {
  vector: 'Vector Formats',
  document: 'Document Formats',
  image: 'Image Formats',
};
