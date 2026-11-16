/*
 * Where each batch has reached in its master flow. Each subject has its own "last
 * finished" choice, because QA, VA and DILR move at different speeds in the same batch.
 * Choosing one marks every earlier session of that subject as finished.
 */

import { h, store, api, refresh, pageHead, emptyState, button, formDialog, toast, plural } from '../lib.js';

let chosenFlowId = null;

const sessionLabel = (s, no) => `${no}. ${s.topic_code ? `${s.topic_code} · ` : ''}${s.topic}`;

/** Biggest subjects first, so the columns used most are the ones in view. */
function subjectsOf(sessions) {
  const counts = new Map();
  for (const s of sessions) counts.set(s.subject, (counts.get(s.subject) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([subject]) => subject);
}

function checklistDialog(batch, flow, finished, onSave) {
  const chosen = new Set(finished);
  const list = h('div', { class: 'checklist' });
  const subjectFilter = h(
    'select',
    { 'aria-label': 'Show one subject', onchange: draw },
    h('option', { value: '' }, 'All subjects'),
    subjectsOf(flow.sessions).map((s) => h('option', { value: s }, s)),
  );

  function draw() {
    list.replaceChildren(
      ...flow.sessions.flatMap((s, i) => {
        if (subjectFilter.value && s.subject !== subjectFilter.value) return [];
        return [
          h(
            'label',
            { class: 'checklist-row' },
            h('input', {
              type: 'checkbox',
              checked: chosen.has(s.id),
              onchange: (e) => (e.target.checked ? chosen.add(s.id) : chosen.delete(s.id)),
            }),
            h('span', null, sessionLabel(s, i + 1)),
            h('span', { class: 'chip' }, s.subject),
          ),
        ];
      }),
    );
  }
  draw();

  formDialog({
    title: `${batch.name}: finished sessions`,
    wide: true,
    body: [
      h('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Use this for exceptions, such as a session taught out of order or skipped.'),
      h('div', { class: 'filters' }, subjectFilter),
      list,
    ],
    onSubmit: () => onSave(chosen),
  });
}

function batchRow(batch, flow, subjects, finishedByBatch) {
  const finished = () => new Set(finishedByBatch[batch.id] ?? []);

  async function saveFinished(set) {
    await api('PUT', `/batches/${batch.id}/progress`, { finished: [...set] });
    finishedByBatch[batch.id] = [...set];
    await refresh();
    row.replaceWith(batchRow(batch, flow, subjects, finishedByBatch));
    document.getElementById(focusId)?.focus();
  }
  let focusId = null;

  async function attempt(set, id) {
    focusId = id;
    try {
      await saveFinished(set);
      toast(`${batch.name} updated`);
    } catch (err) {
      toast(err.message, true);
      store.render();
    }
  }

  const upToId = `upto-${batch.id}`;
  const upTo = h('input', {
    id: upToId,
    type: 'number',
    class: 'up-to',
    min: 0,
    max: flow.sessions.length,
    placeholder: 'No',
    'aria-label': `${batch.name}: finished everything up to session number`,
    onchange: (e) => {
      const n = Number(e.target.value);
      if (!Number.isInteger(n) || n < 0 || n > flow.sessions.length) {
        toast(`Enter a session number from 0 to ${flow.sessions.length}.`, true);
        return;
      }
      attempt(new Set(flow.sessions.slice(0, n).map((s) => s.id)), upToId);
    },
  });

  const cells = subjects.map((subject) => {
    const inSubject = flow.sessions.map((s, i) => ({ ...s, no: i + 1 })).filter((s) => s.subject === subject);
    const done = finished();
    const last = inSubject.filter((s) => done.has(s.id)).at(-1);
    const hasGap = last && inSubject.some((s) => s.no < last.no && !done.has(s.id));
    const selectId = `last-${batch.id}-${subject}`;
    return h(
      'td',
      null,
      h(
        'select',
        {
          id: selectId,
          class: 'last-finished',
          'aria-label': `${batch.name}: last ${subject} session finished`,
          value: last?.id ?? '',
          onchange: (e) => {
            const chosenNo = inSubject.find((s) => s.id === Number(e.target.value))?.no ?? 0;
            const next = finished();
            for (const s of inSubject) {
              if (s.no <= chosenNo) next.add(s.id);
              else next.delete(s.id);
            }
            attempt(next, selectId);
          },
        },
        h('option', { value: '' }, 'Not started'),
        inSubject.map((s) => h('option', { value: s.id }, sessionLabel(s, s.no))),
      ),
      hasGap ? h('div', { class: 'chip warn gap-chip', title: 'An earlier session of this subject is not marked finished' }, 'Has gaps') : null,
    );
  });

  const done = finished();
  const count = flow.sessions.filter((s) => done.has(s.id)).length;
  const nextIndex = flow.sessions.findIndex((s) => !done.has(s.id));
  const next = flow.sessions[nextIndex];

  const row = h(
    'tr',
    null,
    h('td', { class: 'nowrap batch-cell' }, h('b', null, batch.name), h('div', { class: 'muted small-text' }, plural(batch.active_students, 'active student'))),
    h('td', { class: 'num nowrap' }, `${count} / ${flow.sessions.length}`),
    h('td', { class: 'next-cell' }, next ? sessionLabel(next, nextIndex + 1) : h('span', { class: 'chip ok' }, 'Finished')),
    h('td', null, upTo),
    cells,
    h('td', null, button('Sessions', () => checklistDialog(batch, flow, done, async (set) => {
      await saveFinished(set);
      toast(`${batch.name} updated`);
    }), 'small quiet')),
  );
  return row;
}

export function progressView(query) {
  const { flows, batches } = store.state;
  const subtitle = 'Set where each batch has reached once, then keep it up to date. Each subject has its own position, because they move at different speeds.';

  const usable = flows.filter((f) => f.sessions.length);
  if (!usable.length) {
    return h('div', null, pageHead('Batch progress', subtitle), emptyState('No master flows with sessions yet', 'Upload a master flow first, and map batches to it.', h('a', { class: 'btn primary', href: '#/flows' }, 'Go to master flows')));
  }

  // The flow stays in the page address, so reloading keeps the admin's place.
  if (query.has('flow')) chosenFlowId = Number(query.get('flow'));
  const flow = usable.find((f) => f.id === chosenFlowId) ?? usable[0];
  chosenFlowId = flow.id;

  const courseOf = (f) => store.state.courses.find((c) => c.id === f.course_id)?.name ?? '';
  const picker = h(
    'select',
    {
      'aria-label': 'Master flow',
      value: flow.id,
      onchange: (e) => {
        location.hash = `#/progress?flow=${e.target.value}`;
      },
    },
    usable.map((f) => h('option', { value: f.id }, `${courseOf(f)}: ${f.name}`)),
  );

  const following = batches.filter((b) => b.flow?.id === flow.id);
  const listSlot = h('div', null, h('p', { class: 'muted' }, 'Loading…'));

  if (!following.length) {
    listSlot.replaceChildren(emptyState('No batches follow this flow yet', 'Open the flow and tick the batches that follow it.', h('a', { class: 'btn primary', href: `#/flows/${flow.id}` }, 'Map batches')));
  } else {
    api('GET', `/flows/${flow.id}/progress`)
      .then(({ finished }) => {
        const subjects = subjectsOf(flow.sessions);
        listSlot.replaceChildren(
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'progress-table' },
              h('thead', null, h('tr', null,
                h('th', { class: 'batch-cell' }, 'Batch'),
                h('th', { class: 'num' }, 'Finished'),
                h('th', null, 'Next in order'),
                h('th', { title: 'Marks every session up to this number as finished' }, 'All up to No'),
                subjects.map((s) => h('th', null, `Last ${s}`)),
                h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
              h('tbody', null, following.map((b) => batchRow(b, flow, subjects, finished))),
            ),
          ),
          h('p', { class: 'hint', style: 'margin-top:10px' }, 'Changes save straight away. “All up to No” is the quick way when a batch has followed the order exactly.'),
        );
      })
      .catch((err) => listSlot.replaceChildren(h('p', { class: 'form-error', style: 'margin:0' }, err.message)));
  }

  return h('div', null, pageHead('Batch progress', subtitle), h('div', { class: 'filters' }, picker), listSlot);
}
