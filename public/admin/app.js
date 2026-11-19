import { h, store, guard, api, refresh, confirmDialog, formDialog, toast } from './lib.js';
import { sectionTile } from './icons.js';
import { overviewView } from './views/overview.js';
import { facultiesView } from './views/faculties.js';
import { coursesView } from './views/courses.js';
import { batchesView } from './views/batches.js';
import { flowsView, flowEditorView } from './views/flows.js';
import { roomsView } from './views/rooms.js';
import { studentsView } from './views/students.js';
import { progressView } from './views/progress.js';
import { scheduleView } from './views/schedule.js';
import { reportsView } from './views/reports.js';
import { facultyInputView } from './views/inputs.js';

const NAV = [
  { path: '', label: 'Overview' },
  { path: 'faculties', label: 'Faculties', count: (s) => s.faculties.length },
  { path: 'courses', label: 'Courses', count: (s) => s.courses.length },
  { path: 'batches', label: 'Batches', count: (s) => s.batches.length },
  { path: 'flows', label: 'Master flows', count: (s) => s.flows.length },
  { path: 'schedule', label: 'Weekly schedule' },
  { path: 'inputs', label: 'Faculty input' },
  { path: 'progress', label: 'Batch progress' },
  { path: 'reports', label: 'Reports' },
  { path: 'rooms', label: 'Rooms', count: (s) => s.rooms.length },
  { path: 'students', label: 'Students', count: (s) => s.student_count },
];

function parseRoute() {
  const [path, queryText] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(queryText ?? '') };
}

function viewFor({ parts, query }) {
  switch (parts[0]) {
    case undefined: return overviewView();
    case 'faculties': return facultiesView();
    case 'courses': return coursesView();
    case 'batches': return batchesView(query);
    case 'flows': return parts[1] ? flowEditorView(parts[1], query) : flowsView();
    case 'schedule': return scheduleView(query);
    case 'progress': return progressView(query);
    case 'reports': return reportsView(query);
    case 'inputs': return facultyInputView(query);
    case 'rooms': return roomsView();
    case 'students': return studentsView(query);
    default: return overviewView();
  }
}

function drawNav(section) {
  const nav = document.getElementById('nav');
  nav.replaceChildren(
    ...NAV.map((item) =>
      h(
        'a',
        { href: `#/${item.path}`, 'aria-current': (section ?? '') === item.path ? 'page' : null },
        sectionTile(item.path),
        h('span', { class: 'nav-label' }, item.label),
        item.count && h('span', { class: 'nav-count' }, item.count(store.state)),
      ),
    ),
  );
  // On a phone the menu is a sideways strip; keep the current page's item in view.
  if (matchMedia('(max-width: 760px)').matches) nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

store.render = () => {
  if (!store.state) return; // still loading; the first load draws the page when it's done
  const route = parseRoute();
  guard.dirty = false;
  drawNav(route.parts[0]);
  document.getElementById('main').replaceChildren(viewFor(route));
};

// Unsaved work in the flow editor shouldn't vanish on a stray click.
let currentHash = location.hash;
window.addEventListener('hashchange', async () => {
  if (guard.dirty && location.hash !== currentHash) {
    const target = location.hash;
    history.replaceState(null, '', currentHash || '#/');
    const leave = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: 'This master flow has changes that have not been saved.',
      confirmLabel: 'Discard changes',
    });
    if (!leave) return;
    guard.dirty = false;
    location.hash = target;
    return;
  }
  currentHash = location.hash;
  store.render();
  window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', (e) => {
  if (guard.dirty) e.preventDefault();
});

function changePassword() {
  const field = (label, autocomplete) => {
    const input = h('input', { type: 'password', required: true, autocomplete });
    return { input, el: h('label', { class: 'field' }, h('span', { class: 'label' }, label), input) };
  };
  const current = field('Current password', 'current-password');
  const next = field('New password', 'new-password');
  const again = field('New password again', 'new-password');
  formDialog({
    title: 'Change password',
    body: [current.el, next.el, again.el, h('p', { class: 'hint' }, 'At least 10 characters. This signs you out on your other devices.')],
    onSubmit: async () => {
      if (next.input.value !== again.input.value) throw new Error('The two new passwords don’t match.');
      await api('POST', '/auth/password', { current: current.input.value, next: next.input.value });
      toast('Password changed');
    },
  });
}

async function signOut() {
  if (guard.dirty) {
    const leave = await confirmDialog({
      title: 'Discard unsaved changes?',
      message: 'This master flow has changes that have not been saved.',
      confirmLabel: 'Discard and sign out',
    });
    if (!leave) return;
  }
  guard.dirty = false;
  await api('POST', '/auth/logout');
  location.href = '/login/';
}

async function drawAccount() {
  const { username } = await api('GET', '/auth/me');
  document.getElementById('account').replaceChildren(
    h('span', { class: 'avatar', 'aria-hidden': 'true' }, username.slice(0, 1).toUpperCase()),
    h('span', { class: 'account-name' }, username),
    h('button', { type: 'button', onclick: changePassword }, 'Change password'),
    h('button', { type: 'button', onclick: signOut }, 'Sign out'),
  );
}

try {
  await drawAccount();
  await refresh();
  store.render();
} catch (err) {
  toast(err.message, true);
}
