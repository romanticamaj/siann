// The input selector's choices (m5b-ui-recording; UI redesign 3.5;
// docs/schemas/protocol-engine-v0.md, "Recording"): a track records from
// {port, channels}, port the first device input channel (0-based) and
// channels 1 or 2, sent with the command track.set_input. The open input
// (engine.status device.input.channels) of N channels offers N mono ports and
// floor(N / 2) stereo pairs on even ports, named as the mockup names its In
// row ("Mono In 1"). Framework-free.

import type { T } from '../i18n/t';

export interface InputPort {
  readonly port: number;
  readonly channels: 1 | 2;
}

// The mono ports in order, then the stereo pairs.
export function inputPorts(open: number): InputPort[] {
  const channels = Number.isFinite(open) && open > 0 ? Math.floor(open) : 0;
  const out: InputPort[] = [];
  for (let port = 0; port < channels; port += 1) out.push({ port, channels: 1 });
  for (let port = 0; port + 1 < channels; port += 2) out.push({ port, channels: 2 });
  return out;
}

// The input fits inside an open input of `open` channels (none fits without one).
export function inputAvailable(input: { readonly port: number; readonly channels: number } | null | undefined, open: number | null): boolean {
  if (!input) return true;
  return open !== null && input.port >= 0 && input.port + input.channels <= open;
}

export function sameInput(a: { readonly port: number; readonly channels: number } | null | undefined, b: { readonly port: number; readonly channels: number } | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.port === b.port && a.channels === b.channels;
}

// A port's name: "Mono In 1", "Stereo In 1/2" (channels counted from 1).
function portName(input: { readonly port: number; readonly channels: number }, t: T): string {
  return input.channels === 2 ? t('input.stereo', { first: String(input.port + 1), second: String(input.port + 2) }) : t('input.mono', { n: String(input.port + 1) });
}

// What the In row shows for a track's input: its name, "No input", or its
// name marked unavailable when the open input does not cover it.
export function inputLabel(input: { readonly port: number; readonly channels: number } | null | undefined, open: number | null, t: T): string {
  if (!input) return t('input.none');
  const name = portName(input, t);
  return inputAvailable(input, open) ? name : t('input.unavailable', { input: name });
}

// The <option> value of a choice, and back ('none' for no input).
export function portKey(input: { readonly port: number; readonly channels: number } | null | undefined): string {
  return input ? `${input.channels === 2 ? 's' : 'm'}${input.port}` : 'none';
}

export function portOfKey(key: string): InputPort | null {
  const match = /^([ms])(\d+)$/.exec(key);
  if (!match) return null;
  return { port: Number(match[2]), channels: match[1] === 's' ? 2 : 1 };
}

// The command of a choice.
export function inputCommand(trackId: string, input: InputPort | null): { op: 'track.set_input'; trackId: string; input: InputPort | null } {
  return { op: 'track.set_input', trackId, input: input ? { port: input.port, channels: input.channels } : null };
}
