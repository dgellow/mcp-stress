/**
 * Statistical utilities shared between main thread and writer worker.
 */

/**
 * Linear interpolation percentile on a pre-sorted array.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Welch's t-test for comparing two independent samples.
 * Returns p-value (two-tailed).
 */
export function welchTTest(sample1: number[], sample2: number[]): number {
  const n1 = sample1.length;
  const n2 = sample2.length;
  if (n1 < 2 || n2 < 2) return 1;

  const mean1 = sample1.reduce((a, b) => a + b, 0) / n1;
  const mean2 = sample2.reduce((a, b) => a + b, 0) / n2;
  const var1 = sample1.reduce((s, x) => s + (x - mean1) ** 2, 0) / (n1 - 1);
  const var2 = sample2.reduce((s, x) => s + (x - mean2) ** 2, 0) / (n2 - 1);

  const se = Math.sqrt(var1 / n1 + var2 / n2);
  if (se === 0) return mean1 === mean2 ? 1 : 0;

  const t = (mean1 - mean2) / se;

  // Welch–Satterthwaite degrees of freedom
  const num = (var1 / n1 + var2 / n2) ** 2;
  const den = (var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1);
  const df = num / den;

  // Approximate p-value using the t-distribution
  // Using the regularized incomplete beta function approximation
  return tDistPValue(Math.abs(t), df) * 2;
}

/**
 * Cohen's d effect size between two samples.
 * |d| < 0.2 = negligible, 0.2-0.5 = small, 0.5-0.8 = medium, > 0.8 = large.
 */
export function effectSize(sample1: number[], sample2: number[]): number {
  const n1 = sample1.length;
  const n2 = sample2.length;
  if (n1 < 2 || n2 < 2) return 0;

  const mean1 = sample1.reduce((a, b) => a + b, 0) / n1;
  const mean2 = sample2.reduce((a, b) => a + b, 0) / n2;
  const var1 = sample1.reduce((s, x) => s + (x - mean1) ** 2, 0) / (n1 - 1);
  const var2 = sample2.reduce((s, x) => s + (x - mean2) ** 2, 0) / (n2 - 1);

  // Pooled standard deviation
  const pooledVar = ((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2);
  const pooledSd = Math.sqrt(pooledVar);
  if (pooledSd === 0) return 0;

  return (mean1 - mean2) / pooledSd;
}

/**
 * One-tailed p-value for t-distribution.
 * Uses an approximation suitable for df > 1.
 */
function tDistPValue(t: number, df: number): number {
  // Approximation via the regularized incomplete beta function
  // Using the identity: p = 0.5 * I_{df/(df+t²)}(df/2, 1/2)
  const x = df / (df + t * t);
  return 0.5 * regIncBeta(x, df / 2, 0.5);
}

/**
 * Regularized incomplete beta function I_x(a, b).
 * Uses a continued fraction expansion (Lentz's method).
 */
function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use the symmetry relation if x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regIncBeta(1 - x, b, a);
  }

  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;

  // Continued fraction (Lentz's method)
  let f = 1;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  f = d;

  for (let m = 1; m <= 200; m++) {
    // Even step
    let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    f *= c * d;

    // Odd step
    numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < 1e-10) break;
  }

  return front * f;
}

/**
 * Log-gamma function (Lanczos approximation).
 */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t +
    Math.log(x);
}
