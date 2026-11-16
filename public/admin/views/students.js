import { h, store, api, refresh, pageHead, emptyState, button, formDialog, toast, plural } from '../lib.js';

const filter = { q: '', status: '', course: '', batch: '', issues: false, page: 1 };

/* ---------- helpers ---------- */

function timeAgo(iso) {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  return new Date(iso).toLocaleString();
}

const fullName = (s) => `${s.first_name} ${s.surname}`.trim() || '(no name)';

function changeSummary(run) {
  const parts = [plural(run.row_count, 'student')];
  const changes = [
    run.added && `${run.added} added`,
    run.updated && `${run.updated} updated`,
    run.removed && `${run.removed} removed`,
  ].filter(Boolean);
  parts.push(changes.length ? changes.join(', ') : 'no changes');
  return parts.join(' · ');
}

function statusChip(status) {
  if (!status) return h('span', { class: 'muted' }, '–');
  const cls = status === 'Active' ? 'chip ok' : status === 'Drop Out' ? 'chip warn' : 'chip';
  return h('span', { class: cls }, status);
}

/* ---------- sync panel ---------- */

function setupPanel(status) {
  return h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'section' }, 'Connect the student sheet'),
    status.config_error ? h('p', { class: 'form-error', style: 'margin:0 0 12px' }, status.config_error) : null,
    h('ol', { class: 'steps' },
      h('li', null, 'In Google Cloud, enable the Google Sheets API and create a service account with a JSON key.'),
      h('li', null, 'Save the key as ', h('code', null, 'secrets/google-service-account.json'), ' in this project.'),
      h('li', null, 'Ask the sheet’s owner to share it as Viewer with the service account’s email address.'),
      h('li', null, 'Restart the app. It then syncs on its own.')),
    h('p', { class: 'hint', style: 'margin-bottom:12px' }, 'The full steps are in README.md. The app only ever reads the sheet.'),
  );
}

function syncPanel(status, reload) {
  const last = status.last_run;
  const failed = last && !last.ok;
  const success = status.last_success;

  const syncNow = async (allowShrink) => {
    const { run } = await api('POST', '/students/sync', allowShrink ? { allow_shrink: true } : {});
    await refresh();
    store.render();
    await reload?.();
    if (run.ok) toast(`Synced: ${changeSummary(run)}`);
    else toast('Sync failed. See the details on this page.', true);
  };

  const syncBtn = h('button', {
    class: 'btn',
    type: 'button',
    onclick: async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      try {
        await syncNow(false);
      } catch (err) {
        toast(err.message, true);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync now';
      }
    },
  }, 'Sync now');

  const acceptShrink = () =>
    formDialog({
      title: 'Accept the smaller student list?',
      body: h('p', null, last.error, ' Only continue if students were meant to be removed from the sheet.'),
      submitLabel: 'Replace the copy',
      submitClass: 'danger',
      onSubmit: () => syncNow(true),
    });

  return h(
    'section',
    { class: `sync-panel${failed ? ' failed' : ''}` },
    h(
      'div',
      { class: 'sync-text' },
      h('b', null, success ? `Synced ${timeAgo(success.finished_at)}` : 'Not synced yet'),
      success ? h('span', { class: 'muted' }, ` · ${changeSummary(success)} · from tab “${success.tab}” · every ${plural(status.interval_minutes, 'minute')}`) : null,
      failed ? h('p', { class: 'sync-error', role: 'alert' }, `Last sync failed: ${last.error}`, success ? ' The list below is from the last good sync.' : '') : null,
      !failed && last?.warnings?.length ? h('details', { class: 'hint' }, h('summary', null, `${plural(last.warnings.length, 'note')} about the sheet’s columns`), last.warnings.map((w) => h('p', null, w))) : null,
    ),
    h(
      'div',
      { class: 'row-actions' },
      failed && last.error_code === 'shrink' ? button('Review', acceptShrink, 'danger') : null,
      syncBtn,
    ),
  );
}

/* ---------- one student ---------- */

function studentDialog(student) {
  const dlg = formDialog({
    title: fullName(student),
    wide: true,
    submitLabel: 'Close',
    onSubmit: async () => {},
    body: [
      student.issues.length
        ? h('div', { class: 'issue-box' },
            h('b', null, 'To check in the sheet'),
            h('ul', null, student.issues.map((i) => h('li', null, i))))
        : null,
      h('dl', { class: 'detail' },
        Object.entries(student.raw).flatMap(([label, value]) => [h('dt', null, label), h('dd', null, value)])),
      h('p', { class: 'hint' }, `Sheet row ${student.sheet_row}. Change this in the sheet; the next sync brings it here.`),
    ],
  });
  dlg.querySelector('.dialog-foot button[type=button]').hidden = true;
}

/* ---------- list ---------- */

function studentsTable(data) {
  if (!data.rows.length) return h('p', { class: 'muted' }, 'No students match this filter.');
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      null,
      h('thead', null, h('tr', null, ['IMS ID', 'Name', 'Status', 'Course', 'Batch', 'Variant', 'Mobile', ''].map((t) => h('th', null, t)))),
      h(
        'tbody',
        null,
        data.rows.map((s) =>
          h(
            'tr',
            null,
            h('td', { class: 'code' }, s.ims_id || h('span', { class: 'chip warn' }, 'Missing')),
            h('td', { class: 'nowrap' }, h('button', { class: 'batch-open', type: 'button', onclick: () => studentDialog(s) }, fullName(s))),
            h('td', null, statusChip(s.status)),
            h('td', { class: 'nowrap', title: `Sheet course: ${s.course || 'blank'}` }, s.course_name ?? h('span', { class: 'chip warn' }, 'No match')),
            h('td', { class: 'nowrap' }, s.batch),
            h('td', null, s.variant),
            h('td', { class: 'code' }, s.mobile),
            h('td', null, s.issues.length ? h('span', { class: 'chip warn', title: s.issues.join('\n') }, plural(s.issues.length, 'check')) : null),
          ),
        ),
      ),
    ),
  );
}

function pager(data, reload) {
  if (data.pages < 2) return null;
  const go = (page) => {
    filter.page = page;
    reload();
    window.scrollTo(0, 0);
  };
  return h(
    'div',
    { class: 'pager' },
    h('button', { class: 'btn small', type: 'button', disabled: data.page <= 1, onclick: () => go(data.page - 1) }, 'Previous'),
    h('span', { class: 'muted' }, `Page ${data.page} of ${data.pages}`),
    h('button', { class: 'btn small', type: 'button', disabled: data.page >= data.pages, onclick: () => go(data.page + 1) }, 'Next'),
  );
}

function facetSelect(label, key, options, reload) {
  // A chosen value stays listed even if the latest sync removed it.
  const values = options.some((o) => o.value === filter[key]) || !filter[key] ? options : [{ value: filter[key], count: 0 }, ...options];
  const labelOf = (o) => o.label ?? o.value;
  return h(
    'select',
    {
      'aria-label': `Filter by ${label}`,
      value: filter[key],
      onchange: (e) => {
        filter[key] = e.target.value;
        filter.page = 1;
        reload();
      },
    },
    h('option', { value: '' }, `All ${label}`),
    values.map((o) => h('option', { value: o.value }, `${labelOf(o)} (${o.count})`)),
  );
}

export function studentsView(query) {
  // Arriving from a batch's student count shows just that batch.
  if (query.has('batch')) {
    Object.assign(filter, { q: '', status: '', course: '', issues: false, page: 1, batch: query.get('batch') });
    // Applied once, so a later redraw doesn't undo a filter the admin has since changed.
    history.replaceState(null, '', '#/students');
  }
  const subtitle = 'A read-only copy of the BRD student sheet. Make changes in the sheet, not here.';
  const panelSlot = h('div');
  const facetSlot = h('div', { class: 'filters-inline' });
  const listSlot = h('div', null, h('p', { class: 'muted' }, 'Loading students…'));
  const countSlot = h('p', { class: 'list-count muted', role: 'status' });
  let latest = 0;

  async function loadList() {
    const ticket = ++latest;
    const params = new URLSearchParams({ page: filter.page });
    for (const key of ['q', 'status', 'course', 'batch']) if (filter[key]) params.set(key, filter[key]);
    if (filter.issues) params.set('issues', '1');
    const data = await api('GET', `/students?${params}`);
    if (ticket !== latest) return; // a newer search has already started
    filter.page = data.page;

    const issueBox = h('input', { type: 'checkbox', checked: filter.issues, onchange: (e) => { filter.issues = e.target.checked; filter.page = 1; loadList(); } });
    // The search box stays in place, so redrawing these doesn't interrupt typing.
    facetSlot.replaceChildren(
      facetSelect('statuses', 'status', data.facets.status, loadList),
      facetSelect('courses', 'course', data.facets.course, loadList),
      facetSelect('batches', 'batch', data.facets.batch, loadList),
      h('label', { class: 'check' }, issueBox, `Needs checking (${data.issue_total})`),
    );
    countSlot.textContent = plural(data.total, 'student');
    listSlot.replaceChildren(...[studentsTable(data), pager(data, loadList)].filter(Boolean));
  }

  let searchTimer;
  const searchBox = h('input', {
    type: 'search',
    placeholder: 'Search name, IMS ID, email, phone or batch',
    'aria-label': 'Search students',
    value: filter.q,
    oninput: (e) => {
      filter.q = e.target.value;
      filter.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadList().catch((err) => toast(err.message, true)), 200);
    },
  });

  const filterRow = h('div', { class: 'filters' }, searchBox, facetSlot);

  api('GET', '/students/sync')
    .then((status) => {
      if (!status.configured && !store.state.student_count) {
        panelSlot.replaceChildren(setupPanel(status));
        filterRow.hidden = true;
        listSlot.replaceChildren(emptyState('No students yet', 'Students appear here after the first sync from the sheet.'));
        return null;
      }
      panelSlot.replaceChildren(status.configured ? syncPanel(status, null) : setupPanel(status));
      return loadList();
    })
    .catch((err) => {
      listSlot.replaceChildren(h('p', { class: 'form-error', style: 'margin:0' }, err.message));
    });

  return h('div', null, pageHead('Students', subtitle), panelSlot, filterRow, countSlot, listSlot);
}
