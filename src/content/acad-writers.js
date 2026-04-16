/**
 * Lazy-loaded AutoCAD writers chunk.
 * Pulls in @node-projects/acad-ts at bundle time.
 * Only injected when the user picks "DXF (AutoCAD)" or "DWG".
 */
import { DWGWriter, AcadDXFWriter } from '@node-projects/layout2vector';

if (globalThis.__web2vector) {
  globalThis.__web2vector.writers.DWGWriter = DWGWriter;
  globalThis.__web2vector.writers.AcadDXFWriter = AcadDXFWriter;
}
