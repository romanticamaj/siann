// The insert slots (m5b-ui-inserts-master; UI redesign 3.4, 4.2), ported from
// the mockup's markup: a track strip's rack is strip()'s .ins with one .slot
// per plugin_slot in the track's inserts order and the .slot.empty "+" in
// the positions left (mixer/inserts.ts: two positions, or every slot then one
// empty slot, scrolled inside the row by shell.css); the Inspector's Inserts
// section is sec('Inserts', ...) with one .islot per slot and one
// .islot.empty "+ Add insert". Each filled slot shows the plugin's name, and
// carries the elements this feature adds to the mockup's slot: a bypass
// button (plugin.set_bypass, pressed while bypassed), e (plugin.open_editor /
// plugin.close_editor, lit after the editorOpen of the last result) and
// Remove (plugin.remove). In the Inspector the mockup's <em>e</em> stays the
// place of e. A missing plugin shows the engine's code (engine.status
// plugins[]). An empty slot opens the picker for the track; it inserts at
// the end of the chain.
//
// The plan under review adds what 4.2 asks for, app-only rules in shell.css on
// the --ai* tokens: a dashed slot numbered by its step for an insert (at its
// index), a dimmed slot for a removal, a dashed ring on bypass. A click on a
// ghost pins its step.

import { useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';

import { useT } from '../i18n/t';
import type { Entity, PluginSlotEntity, TrackEntity } from '../model/document';
import type { SessionClient } from '../model/session-client';
import { ghostAttrs, type GhostView } from '../plans/ghost-context';
import { slotGhosts, type Ghost, type SlotGhosts } from '../plans/ghosts';
import { useCapabilities } from '../shell/Capable';
import { Icon } from '../shell/icons';
import { buttonsListed, RACK_POSITIONS, slotState, type SlotButtons } from './inserts';
import { useEditorVersion, useEngineStatus, useInsertsHost, type InsertsHost } from './inserts-context';

// The plugin_slot entities of a track's inserts, in its order, with a stable
// identity while none of them changes (entities keep theirs across revisions).
export function useSlots(client: SessionClient, inserts: readonly string[] | undefined): readonly (PluginSlotEntity | undefined)[] {
  const cache = useRef<readonly (Entity | undefined)[]>([]);
  const read = () => {
    const next = (inserts ?? []).map((id) => client.model.select(`plugin_slot:${id}`));
    const last = cache.current;
    if (next.length === last.length && next.every((e, i) => e === last[i])) return last;
    cache.current = next;
    return next;
  };
  return useSyncExternalStore((l) => client.model.subscribe(l), read, read) as readonly (PluginSlotEntity | undefined)[];
}

type Row =
  | { readonly kind: 'slot'; readonly slotId: string; readonly slot: PluginSlotEntity | undefined }
  | { readonly kind: 'ghost'; readonly ghost: Extract<Ghost, { kind: 'insert-add' }> }
  | { readonly kind: 'empty' };

// The slots, with the proposed inserts at their index, then the empty slots:
// two positions in a strip's rack, one empty slot after every slot in the Inspector.
function rows(inserts: readonly string[], slots: readonly (PluginSlotEntity | undefined)[], ghosts: SlotGhosts, positions: number): Row[] {
  const out: Row[] = inserts.map((slotId, i) => ({ kind: 'slot', slotId, slot: slots[i] }));
  for (const ghost of ghosts.add) out.splice(Math.min(ghost.index, out.length), 0, { kind: 'ghost', ghost });
  const empties = out.length >= positions ? 1 : positions - out.length;
  for (let i = 0; i < empties; i += 1) out.push({ kind: 'empty' });
  return out;
}

const activate = (fn: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fn();
  }
};

// The classes of a slot in a strip's rack (lower-zone.css's .slot) and in the
// Inspector (left-zone.css's .islot), as literal tables.
const SLOT_CLASS = { strip: 'slot', inspector: 'islot' } as const;
const BUTTON_CLASS = { strip: 'slot-btn', inspector: 'islot-btn' } as const;
const NAME_CLASS = { strip: 'slot-name', inspector: 'islot-name' } as const;

interface SlotProps {
  readonly variant: 'strip' | 'inspector';
  readonly slotId: string;
  readonly slot: PluginSlotEntity | undefined;
  readonly ghosts: SlotGhosts;
  readonly view: GhostView;
  readonly host: InsertsHost | null;
  readonly buttons: SlotButtons;
}

function FilledSlot({ variant, slotId, slot, ghosts, view, host, buttons }: SlotProps) {
  const t = useT();
  const status = useEngineStatus(host);
  useEditorVersion(host);
  const name = slot?.name ?? slotId;
  const bypass = slot?.bypass === true;
  const open = host?.actions.editorOpen(slotId) ?? false;
  const { state, error } = slotState(status, slotId);
  const missing = state === 'missing';
  const removal = ghosts.remove.find((g) => g.slotId === slotId);
  const ring = ghosts.bypass.find((g) => g.slotId === slotId);
  const base = SLOT_CLASS[variant];
  const btn = BUTTON_CLASS[variant];
  const classes = [SLOT_CLASS[variant], bypass ? 'bypassed' : '', missing ? 'missing' : '', removal ? 'ghost-removed' : ''].filter(Boolean).join(' ');
  const title = error ? `${name} · ${error.code}: ${error.message}` : name;
  const bypassButton = buttons.bypass ? (
    <button
      type="button"
      className={`${BUTTON_CLASS[variant]}${bypass ? ' on' : ''}${ring ? ' ghost' : ''}`}
      data-testid={`${base}-bypass-${slotId}`}
      aria-pressed={bypass}
      aria-label={t('inserts.bypass', { plugin: name })}
      title={t('inserts.bypass', { plugin: name })}
      {...(ring ? ghostAttrs(view, [ring.step]) : {})}
      onClick={() => void host?.actions.setBypass(slotId, !bypass)}
    >
      <Icon name="power" small />
    </button>
  ) : null;
  const edit = buttons.edit ? (
    <button
      type="button"
      className={`${BUTTON_CLASS[variant]} edit${open ? ' on' : ''}`}
      data-testid={`${base}-edit-${slotId}`}
      aria-pressed={open}
      aria-label={t('inserts.edit', { plugin: name })}
      title={t('inserts.edit', { plugin: name })}
      onClick={() => void host?.actions.toggleEditor(slotId)}
    >
      e
    </button>
  ) : null;
  const remove = buttons.remove ? (
    <button
      type="button"
      className={btn}
      data-testid={`${base}-remove-${slotId}`}
      aria-label={t('inserts.remove', { plugin: name })}
      title={t('inserts.remove', { plugin: name })}
      onClick={() => void host?.actions.remove(slotId)}
    >
      <Icon name="x" small />
    </button>
  ) : null;
  const attrs = {
    'data-testid': `${base}-${slotId}`,
    'data-slot-id': slotId,
    'data-state': state,
    ...(removal ? ghostAttrs(view, [removal.step]) : {}),
  };
  if (variant === 'strip') {
    return (
      <div className={classes} {...attrs} title={title}>
        <span className="slot-name">{name}</span>
        {bypassButton}
        {edit}
        {remove}
      </div>
    );
  }
  return (
    <div className={classes} {...attrs} title={title}>
      <span className="islot-name">{name}</span>
      {error ? <span className="islot-state">{error.code}</span> : null}
      <em>{edit}</em>
      {bypassButton}
      {remove}
    </div>
  );
}

function GhostSlot({ variant, ghost, view }: { variant: 'strip' | 'inspector'; ghost: Extract<Ghost, { kind: 'insert-add' }>; view: GhostView }) {
  const base = SLOT_CLASS[variant];
  return (
    <div className={`${SLOT_CLASS[variant]} ghost`} data-testid={`${base}-ghost-${ghost.step}`} {...ghostAttrs(view, [ghost.step])} title={ghost.name} onClick={() => view.pin(ghost.step)}>
      <span className="stepn">{String(ghost.step)}</span>
      <span className={NAME_CLASS[variant]}>{ghost.name}</span>
    </div>
  );
}

// An empty slot; its test id names the track and the position (each is a stop of its own).
function EmptySlot({ variant, id, label, onOpen, children }: { variant: 'strip' | 'inspector'; id: string; label: string; onOpen: () => void; children: ReactNode }) {
  const base = SLOT_CLASS[variant];
  return (
    <div className={`${SLOT_CLASS[variant]} empty`} role="button" tabIndex={0} aria-label={label} data-testid={`${base}-add-${id}`} onClick={onOpen} onKeyDown={activate(onOpen)}>
      {children}
    </div>
  );
}

interface RackProps {
  readonly client: SessionClient;
  readonly track: TrackEntity;
  readonly view: GhostView;
}

// A track strip's insert rack: strip()'s .ins.
export function InsertRack({ client, track, view }: RackProps) {
  const t = useT();
  const can = useCapabilities();
  const host = useInsertsHost();
  const inserts = track.inserts ?? [];
  const slots = useSlots(client, inserts);
  const ghosts = slotGhosts(view.ghosts, track.id);
  const buttons = buttonsListed(can);
  const open = () => void host?.picker.open(track.id);
  return (
    <div className="ins" data-part-of="inserts" role="group" aria-label={t('inserts.rack', { track: track.name })}>
      {rows(inserts, slots, ghosts, RACK_POSITIONS).map((row, i) =>
        row.kind === 'slot' ? (
          <FilledSlot key={row.slotId} variant="strip" slotId={row.slotId} slot={row.slot} ghosts={ghosts} view={view} host={host} buttons={buttons} />
        ) : row.kind === 'ghost' ? (
          <GhostSlot key={`g${row.ghost.step}`} variant="strip" ghost={row.ghost} view={view} />
        ) : (
          <EmptySlot key={`e${i}`} variant="strip" id={`${track.id}-${i}`} label={t('inserts.addTo', { track: track.name })} onOpen={open}>
            +
          </EmptySlot>
        ),
      )}
    </div>
  );
}

// The Inspector's sec('Inserts', ...): its head with the count, every slot, then one empty slot.
export function InspectorInserts({ client, track, view }: RackProps) {
  const t = useT();
  const can = useCapabilities();
  const host = useInsertsHost();
  const inserts = track.inserts ?? [];
  const slots = useSlots(client, inserts);
  const ghosts = slotGhosts(view.ghosts, track.id);
  const buttons = buttonsListed(can);
  const open = () => void host?.picker.open(track.id);
  return (
    <div className="sec" data-part="inspector-inserts">
      <div className="sec-h">
        <Icon name="chev" small />
        {t('inspector.inserts')}
        <span>{String(inserts.length)}</span>
      </div>
      <div className="sec-b">
        {rows(inserts, slots, ghosts, 1).map((row, i) =>
          row.kind === 'slot' ? (
            <FilledSlot key={row.slotId} variant="inspector" slotId={row.slotId} slot={row.slot} ghosts={ghosts} view={view} host={host} buttons={buttons} />
          ) : row.kind === 'ghost' ? (
            <GhostSlot key={`g${row.ghost.step}`} variant="inspector" ghost={row.ghost} view={view} />
          ) : (
            <EmptySlot key={`e${i}`} variant="inspector" id={`${track.id}-${i}`} label={t('inserts.addTo', { track: track.name })} onOpen={open}>
              {`+ ${t('inserts.add')}`}
            </EmptySlot>
          ),
        )}
      </div>
    </div>
  );
}
