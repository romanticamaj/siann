// The transport and undo/redo over the session client (m5-ui-transport; UI
// redesign spec 3.1, 3.2; docs/schemas/protocol-engine-v0.md and
// protocol-events-v1.md): play, stop, start/stop from the realtime playing
// flag, locate to a frame (a decimal string), go to the project start, and
// session.undo / session.redo. None of them is optimistic: the realtime
// playhead and playing flag, and session.changed, show what happened. A
// refusal (no_device, nothing_to_undo, ...) becomes one toast worded by
// i18n/errors.ts, re-worded on a language switch. Framework-free.
//
// bindTransportCommands registers the window-scope key commands of the
// Cubase preset on the registry: the transport keys run only while the
// transport is ready (capable and a device; otherwise they decline and the
// key keeps its default), undo and redo only when the engine lists them.

import { refusalLine } from '../i18n/errors';
import type { Locale } from '../i18n/locale';
import type { CommandRegistry } from '../keys/commands';
import type { SessionClient } from './session-client';

export interface TransportToasts {
  push(text: string, reword?: (locale: Locale) => string): number;
}

export interface TransportControllerOptions {
  readonly client: Pick<SessionClient, 'request'>;
  // The realtime playing flag (RealtimeClient.latest().playing).
  readonly playing: () => boolean;
  readonly toasts: TransportToasts;
  readonly locale: () => Locale;
}

export class TransportController {
  readonly #options: TransportControllerOptions;

  constructor(options: TransportControllerOptions) {
    this.#options = options;
  }

  playing(): boolean {
    return this.#options.playing();
  }

  play(): Promise<void> {
    return this.#send('transport.play', {});
  }

  stop(): Promise<void> {
    return this.#send('transport.stop', {});
  }

  // Space: stop while playing, start while stopped.
  toggle(): Promise<void> {
    return this.playing() ? this.stop() : this.play();
  }

  // frames: a non-negative decimal string.
  locate(frames: string): Promise<void> {
    return this.#send('transport.locate', { frames });
  }

  toStart(): Promise<void> {
    return this.locate('0');
  }

  undo(): Promise<void> {
    return this.#send('session.undo', {});
  }

  redo(): Promise<void> {
    return this.#send('session.redo', {});
  }

  async #send(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.#options.client.request(method, params);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : String(error);
      const known = typeof code === 'string' ? code : null;
      this.#options.toasts.push(refusalLine(known, message, this.#options.locale()), (locale) => refusalLine(known, message, locale));
    }
  }
}

export interface TransportBindings {
  // The transport may run: the engine lists it and a device runs.
  readonly transportReady: () => boolean;
  // The engine lists session.undo and session.redo.
  readonly canUndo: () => boolean;
}

export function bindTransportCommands(commands: CommandRegistry, transport: TransportController, bindings: TransportBindings): () => void {
  const whenReady = (run: () => Promise<void>) => (): boolean => {
    if (!bindings.transportReady()) return false;
    void run();
    return true;
  };
  const whenUndoable = (run: () => Promise<void>) => (): boolean => {
    if (!bindings.canUndo()) return false;
    void run();
    return true;
  };
  const offs = [
    commands.register('window', 'transport.toggle', whenReady(() => transport.toggle())),
    commands.register('window', 'transport.start', whenReady(() => transport.play())),
    commands.register('window', 'transport.stop', whenReady(() => transport.stop())),
    commands.register('window', 'transport.toStart', whenReady(() => transport.toStart())),
    commands.register('window', 'edit.undo', whenUndoable(() => transport.undo())),
    commands.register('window', 'edit.redo', whenUndoable(() => transport.redo())),
  ];
  return () => offs.forEach((off) => off());
}
