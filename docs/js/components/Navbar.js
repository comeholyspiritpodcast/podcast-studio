/**
 * Navbar.js — top bar (brand, page title, guest toggle, account) and the
 * left nav.
 */

import { el, clear, icons, uploads, guestMode, creator } from '../config.js';

const NAV = [
  { route: '/', label: 'Library', icon: icons.projects },
  { route: '/scheduled', label: 'Scheduled events', icon: icons.calendar },
  { route: '/settings', label: 'Settings', icon: icons.settings }
];

export function renderNavbar({ title, status }) {
  const bar = clear(document.getElementById('navbar'));

  const logo = el('img', {
    class: 'brand-mark',
    src: 'images/chsp-logo.png',
    alt: '',
    onerror: (e) => {
      e.target.style.background = 'conic-gradient(from 200deg, #f0356a, #ff9a3c, #b14bf4, #f0356a)';
      e.target.removeAttribute('src');
    }
  });

  bar.append(
    el('a', { class: 'brand', href: '#/' }, [logo, 'Come Holy Spirit']),
    el('span', { class: 'topbar-title', text: title || '' }),
    el('div', { class: 'topbar-spacer' }),
    uploadIndicator()
  );

  // Guests never see this bar's creator controls at all — StudioRoom swaps
  // to a stripped-down header in guest mode. This toggle only appears for
  // a signed-in creator, so they can preview what a guest sees.
  if (creator.isSignedIn() && !guestMode.isGuest()) {
    bar.append(
      el(
        'button',
        {
          class: 'guest-toggle',
          html: icons.guest,
          title: 'Preview the simplified guest view',
          onclick: () => {
            guestMode.set(true);
            window.location.reload();
          }
        },
        [document.createTextNode(' View as guest')]
      )
    );
  } else if (guestMode.isGuest()) {
    bar.append(
      el(
        'button',
        {
          class: 'guest-toggle',
          onclick: () => {
            guestMode.set(false);
            window.location.reload();
          }
        },
        ['← Back to creator view']
      )
    );
  }

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

function uploadIndicator() {
  const wrap = el('div', { class: 'upload-indicator', style: 'display:none' }, [
    el('span', { html: icons.cloud, style: 'width:14px;display:inline-flex' }),
    el('span', { class: 'upload-indicator-text' })
  ]);

  const paint = () => {
    const active = uploads.list();
    if (!active.length) {
      wrap.style.display = 'none';
      return;
    }
    const avg = Math.round(active.reduce((sum, u) => sum + u.percent, 0) / active.length);
    wrap.style.display = 'inline-flex';
    wrap.querySelector('.upload-indicator-text').textContent =
      active.length === 1 ? `Uploading ${active[0].label}… ${avg}%` : `Uploading ${active.length} tracks… ${avg}%`;
  };

  uploads.onChange(paint);
  paint();
  return wrap;
}

export function renderSidebar({ route, status }) {
  const side = clear(document.getElementById('sidebar'));

  // Guests get no sidebar navigation at all — they only ever see the room
  // they joined, never the creator's library.
  if (guestMode.isGuest()) return;

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
