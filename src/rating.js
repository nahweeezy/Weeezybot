// XP -> rating conversion (the FC-style 45..99 curve) and rating -> tier lookup.
// The curve itself lives in config.json (rating.curve) so it can be retuned without code changes.
import { getConfig } from './config.js';

let cache = { source: null, thresholds: null };

/**
 * Build the cumulative XP needed for every rating from rating.min to rating.max.
 * Returns an array where index i holds the XP required to reach rating (min + i).
 *
 * "anchors" curve: between two anchors, XP follows  from.xp + (to.xp - from.xp) * t^easing,
 * where t goes 0 -> 1 across the segment. easing 1 = every rating in the segment costs the
 * same; easing > 1 = early ratings in the segment are cheap and later ones cost more.
 * "table" curve: the exact XP for each rating is read from rating.curve.table.
 */
export function buildThresholds(ratingCfg) {
  const { min, max, curve } = ratingCfg;
  const raw = [];

  if (curve.type === 'table') {
    for (let r = min; r <= max; r++) raw.push(curve.table[String(r)]);
  } else {
    const anchors = curve.anchors;
    raw.push(anchors[0].xp);
    for (let i = 1; i < anchors.length; i++) {
      const from = anchors[i - 1];
      const to = anchors[i];
      const easing = to.easing ?? 1;
      const span = to.rating - from.rating;
      for (let r = from.rating + 1; r <= to.rating; r++) {
        const t = (r - from.rating) / span;
        raw.push(from.xp + (to.xp - from.xp) * t ** easing);
      }
    }
  }

  // Whole XP only, and every rating must cost at least 1 XP more than the previous one.
  const out = [];
  for (const value of raw) {
    const rounded = Math.round(value);
    out.push(out.length ? Math.max(rounded, out.at(-1) + 1) : rounded);
  }
  return out;
}

function thresholds(cfg = getConfig()) {
  // Config edits replace the whole object, so an identity check is enough to invalidate.
  if (cache.source !== cfg.rating) cache = { source: cfg.rating, thresholds: buildThresholds(cfg.rating) };
  return cache.thresholds;
}

/** Rating for a cumulative XP total. */
export function ratingForXp(xp, cfg = getConfig()) {
  const t = thresholds(cfg);
  // Binary search for the highest rating whose threshold is <= xp.
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= xp) lo = mid;
    else hi = mid - 1;
  }
  return cfg.rating.min + lo;
}

/** Cumulative XP needed to reach a rating. */
export function xpForRating(rating, cfg = getConfig()) {
  const { min, max } = cfg.rating;
  const clamped = Math.min(Math.max(rating, min), max);
  return thresholds(cfg)[clamped - min];
}

/** Everything the card / commands need to describe progress toward the next rating. */
export function progressFor(xp, cfg = getConfig()) {
  const rating = ratingForXp(xp, cfg);
  const floorXp = xpForRating(rating, cfg);
  if (rating >= cfg.rating.max) {
    return { rating, isMax: true, floorXp, nextRating: null, nextXp: null, xpToNext: 0, fraction: 1 };
  }
  const nextXp = xpForRating(rating + 1, cfg);
  return {
    rating,
    isMax: false,
    floorXp,
    nextRating: rating + 1,
    nextXp,
    xpToNext: nextXp - xp,
    fraction: (xp - floorXp) / (nextXp - floorXp),
  };
}

/** Index into config.tiers for a rating (tiers are sorted by minRating). */
export function tierIndexForRating(rating, cfg = getConfig()) {
  let index = 0;
  cfg.tiers.forEach((tier, i) => {
    if (rating >= tier.minRating) index = i;
  });
  return index;
}

export function tierForRating(rating, cfg = getConfig()) {
  return cfg.tiers[tierIndexForRating(rating, cfg)];
}

/** Highest XP any single reaction can give (used for "reactions needed" estimates). */
export function topEmojiXp(cfg = getConfig()) {
  return Math.max(cfg.xp.defaultEmojiXp, ...Object.values(cfg.xp.emojiValues), 1);
}

/**
 * Plain-text table of the whole curve, used by `npm run xp-table` and `/config curve`.
 * Also flags any rating that is cheaper than the one before it (usually an easing typo).
 */
export function formatXpTable(cfg = getConfig()) {
  const t = thresholds(cfg);
  const top = topEmojiXp(cfg);
  const rows = [];
  const warnings = [];
  let prevStep = 0;

  rows.push(`OVR   TOTAL XP    +STEP  TIER${' '.repeat(10)}≈ TOP-EMOJI GRANTS (${top} XP each)`);
  rows.push('-'.repeat(66));
  for (let r = cfg.rating.min; r <= cfg.rating.max; r++) {
    const total = t[r - cfg.rating.min];
    const step = r === cfg.rating.min ? 0 : total - t[r - cfg.rating.min - 1];
    // Ignore 1 XP dips: those are just rounding.
    if (prevStep - step > 1) warnings.push(`Rating ${r} costs ${step} XP, less than rating ${r - 1} (${prevStep} XP).`);
    prevStep = step;
    const tier = tierForRating(r, cfg);
    const tierStart = tier.minRating === r && r !== cfg.rating.min ? ' ◄' : '';
    rows.push(
      `${String(r).padEnd(4)}  ${total.toLocaleString('en-US').padStart(8)}  ${`+${step.toLocaleString('en-US')}`.padStart(7)}  ` +
        `${(tier.name + tierStart).padEnd(14)}${Math.ceil(total / top).toLocaleString('en-US').padStart(8)}`,
    );
  }
  return { text: rows.join('\n'), warnings, thresholds: t };
}
