/**
 * EntryPortal.js — the split shown before anyone reaches the app proper,
 * plus the two single-purpose landing screens for /host and /guest.
 *
 * Entry portal (path "/"): the neutral first-visit split between the two
 * sides. "Daniel & Tom" leads to the host sign-in; "I have a room code"
 * leads to the guest join flow.
 *
 * Host sign-in (path "/host", not yet signed in): the same sign-in used
 * from the split, shown on its own — this is what "/host" resolves to for
 * anyone who bookmarks or is sent that link directly. Once signed in, a
 * creator's home moves to "/host" (no longer a hash route).
 *
 * Guest landing (path "/guest"): the only thing a guest's home ever shows —
 * a way to join a room, and nothing else. No projects, no creation tools,
 * no schedule, no upload. A guest who leaves a room lands back here.
 */

import { el, clear, icons, toast, askText, creator, guestMode } from '../config.js';
import { gdrive } from '../services/gdriveService.js';

function brandBlock() {
  const logo = el('img', {
    class: 'entry-logo',
    src: 'images/chsp-logo.png',
    alt: 'Come Holy Spirit',
    onerror: (e) => e.target.remove()
  });

  return el('div', { class: 'entry-brand' }, [
    logo,
    el('hr', { class: 'entry-divider' }),
    el('h1', { class: 'entry-title', text: 'STUDIO' })
  ]);
}

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

  view.append(
    el('div', { class: 'entry-portal' }, [
      el('div', { class: 'entry-card' }, [
        brandBlock(),
        el('p', { class: 'entry-sub', text: 'Choose how you are joining today.' }),
        el('div', { class: 'entry-choices' }, [
          el(
            'button',
            { class: 'entry-choice', onclick: () => creatorSignIn(view, status) },
            [el('div', { html: icons.key }), el('h3', { text: 'Daniel & Tom' }), el('p', { text: 'Manage projects, start rooms, and review recordings.' })]
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

/** The /host landing for someone who isn't signed in yet. */
export async function renderHostSignIn(view) {
  clear(view);
  document.getElementById('navbar').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';

  let status = { linked: false };
  try {
    status = await gdrive.status();
  } catch {
    /* still show the card even if the API is briefly unreachable */
  }

  view.append(
    el('div', { class: 'entry-portal' }, [
      el('div', { class: 'entry-card' }, [
        brandBlock(),
        el('p', { class: 'entry-sub', text: 'Sign in to manage projects and start rooms.' }),
        el('div', { class: 'entry-choices', style: 'grid-template-columns:1fr;max-width:340px;margin:0 auto' }, [
          el(
            'button',
            { class: 'entry-choice', onclick: () => creatorSignIn(view, status) },
            [el('div', { html: icons.key }), el('h3', { text: 'Daniel & Tom' }), el('p', { text: 'Manage projects, start rooms, and review recordings.' })]
          )
        ])
      ])
    ])
  );
}

/**
 * The /guest landing — the entirety of a guest's "home". No projects, no
 * creation tools, no schedule, no upload: just a way in. Shown on first
 * visit to /guest, and again any time a guest leaves a room.
 */
export async function renderGuestLanding(view) {
  clear(view);
  document.getElementById('navbar').style.display = 'none';
  document.getElementById('sidebar').style.display = 'none';

  view.append(
    el('div', { class: 'entry-portal' }, [
      el('div', { class: 'entry-card' }, [
        brandBlock(),
        el('p', { class: 'entry-sub', text: 'Enter the code your host shared with you to join a session.' }),
        el('div', { class: 'entry-choices', style: 'grid-template-columns:1fr;max-width:340px;margin:0 auto' }, [
          el(
            'button',
            { class: 'entry-choice', onclick: () => guestJoin(view) },
            [el('div', { html: icons.guest }), el('h3', { text: 'Join a room' }), el('p', { text: 'Enter the code your host shared to join a session.' })]
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
  window.location.href = `${window.location.origin}/host`;
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