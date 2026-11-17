/* Shared helpers: DOM building, server calls, dialogs and form controls. */

import { currentSection, sectionTile } from './icons.js';

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const YEAR_NOW = new Date().getFullYear();

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [key, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (key === 'class') el.className = v;
    else if (key === 'value') value = v; // set after children so <select> has its options
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), v);
    else if (key in el && key !== 'list') el[key] = v;
    else el.setAttribute(key, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  if (value !== undefined) el.value = value;
  return el;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- data ---------- */

export const store = { state: null, render: () => {} };
export const guard = { dirty: false };

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the server. Check that it's still running.");
  }
  if (res.status === 401 && !path.startsWith('/auth/')) {
    guard.dirty = false;
    location.href = '/login/';
    throw new Error('Please sign in.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? 'Something went wrong.');
  return data;
}

export async function refresh() {
  store.state = await api('GET', '/state');
  const list = document.getElementById('subject-list');
  list.replaceChildren(...store.state.subjects.map((s) => h('option', { value: s })));
  document.getElementById('topic-list').replaceChildren(...store.state.topic_suggestions.map((t) => h('option', { value: t })));
}

/** Sends a change, reloads the data, redraws the page and confirms to the admin. */
export async function save(method, path, body, message) {
  const result = await api(method, path, body);
  await refresh();
  store.render();
  if (message) toast(message);
  return result;
}

export const courseName = (id) => store.state.courses.find((c) => c.id === id)?.name ?? '';

/* ---------- feedback ---------- */

export function toast(message, isError = false) {
  const el = h('div', { class: `toast${isError ? ' error' : ''}`, role: isError ? 'alert' : 'status' },
    h('span', { class: 'toast-icon', 'aria-hidden': 'true' }, isError ? '!' : '✓'), h('span', null, message));
  const toasts = document.getElementById('toasts');
  toasts.append(el);
  while (toasts.children.length > 2) toasts.firstChild.remove();
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

/* ---------- dialogs ---------- */

export function formDialog({ title, body, submitLabel = 'Save', submitClass = 'primary', wide, onSubmit }) {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { class: `btn ${submitClass}`, type: 'submit' }, submitLabel);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel');

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        try {
          await onSubmit();
          dlg.close();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('div', { class: 'dialog-head' }, h('h2', null, title)),
    h('div', { class: 'dialog-body' }, body),
    error,
    h('div', { class: 'dialog-foot' }, cancel, submit),
  );
  const dlg = h('dialog', { class: `dialog${wide ? ' wide' : ''}` }, form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

export function confirmDialog({ title, message, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    let answer = false;
    const dlg = formDialog({
      title,
      body: h('p', null, message),
      submitLabel: confirmLabel,
      submitClass: danger ? 'danger' : 'primary',
      onSubmit: async () => {
        answer = true;
      },
    });
    dlg.addEventListener('close', () => resolve(answer));
  });
}

/** Asks first, then deletes. A refusal from the server is shown inside the dialog. */
export function deleteDialog({ title, message, path, done }) {
  formDialog({
    title,
    body: h('p', null, message),
    submitLabel: 'Delete',
    submitClass: 'danger',
    onSubmit: () => save('DELETE', path, null, done),
  });
}

/* ---------- form controls ---------- */

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), control, hint && h('p', { class: 'hint' }, hint));
}

export function pageHead(title, subtitle, ...actions) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', { class: 'page-head-title' },
      sectionTile(currentSection(), 'large'),
      h('div', null, h('h1', null, title), subtitle && h('p', null, subtitle))),
    actions.length ? h('div', { class: 'row-actions' }, actions) : null,
  );
}

export function emptyState(title, message, action) {
  return h('div', { class: 'empty' }, h('h2', null, title), h('p', null, message), action);
}

export function button(label, onclick, cls = '') {
  return h('button', { class: `btn ${cls}`, type: 'button', onclick }, label);
}

/** A set of checkboxes. options: [{ value, label, disabled, title }]. Read with .values(). */
export function checkGroup(legend, options, selected, { hint, onChange } = {}) {
  const chosen = new Set(selected);
  const boxes = options.map((o) => ({
    value: o.value,
    input: h('input', {
      type: 'checkbox',
      checked: chosen.has(o.value),
      disabled: o.disabled,
      onchange: () => onChange?.(),
    }),
    option: o,
  }));
  const el = h(
    'fieldset',
    { class: 'field' },
    h('legend', null, legend),
    h(
      'div',
      { class: 'check-group' },
      boxes.map((b) => h('label', { class: 'check', title: b.option.title }, b.input, b.option.label)),
    ),
    hint && h('p', { class: 'hint' }, hint),
  );
  el.values = () => boxes.filter((b) => b.input.checked).map((b) => b.value);
  return el;
}

/** Free typing with suggestions: Enter or comma adds a tag. Read with .values(). */
export function tagInput(initial, { suggestions = 'subject-list', placeholder = 'Type a subject, press Enter', label = 'Add a subject' } = {}) {
  const tags = [...initial];
  const list = h('span', { style: 'display:contents' });
  const input = h('input', {
    list: suggestions,
    placeholder,
    'aria-label': label,
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Backspace' && !input.value && tags.length) {
        tags.pop();
        draw();
      }
    },
    onblur: () => commit(),
  });

  function commit() {
    const value = input.value.trim().replace(/,$/, '').trim();
    input.value = '';
    if (!value) return;
    if (!tags.some((t) => t.toLowerCase() === value.toLowerCase())) tags.push(value);
    draw();
  }
  function draw() {
    list.replaceChildren(
      ...tags.map((tag, i) =>
        h(
          'span',
          { class: 'tag' },
          tag,
          h(
            'button',
            {
              type: 'button',
              'aria-label': `Remove ${tag}`,
              onclick: () => {
                tags.splice(i, 1);
                draw();
                input.focus();
              },
            },
            '×',
          ),
        ),
      ),
    );
  }
  draw();
  const el = h('div', { class: 'tag-input', onclick: (e) => e.target === el && input.focus() }, list, input);
  // Includes anything still being typed, so a subject isn't lost when Save is clicked.
  el.values = () => {
    commit();
    return [...tags];
  };
  return el;
}
