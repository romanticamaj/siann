// The right zone's Media tab (m5b-ui-media; UI redesign UR-5, 3.0, 10.8, 1):
// Cubase's Pool as a tab, which replaced the Pool window of
// m5-ui-port-toolbar. It lists the session's media by name (the media id when
// there is none) with length, channels, sample rate (the session's: the
// engine converts at import) and use count (the document's clips that play
// it), filtered by a search field. Import opens the shell's file dialog
// (only with the preload bridge) and imports each file chosen; a row drags to
// the event display (the app's drag type, MEDIA_ROW_TYPE) to place a clip,
// only with clip.place and the drop target; a double-click on a name renames
// it (media.rename) where the engine lists that command; Remove
// (media.remove) is enabled only for media no clip uses and says why
// otherwise. On an engine without media.import nothing of it is in the DOM
// (Shell keeps the tab's box empty). While a proposal is heard the edit
// guard (model/edit-guard.ts; UI redesign 4.5 C5) holds Import, the drag, the
// rename and Remove, each disabled with the guard's reason; the search and
// the list stay. The mockup draws the tab but not its
// content, so the content's rules are shell.css's, from existing tokens.

import { useContext, useMemo, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent } from 'react';

import { formatSeconds } from '../format';
import type { Locale } from '../i18n/locale';
import { refusalLine } from '../i18n/errors';
import { localeStore, useT, type T } from '../i18n/t';
import type { MediaEntity } from '../model/document';
import { acceptedFormats, MEDIA_ROW_TYPE, type MediaBridge } from '../model/media-bridge';
import type { ImportClient, ImportToasts, MediaImporter, Placeholder } from '../model/media-import';
import type { Snapshot } from '../model/read-model';
import { useEditGuard } from '../plans/heard-context';
import { CapabilitiesContext, useCapabilities } from '../shell/Capable';
import type { TimelineCommand } from '../timeline/commands';

// What the window gives the Media tab and the event display: the preload
// bridge (null in a plain browser tab), the importer and the toasts.
export interface MediaHost {
  readonly bridge: MediaBridge | null;
  readonly importer: MediaImporter;
  readonly toasts: ImportToasts;
}

export interface MediaRow {
  readonly id: string;
  // The media's name, or its id when it has none.
  readonly name: string;
  readonly frames: string;
  readonly channels: number;
  readonly sampleRate: number;
  // The clips of the document that play it.
  readonly uses: number;
}

// The rows, in the document's media order, whose name or id holds the query (any case).
export function mediaRows(snapshot: Snapshot | null, query: string): MediaRow[] {
  if (!snapshot) return [];
  const uses = new Map<string, number>();
  for (const clip of snapshot.clips) uses.set(clip.mediaId, (uses.get(clip.mediaId) ?? 0) + 1);
  const wanted = query.trim().toLowerCase();
  return snapshot.media
    .map((media) => ({
      id: media.id,
      name: media.name ? media.name : media.id,
      frames: media.frames,
      channels: media.channels,
      sampleRate: media.sampleRate,
      uses: uses.get(media.id) ?? 0,
    }))
    .filter((row) => wanted === '' || row.name.toLowerCase().includes(wanted) || row.id.toLowerCase().includes(wanted));
}

// media.rename with the trimmed name; nothing for an empty or unchanged one.
export function renameMediaCommand(snapshot: Snapshot | null, mediaId: string, name: string): TimelineCommand | null {
  const media = snapshot?.entities[`media:${mediaId}`] as MediaEntity | undefined;
  const next = name.trim();
  if (!snapshot || !media || next === '' || next === media.name) return null;
  return { expectedRevision: snapshot.revision, commands: [{ op: 'media.rename', mediaId, name: next }] };
}

// media.remove for media no clip plays; nothing otherwise.
export function removeMediaCommand(snapshot: Snapshot | null, mediaId: string): TimelineCommand | null {
  if (!snapshot || !snapshot.entities[`media:${mediaId}`]) return null;
  if (snapshot.clips.some((clip) => clip.mediaId === mediaId)) return null;
  return { expectedRevision: snapshot.revision, commands: [{ op: 'media.remove', mediaId }] };
}

// Rename and Remove through command.execute; a refusal is a toast.
export class MediaActions {
  readonly #options: { client: Pick<ImportClient, 'execute' | 'model'>; toasts: ImportToasts; locale: () => Locale };

  constructor(options: { client: Pick<ImportClient, 'execute' | 'model'>; toasts: ImportToasts; locale: () => Locale }) {
    this.#options = options;
  }

  rename(mediaId: string, name: string): Promise<void> {
    return this.#send(renameMediaCommand(this.#options.client.model.getSnapshot(), mediaId, name));
  }

  remove(mediaId: string): Promise<void> {
    return this.#send(removeMediaCommand(this.#options.client.model.getSnapshot(), mediaId));
  }

  async #send(command: TimelineCommand | null): Promise<void> {
    if (!command) return;
    try {
      await this.#options.client.execute(command.commands, command.expectedRevision);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const message = error instanceof Error ? error.message : '';
      const text = (locale: Locale) => refusalLine(typeof code === 'string' ? code : null, message, locale);
      this.#options.toasts.push(text(this.#options.locale()), text);
    }
  }
}

const rateOf = (rate: number) => String(Number((rate / 1000).toFixed(1)));

export interface MediaTabViewProps {
  readonly rows: readonly MediaRow[];
  // How many media the session holds (the empty line says why the list is empty).
  readonly total: number;
  readonly query: string;
  readonly importing: readonly Placeholder[];
  readonly can: { readonly rename: boolean; readonly remove: boolean; readonly place: boolean };
  readonly canImport: boolean;
  // The media whose name is being edited.
  readonly renaming: string | null;
  // The edit guard's reason while a proposal is heard (every edit held), null otherwise.
  readonly guard: string | null;
  readonly t: T;
  readonly onQuery: (query: string) => void;
  readonly onImport: () => void;
  readonly onStartRename: (mediaId: string) => void;
  readonly onRename: (mediaId: string, name: string) => void;
  readonly onCancelRename: () => void;
  readonly onRemove: (mediaId: string) => void;
  readonly onDragStart: (mediaId: string, event: DragEvent<HTMLElement>) => void;
}

// The tab's content, without effects.
export function MediaTabView({ rows, total, query, importing, can: allowed, canImport, renaming: editing, guard, t, onQuery, onImport, onStartRename, onRename, onCancelRename, onRemove, onDragStart }: MediaTabViewProps) {
  const held = guard !== null;
  const can = { rename: allowed.rename, remove: allowed.remove, place: allowed.place && !held };
  const renaming = held ? null : editing;
  const channels = (count: number) => (count === 1 ? t('media.mono') : count === 2 ? t('media.stereo') : t('media.channels', { count }));
  return (
    <div className="media-tab" data-testid="media-tab" aria-label={t('media.label')}>
      <div className="media-bar">
        <input
          type="search"
          className="media-search"
          data-testid="media-search"
          aria-label={t('media.search')}
          placeholder={t('media.search')}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {canImport ? (
          <button type="button" className="media-import" data-testid="media-import" disabled={held} title={guard ?? t('media.importTitle')} onClick={() => (held ? undefined : onImport())}>
            {t('media.import')}
          </button>
        ) : null}
      </div>
      <div className="media-scroll">
        <table className="media-list" data-testid="media-list">
          <thead>
            <tr>
              <th>{t('media.colName')}</th>
              <th className="num">{t('media.colLength')}</th>
              <th>{t('media.colChannels')}</th>
              <th className="num">{t('media.colRate')}</th>
              <th className="num">{t('media.colUses')}</th>
              {can.remove ? <th aria-hidden="true" /> : null}
            </tr>
          </thead>
          <tbody>
            {importing.map((file) => (
              <tr key={file.key} className="media-importing" data-testid={`media-importing-${file.key}`}>
                <td colSpan={can.remove ? 6 : 5} dir="auto">
                  {file.progress === null ? t('media.importingStart', { name: file.name }) : t('media.importing', { name: file.name, percent: Math.round(file.progress * 100) })}
                </td>
              </tr>
            ))}
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid={`media-row-${row.id}`}
                draggable={can.place ? true : undefined}
                onDragStart={can.place ? (event: DragEvent<HTMLElement>) => onDragStart(row.id, event) : undefined}
              >
                <td className="media-name" data-testid={`media-name-${row.id}`} dir="auto" title={row.name} onDoubleClick={can.rename && !held ? () => onStartRename(row.id) : undefined}>
                  {renaming === row.id ? (
                    <input
                      type="text"
                      className="media-rename"
                      data-testid="media-rename-input"
                      aria-label={t('media.rename', { name: row.name })}
                      defaultValue={row.name}
                      autoFocus
                      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          onRename(row.id, event.currentTarget.value);
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          onCancelRename();
                        }
                      }}
                      onBlur={() => onCancelRename()}
                    />
                  ) : (
                    row.name
                  )}
                </td>
                <td className="num">{t('media.length', { value: row.sampleRate > 0 ? formatSeconds(Number(row.frames) / row.sampleRate) : '?' })}</td>
                <td>{channels(row.channels)}</td>
                <td className="num">{t('media.rate', { value: rateOf(row.sampleRate) })}</td>
                <td className="num">{String(row.uses)}</td>
                {can.remove ? (
                  <td>
                    <button
                      type="button"
                      className="media-remove"
                      data-testid={`media-remove-${row.id}`}
                      disabled={held || row.uses > 0}
                      title={guard ?? (row.uses > 0 ? t('media.inUse', { count: row.uses }) : undefined)}
                      onClick={() => (held ? undefined : onRemove(row.id))}
                    >
                      {t('media.remove')}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && importing.length === 0 ? <p className="media-empty">{total === 0 ? t('media.empty') : t('media.noMatch')}</p> : null}
      </div>
    </div>
  );
}

export interface MediaTabProps {
  readonly client: Pick<ImportClient, 'execute' | 'model'>;
  // null in a plain browser tab before the importer exists.
  readonly media: MediaHost | null;
}

const NO_IMPORTS: readonly Placeholder[] = Object.freeze([]);
const noImports = () => NO_IMPORTS;
const noSubscribe = () => () => undefined;

export function MediaTab({ client, media }: MediaTabProps) {
  const t = useT();
  const can = useCapabilities();
  const guard = useEditGuard();
  const capabilities = useContext(CapabilitiesContext);
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
  const importer = media?.importer;
  const importing = useSyncExternalStore(importer ? importer.subscribe : noSubscribe, importer ? importer.getSnapshot : noImports, importer ? importer.getSnapshot : noImports);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const actions = useMemo(
    () => new MediaActions({ client, toasts: media?.toasts ?? { push: () => 0 }, locale: () => localeStore().getSnapshot() }),
    [client, media],
  );
  if (!can.has('media.import')) return null;
  const bridge = media?.bridge ?? null;
  const rows = mediaRows(snapshot, query);
  return (
    <MediaTabView
      rows={rows}
      total={snapshot?.media.length ?? 0}
      query={query}
      importing={importing}
      can={{ rename: can.command('media.rename'), remove: can.command('media.remove'), place: can.command('clip.place') && bridge !== null }}
      canImport={bridge !== null && importer !== undefined}
      renaming={renaming}
      guard={guard}
      t={t}
      onQuery={setQuery}
      onImport={() => {
        if (!bridge || !importer) return;
        void bridge.choose({ formats: acceptedFormats(capabilities), label: t('media.formats') }).then((paths) => (paths.length > 0 ? importer.importFiles(paths) : undefined));
      }}
      onStartRename={setRenaming}
      onRename={(mediaId, name) => {
        setRenaming(null);
        void actions.rename(mediaId, name);
      }}
      onCancelRename={() => setRenaming(null)}
      onRemove={(mediaId) => void actions.remove(mediaId)}
      onDragStart={(mediaId, event) => {
        event.dataTransfer?.setData(MEDIA_ROW_TYPE, mediaId);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      }}
    />
  );
}
