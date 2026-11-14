// Meter ballistics (UI redesign spec 1.6, 1.2): instant attack, a release of
// 20 dB in 1.7 s (the IEC 60268-18 digital PPM return rate), a peak-hold line
// that stays 1.5 s and then falls at the release rate, and a clip indication
// that latches until reset. One slot per meter, in typed arrays the draw loop
// reads without allocating; time is the frame delta the loop passes in.

export const RELEASE_DB_PER_SECOND = 20 / 1.7;
export const HOLD_SECONDS = 1.5;
// Silence, as the bars see it.
export const FLOOR_DB = -120;
// A peak at or above full scale latches the clip indication.
const CLIP_LINEAR = 1;

function toDb(linear: number): number {
  if (!(linear > 0)) return FLOOR_DB;
  return Math.max(FLOOR_DB, 20 * Math.log10(linear));
}

export class PeakHold {
  // The bar, in dB.
  level = new Float32Array(0);
  // The hold line, in dB, and how long it has stayed (s).
  hold = new Float32Array(0);
  holdAge = new Float32Array(0);
  // The loudest peak since the last reset (linear): the strip's peak value.
  max = new Float32Array(0);
  // 1 while the clip indication is latched.
  clip = new Uint8Array(0);

  constructor(size: number) {
    this.resize(size);
  }

  get size(): number {
    return this.level.length;
  }

  // Every meter starts again from silence.
  resize(size: number): void {
    this.level = new Float32Array(size).fill(FLOOR_DB);
    this.hold = new Float32Array(size).fill(FLOOR_DB);
    this.holdAge = new Float32Array(size);
    this.max = new Float32Array(size);
    this.clip = new Uint8Array(size);
  }

  // Follows a new entity list: `from[i]` is meter i's index before, or -1 for
  // a meter new to the list. A carried meter keeps its bar, hold line, peak
  // value and clip; a new one starts from silence; one not named is dropped.
  remap(from: ArrayLike<number>): void {
    const before = { level: this.level, hold: this.hold, holdAge: this.holdAge, max: this.max, clip: this.clip };
    this.resize(from.length);
    for (let i = 0; i < from.length; i += 1) {
      const j = from[i]!;
      if (!(j >= 0 && j < before.level.length)) continue;
      this.level[i] = before.level[j]!;
      this.hold[i] = before.hold[j]!;
      this.holdAge[i] = before.holdAge[j]!;
      this.max[i] = before.max[j]!;
      this.clip[i] = before.clip[j]!;
    }
  }

  step(index: number, peakLinear: number, dtSeconds: number): void {
    if (index < 0 || index >= this.level.length) return;
    const dt = Math.max(0, dtSeconds);
    const input = toDb(peakLinear);
    const fallen = Math.max(FLOOR_DB, this.level[index]! - RELEASE_DB_PER_SECOND * dt);
    this.level[index] = Math.max(input, fallen);

    if (input >= this.hold[index]!) {
      this.hold[index] = input;
      this.holdAge[index] = 0;
    } else {
      const before = this.holdAge[index]!;
      const age = before + dt;
      this.holdAge[index] = age;
      const falling = Math.min(dt, age - HOLD_SECONDS);
      if (falling > 0) this.hold[index] = Math.max(FLOOR_DB, this.hold[index]! - RELEASE_DB_PER_SECOND * falling);
    }
    if (this.hold[index]! < this.level[index]!) this.hold[index] = this.level[index]!;

    if (peakLinear > this.max[index]!) this.max[index] = peakLinear;
    if (peakLinear >= CLIP_LINEAR) this.clip[index] = 1;
  }

  reset(index: number): void {
    if (index < 0 || index >= this.level.length) return;
    // The line comes back at the bar's level on the next step.
    this.hold[index] = FLOOR_DB;
    this.holdAge[index] = 0;
    this.max[index] = 0;
    this.clip[index] = 0;
  }

  // The bar and the hold line are both at the floor.
  decayed(index: number): boolean {
    return this.level[index]! <= FLOOR_DB && this.hold[index]! <= FLOOR_DB;
  }
}
