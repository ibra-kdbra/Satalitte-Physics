// Adaptive resolution: watches how long frames take and scales the drawing
// buffer (and with it the bloom targets) down when the GPU cannot keep up,
// and back up when there is headroom. The user's quality setting is the
// ceiling (scale 1 = the quality's pixel ratio); the floor is MIN_SCALE.
//
// Only the GPU-bound part of a frame is judged: the frame interval minus the
// main-thread work outside the render call. A slow physics step at high warp
// therefore never costs resolution. Decisions use the median of a window of
// frames, with separate thresholds and patience for going down and up
// (hysteresis), and a level that proved too slow is not retried for a while.
// A step down that does not shorten the frames (vsync- or CPU-bound, e.g. a
// 30 Hz display or a throttled browser) is undone and not tried again for a
// while, so resolution is never traded for nothing.

const MIN_SCALE = 0.5;
const STEP = 0.85;            // one level = ×0.85 in pixel ratio (≈ ×0.72 in pixels)
const WINDOW = 40;            // frames per decision (at most)
const MIN_FRAMES = 8;         // … or at least this many over WINDOW_MS, so slow devices adapt in seconds
const WINDOW_MS = 1000;
const SLOW_MS = 22;           // median GPU-bound interval above this → step down (< ~45 fps)
const FAST_MS = 17.5;         // below this for UP_PATIENCE windows → step up (≥ ~57 fps)
const DOWN_PATIENCE = 2;      // consecutive slow windows before stepping down
const UP_PATIENCE = 4;        // consecutive fast windows before stepping up
const RETRY_MS = 60000;       // a level that was too slow is not retried for this long
const VERY_SLOW_MS = 50;      // median above this (< 20 fps): step down at once, two levels

export class AdaptiveResolution {
  /** @param {{ apply(scale:number):void, now?:() => number }} opts */
  constructor({ apply, now = () => performance.now() }) {
    this.apply = apply;
    this.now = now;
    this.scale = 1;
    this.samples = new Float32Array(WINDOW);
    this.reset();
  }

  /** Forget the timing history (after a resize or a hidden tab); keeps the scale. */
  reset() {
    this.n = 0;
    this.windowStart = NaN;
    this.lastNow = NaN;
    this.slow = 0;
    this.fast = 0;
    this.skip = 3;               // the first frames after a change are not representative
    this.blockedAbove = Infinity; // scale known to be too slow
    this.blockedUntil = 0;
    this.downFrom = null;         // { scale, median } of the last step down, to check it helped
    this.noDownUntil = 0;         // stepping down did not help: leave the resolution alone
  }

  /** Back to full resolution (e.g. when the user picks another quality). */
  restore() {
    this.reset();
    if (this.scale !== 1) this.set(1);
  }

  /**
   * @param {number} now     rAF timestamp (ms)
   * @param {boolean} drawn  whether this frame drew the GL scene
   * @param {number} cpuMs   main-thread work this frame outside the render call
   */
  sample(now, drawn, cpuMs) {
    const prev = this.lastNow;
    this.lastNow = drawn ? now : NaN;
    if (!drawn || !(prev === prev)) return; // only consecutive drawn frames measure the GPU
    if (this.skip > 0) { this.skip--; return; }
    const interval = now - prev;
    if (interval > 1500) return;           // a hitch (tab switch, shader compile): not a trend
    if (this.n === 0) this.windowStart = now;
    this.samples[this.n++] = Math.max(0, interval - cpuMs);
    if (this.n < WINDOW && !(this.n >= MIN_FRAMES && now - this.windowStart >= WINDOW_MS)) return;
    const median = this.samples.subarray(0, this.n).sort()[this.n >> 1];
    this.n = 0;
    this.decide(median);
  }

  decide(gpuMs) {
    const t = this.now();
    if (this.downFrom) {
      const { scale, median } = this.downFrom;
      this.downFrom = null;
      if (gpuMs > median * 0.9) { // no gain: not GPU-bound, so give the resolution back
        this.noDownUntil = t + RETRY_MS;
        this.blockedAbove = Infinity;
        this.set(scale);
        return;
      }
    }
    if (gpuMs > SLOW_MS) {
      if (t < this.noDownUntil) return;
      this.fast = 0;
      const verySlow = gpuMs > VERY_SLOW_MS;
      if ((verySlow || ++this.slow >= DOWN_PATIENCE) && this.scale > MIN_SCALE) {
        this.slow = 0;
        this.blockedAbove = this.scale;    // this level was too slow
        this.blockedUntil = t + RETRY_MS;
        this.downFrom = { scale: this.scale, median: gpuMs };
        this.set(Math.max(MIN_SCALE, this.scale * (verySlow ? STEP * STEP : STEP)));
      }
    } else if (gpuMs < FAST_MS) {
      this.slow = 0;
      if (++this.fast >= UP_PATIENCE && this.scale < 1) {
        this.fast = 0;
        const next = Math.min(1, this.scale / STEP);
        if (next >= this.blockedAbove - 1e-6 && t < this.blockedUntil) return;
        this.set(next);
      }
    } else {
      this.slow = 0;
      this.fast = 0;
    }
  }

  set(scale) {
    this.scale = scale > 0.995 ? 1 : scale;
    this.skip = 3;
    this.apply(this.scale);
  }
}
