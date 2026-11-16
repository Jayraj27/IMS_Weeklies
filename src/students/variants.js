/* Rules for reading the sheet's Current Variant and Batch columns. No database here. */

/** Variants are matched by name; spacing and capitals don't make a different variant. */
export const variantKey = (variant) => String(variant ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Spacing and capitals don't make a different batch: "27 E: IPMAT101" = "27 e:ipmat101". */
export const normalizeCode = (code) => String(code ?? '').toLowerCase().replace(/\s+/g, '');

/** 26CA02, eCAT26 : 101 and 26 E: IPMAT101 are all 2026. GC01 has no usable year. */
export function yearFromCode(code) {
  const first = /\d+/.exec(String(code ?? ''))?.[0];
  if (first?.length !== 2) return null;
  const year = 2000 + Number(first);
  return year >= 2020 && year <= 2045 ? year : null;
}

export function yearFromVariant(variant) {
  const year = /\b(20\d{2})\b/.exec(String(variant ?? ''))?.[1];
  return year ? Number(year) : null;
}
