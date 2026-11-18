// The pending takes the engine lists (m5b-ui-recording; protocol-events-v1.md,
// the auth reply's and session.sync's pendingTakes; protocol-engine-v0.md,
// "Recording"): takes in the bundle's media/recording/ that are not being
// recorded, typically left by a crash. The window offers Keep and Discard
// for each (record.recover_take). Framework-free.

export interface PendingTake {
  readonly takeId: string;
  // The track the take was recorded on (null when the engine has none).
  readonly trackId: string | null;
  readonly channels: number;
  readonly sampleRate: number;
  // The timeline frame it lands on, a decimal string; null when it never captured a frame.
  readonly startFrame: string | null;
  readonly endedBy: string | null;
  readonly overflows: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

// The list of a pendingTakes field, or null when the field is absent (an
// engine before m5b-engine-record); malformed rows are left out.
export function parsePendingTakes(value: unknown): readonly PendingTake[] | null {
  if (!Array.isArray(value)) return null;
  const out: PendingTake[] = [];
  for (const row of value) {
    if (row === null || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.takeId !== 'string') continue;
    out.push(
      Object.freeze({
        takeId: r.takeId,
        trackId: text(r.trackId),
        channels: count(r.channels),
        sampleRate: count(r.sampleRate),
        startFrame: text(r.startFrame),
        endedBy: text(r.endedBy),
        overflows: text(r.overflows),
      }),
    );
  }
  return Object.freeze(out);
}
