// The English catalog (UI redesign spec 6.2). It defines the key set: the
// other catalogs are typed `Catalog`, so tsc refuses one with a missing or an
// extra key. A message is a string with {named} placeholders, or a function
// where grammar needs one (plurals). Text an agent or the user wrote (track
// names, plan notes, branch names, ids) never goes through a catalog.
//
// P1-0 keeps today's English wording exactly; the redesign's wording arrives
// with the tickets that change each surface.

import { plural } from './intl';

export const en = {
  'app.title': 'SIANN',
  'locale.label': 'Language',

  // The status panel.
  'status.engine': 'Engine',
  'status.session': 'Session',
  'status.revision': 'Revision',
  'status.tracks': 'Tracks',
  'status.clips': 'Clips',
  'status.syncs': 'Syncs',
  'status.connections': 'Connections',
  'connection.connecting': 'connecting',
  'connection.connected': 'connected',
  'connection.disconnected': 'disconnected',
  'about.unknownCommit': 'unknown',
  'about.source': 'source: {url}',

  // Timeline.
  'timeline.mediaPool': 'Media pool',
  'timeline.deleteClip': 'Delete clip',
  'timeline.selected': 'Selected',
  'timeline.lastError': 'Last error',
  // The ruler's labels; {value} is a locale-free number of seconds.
  'timeline.seconds': '{value}s',

  // Mixer.
  'mixer.label': 'Mixer',
  'strip.gain': 'Gain',
  'strip.pan': 'Pan',
  'strip.gainLabel': '{track} gain',
  'strip.panLabel': '{track} pan',

  // Plan review.
  'plans.label': 'Plan review',
  'plans.title': 'Plans',
  'plans.heard': 'heard:',
  'plans.heardMark': '(heard)',
  'plans.steps': ({ count }: { count: number }): string =>
    plural('en', count, { one: `${count} step`, other: `${count} steps` }),
  'plans.partOf': '(part of {plan})',
  'plans.note': 'Note',
  'plans.approve': 'Approve',
  'plans.approveSelected': 'Approve selected',
  'plans.reject': 'Reject',
  'plans.apply': 'Apply',
  'plans.audition': 'Audition',
  'plans.hearMain': 'Hear main',
  'plans.hearProposal': 'Hear proposal',
  'plans.merge': 'Merge',
  'plans.discard': 'Discard',
  'plans.applied': 'applied',
  'plans.appliedAt': 'applied at {revision}',
  'plans.rolledBack': 'rolled back',
  'plans.rolledBackAt': 'rolled back (applied at {revision})',
  'planState.draft': 'draft',
  'planState.validated': 'validated',
  'planState.approved': 'approved',
  'planState.rejected': 'rejected',
  'planState.applied': 'applied',
  'planState.rolled_back': 'rolled_back',

  // The plan's diff.
  'diff.entity': 'Entity',
  'diff.change': 'Change',
  'diff.fields': 'Fields',
  'diff.before': 'Before',
  'diff.after': 'After',
  'diff.stale': 'Stale',
  'diff.kind.added': 'added',
  'diff.kind.removed': 'removed',
  'diff.kind.modified': 'modified',
  'diff.kind.unchanged': 'unchanged',
  'diff.staleMark': 'stale ({change})',

  // Plan step descriptions (plans/describe.ts). {track} and {name} are the
  // session's names, {gain} a formatted dB value, {pan} the step's value.
  'step.addTrack': 'Add track {name}',
  'step.removeTrack': 'Remove track {track}',
  'step.renameTrack': 'Rename {track} to {name}',
  'step.setGain': 'Set gain of {track} to {gain}',
  'step.setPan': 'Set pan of {track} to {pan}',
  'step.mute': 'Mute {track}',
  'step.unmute': 'Unmute {track}',
  'step.solo': 'Solo {track}',
  'step.unsolo': 'Unsolo {track}',

  // Toasts (the surface arrives with P1-5 and P1-6).
  'toast.planArrived': ({ steps }: { steps: number }): string =>
    plural('en', steps, { one: `A plan with ${steps} step arrived`, other: `A plan with ${steps} steps arrived` }),
  'toast.reconnected': 'Reconnected at {revision}',

  // Engine error codes (i18n/errors.ts). In English the engine's own message
  // is shown; these are the text when it sent none.
  'error.revision_mismatch': 'The session changed since this edit began',
  'error.plan_stale': 'Entities the plan touches have changed',
  'error.invalid_state': 'Not possible in the current state',
  'error.already_exists': 'It already exists',
  'error.session_mismatch': 'The engine is on another session',
  'error.disconnected': 'Not connected to the engine',
  'error.audition_budget_exceeded': 'Too many proposals are being auditioned',
  'error.not_found': 'Not found',
  'error.invalid_params': 'The request was not valid',
  'error.internal_error': 'The engine hit an internal error',
  'error.not_supported': 'Not supported by this engine',
  'error.nothing_to_undo': 'Nothing to undo',
  'error.nothing_to_redo': 'Nothing to redo',
  'error.session_locked': 'The session is open in another program',
  'error.media_missing': 'The media file is missing',
  'error.device_open_failed': 'The audio device could not be opened',
  'error.device_lost': 'The audio device was lost',
  'error.no_device': 'No audio device',
  'error.plugin_not_approved': 'The plugin is not approved',
  'error.gesture_open': 'Another gesture is still held',
  'error.queue_full': 'The engine is busy; try again',
  'error.lease_expired': 'The lease expired',
};

export type Catalog = typeof en;
export type MessageKey = keyof Catalog;
