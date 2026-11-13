// One-line descriptions of plan steps (m5-plan-review, m5-ui-i18n; UI
// redesign spec 6.2), built from the catalogs so every locale goes through
// the same code path. Track names come from the read model and the step's own
// fields as written (never translated); dB values are formatted locale-free;
// the pan value is the step's. An op the catalogs have no wording for shows
// its op and parameters as the protocol has them.

import { formatMilliDb } from '../format';
import { translator, type T } from '../i18n/t';

const english = translator('en');

// `trackName` names a track by id from the read model, when it knows the track.
export function describeStep(
  step: Record<string, unknown>,
  t: T = english,
  trackName: (id: string) => string | undefined = () => undefined,
): string {
  const trackId = typeof step.trackId === 'string' ? step.trackId : '';
  const track = trackName(trackId) ?? trackId;
  switch (step.op) {
    case 'track.add':
      return t('step.addTrack', { name: typeof step.name === 'string' ? step.name : trackId });
    case 'track.remove':
      return t('step.removeTrack', { track });
    case 'track.rename':
      return t('step.renameTrack', { track, name: String(step.name) });
    case 'track.set_gain':
      if (typeof step.gainMilliDb === 'number') return t('step.setGain', { track, gain: formatMilliDb(step.gainMilliDb) });
      break;
    case 'track.set_pan':
      return t('step.setPan', { track, pan: String(step.pan) });
    case 'track.set_mute':
      return t(step.mute ? 'step.mute' : 'step.unmute', { track });
    case 'track.set_solo':
      return t(step.solo ? 'step.solo' : 'step.unsolo', { track });
    default:
      break;
  }
  const { op, ...params } = step;
  return `${String(op)} ${JSON.stringify(params)}`;
}
