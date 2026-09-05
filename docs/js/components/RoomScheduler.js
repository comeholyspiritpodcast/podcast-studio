/**
 * RoomScheduler.js — scheduled sessions and guest invite links.
 *
 * Scheduling is intentionally local (localStorage): a session is just a room
 * address plus a time, and the room itself needs no server-side booking.
 * Also exports the modal helper shared by the other components.
 */

import { el, clear, icons, toast, slugify } from '../config.js';
import { gdrive } from '../services/gdriveService.js';

const STORE_KEY = 'studio.scheduled';

const readEvents = () => {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
};
const writeEvents = (events) => localStorage.setItem(STORE_KEY, JSON.stringify(events));

export const roomUrl = (slug) => `${window.location.origin}/room/${slug}`;

export async function copyInvite(slug) {
  const url = roomUrl(slug);
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied', 'success');
  } catch {
    showLinkModal(url);
  }
}

/** Fallback when the Clipboard API is unavailable — a selectable field, not window.prompt(). */
function showLinkModal(url) {
  const input = el('input', { class: 'input', value: url, readonly: true, onclick: (e) => e.target.select() });
  openModal({
    title: 'Invite link',
    description: 'Your browser blocked automatic copying — select the text below and copy it manually.',
    body: el('div', { class: 'field' }, [input]),
    confirmLabel: 'Done',
    onConfirm: (close) => close()
  });
  setTimeout(() => input.select(), 30);
}

/* ---------------- scheduled events view ---------------- */

export async function renderScheduler(view, { status }) {
  clear(view);

  view.append(
    el('h1', { class: 'page-head', text: 'Scheduled events' }),
    el('p', { class: 'page-sub', text: 'Pick a time, send the link. Guests join in the browser with no account.' }),
    el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-primary', html: icons.plus, onclick: () => scheduleDialog(view, status) })
    ])
  );

  const events = readEvents().sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  if (!events.length) {
    view.append(
      el('div', { class: 'empty' }, [
        el('h3', { text: 'Nothing scheduled' }),
        el('p', { text: 'Schedule a session to generate a guest link ahead of time.' }),
        el('button', { class: 'btn btn-primary', onclick: () => scheduleDialog(view, status) }, ['Schedule a session'])
      ])
    );
    return;
  }

  const list = el('div', { class: 'assets' });

  for (const event of events) {
    const when = new Date(event.startsAt);
    list.append(
      el('div', { class: 'asset', style: 'grid-template-columns: 1fr auto' }, [
        el('div', {}, [
          el('div', { class: 'asset-name', text: event.title }),
          el('div', {
            class: 'asset-meta',
            text: `${when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · /room/${event.slug}`
          })
        ]),
        el('div', { class: 'asset-actions' }, [
          el('button', { class: 'btn btn-sm', html: icons.link, onclick: () => copyInvite(event.slug) }),
          el('a', { class: 'btn btn-sm', href: `#/room/${event.slug}` }, ['Open studio']),
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Remove',
            onclick: () => {
              writeEvents(readEvents().filter((e) => e.id !== event.id));
              renderScheduler(view, { status });
            }
          })
        ])
      ])
    );
  }

  view.append(list);
}

function scheduleDialog(view, status) {
  const title = el('input', { class: 'input', placeholder: 'Episode 12 — guest interview' });
  const slug = el('input', { class: 'input', placeholder: 'episode-12' });
  const when = el('input', { class: 'input', type: 'datetime-local' });

  title.addEventListener('input', () => { slug.value = slugify(title.value); });

  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  when.value = new Date(start.getTime() - start.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  openModal({
    title: 'Schedule a session',
    description: 'The room stays open — guests can join any time from the link.',
    body: el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Session title' }), title]),
      el('div', { class: 'field' }, [el('label', { text: 'Room address' }), slug]),
      el('div', { class: 'field' }, [el('label', { text: 'Starts' }), when])
    ]),
    confirmLabel: 'Save session',
    onConfirm: (close) => {
      if (!title.value.trim()) return toast('Give the session a title.', 'error');

      const event = {
        id: `evt-${Date.now()}`,
        title: title.value.trim(),
        slug: slugify(slug.value || title.value),
        startsAt: new Date(when.value || Date.now()).toISOString()
      };
      writeEvents(readEvents().concat(event));
      close();
      copyInvite(event.slug);
      renderScheduler(view, { status });
    }
  });

  setTimeout(() => title.focus(), 30);
}

/* ---------------- settings view ---------------- */

export async function renderSettings(view, { status }) {
  clear(view);

  view.append(
    el('h1', { class: 'page-head', text: 'Settings' }),
    el('p', { class: 'page-sub', text: 'Storage and capture defaults for this browser.' })
  );

  const storage = el('div', { class: 'asset', style: 'grid-template-columns: 1fr auto' }, [
    el('div', {}, [
      el('div', { class: 'asset-name', text: 'Studio Google Drive' }),
      el('div', {
        class: 'asset-meta',
        text: status.linked
          ? 'Linked. Every take from every guest uploads into Podcast_Studio_Projects while recording.'
          : status.message || 'Not linked. Takes are recorded locally and must be downloaded by hand.'
      })
    ]),
    el('button', {
      class: `btn btn-sm${status.linked ? '' : ' btn-primary'}`,
      text: status.linked ? 'Re-link' : 'Link Drive',
      onclick: () => gdrive.linkDrive(localStorage.getItem('studio.adminKey') || '')
    })
  ]);

  const nameInput = el('input', {
    class: 'input',
    value: localStorage.getItem('studio.name') || '',
    placeholder: 'Your name as guests see it'
  });
  nameInput.addEventListener('change', () => {
    localStorage.setItem('studio.name', nameInput.value.trim());
    toast('Display name saved', 'success');
  });

  view.append(
    storage,
    el('div', { class: 'asset', style: 'grid-template-columns: 1fr' }, [
      el('div', { class: 'field', style: 'margin:0' }, [el('label', { text: 'Display name' }), nameInput])
    ]),
    el('div', { class: 'asset', style: 'grid-template-columns: 1fr' }, [
      el('div', {}, [
        el('div', { class: 'asset-name', text: 'Creator sign-in' }),
        el('div', {
          class: 'asset-meta',
          text: status.creatorGateEnabled
            ? 'A shared access code is required to sign in as Creator (CREATOR_ACCESS_CODE is set on the server).'
            : 'No access code is set — anyone who taps "I\u2019m the Creator" gets in. Set CREATOR_ACCESS_CODE on the server to require one.'
        })
      ])
    ]),
    el('div', { class: 'asset', style: 'grid-template-columns: 1fr' }, [
      el('div', {}, [
        el('div', { class: 'asset-name', text: 'MP4 / MP3 export' }),
        el('div', {
          class: 'asset-meta',
          text: status.exportEnabled
            ? 'On — exporting re-encodes on the server (bandwidth cost, see README).'
            : 'Off — recordings stay as WebM, which already plays in every modern editor and most players. Set ENABLE_SERVER_EXPORT=true on the server to turn this on.'
        })
      ])
    ]),
    el('button', {
      class: 'btn btn-sm',
      text: 'Sign out of Creator',
      onclick: async () => {
        const { creator } = await import('../config.js');
        creator.signOut();
        window.location.hash = '#/';
        window.location.reload();
      }
    })
  );
}

/* ---------------- shared modal ---------------- */

export function openModal({ title, description, body, confirmLabel = 'Confirm', onConfirm }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (previous && previous.focus) previous.focus();
  };

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const confirmBtn = el('button', { class: 'btn btn-primary', text: confirmLabel });
  const setBusy = (busy) => {
    confirmBtn.disabled = busy;
    confirmBtn.textContent = busy ? 'Working…' : confirmLabel;
  };
  confirmBtn.addEventListener('click', () => onConfirm(close, setBusy));

  const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('h2', { text: title }),
    description ? el('p', { text: description }) : null,
    body,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: close }),
      confirmBtn
    ])
  ]);

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (e.target === backdrop) close(); }
  }, [modal]);

  root.append(backdrop);
  return close;
}
