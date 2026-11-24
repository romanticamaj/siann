// The lower zone's Editor tab (m5b-ui-editor-channel; UI redesign 2.1, 5.2,
// UR-18). The mockup draws the tab's label only; the body is built from the
// shared rules and existing tokens, laid out by shell.css:
//
//   p.editor-empty            with no clip selected: the catalog's line, and
//                             nothing else (no placeholder control)
//   div.editor                with one: the sample editor's container
//     canvas.editor-content   the content layer (SampleEditorCanvas.ts)
//     canvas.editor-overlay   the overlay, on top, which takes the pointer
//
// The clip is the app's selectedClipId (the primary one, the info line's).
// While the tab is shown H and G (view.zoomIn / view.zoomOut in the lower
// zone's scope) zoom the editor about its range's centre; on the MixConsole
// tab the tab is not mounted and they decline. Every command the editor sends
// goes through the capability rule and the edit guard.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { PeaksCache } from '../model/peaks-cache';
import type { SessionClient } from '../model/session-client';
import { useHeard } from '../plans/heard-context';
import { useCapabilities } from '../shell/Capable';
import type { LayoutStore } from '../shell/layout-store';
import { editorAllows, editorClip } from './editor-model';
import { SampleEditorCanvas, type EditorTestHooks } from './SampleEditorCanvas';

export interface EditorTabProps {
  readonly client: Pick<SessionClient, 'model' | 'execute'>;
  readonly peaks: Pick<PeaksCache, 'get' | 'subscribe'>;
  // The app's selected (primary) clip.
  readonly clipId: string | null;
  // The event display's snap settings live here.
  readonly layout: LayoutStore;
  readonly commands: CommandRegistry;
  readonly platform: 'mac' | 'other';
  // Test-only (SIANN_SHELL_TEST=1): the editor's hooks once it is mounted.
  readonly onHooks?: (hooks: EditorTestHooks | null) => void;
}

export function EditorTab({ client, peaks, clipId, layout, commands, platform, onHooks }: EditorTabProps) {
  const t = useT();
  const can = useCapabilities();
  const heard = useHeard();
  const allowsRef = useRef(editorAllows((op) => can.command(op), heard));
  allowsRef.current = editorAllows((op) => can.command(op), heard);
  const shown = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => editorClip(client.model.getSnapshot(), clipId)?.clip.id ?? null,
    () => editorClip(client.model.getSnapshot(), clipId)?.clip.id ?? null,
  );
  const container = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLCanvasElement | null>(null);
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const [editor, setEditor] = useState<SampleEditorCanvas | null>(null);
  const present = shown !== null;

  useEffect(() => {
    if (!present || !container.current || !content.current || !overlay.current) return undefined;
    const surface = new SampleEditorCanvas({
      content: content.current,
      overlay: overlay.current,
      container: container.current,
      model: client.model,
      peaks,
      execute: (commandList, expectedRevision) => client.execute(commandList, expectedRevision),
      allows: (op) => allowsRef.current(op),
      snap: () => layout.getSnapshot().layout.snap,
      platform,
    });
    setEditor(surface);
    onHooks?.(surface.testHooks());
    return () => {
      onHooks?.(null);
      surface.destroy();
      setEditor(null);
    };
  }, [present, client, peaks, layout, platform, onHooks]);

  useEffect(() => {
    editor?.setClip(shown);
  }, [editor, shown]);

  // H and G while the lower zone has the focus and this tab is shown.
  useEffect(() => {
    if (!editor) return undefined;
    const offs = [commands.register('lower', 'view.zoomIn', () => editor.zoomIn()), commands.register('lower', 'view.zoomOut', () => editor.zoomOut())];
    return () => offs.forEach((off) => off());
  }, [editor, commands]);

  if (!present) {
    return (
      <p className="editor-empty" data-testid="editor-empty">
        {t('editor.none')}
      </p>
    );
  }
  return (
    <div className="editor" data-testid="editor" data-clip={shown} role="group" aria-label={t('editor.label')} ref={container}>
      <canvas className="editor-content" ref={content} aria-hidden="true" />
      <canvas className="editor-overlay" data-testid="editor-canvas" ref={overlay} aria-hidden="true" />
    </div>
  );
}
