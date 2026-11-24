// The output selector (m5b-ui-sends-buses; UI redesign 3.4; 10.11, 25): the
// Routing rack of a strip and the Inspector's Out row.
//
// - RoutingRack: the strip's rack row with the Routing switch lit, strip()'s
//   .ins holding one .slot: the name of the bus the track or bus outputs to,
//   or the master's, with a native <select> over it, invisible, so a press on
//   the slot opens the list (the master, then the buses in busOrder; on a bus
//   strip the other buses). A choice sends one track.set_output or
//   bus.set_output. The second position of the row is an empty box, unless
//   the engine refused the last choice: then it holds the refusal line (the
//   error's code and its catalog text, e.g. routing_cycle for a bus routed
//   into a loop), and the selector keeps its committed value.
// - OutputRow: sec('Routing')'s second .irow, the label Out and the .pick
//   with the name and ic('chev','s'), the same selector over it, for the
//   selected track.
//
// The edit guard (4.5 C5): while a proposal is heard both are disabled with
// the reason; they commit onto main. The select is controlled by what the
// engine committed: a refused choice snaps back.

import { useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { useLocale, useT } from '../i18n/t';
import type { SessionClient } from '../model/session-client';
import { useEditGuard } from '../plans/heard-context';
import { Icon } from '../shell/icons';
import { useCapabilities } from '../shell/Capable';
import type { TimelineCommand } from '../timeline/commands';
import { busOutputCommand, trackOutputCommand } from './bus-commands';
import { outputChoices, outputOf, type OutputOwner } from './routing';

function useSnapshot(client: SessionClient) {
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );
}

// Sends the command; resolves with the refusal's code and message, or null.
async function sendCommand(client: SessionClient, command: TimelineCommand | null): Promise<{ code: string; message: string } | null> {
  if (!command) return null;
  try {
    await client.execute(command.commands, command.expectedRevision);
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : 'internal_error', message: error instanceof Error ? error.message : String(error) };
  }
}

interface SelectorState {
  readonly value: string;
  readonly current: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly name: string }>;
  readonly choose: (value: string) => void;
  readonly refusal: string | null;
  readonly guard: string | null;
}

// What both presentations share: the choices, the committed value and the change.
function useOutput(client: SessionClient, owner: OutputOwner): SelectorState {
  const t = useT();
  const locale = useLocale();
  const guard = useEditGuard();
  const snapshot = useSnapshot(client);
  const [refused, setRefused] = useState<{ code: string; message: string } | null>(null);
  const master = t('routing.master');
  const choices = snapshot ? outputChoices(snapshot, owner) : [];
  const busId = snapshot ? outputOf(snapshot, owner) : null;
  const options = choices.map((c) => ({ value: c.busId ?? '', name: c.name ?? master }));
  const current = options.find((o) => o.value === (busId ?? ''))?.name ?? master;
  const choose = (value: string) => {
    const now = client.model.getSnapshot();
    if (!now || guard !== null) return;
    const target = value === '' ? null : value;
    const command = owner.kind === 'track' ? trackOutputCommand(now, owner.id, target) : busOutputCommand(now, owner.id, target);
    setRefused(null);
    void sendCommand(client, command).then((refusal) => setRefused(refusal));
  };
  return { value: busId ?? '', current, options, choose, refusal: refused ? refusalLine(refused.code, refused.message, locale) : null, guard };
}

function Options({ options }: { options: SelectorState['options'] }) {
  return (
    <>
      {options.map((o) => (
        <option key={o.value || 'master'} value={o.value}>
          {o.name}
        </option>
      ))}
    </>
  );
}

// A strip's Routing rack: one .slot, the output selector, and the refusal line
// in the second position. prefix goes before its test ids (the Channel zone's
// strip: 'channel-'; m5b-ui-editor-channel).
export function RoutingRack({ client, owner, name, prefix = '' }: { client: SessionClient; owner: OutputOwner; name: string; prefix?: string }) {
  const t = useT();
  const output = useOutput(client, owner);
  return (
    <div className="ins" role="group" aria-label={t('routing.rack', { owner: name })}>
      <div className="slot" title={output.guard ?? output.current}>
        <span className="slot-name">{output.current}</span>
        <select
          className="slot-select"
          data-testid={`${prefix}output-${owner.id}`}
          aria-label={t('routing.select', { owner: name })}
          value={output.value}
          disabled={output.guard !== null}
          onChange={(event) => output.choose(event.currentTarget.value)}
        >
          <Options options={output.options} />
        </select>
      </div>
      {output.refusal !== null ? (
        <div className="rack-refusal" role="alert" data-testid={`${prefix}output-refusal-${owner.id}`} title={output.refusal}>
          {output.refusal}
        </div>
      ) : null}
    </div>
  );
}

// The Inspector's Out row: sec('Routing')'s second .irow, for the selected track.
export function OutputRow({ client, trackId, name }: { client: SessionClient; trackId: string; name: string }) {
  const t = useT();
  const can = useCapabilities();
  const output = useOutput(client, { kind: 'track', id: trackId });
  return (
    <div className="irow" data-testid="inspector-out-row">
      <span>{t('routing.out')}</span>
      <span className="pick">
        <span className="pick-name" data-testid="inspector-output-name">
          {output.current}
        </span>
        <Icon name="chev" small />
        <select
          className="pick-select"
          data-testid="inspector-output"
          aria-label={t('routing.select', { owner: name })}
          value={output.value}
          disabled={output.guard !== null || !can.command('track.set_output')}
          title={output.guard ?? output.refusal ?? undefined}
          onChange={(event) => output.choose(event.currentTarget.value)}
        >
          <Options options={output.options} />
        </select>
      </span>
    </div>
  );
}
