import {
  h, store, DAYS, field, pageHead, emptyState, button, checkGroup, tagInput,
  formDialog, deleteDialog, save, courseName, plural,
} from '../lib.js';
import { facultyUpload } from './uploads.js';

const filter = { course: 'all', search: '' };

function facultyDialog(faculty) {
  const { courses } = store.state;
  const code = h('input', { required: true, maxLength: 20, value: faculty?.code ?? '' });
  const name = h('input', { required: true, maxLength: 120, value: faculty?.name ?? '' });
  const presetCourse = !faculty && typeof filter.course === 'number' ? [filter.course] : [];
  const courseBoxes = checkGroup(
    'Courses they teach',
    courses.map((c) => ({ value: c.id, label: c.name })),
    faculty?.course_ids ?? presetCourse,
  );
  const subjects = tagInput(faculty?.subjects ?? []);
  const topics = tagInput(faculty?.topics ?? [], {
    suggestions: 'topic-list',
    placeholder: 'Type a topic code or area, press Enter',
    label: 'Add a topic',
  });
  const offs = checkGroup('Week-offs', DAYS.map((d) => ({ value: d, label: d })), faculty?.week_offs ?? []);

  formDialog({
    title: faculty ? `Edit ${faculty.name}` : 'Add faculty',
    body: [
      h('div', { class: 'field-row' }, field('Faculty code', code), field('Name', name)),
      courseBoxes,
      field('Subjects they can teach', subjects),
      field('Topics they can teach', topics, 'Suggestions come from your master flows. Use topic codes or areas, whichever suits you.'),
      offs,
    ],
    onSubmit: () => {
      const body = {
        code: code.value,
        name: name.value,
        course_ids: courseBoxes.values(),
        subjects: subjects.values(),
        topics: topics.values(),
        week_offs: offs.values(),
      };
      return faculty
        ? save('PUT', `/faculties/${faculty.id}`, body, 'Faculty updated')
        : save('POST', '/faculties', body, `${body.name.trim()} added`);
    },
  });
}

function askDelete(faculty) {
  const allSlots = store.state.batches.flatMap((b) => b.assignments);
  const slots = allSlots.filter((a) => a.faculty_id === faculty.id).length;
  const subs = allSlots.filter((a) => a.substitute_ids.includes(faculty.id)).length;
  const parts = [];
  if (slots) parts.push(`primary on ${plural(slots, 'batch slot')}, which will become unfilled`);
  if (subs) parts.push(`substitute on ${plural(subs, 'batch slot')}, and will be removed from those`);
  deleteDialog({
    title: `Delete ${faculty.name}?`,
    message: parts.length ? `They are ${parts.join(', and ')}.` : 'They are not assigned to any batch.',
    path: `/faculties/${faculty.id}`,
    done: 'Faculty deleted',
  });
}

function matches(f) {
  if (filter.course === 'none' && f.course_ids.length) return false;
  if (typeof filter.course === 'number' && !f.course_ids.includes(filter.course)) return false;
  const q = filter.search.trim().toLowerCase();
  if (!q) return true;
  return [f.name, f.code, ...f.subjects, ...f.topics].some((t) => t.toLowerCase().includes(q));
}

function facultyTable() {
  const rows = store.state.faculties.filter(matches);
  if (!rows.length) return h('p', { class: 'muted' }, 'No faculty match this filter.');
  const batchCount = (id) =>
    store.state.batches.filter((b) => b.assignments.some((a) => a.faculty_id === id || a.substitute_ids.includes(id))).length;

  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ['Code', 'Name', 'Courses', 'Subjects', 'Topics', 'Week-offs'].map((t) => h('th', null, t)), h('th', { class: 'num' }, 'Batches'), h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
      h(
        'tbody',
        null,
        rows.map((f) =>
          h(
            'tr',
            null,
            h('td', { class: 'code' }, f.code),
            h('td', { class: 'nowrap' }, f.name),
            h('td', null, f.course_ids.length
              ? h('div', { class: 'chips' }, f.course_ids.map((id) => h('span', { class: 'chip accent' }, courseName(id))))
              : h('span', { class: 'chip warn' }, 'No course')),
            h('td', null, h('div', { class: 'chips' }, f.subjects.map((s) => h('span', { class: 'chip' }, s)))),
            h('td', null, f.topics.length
              ? h('span', { title: f.topics.join('\n') }, f.topics.length > 2 ? `${f.topics.slice(0, 2).join(', ')} +${f.topics.length - 2}` : f.topics.join(', '))
              : h('span', { class: 'muted' }, 'None')),
            h('td', { class: 'nowrap' }, f.week_offs.join(', ') || h('span', { class: 'muted' }, 'None')),
            h('td', { class: 'num' }, batchCount(f.id)),
            h('td', null, h('div', { class: 'row-actions' },
              button('Edit', () => facultyDialog(f), 'small quiet'),
              button('Delete', () => askDelete(f), 'small link-danger'))),
          ),
        ),
      ),
    ),
  );
}

export function facultiesView() {
  const { faculties, courses } = store.state;
  const add = button('Add faculty', () => facultyDialog(), 'primary');
  const upload = button('Upload faculty', facultyUpload);
  const subtitle = 'Filter by course to see who teaches what. A faculty member teaching two courses appears under both.';

  if (!faculties.length) {
    return h('div', null, pageHead('Faculties', subtitle), emptyState('No faculty yet', 'Upload your whole faculty list, or add them one at a time: code, courses, subjects, topics and week-offs.', h('div', { class: 'row-actions', style: 'justify-content:center' }, add, upload)));
  }

  const noCourse = faculties.filter((f) => !f.course_ids.length).length;
  if (filter.course === 'none' && !noCourse) filter.course = 'all';
  if (typeof filter.course === 'number' && !courses.some((c) => c.id === filter.course)) filter.course = 'all';

  const tableSlot = h('div', null, facultyTable());
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Filter by course' });
  const drawTabs = () => {
    const options = [
      { value: 'all', label: 'All', count: faculties.length },
      ...courses.map((c) => ({ value: c.id, label: c.name, count: faculties.filter((f) => f.course_ids.includes(c.id)).length })),
      ...(noCourse ? [{ value: 'none', label: 'No course', count: noCourse }] : []),
    ];
    tabs.replaceChildren(
      ...options.map((o) =>
        h(
          'button',
          {
            class: 'tab',
            type: 'button',
            'aria-pressed': String(filter.course === o.value),
            onclick: () => {
              filter.course = o.value;
              drawTabs();
              tableSlot.replaceChildren(facultyTable());
            },
          },
          o.label,
          h('span', { class: 'count' }, o.count),
        ),
      ),
    );
  };
  drawTabs();

  const search = h('input', {
    type: 'search',
    placeholder: 'Search name, code, subject or topic',
    'aria-label': 'Search faculty',
    value: filter.search,
    oninput: (e) => {
      filter.search = e.target.value;
      tableSlot.replaceChildren(facultyTable());
    },
  });

  return h('div', null, pageHead('Faculties', subtitle, upload, add), tabs, h('div', { class: 'filters' }, search), tableSlot);
}
