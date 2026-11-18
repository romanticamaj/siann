// The shell's half of importing audio (m5b-ui-media; UI redesign UR-5;
// architecture spec, "Frontend"): the file dialog of the Media tab's Import.
// The renderer names the formats engine.capabilities lists
// (features.mediaImport.formats) and the filter's label in its locale; the
// shell takes them only as plain extensions and a short label, and hands back
// absolute paths only. The path of a dropped file is the preload's
// (webUtils.getPathForFile), never the renderer's own. Pure, for the tests.

import * as path from 'node:path';

export const DEFAULT_MEDIA_FORMATS: readonly string[] = Object.freeze(['wav', 'flac']);
const FORMAT_RE = /^[a-z0-9]{1,8}$/;
const MAX_FORMATS = 16;
const MAX_LABEL = 64;

// The renderer's formats, lower case, when every one is a plain extension; the defaults otherwise.
export function mediaFormats(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORMATS) return [...DEFAULT_MEDIA_FORMATS];
  const formats = value.map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : ''));
  return formats.every((format) => FORMAT_RE.test(format)) ? formats : [...DEFAULT_MEDIA_FORMATS];
}

// The renderer's label for the filter, or a neutral one.
export function mediaLabel(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_LABEL ? value : 'Audio';
}

export interface MediaDialogOptions {
  readonly properties: Array<'openFile' | 'multiSelections'>;
  readonly filters: Array<{ name: string; extensions: string[] }>;
}

// Open one or more files of the formats.
export function mediaDialogOptions(formats: readonly string[], label: string): MediaDialogOptions {
  return { properties: ['openFile', 'multiSelections'], filters: [{ name: label, extensions: [...formats] }] };
}

// What the dialog chose: nothing when it was cancelled, absolute paths only.
export function chosenPaths(result: { readonly canceled: boolean; readonly filePaths: readonly string[] }): string[] {
  if (result.canceled) return [];
  return result.filePaths.filter((file) => typeof file === 'string' && file !== '' && path.isAbsolute(file));
}
