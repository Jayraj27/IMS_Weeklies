import {
  h, store, field, pageHead, emptyState, button, formDialog, deleteDialog, save, plural, toast,
} from '../lib.js';

const keyOf = (variant) => variant.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Every variant: those in the student sheet, plus any ticked into a course that no
 * longer appear there. Each has its course (or null) and student counts.
 */
function allVariants() {
  const { variants, variant_map: map } = store.state;
  const byKey = new Map();
  for (const v of variants) {
    const key = keyOf(v.variant);
    const entry = byKey.get(key) ?? { variant: v.variant, course_id: null, active: 0, count: 0 };
    entry.active += v.active;
    entry.count += v.count;
    byKey.set(key, entry);
  }
  for (const m of map) {
    const key = keyOf(m.variant);
    if (!byKey.has(key)) byKey.set(key, { variant: m.variant, course_id: null, active: 0, count: 0, gone: true });
    byKey.get(key).course_id = m.course_id;
  }
  return [...byKey.values()].sort((a, b) => a.variant.localeCompare(b.variant, 'en', { numeric: true, sensitivity: 'base' }));
}

function variantPicker(course) {
  const courseName = (id) => store.state.courses.find((c) => c.id === id)?.name;
  const all = allVariants();
  const ticked = new Set(all.filter((v) => course && v.course_id === course.id).map((v) => v.variant));
  // This course's variants first, then ones with no course, then the rest.
  const rank = (v) => (ticked.has(v.variant) ? 0 : v.course_id ? 2 : 1);
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));

  const count = h('span', { class: 'muted' });
  const search = h('input', { type: 'search', placeholder: 'Filter variants', 'aria-label': 'Filter variants', oninput: draw });
  const listEl = h('div', { class: 'checklist variant-checklist' });
  const updateCount = () => { count.textContent = `${plural(ticked.size, 'variant')} ticked`; };

  function draw() {
    const q = search.value.trim().toLowerCase();
    const shown = ordered.filter((v) => !q || v.variant.toLowerCase().includes(q));
    if (!shown.length) {
      const message = all.length ? 'No variants match this filter.' : 'No variants yet. They appear after the student sheet syncs.';
      listEl.replaceChildren(h('p', { class: 'hint', style: 'padding:8px 10px;margin:0' }, message));
      return;
    }
    listEl.replaceChildren(...shown.map((v) => {
      const elsewhere = v.course_id && !(course && v.course_id === course.id) ? courseName(v.course_id) : null;
      return h(
        'label',
        { class: 'checklist-row' },
        h('input', {
          type: 'checkbox',
          checked: ticked.has(v.variant),
          onchange: (e) => {
            if (e.target.checked) ticked.add(v.variant);
            else ticked.delete(v.variant);
            updateCount();
          },
        }),
        h('span', null, v.variant, elsewhere ? h('span', { class: 'muted check-note' }, `Now in ${elsewhere}. Ticking moves it here.`) : null),
        h('span', { class: 'muted small-text nowrap' }, v.gone ? 'Not in sheet' : plural(v.active, 'active student')),
      );
    }));
  }
  draw();
  updateCount();

  const el = h('div', { class: 'field' },
    h('span', { class: 'label' }, 'Current Variants in this course'),
    h('div', { class: 'filters', style: 'margin-bottom:6px;align-items:center' }, search, count),
    listEl,
    h('p', { class: 'hint' }, 'Students on a ticked variant belong to this course. Each variant can be in one course only.'));
  el.values = () => [...ticked];
  return el;
}

function courseDialog(course) {
  const { courses, batches } = store.state;
  const batchCount = course ? batches.filter((b) => b.course_id === course.id).length : 0;
  const name = h('input', { required: true, maxLength: 60, value: course?.name ?? '' });
  let slots = (course?.roles ?? [{ name: 'Mentor', subject: null }]).map((r) => ({ ...r, subject: r.subject ?? '' }));

  const rowsEl = h('div', { class: 'slot-rows' });
  const move = (i, by) => {
    [slots[i], slots[i + by]] = [slots[i + by], slots[i]];
    draw();
  };
  function draw() {
    rowsEl.replaceChildren(
      h('div', { class: 'slot-row slot-head' }, h('span', null, 'Slot name'), h('span', null, 'Subject (optional)'), h('span', { style: 'width:84px' })),
      ...slots.map((slot, i) =>
        h(
          'div',
          { class: 'slot-row' },
          h('input', { 'aria-label': `Slot ${i + 1} name`, placeholder: 'e.g. QA1', maxLength: 40, value: slot.name, oninput: (e) => (slot.name = e.target.value) }),
          h('input', { 'aria-label': `Slot ${i + 1} subject`, list: 'subject-list', placeholder: 'e.g. Quant', maxLength: 60, value: slot.subject, oninput: (e) => (slot.subject = e.target.value) }),
          h(
            'span',
            { class: 'buttons' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${slot.name || 'slot'} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Move ${slot.name || 'slot'} down`, disabled: i === slots.length - 1, onclick: () => move(i, 1) }, '↓'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${slot.name || 'slot'}`, onclick: () => { slots.splice(i, 1); draw(); } }, '×'),
          ),
        ),
      ),
    );
  }
  draw();

  const sources = courses.filter((c) => c.id !== course?.id && c.roles.length);
  const copyFrom = sources.length
    ? h(
        'select',
        {
          'aria-label': 'Copy slots from another course',
          class: 'copy-select',
          onchange: (e) => {
            const source = courses.find((c) => c.id === Number(e.target.value));
            if (!source) return;
            slots = source.roles.map((r) => ({ name: r.name, subject: r.subject ?? '' }));
            e.target.value = '';
            draw();
          },
        },
        h('option', { value: '' }, 'Copy slots from…'),
        sources.map((c) => h('option', { value: c.id }, c.name)),
      )
    : null;

  const applyBox = h('input', { type: 'checkbox' });
  const variants = variantPicker(course);

  formDialog({
    title: course ? `Edit ${course.name}` : 'Add course',
    wide: true,
    body: [
      field('Course name', name),
      variants,
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, 'Faculty slots for each batch'),
        rowsEl,
        h(
          'div',
          { class: 'filters' },
          button('Add slot', () => { slots.push({ name: '', subject: '' }); draw(); rowsEl.lastChild.querySelector('input').focus(); }, 'small'),
          copyFrom,
        ),
        h('p', { class: 'hint' }, 'New batches start with these slots. Adding a subject lets the batch form list the faculty who teach it first.'),
      ),
      batchCount
        ? h(
            'div',
            { class: 'field' },
            h('label', { class: 'check' }, applyBox, `Also add new slots to the ${plural(batchCount, 'existing batch', 'existing batches')}`),
            h('p', { class: 'hint' }, 'Slots you remove here stay on existing batches, so no faculty assignment is lost. Remove those from the batch itself.'),
          )
        : null,
    ],
    onSubmit: () => {
      const body = {
        name: name.value,
        roles: slots.filter((s) => s.name.trim() || s.subject.trim()),
        variants: variants.values(),
        apply_to_batches: applyBox.checked,
      };
      return course
        ? save('PUT', `/courses/${course.id}`, body, 'Course updated')
        : save('POST', '/courses', body, `${body.name.trim()} added`);
    },
  });
}

function variantTable() {
  const { courses } = store.state;
  const all = allVariants();
  if (!all.length) return null;
  // Variants with no course come first, because they're the ones to act on.
  const sorted = [...all].sort((a, b) => (a.course_id ? 1 : 0) - (b.course_id ? 1 : 0));
  const waiting = all.filter((v) => !v.course_id && v.active).length;

  const choose = async (variant, value) => {
    const done = value ? `${variant} is now in ${courses.find((c) => c.id === Number(value)).name}` : `${variant} is in no course`;
    await save('PUT', '/variants', { variant, course_id: value ? Number(value) : null }, done);
    // Keep the admin's place in a long list.
    document.querySelector(`select[data-variant="${CSS.escape(keyOf(variant))}"]`)?.focus();
  };

  const intro = waiting
    ? `${plural(waiting, 'variant')} with active students ${waiting === 1 ? 'is' : 'are'} in no course yet. Choose a course for each, here or by ticking them in a course.`
    : 'Choose the course for each variant here, or tick them in a course.';

  return [
    h('h2', { class: 'section', style: 'margin-top:28px' }, 'Current Variants in the student sheet'),
    h('p', { class: 'hint', style: 'margin:-4px 0 10px' }, intro),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, 'Current Variant'), h('th', null, 'Course'), h('th', { class: 'num' }, 'Active students'), h('th', { class: 'num' }, 'All students'))),
        h(
          'tbody',
          null,
          sorted.map((v) =>
            h(
              'tr',
              null,
              h('td', null, v.variant, v.gone ? h('span', { class: 'muted small-text' }, ' · not in sheet') : null),
              h('td', null, h(
                'select',
                {
                  class: `variant-course${v.course_id ? '' : ' unset'}`,
                  'data-variant': keyOf(v.variant),
                  'aria-label': `Course for ${v.variant}`,
                  value: v.course_id ?? '',
                  onchange: (e) => choose(v.variant, e.target.value).catch((err) => { toast(err.message, true); store.render(); }),
                },
                h('option', { value: '' }, 'No course'),
                courses.map((c) => h('option', { value: c.id }, c.name)),
              )),
              h('td', { class: 'num' }, v.active),
              h('td', { class: 'num' }, v.count),
            ),
          ),
        ),
      ),
    ),
  ];
}

export function coursesView() {
  const { courses, faculties, batches, flows } = store.state;
  const add = button('Add course', () => courseDialog(), 'primary');
  const subtitle = 'Each course sets the faculty slots its batches start with. You can name those slots however you like.';

  if (!courses.length) {
    return h('div', null, pageHead('Courses', subtitle), emptyState('No courses yet', 'Add a course such as CAT or CLAT. Then tick its Current Variants, and its batches from the student sheet appear.', add), variantTable());
  }

  return h(
    'div',
    null,
    pageHead('Courses', subtitle, add),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null,
          h('th', null, 'Course'),
          h('th', null, 'Faculty slots'),
          h('th', { class: 'num' }, 'Variants'),
          h('th', { class: 'num' }, 'Faculty'),
          h('th', { class: 'num' }, 'Batches'),
          h('th', { class: 'num' }, 'Flows'),
          h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
        h(
          'tbody',
          null,
          courses.map((c) =>
            h(
              'tr',
              null,
              h('td', { class: 'nowrap' }, h('b', null, c.name)),
              h('td', null, c.roles.length
                ? h('div', { class: 'chips' }, c.roles.map((r) => h('span', { class: 'chip', title: r.subject ?? 'No subject' }, r.name)))
                : h('span', { class: 'chip warn' }, 'No slots')),
              h('td', { class: 'num' }, store.state.variant_map.filter((m) => m.course_id === c.id).length
                || h('span', { class: 'chip warn' }, 'None')),
              h('td', { class: 'num' }, faculties.filter((f) => f.course_ids.includes(c.id)).length),
              h('td', { class: 'num' }, batches.filter((b) => b.course_id === c.id).length),
              h('td', { class: 'num' }, flows.filter((f) => f.course_id === c.id).length),
              h('td', null, h('div', { class: 'row-actions' },
                button('Edit', () => courseDialog(c), 'small quiet'),
                button('Delete', () => deleteDialog({
                  title: `Delete ${c.name}?`,
                  message: 'Faculty will no longer be linked to this course. Courses that still have batches or master flows cannot be deleted.',
                  path: `/courses/${c.id}`,
                  done: 'Course deleted',
                }), 'small link-danger'))),
            ),
          ),
        ),
      ),
    ),
    variantTable(),
  );
}
