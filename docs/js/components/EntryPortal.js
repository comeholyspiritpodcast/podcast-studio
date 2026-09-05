/**
 * EntryPortal.js — the split shown before anyone reaches the app proper.
 *
 * Creator: enters a shared access code (if the server has one configured)
 * and lands on the library. This is a lightweight gate, not per-person
 * Google login — see the note in server.js on CREATOR_ACCESS_CODE for why.
 *
 * Guest: enters a room code (set by the creator per project) and is taken
 * straight into that room's simplified studio view — no library, no
 * settings, nothing but the room.
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
    alt: '',
    onerror: (e) => e.target.removeAttribute('src')
  });

  view.append(
    el('div', { class: 'entry-portal' }, [
      el('div', { class: 'entry-card' }, [
        logo,
        el('h1', { class: 'entry-title', text: 'Come Holy Spirit Studio' }),
        el('p', { class: 'entry-sub', text: 'Choose how you are joining today.' }),
        el('div', { class: 'entry-choices' }, [
          el(
            'button',
            {
              class: 'entry-choice',
              onclick: () => creatorSignIn(view, status)
            },
            [el('div', { html: icons.key }), el('h3', { text: 'I\u2019m the Creator' }), el('p', { text: 'Manage projects, start rooms, and review recordings.' })]
          ),
          el(
            'button',
            {
              class: 'entry-choice',
              onclick: () => guestJoin(view)
            },
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
    confirmLabel: 'Join'
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
