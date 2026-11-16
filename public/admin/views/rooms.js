import { h, store, field, pageHead, emptyState, button, formDialog, deleteDialog, save } from '../lib.js';

function roomDialog(room) {
  const name = h('input', { required: true, maxLength: 60, value: room?.name ?? '', placeholder: 'e.g. Room 101' });
  const capacity = h('input', { type: 'number', min: 1, max: 5000, value: room?.capacity ?? '' });
  const location = h('input', { maxLength: 120, value: room?.location ?? '', placeholder: 'e.g. 2nd floor' });

  formDialog({
    title: room ? `Edit ${room.name}` : 'Add room',
    body: [
      field('Room name', name),
      h('div', { class: 'field-row' }, field('Seats (optional)', capacity), field('Location (optional)', location)),
    ],
    onSubmit: () => {
      const body = { name: name.value, capacity: capacity.value, location: location.value };
      return room
        ? save('PUT', `/rooms/${room.id}`, body, 'Room updated')
        : save('POST', '/rooms', body, `${body.name.trim()} added`);
    },
  });
}

export function roomsView() {
  const { rooms } = store.state;
  const add = button('Add room', () => roomDialog(), 'primary');
  const subtitle = 'The rooms available for classes.';

  if (!rooms.length) {
    return h('div', null, pageHead('Rooms', subtitle), emptyState('No rooms yet', 'Add each classroom with its seats and location.', add));
  }

  return h(
    'div',
    null,
    pageHead('Rooms', subtitle, add),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null,
          h('th', null, 'Room'),
          h('th', { class: 'num' }, 'Seats'),
          h('th', null, 'Location'),
          h('th', null, h('span', { class: 'sr-only' }, 'Actions')))),
        h(
          'tbody',
          null,
          rooms.map((r) =>
            h(
              'tr',
              null,
              h('td', { class: 'nowrap' }, h('b', null, r.name)),
              h('td', { class: 'num' }, r.capacity ?? h('span', { class: 'muted' }, '–')),
              h('td', null, r.location ?? h('span', { class: 'muted' }, '–')),
              h('td', null, h('div', { class: 'row-actions' },
                button('Edit', () => roomDialog(r), 'small quiet'),
                button('Delete', () => deleteDialog({ title: `Delete ${r.name}?`, message: 'This removes the room from the list.', path: `/rooms/${r.id}`, done: 'Room deleted' }), 'small link-danger'))),
            ),
          ),
        ),
      ),
    ),
  );
}
