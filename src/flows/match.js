/*
 * When a flow is saved or re-uploaded, works out which incoming row is which existing
 * session, so that a batch's progress survives corrections and reordering.
 *
 * Tried in order: the row's own id (edited on screen), then the same code and topic
 * (re-uploaded; repeated rows pair up in order), then the same code alone if exactly one
 * session on each side has it (a corrected topic name).
 */

const norm = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, '');
const fullKey = (s) => `${norm(s.code)}|${norm(s.topic)}`;

export function matchSessions(existing, incoming) {
  const free = new Map(existing.map((e) => [e.id, e]));
  const result = new Array(incoming.length).fill(null);

  incoming.forEach((row, i) => {
    if (row.id && free.has(row.id)) {
      result[i] = row.id;
      free.delete(row.id);
    }
  });

  incoming.forEach((row, i) => {
    if (result[i]) return;
    const found = [...free.values()].find((e) => fullKey(e) === fullKey(row));
    if (found) {
      result[i] = found.id;
      free.delete(found.id);
    }
  });

  incoming.forEach((row, i) => {
    if (result[i] || !norm(row.code)) return;
    const sameCode = (s) => norm(s.code) === norm(row.code);
    const candidates = [...free.values()].filter(sameCode);
    const rivals = incoming.filter((r, j) => !result[j] && sameCode(r));
    if (candidates.length === 1 && rivals.length === 1) {
      result[i] = candidates[0].id;
      free.delete(candidates[0].id);
    }
  });

  return result;
}
