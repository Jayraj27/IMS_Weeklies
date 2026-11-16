/*
 * Block colours, shared by the day grid and the spreadsheet export so a faculty or
 * batch has the same colour in both. Light fills with a strong edge, so text stays readable.
 */

export const PALETTE = [
  ['#dbeafe', '#1d4ed8'], ['#dcfce7', '#15803d'], ['#fef3c7', '#b45309'], ['#fce7f3', '#be185d'],
  ['#ede9fe', '#6d28d9'], ['#ccfbf1', '#0f766e'], ['#ffedd5', '#c2410c'], ['#e0e7ff', '#4338ca'],
  ['#f3e8ff', '#7e22ce'], ['#fee2e2', '#b91c1c'], ['#ecfccb', '#4d7c0f'], ['#e0f2fe', '#0369a1'],
];
export const EVENT_COLOURS = ['#eeece5', '#5d6474'];

export function colourFor(key) {
  if (!key) return ['#f1f0ea', '#8a8a80'];
  let hash = 0;
  for (const ch of String(key)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}
