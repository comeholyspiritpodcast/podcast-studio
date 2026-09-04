/**
 * Navbar.js — top bar (brand, page title, account) and the left nav.
 */

import { el, clear, icons } from '../config.js';

const NAV = [
  { route: '/', label: 'Projects', icon: icons.projects },
  { route: '/scheduled', label: 'Scheduled events', icon: icons.calendar },
  { route: '/settings', label: 'Settings', icon: icons.settings }
];

export function renderNavbar({ title, status }) {
  const bar = clear(document.getElementById('navbar'));

  bar.append(
    el('a', { class: 'brand', href: '#/' }, [el('span', { class: 'brand-mark' }), 'studio']),
    el('span', { class: 'topbar-title', text: title || '' }),
    el('div', { class: 'topbar-spacer' })
  );

  bar.append(
    status && status.linked
      ? el('span', { class: 'drive-badge ok', title: 'Recordings save to the studio Drive' }, [
          el('span', { class: 'dot-ok' }),
          'Drive linked'
        ])
      : el('a', { class: 'drive-badge warn', href: '#/settings', title: 'Link the studio Drive' }, [
          el('span', { class: 'dot-warn' }),
          'Drive not linked'
        ])
  );
}

export function renderSidebar({ route, status }) {
  const side = clear(document.getElementById('sidebar'));

  for (const item of NAV) {
    const link = el('a', {
      class: 'nav-item',
      href: `#${item.route}`,
      'aria-current': route === item.route ? 'page' : null,
      html: item.icon
    });
    link.append(el('span', { text: item.label }));
    side.append(link);
  }

  if (status && status.linked) {
    side.append(
      el('div', { class: 'sidebar-foot' }, [
        el('strong', { text: 'Uploading live' }),
        el('span', { text: 'Tracks reach Drive while you record' })
      ])
    );
  }
}
