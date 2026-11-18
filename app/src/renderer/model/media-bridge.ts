// The renderer's side of importing audio (m5b-ui-media; UI redesign UR-5,
// 3.0; architecture spec, "Frontend"): the preload bridge's media half (the
// shell's file dialog and a dropped file's path, webUtils.getPathForFile),
// the formats the engine imports (features.mediaImport.formats, only while it
// lists media.import), and the split of a drop into the files it accepts and
// the ones it refuses before any request: by extension, and only with an
// absolute path the bridge gave. A Media tab row drags under the app's own
// type, so a drop tells a row from files. Framework-free.

import { capabilitySelector, type Capabilities } from './capabilities';

// The preload bridge's media half (preload.ts).
export interface MediaBridge {
  choose(request: { formats: readonly string[]; label: string }): Promise<string[]>;
  pathForFile(file: File): string;
}

export interface DroppedFile {
  // The file's base name, for the placeholder and the toasts.
  readonly name: string;
  // Absolute; '' when the bridge gave none.
  readonly path: string;
}

// The drag type of a Media tab row: its data is the media id.
export const MEDIA_ROW_TYPE = 'application/x-siann-media';

// The formats engine.capabilities lists for media.import, lower case.
export function acceptedFormats(capabilities: Capabilities | null): string[] {
  if (!capabilitySelector(capabilities).has('media.import')) return [];
  const feature = capabilities?.features?.mediaImport as { formats?: unknown } | undefined;
  const formats = Array.isArray(feature?.formats) ? feature.formats : [];
  return formats.filter((format): format is string => typeof format === 'string' && format !== '').map((format) => format.toLowerCase());
}

// The last suffix of a base name, lower case ('' for none or a dot file).
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/;

// The files of a drop the engine imports, and the rest, each in drop order.
export function splitDrop(files: readonly DroppedFile[], formats: readonly string[]): { accepted: DroppedFile[]; refused: DroppedFile[] } {
  const accepted: DroppedFile[] = [];
  const refused: DroppedFile[] = [];
  for (const file of files) {
    if (ABSOLUTE.test(file.path) && formats.includes(extensionOf(file.name))) accepted.push(file);
    else refused.push(file);
  }
  return { accepted, refused };
}

// The base name of a path, either separator.
export function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}
