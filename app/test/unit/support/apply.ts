// Applies a command list's clip commands to a snapshot, as the engine's
// document does (architecture spec, "Commands"; m5b-engine-clip-fades): the
// expectation of a glue or a paste is the entities the list leaves, worked
// out here from the protocol's rules and not by the builders under test.
// clip.place adds a clip without fades; clip.move sets the position (and the
// track); clip.trim sets sourceStart and length, shortening the fades only when
// they no longer fit (not needed by these tests, so it asserts they fit);
// clip.set_fade sets the sides it names, a length of "0" removing that side;
// clip.set_gain sets the gain; clip.remove deletes the clip.

import assert from 'node:assert/strict';

import type { ClipEntity, ClipFade } from '../../../src/renderer/model/document';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import { snapshotOf } from './timeline';

type Command = Readonly<Record<string, unknown>>;

export function applyClipCommands(snapshot: Snapshot, commands: readonly Command[]): Map<string, ClipEntity> {
  const clips = new Map<string, ClipEntity>(snapshot.clips.map((c) => [c.id, c]));
  for (const command of commands) {
    const id = String(command.clipId);
    const clip = clips.get(id);
    switch (command.op) {
      case 'clip.place': {
        assert.ok(!clip, `${id} already exists`);
        clips.set(id, {
          schema: 'siann.entity.clip.v1',
          id,
          trackId: String(command.trackId),
          mediaId: String(command.mediaId),
          position: command.position as ClipEntity['position'],
          sourceStart: String(command.sourceStart),
          length: String(command.length),
          gainMilliDb: typeof command.gainMilliDb === 'number' ? command.gainMilliDb : 0,
        });
        break;
      }
      case 'clip.move': {
        assert.ok(clip, `${id} is unknown`);
        clips.set(id, { ...clip, position: command.position as ClipEntity['position'], ...(command.trackId ? { trackId: String(command.trackId) } : {}) });
        break;
      }
      case 'clip.trim': {
        assert.ok(clip, `${id} is unknown`);
        const length = BigInt(String(command.length));
        const fades = BigInt(clip.fadeIn?.length ?? '0') + BigInt(clip.fadeOut?.length ?? '0');
        assert.ok(fades <= length, `${id}: the fades still fit`);
        clips.set(id, { ...clip, sourceStart: String(command.sourceStart), length: length.toString() });
        break;
      }
      case 'clip.set_fade': {
        assert.ok(clip, `${id} is unknown`);
        const next: { -readonly [K in keyof ClipEntity]: ClipEntity[K] } = { ...clip };
        for (const side of ['fadeIn', 'fadeOut'] as const) {
          const fade = command[side] as ClipFade | undefined;
          if (!fade) continue;
          if (fade.length === '0') delete next[side];
          else next[side] = { ...fade };
        }
        clips.set(id, next);
        break;
      }
      case 'clip.set_gain': {
        assert.ok(clip, `${id} is unknown`);
        clips.set(id, { ...clip, gainMilliDb: command.gainMilliDb as number });
        break;
      }
      case 'clip.remove': {
        assert.ok(clip, `${id} is unknown`);
        clips.delete(id);
        break;
      }
      default:
        assert.fail(`not a clip command: ${String(command.op)}`);
    }
  }
  return clips;
}

// The snapshot after the list, with a new revision.
export function applied(snapshot: Snapshot, commands: readonly Command[], revision = 'r8'): Snapshot {
  const clips = [...applyClipCommands(snapshot, commands).values()];
  return snapshotOf(snapshot.trackOrder, snapshot.tracks, snapshot.media, clips, revision);
}
