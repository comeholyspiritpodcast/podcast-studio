/**
 * EntryPortal.js — the split shown before anyone reaches the app proper.
 *
 * Creator: enters a shared access code (if the server has one configured)
 * and lands on the library.
 *
 * Guest: enters a room code (set by the creator per project), then is
 * routed to that room — where the device-check screen (see StudioRoom's
 * showPreJoin) is the very next thing they see, same as a creator pressing
 * Record.
 */

import { el, clear, icons, toast, askText, creator, guestMode } from '../config.js';
import { gdrive } from '../services/gdriveService.js';

export async function renderEntryPortal(view) {
  clear(view);
  document.getElementById('navbar').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';

  let status = { linked: false };
  try {
    status = await gdrive.status();
  } catch {
    /* still show the portal even if the API is briefly unreachable */
  }

  const logo = el('img', {
    class: 'entry-logo',
    src: 'images/chsp-logo.png',
    alt: 'Come Holy Spirit',
    onerror: (e) => e.target.remove()
  });

  view.append(
    el('div', { class: 'entry-portal' }, [
      el('div', { class: 'entry-card' }, [
        logo,
        el('h1', { class: 'entry-title' }, [
          el('span', { class: 'script-name', text: 'Come Holy Spirit' }),
          ' Studio'
        ]),
        el('p', { class: 'entry-sub', text: 'Choose how you are joining today.' }),
        el('div', { class: 'entry-choices' }, [
          el(
            'button',
            { class: 'entry-choice', onclick: () => creatorSignIn(view, status) },
            [el('div', { html: icons.key }), el('h3', { text: 'I\u2019m the Creator' }), el('p', { text: 'Manage projects, start rooms, and review recordings.' })]
          ),
          el(
            'button',
            { class: 'entry-choice', onclick: () => guestJoin(view) },
            [el('div', { html: icons.guest }), el('h3', { text: 'I have a room code' }), el('p', { text: 'Enter the code your host shared to join a session.' })]
          )
        ])
      ])
    ])
  );
}

async function creatorSignIn(view, status) {
  let code = '';

  if (status.creatorGateEnabled) {
    code = await askText({
      title: 'Creator sign-in',
      description: 'Enter the studio access code.',
      placeholder: 'Access code',
      confirmLabel: 'Sign in'
    });
    if (code === null) return;
  }

  try {
    const res = await gdrive.creatorLogin(code);
    if (!res.ok) return toast('That code isn\u2019t right.', 'error');
  } catch (err) {
    return toast(err.message, 'error');
  }

  creator.signIn(code);
  guestMode.set(false);
  document.getElementById('navbar').style.display = '';
  document.getElementById('sidebar').style.display = '';
  window.location.hash = '#/';
  window.location.reload();
}

async function guestJoin(view) {
  const code = await askText({
    title: 'Join a room',
    description: 'Enter the code your host shared with you.',
    placeholder: 'Room code',
    confirmLabel: 'Continue'
  });
  if (!code) return;

  let room;
  try {
    room = await gdrive.resolveRoomCode(code);
  } catch (err) {
    return toast(err.message || 'That code doesn\u2019t match a room.', 'error');
  }

  guestMode.set(true);
  document.getElementById('navbar').style.display = '';
  document.getElementById('sidebar').style.display = '';
  window.location.hash = `#/room/${room.slug}`;
  window.location.reload();
}
