/*
 * Line icons for each section, drawn inline so no image files or outside sources are
 * needed. Each section has a tile colour from the IMS palette, used in the menu and the
 * page header.
 */

const SVG = 'http://www.w3.org/2000/svg';

const PATHS = {
  overview: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
  faculties: 'M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1 M16 3.5a4 4 0 0 1 0 7.5 M22 21v-1a6 6 0 0 0-4-5.6',
  courses: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  batches: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  flows: 'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
  schedule: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M16 2v4 M8 2v4 M3 10h18 M8 14h3 M8 18h6',
  progress: 'M22 7l-8.5 8.5-5-5L2 17 M16 7h6v6',
  reports: 'M3 3v18h18 M8 17v-6 M13 17V7 M18 17v-4',
  rooms: 'M3 21h18 M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17 M14 12h.01',
  students: 'M22 10 12 5 2 10l10 5 10-5z M6 12v5c3 2 9 2 12 0v-5',
};

export const SECTIONS = {
  '': { icon: 'overview', colour: '#0481FE' },
  faculties: { icon: 'faculties', colour: '#4B2BC3' },
  courses: { icon: 'courses', colour: '#E39200' },
  batches: { icon: 'batches', colour: '#1886BC' },
  flows: { icon: 'flows', colour: '#1FA971' },
  schedule: { icon: 'schedule', colour: '#E8590C' },
  progress: { icon: 'progress', colour: '#0B8F86' },
  reports: { icon: 'reports', colour: '#404F56' },
  rooms: { icon: 'rooms', colour: '#B5521B' },
  students: { icon: 'students', colour: '#3B5BDB' },
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.overview);
  svg.append(path);
  return svg;
}

/** A coloured square with the section's icon, as in the menu and page headers. */
export function sectionTile(section, size = 'small') {
  const s = SECTIONS[section] ?? SECTIONS[''];
  const tile = document.createElement('span');
  tile.className = `icon-tile ${size}`;
  tile.style.setProperty('--tile', s.colour);
  tile.append(icon(s.icon, size === 'large' ? 22 : 15));
  return tile;
}

export const currentSection = () => location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
