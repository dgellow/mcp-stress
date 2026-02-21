/**
 * Load shapes — functions that return target concurrency at time t.
 */

export type ShapeFn = (t: number, duration: number, peak: number) => number;

export const SHAPES: Record<string, { description: string; fn: ShapeFn }> = {
  constant: {
    description: "Fixed concurrency for entire duration",
    fn: (_t, _dur, peak) => peak,
  },
  "linear-ramp": {
    description: "Linearly ramp from 1 to peak concurrency",
    fn: (t, dur, peak) => Math.max(1, Math.ceil((t / dur) * peak)),
  },
  exponential: {
    description: "Exponential growth from 1 to peak",
    fn: (t, dur, peak) => {
      const ratio = (Math.exp(3 * t / dur) - 1) / (Math.exp(3) - 1);
      return Math.max(1, Math.ceil(ratio * peak));
    },
  },
  step: {
    description: "Step up in 5 discrete jumps",
    fn: (t, dur, peak) => {
      const steps = 5;
      const step = Math.min(Math.floor(t / (dur / steps)), steps - 1);
      return Math.max(1, Math.ceil(((step + 1) / steps) * peak));
    },
  },
  spike: {
    description: "Low baseline with a spike in the middle",
    fn: (t, dur, peak) => {
      const mid = dur / 2;
      const spikeWidth = dur * 0.2;
      if (t >= mid - spikeWidth / 2 && t <= mid + spikeWidth / 2) return peak;
      return Math.max(1, Math.ceil(peak * 0.1));
    },
  },
  sawtooth: {
    description: "Repeating ramp-up/drop cycles",
    fn: (t, dur, peak) => {
      const cycleLen = dur / 4;
      const pos = (t % cycleLen) / cycleLen;
      return Math.max(1, Math.ceil(pos * peak));
    },
  },
};
