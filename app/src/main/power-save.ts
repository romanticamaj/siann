// The shell's power-save blocker while recording (m5b-ui-recording; UI
// redesign 3.5 [E3]: "While recording, the shell holds
// powerSaveBlocker('prevent-app-suspension')"). The renderer tells the main
// process when a recording starts and ends (IPC_RECORDING); the handler holds
// one blocker of that type from the start to the end, and lets it go when
// the window closes or the engine goes away, whatever the renderer said
// last. Repeated news changes nothing. Kept apart from main.ts so a unit test
// can hand it a fake blocker.

export const IPC_RECORDING = 'siann:power:recording';

// The part of Electron's powerSaveBlocker the handler uses.
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export class PowerSaveHandler {
  readonly #blocker: PowerSaveBlockerLike;
  #id: number | null = null;

  constructor(blocker: PowerSaveBlockerLike) {
    this.#blocker = blocker;
  }

  held(): boolean {
    return this.#id !== null && this.#blocker.isStarted(this.#id);
  }

  // The renderer's news: a recording runs (true) or not (false).
  recording(on: boolean): void {
    if (on === true) {
      if (this.held()) return;
      this.#id = this.#blocker.start('prevent-app-suspension');
    } else if (on === false) {
      this.release('renderer');
    }
  }

  // The recording is over: the renderer said so, the window closed or the engine went away.
  release(_why: 'renderer' | 'window' | 'engine'): void {
    if (this.#id === null) return;
    if (this.#blocker.isStarted(this.#id)) this.#blocker.stop(this.#id);
    this.#id = null;
  }
}
