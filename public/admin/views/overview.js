import { h, store, pageHead, plural } from '../lib.js';

function needsAttention(s) {
  const items = [];
  const add = (text, href, go) => items.push({ text, href, go });

  if (!s.student_sync.configured) add('The student sheet is not connected yet.', '#/students', 'Connect');
  else if (s.student_sync.last_ok === false) add('The last student sheet sync failed, so student data may be out of date.', '#/students', 'See why');

  const unmatched = s.variants.filter((v) => !v.course_id && v.active > 0).length;
  if (unmatched) add(`${plural(unmatched, 'Current Variant')} with active students ${unmatched === 1 ? 'is' : 'are'} in no course yet.`, '#/courses', 'Review');
  if (s.batches_waiting.length) add(`${plural(s.batches_waiting.length, 'batch code')} from the sheet can’t be placed in a course yet.`, '#/batches', 'Review');
  if (s.batches_mismatched.length) add(`${plural(s.batches_mismatched.length, 'batch', 'batches')} have students from another course.`, '#/batches', 'Review');

  if (!s.faculties.length) add('No faculty added yet.', '#/faculties', 'Add faculty');

  const noCourse = s.faculties.filter((f) => !f.course_ids.length).length;
  if (noCourse) add(`${plural(noCourse, 'faculty member')} not linked to any course.`, '#/faculties', 'Review');

  for (const course of s.courses) {
    const batches = s.batches.filter((b) => b.course_id === course.id);
    if (!batches.length) continue;
    const slots = batches.flatMap((b) => b.assignments);
    const open = slots.filter((a) => !a.faculty_id).length;
    const atLink = `#/batches?course=${course.id}`;
    if (!slots.length) {
      add(`${course.name}: ${plural(batches.length, 'batch', 'batches')} with no faculty slots.`, `#/courses`, 'Set up slots');
    } else if (open) {
      const affected = batches.filter((b) => b.assignments.some((a) => !a.faculty_id)).length;
      add(`${course.name}: ${plural(open, 'unfilled faculty slot')} across ${plural(affected, 'batch', 'batches')}.`, atLink, 'Assign');
    }
    const noFlow = batches.filter((b) => !b.flow).length;
    if (noFlow) {
      add(`${course.name}: ${plural(noFlow, 'batch', 'batches')} with no master flow.`, `#/flows/new?course=${course.id}`, 'Add flow');
    }
    const noTimetable = batches.filter((b) => b.active_students > 0 && !b.timings.length).length;
    if (noTimetable) {
      add(`${course.name}: ${plural(noTimetable, 'running batch', 'running batches')} with no timetable.`, `#/batches?course=${course.id}`, 'Add timetable');
    }
    const noPosition = batches.filter((b) => b.active_students > 0 && b.progress?.total && !b.progress.done).length;
    if (noPosition) {
      add(`${course.name}: ${plural(noPosition, 'running batch', 'running batches')} with no session position set.`, '#/progress', 'Set position');
    }
  }
  if (!s.rooms.length) add('No rooms added yet.', '#/rooms', 'Add room');
  return items;
}

export function overviewView() {
  const s = store.state;
  const tiles = [
    ['Faculties', s.faculties.length, '#/faculties'],
    ['Courses', s.courses.length, '#/courses'],
    ['Batches', s.batches.length, '#/batches'],
    ['Master flows', s.flows.length, '#/flows'],
    ['Rooms', s.rooms.length, '#/rooms'],
    ['Students', s.student_count, '#/students'],
  ];
  const items = needsAttention(s);

  return h(
    'div',
    null,
    pageHead('Overview'),
    h('div', { class: 'tiles' }, tiles.map(([label, n, href]) => h('a', { class: 'tile', href }, h('b', null, n), h('span', null, label)))),
    h('h2', { class: 'section' }, 'Needs attention'),
    items.length
      ? h(
          'ul',
          { class: 'todo' },
          items.map((i) => h('li', null, h('a', { href: i.href }, h('span', null, i.text), h('span', { class: 'go' }, `${i.go} →`)))),
        )
      : h('p', { class: 'all-clear' }, 'Everything is set up: all batches have faculty and a master flow.'),
  );
}
