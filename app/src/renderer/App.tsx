// The renderer's root component. React renders chrome only; timeline,
// waveform and meter surfaces are imperative canvas classes (ADR-0019
// point 3): the timeline's drawing is a canvas class it mounts, and the
// mixer's meters are one MixerMeters canvas over its strips. Plan review
// (m5-plan-review, m5-ui-plan-panel) is chrome over the PlanStore and
// plan.preview.
//
// The window is the zone shell of m5-ui-shell (UI redesign spec 2): the
// timeline in the project zone, the mixer on the lower zone's MixConsole tab,
// the Plans tab in the right zone, and the selected track in the left zone;
// the audition banner sits under the top bar and the toasts over the zones,
// so both are visible whichever zones are open. A new plan from an agent
// raises a toast (never the focus, never a zone). engine.capabilities, as the
// session client last heard it, decides which controls exist (spec 3.0,
// through Capable). The connection phase (m5-ui-connection) decides the
// shell's disconnected state, and each reconnect clears the clip and plan
// selections. The selected track (m5-ui-arrange) is the track list's: a
// header clicked, or the selected clip's track; the Inspector shows it, and a
// reconnect clears it too. Since m5-ui-edit-basics it is a primary track (the
// Inspector's) and a set: Ctrl-click toggles a header, Shift-click selects a
// range, and M, S and Shift+Delete act on the set; removed tracks leave it.
// The transport bar (m5-ui-transport) sits in the top bar over the
// TransportController; the position display's primary format, a layout
// setting, also words positions in the Plans tab. The locators, cycle and
// metronome (m5-ui-loop-click) are the LoopClickController's: its buttons in
// the transport, its band in the event display's ruler, its keys in the shell.
// Projects (m5b-ui-project): New, Open, the recent list and Save are the
// ProjectController's commands (New, Open and the recent list only with the
// shell's port), the start view covers the zones until a bundle is opened, and
// Studio Setup is a dialog opened by studio.setup or by a transport button
// without a device. Every session epoch (session.opened) drops what the
// window keeps of the old session: the track selection, and the timeline and
// the Plans tab are mounted again, so their clip selection, zoom and plan
// selection start afresh; a reconnect still clears the selections only.
//
// The Meter tab (m5b-ui-meter) is the right zone's second tab: its panel draws
// the master from the MeterStore the mixer draws from, made here once.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { localeStore } from './i18n/t';
import type { CommandRegistry } from './keys/commands';
import type { ConnectionPhaseStore } from './model/connection-phase';
import type { EngineStatusSource } from './model/engine-status';
import type { GestureController } from './model/gesture-controller';
import type { PeaksCache } from './model/peaks-cache';
import type { AgentStore } from './model/agents';
import type { RequestStore } from './model/request-store';
import { capabilitySelector } from './model/capabilities';
import { structuralBlocked } from './model/edit-guard';
import type { PlanStore } from './model/plan-store';
import type { ReviewStore } from './model/review-store';
import type { RealtimeClient } from './model/realtime-client';
import type { SessionClient } from './model/session-client';
import type { LoopClickController } from './model/loop-click';
import type { ProjectController, SavedMark } from './model/project';
import { studioSetupAvailable, type StudioSetupController } from './model/studio-setup';
import { MeterStore } from './model/meter-store';
import type { UndoHistory } from './model/undo-history';
import type { TransportController } from './model/transport';
import { pluginsListed } from './mixer/inserts';
import { InsertsContext, type InsertsHost } from './mixer/inserts-context';
import { Mixer } from './mixer/Mixer';
import { PluginPicker } from './mixer/PluginPicker';
import { announceArrivals } from './plans/arrivals';
import { AuditionBanner } from './plans/AuditionBanner';
import { HearingSwitch } from './plans/HearingSwitch';
import { GhostContext, ReviewContext, useReviewGhosts } from './plans/ghost-context';
import { HeardContext } from './plans/heard-context';
import { PlanPanel } from './plans/PlanPanel';
import { CapabilitiesContext } from './shell/Capable';
import { Counted } from './shell/Counted';
import { Inspector } from './shell/Inspector';
import { createNotepadStore } from './shell/notepad';
import { structuralBlocked } from './model/edit-guard';
import { refusalOf } from './plans/RefusalLine';
import { MeterPanel } from './shell/MeterPanel';
import type { LayoutStore } from './shell/layout-store';
import { Shell } from './shell/Shell';
import { StartView } from './shell/StartView';
import { StudioSetup } from './shell/StudioSetup';
import { TimeFormatContext } from './shell/time-format';
import type { ToastStore } from './shell/toast-store';
import { NO_TRACKS, pruneTracks, selectTrack, type TrackSelectMode, type TrackSelection } from './timeline/selection';
import { Timeline } from './timeline/Timeline';
import { MediaTab, type MediaHost } from './media/MediaTab';
import { bindRecordCommands, monitoredTracks, recordGates } from './model/record';
import { RecordContext, type RecordHost } from './shell/record-context';
import { PendingTakes } from './shell/Recording';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';
import type { MeterTestHooks } from './mixer/MixerMeters';
import { BusSelection } from './mixer/bus-selection';
import { addBusCommand, needsConfirmation, nextBusName, removalSummary, removeBusCommand, type RemovalSummary } from './mixer/bus-commands';
import { busesListed } from './mixer/routing';
import { ConfirmDialog } from './shell/ConfirmDialog';
import { useT } from './i18n/t';
import type { TimelineCommand } from './timeline/commands';

export interface AppProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
  readonly peaks: PeaksCache;
  readonly plans: PlanStore;
  // The agents the engine lists (m5b-ui-plan-metadata: the Plans tab's agent row).
  readonly agents?: AgentStore;
  // The requests to the agent (m5b-ui-composer: the Plans tab's "ask the agent" box).
  readonly requests?: RequestStore;
  // The plan review and its ghosts (m5b-ui-ghosts).
  readonly review: ReviewStore;
  readonly engineStatus: EngineStatusSource;
  readonly layout: LayoutStore;
  readonly commands: CommandRegistry;
  readonly platform: 'mac' | 'other';
  readonly connection: ConnectionPhaseStore;
  readonly toasts: ToastStore;
  readonly transport: TransportController;
  // Locators, cycle and metronome (m5-ui-loop-click).
  readonly loopClick: LoopClickController;
  // What undo and redo can do now (the top bar's undo and redo).
  readonly history: UndoHistory;
  readonly onTimelineHooks?: (hooks: TimelineTestHooks | null) => void;
  readonly onMeterHooks?: (hooks: MeterTestHooks | null) => void;
  // Projects and Studio Setup (m5b-ui-project).
  readonly project: ProjectController;
  readonly saved: SavedMark;
  readonly studioSetup: StudioSetupController;
  // The insert racks' plugin actions, picker and slot states (m5b-ui-inserts-master).
  readonly inserts?: InsertsHost;
  // Importing audio and the Media tab (m5b-ui-media).
  readonly media?: MediaHost | null;
  // Recording (m5b-ui-recording): the record state and its actions.
  readonly record?: RecordHost | null;
  // The selected bus (m5b-ui-sends-buses), shared with the application menu.
  readonly buses?: BusSelection;
}

// The confirmation of a bus removal (m5b-ui-sends-buses): the bus, what goes with it, by name.
function removalMessage(t: ReturnType<typeof useT>, bus: string, summary: RemovalSummary): string {
  const parts = [t('bus.confirmRemove', { bus })];
  if (summary.sends.length > 0) parts.push(t('bus.confirmSends', { names: summary.sends.join(', ') }));
  const routed = [...summary.tracks, ...summary.buses];
  if (routed.length > 0) parts.push(t('bus.confirmRouted', { names: routed.join(', ') }));
  return parts.join(' ');
}

function sendCommand(client: SessionClient, command: TimelineCommand | null): boolean {
  if (!command) return false;
  void client.execute(command.commands, command.expectedRevision).catch(() => undefined);
  return true;
}

export function App({
  client,
  gestures,
  realtime,
  peaks,
  plans,
  agents,
  requests,
  review,
  engineStatus,
  layout,
  commands,
  platform,
  connection,
  toasts,
  transport,
  loopClick,
  history,
  onTimelineHooks,
  onMeterHooks,
  project,
  saved,
  studioSetup,
  inserts,
  media = null,
  record = null,
  buses: givenBuses,
}: AppProps) {
  const t = useT();
  const [ownBuses] = useState(() => new BusSelection());
  const buses = givenBuses ?? ownBuses;
  const capabilities = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().capabilities,
  );
  const phase = useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().phase);
  const reconnects = useSyncExternalStore(connection.subscribe, () => connection.getSnapshot().reconnect?.count ?? 0);
  useEffect(
    () => announceArrivals(plans, toasts, () => localeStore().getSnapshot(), () => capabilitySelector(client.getState().capabilities)),
    [plans, toasts, client],
  );
  // The monitoring tracks' track meters stay live while stopped (m5b-ui-recording).
  const recordRef = useRef(record);
  recordRef.current = record;
  const [meterStore] = useState(
    () =>
      new MeterStore(realtime, {
        monitored: () => monitoredTracks(client.model.getSnapshot()?.tracks ?? [], recordRef.current?.controller.store.getSnapshot()?.armed ?? []),
      }),
  );
  const [tracks, setTracks] = useState<TrackSelection>(NO_TRACKS);
  // The selected clips, sent with a request from the "ask the agent" box (m5b-ui-composer).
  const [clips, setClips] = useState<readonly string[]>([]);
  const selection = useMemo(() => ({ tracks: tracks.ids, clips }), [tracks.ids, clips]);
  const order = () => client.model.getSnapshot()?.trackOrder ?? [];
  // A clip selected selects its track.
  const selectClip = useCallback(
    (clipId: string | null) => {
      if (!clipId) return;
      const clip = client.model.getSnapshot()?.clips.find((c) => c.id === clipId);
      if (clip) setTracks((current) => (current.primary === clip.trackId && current.ids.length === 1 ? current : selectTrack(current, clip.trackId, 'replace', [])));
    },
    [client],
  );
  // Selecting a track clears the bus selection (m5b-ui-sends-buses).
  const onSelectTrack = useCallback(
    (trackId: string, mode: TrackSelectMode) => {
      buses.set(null);
      setTracks((current) => selectTrack(current, trackId, mode, client.model.getSnapshot()?.trackOrder ?? []));
    },
    [client, buses],
  );
  // Removed tracks leave the selection, and a removed bus the bus selection.
  useEffect(
    () =>
      client.model.subscribe(() => {
        setTracks((current) => pruneTracks(current, order()));
        buses.prune(client.model.getSnapshot()?.busOrder ?? []);
      }),
    [client, buses],
  );
  // Add Bus and Remove Bus (m5b-ui-sends-buses; UI redesign 3.6; 10.11, 24):
  // one bus.add named "Bus N"; one bus.remove of the selected bus, after a
  // confirmation naming what goes with it when anything does.
  const [removing, setRemoving] = useState<{ readonly busId: string; readonly message: string } | null>(null);
  useEffect(() => {
    const can = () => capabilitySelector(client.getState().capabilities);
    const offAdd = commands.register('window', 'mixer.bus.add', () => {
      const snapshot = client.model.getSnapshot();
      if (!snapshot || !busesListed(can()) || !can().command('bus.add') || structuralBlocked(plans.getSnapshot().heard)) return false;
      return sendCommand(client, addBusCommand(snapshot, nextBusName(snapshot, (n) => t('bus.default', { n }))));
    });
    const offRemove = commands.register('window', 'mixer.bus.remove', () => {
      const snapshot = client.model.getSnapshot();
      const busId = buses.getSnapshot();
      if (!snapshot || busId === null || !busesListed(can()) || !can().command('bus.remove') || structuralBlocked(plans.getSnapshot().heard)) return false;
      const bus = snapshot.entities[`bus:${busId}`] as { name?: string } | undefined;
      if (!bus) return false;
      const summary = removalSummary(busId, snapshot);
      if (needsConfirmation(summary)) {
        setRemoving({ busId, message: removalMessage(t, bus.name ?? '', summary) });
        return true;
      }
      return sendCommand(client, removeBusCommand(snapshot, busId));
    });
    return () => {
      offAdd();
      offRemove();
    };
  }, [commands, client, buses, plans, t]);
  const epoch = useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState().epoch,
  );
  useEffect(() => {
    setTracks(NO_TRACKS);
    buses.set(null);
  }, [reconnects, epoch, buses]);
  // Projects: the key commands and menu items, and the start view.
  useEffect(() => project.bind(commands, () => capabilitySelector(client.getState().capabilities)), [project, commands, client]);
  const startView = useSyncExternalStore(project.subscribe, () => project.getSnapshot().shell && project.getSnapshot().startView);
  // Studio Setup: studio.setup, and the transport's buttons without a device.
  const [setupOpen, setSetupOpen] = useState(false);
  const openSetup = useCallback(() => setSetupOpen(true), []);
  const closeSetup = useCallback(() => setSetupOpen(false), []);
  const setupAvailable = studioSetupAvailable(capabilitySelector(capabilities));
  useEffect(
    () =>
      commands.register('window', 'studio.setup', () => {
        if (!studioSetupAvailable(capabilitySelector(client.getState().capabilities))) return false;
        setSetupOpen(true);
        return true;
      }),
    [commands, client],
  );
  const sessionRate = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot()?.root?.sampleRate ?? null,
  );
  // A reconnect clears the plan review's selection, its ticks and its pin (spec 4.5 C8),
  // and so does a session epoch: the plans are another session's.
  const seenSession = useRef({ reconnects, epoch });
  useEffect(() => {
    const seen = seenSession.current;
    if (reconnects === seen.reconnects && epoch === seen.epoch) return;
    seenSession.current = { reconnects, epoch };
    review.reset();
  }, [review, reconnects, epoch]);
  const ghosts = useReviewGhosts(review);
  // The side heard, for the edit guard of the zones (m5b-ui-audition).
  const heard = useSyncExternalStore((listener) => plans.subscribe(listener), () => plans.getSnapshot().heard);
  const locate = useCallback((frames: string) => void transport.locate(frames), [transport]);
  const timeFormat = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().layout.timeFormat);
  const racks = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().layout.racks);
  // The Notepad (m5b-ui-notepad): its drafts live as long as the window, its
  // commits go through the edit guard, and whether it is open is kept in
  // siann.layout.v1.
  const notepadOpen = useSyncExternalStore(layout.subscribe, () => layout.getSnapshot().layout.inspector.notepad);
  const toggleNotepad = useCallback(() => layout.dispatch({ type: 'section', section: 'notepad' }), [layout]);
  const notepad = useMemo(
    () =>
      createNotepadStore({
        model: client.model,
        execute: (commands, revision) => client.execute(commands, revision),
        blocked: () => structuralBlocked(plans.getSnapshot().heard),
        refusal: refusalOf,
      }),
    [client, plans],
  );
  useEffect(() => () => notepad.dispose(), [notepad]);
  const openMedia = useCallback(() => void commands.run('window', 'media.open'), [commands]);
  const trackName = useCallback((id: string) => (client.model.select(`track:${id}`) as { name?: string } | undefined)?.name ?? id, [client]);
  const busName = useCallback((id: string) => (client.model.select(`bus:${id}`) as { name?: string } | undefined)?.name ?? id, [client]);
  // R arms the selected track; Num * and Ctrl+Shift+R record (m5b-ui-recording).
  const selectedRef = useRef(tracks.primary);
  selectedRef.current = tracks.primary;
  useEffect(() => (record ? bindRecordCommands(commands, record.controller, { selectedTrack: () => selectedRef.current }) : undefined), [record, commands]);
  const can = capabilitySelector(capabilities);
  const recoverable = record !== null && recordGates(can).record && can.has('record.recover_take');
  return (
    <CapabilitiesContext.Provider value={capabilities}>
     <RecordContext.Provider value={record}>
     <InsertsContext.Provider value={inserts ?? null}>
      <TimeFormatContext.Provider value={timeFormat}>
       <ReviewContext.Provider value={review}>
        <GhostContext.Provider value={ghosts}>
        <HeardContext.Provider value={heard}>
        <Shell
          client={client}
          plans={plans}
          review={review}
          engineStatus={engineStatus}
          store={layout}
          commands={commands}
          platform={platform}
          banner={<AuditionBanner client={client} plans={plans} />}
          phase={phase}
          toasts={toasts}
          realtime={realtime}
          transport={transport}
          loopClick={loopClick}
          history={history}
          left={<Inspector client={client} gestures={gestures} trackId={tracks.primary} plans={plans} notepad={notepad} notepadOpen={notepadOpen} onNotepadToggle={toggleNotepad} />}
          project={
            <Counted id="timeline">
              <Timeline
                key={epoch}
                client={client}
                peaks={peaks}
                commands={commands}
                layout={layout}
                realtime={realtime}
                selectedTrackId={tracks.primary}
                selectedTrackIds={tracks.ids}
                onSelectTrack={onSelectTrack}
                platform={platform}
                onSelect={selectClip}
                onSelectClips={setClips}
                onHooks={onTimelineHooks}
                onLocate={locate}
                loopClick={loopClick}
                reconnects={reconnects}
                review={review}
                toasts={toasts}
                media={media}
                onOpenMedia={openMedia}
              />
            </Counted>
          }
          lower={
            <Counted id="mixer">
              <Mixer client={client} gestures={gestures} realtime={realtime} selectedTrackId={tracks.primary} onMeterHooks={onMeterHooks} racks={racks} meterStore={meterStore} busSelection={buses} />
            </Counted>
          }
          right={<PlanPanel key={epoch} client={client} plans={plans} agents={agents} requests={requests} selection={selection} review={review} reconnects={reconnects} commands={commands} />}
          rightMedia={<MediaTab key={epoch} client={client} media={media} />}
          rightMeter={<MeterPanel client={client} realtime={realtime} store={meterStore} />}
          rightHead={<HearingSwitch client={client} plans={plans} />}
          startView={startView ? <StartView project={project} /> : null}
          studioSetup={<StudioSetup open={setupOpen} controller={studioSetup} engineStatus={engineStatus} sessionRate={sessionRate} onClose={closeSetup} />}
          saved={saved}
          onStudioSetup={setupAvailable ? openSetup : undefined}
        />
        {inserts && pluginsListed(capabilitySelector(capabilities)) ? <PluginPicker picker={inserts.picker} trackName={trackName} busName={busName} /> : null}
        {removing ? (
          <ConfirmDialog
            open
            message={removing.message}
            confirmLabel={t('confirm.remove')}
            cancelLabel={t('confirm.cancel')}
            onConfirm={() => {
              const snapshot = client.model.getSnapshot();
              if (snapshot) sendCommand(client, removeBusCommand(snapshot, removing.busId));
              setRemoving(null);
            }}
            onCancel={() => setRemoving(null)}
          />
        ) : null}
        {recoverable ? <PendingTakes controller={record.controller} client={client} /> : null}
        </HeardContext.Provider>
        </GhostContext.Provider>
       </ReviewContext.Provider>
      </TimeFormatContext.Provider>
     </InsertsContext.Provider>
     </RecordContext.Provider>
    </CapabilitiesContext.Provider>
  );
}
