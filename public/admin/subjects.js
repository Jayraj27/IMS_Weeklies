/*
 * A master flow divided by subject. Each subject keeps the flow's order, and the scheduler
 * works through each one separately, so this is how the flow is actually taught.
 */

const words = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const clean = (subject) => String(subject ?? '').trim();

/**
 * sessions: in flow order, each with a subject. Returns the subjects in order of first
 * appearance: [{ subject, items: [{ session, index, no }] }], where index is the place in
 * the whole flow and no counts within the subject. A session such as "TEST QA" is taught by
 * the QA faculty, so it goes under QA when the flow has QA, marked by its own subject.
 */
export function groupBySubject(sessions) {
  const names = [...new Set(sessions.map((s) => clean(s.subject)).filter(Boolean))];
  const lower = names.map((n) => n.toLowerCase());
  const home = (subject) => {
    const key = subject.toLowerCase();
    const parent = names.find((n, i) => lower[i] !== key && words(subject).includes(lower[i]));
    return parent ?? subject;
  };
  const groups = new Map();
  sessions.forEach((session, index) => {
    const subject = clean(session.subject);
    if (!subject) return;
    const owner = home(subject);
    const key = owner.toLowerCase();
    if (!groups.has(key)) groups.set(key, { subject: owner, items: [] });
    const group = groups.get(key);
    group.items.push({ session, index, no: group.items.length + 1 });
  });
  return [...groups.values()];
}

const letters = (text) => text.toLowerCase().replace(/[^a-z]/g, '');

/**
 * Pairs of subject names that look like one subject written two ways: one is the start of
 * the other (VA and VARC), or the same letters (DILR and LRDI). The scheduler treats them
 * as different subjects, so a slot for one won't take classes of the other.
 */
export function similarSubjects(subjects) {
  const names = [...new Set(subjects.map(clean).filter(Boolean))];
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, b] = [letters(names[i]), letters(names[j])];
      if (!a || !b || a === b) continue;
      if (words(names[i]).includes(b) || words(names[j]).includes(a)) continue; // TEST QA and QA belong together already
      const prefix = a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a));
      const anagram = a.length >= 3 && [...a].sort().join('') === [...b].sort().join('');
      if (prefix || anagram) pairs.push([names[i], names[j]]);
    }
  }
  return pairs;
}

export const similarText = (pairs) => pairs.map(([a, b]) => `${a} and ${b} look like the same subject. The scheduler treats them as two, so rename one to match the batch slots.`);
