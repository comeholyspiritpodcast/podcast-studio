/**
 * ProjectManager.js — the projects dashboard: list, create, edit.
 * Each project maps 1:1 to a folder inside /Podcast_Studio_Projects in Drive.
 */

import { el, clear, icons, toast, slugify, initials } from '../config.js';
import { gdrive } from '../services/gdriveService.js';
import { openModal } from './RoomScheduler.js';

export async function renderProjects(view, { status }) {
  clear(view);

  if (!status.linked) return renderLinkPrompt(view, status.message);

  view.append(
    el('div', { class: 'toolbar' }, [
      el('button', { class: 'btn btn-record', onclick: () => quickRecord() }, [
        el('span', { class: 'dot' }),
        'Record'
      ]),
      el('button', { class: 'btn', onclick: () => (window.location.hash = '#/scheduled') }, ['Schedule']),
      el('button', { class: 'btn', html: icons.upload, onclick: () => toast('Open a project to upload takes into it.') }),
      el('div', { class: 'toolbar-spacer' }),
      el('button', { class: 'btn btn-primary', html: icons.plus, onclick: () => newProjectDialog(view, status) })
    ])
  );

  const grid = el('div', { class: 'grid' });
  view.append(el('div', { class: 'loading', text: 'Loading projects…' }));

  let data;
  try {
    data = await gdrive.listProjects();
  } catch (err) {
    clear(view);
    return renderLinkPrompt(view, err.message);
  }

  view.querySelector('.loading').remove();

  if (!data.projects.length) {
    view.append(
      el('div', { class: 'empty' }, [
        el('h3', { text: 'No projects yet' }),
        el('p', { text: 'A project holds every take from one show. Create one to start recording.' }),
        el('button', { class: 'btn btn-primary', onclick: () => newProjectDialog(view, status) }, [
          'Create your first project'
        ])
      ])
    );
    return;
  }

  for (const project of data.projects) grid.append(projectCard(project));
  view.append(grid);
}

function projectCard(project) {
  const card = el('a', { class: 'card', href: `#/room/${project.slug}` });

  const count = project.recordings || 0;
  card.append(
    el('div', { class: 'card-meta' }, [
      el('span', { html: icons.folder, style: 'display:inline-flex;width:16px' }),
      `${count} ${count === 1 ? 'recording' : 'recordings'}`
    ])
  );

  const frame = el('div', { class: 'thumb-frame' });
  const names = project.name.split(/[,&]/).slice(0, 2);
  names.forEach((n) => frame.append(el('span', { text: initials(n.trim()) })));
  card.append(el('div', { class: 'card-thumb' }, [frame]));

  card.append(
    el('div', {}, [
      el('div', { class: 'card-title', text: project.name }),
      el('div', { class: 'card-slug', text: `/room/${project.slug}` })
    ])
  );

  return card;
}

function renderLinkPrompt(view, message) {
  view.append(
    el('h1', { class: 'page-head', text: 'Record multitrack, keep the files' }),
    el('p', {
      class: 'page-sub',
      text: 'Each person is recorded locally at full quality, then every track lands in your own Google Drive.'
    }),
    el('div', { class: 'empty' }, [
      el('h3', { text: 'Studio Drive is not linked' }),
      el('p', {
        text:
          message ||
          'Every recording goes to one Google account. Open /auth/owner on the API server, signed in as that account, to link it once.'
      }),
      el('button', { class: 'btn btn-primary', onclick: () => gdrive.linkDrive(linkKey()) }, ['Link studio Drive'])
    ])
  );
}

function quickRecord() {
  const slug = `session-${Math.random().toString(36).slice(2, 7)}`;
  window.location.hash = `#/room/${slug}`;
}

export function newProjectDialog(view, status) {
  let slugTouched = false;

  const nameInput = el('input', { class: 'input', placeholder: 'Eve & The Everyday Saint', maxlength: '80' });
  const slugInput = el('input', { class: 'input', placeholder: 'eve-and-the-everyday-saint' });
  const descInput = el('input', { class: 'input', placeholder: 'Weekly interview show' });

  nameInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = slugify(nameInput.value);
  });
  slugInput.addEventListener('input', () => { slugTouched = true; });

  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'Project name' }), nameInput]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Room address' }),
      slugInput,
      el('div', { class: 'hint', text: 'Guests join at /room/<address>. Letters, numbers and dashes.' })
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Description (optional)' }), descInput])
  ]);

  openModal({
    title: 'New project',
    description: 'Creates a matching folder in your Google Drive.',
    body,
    confirmLabel: 'Create project',
    onConfirm: async (close, setBusy) => {
      const name = nameInput.value.trim();
      if (!name) return toast('Give the project a name.', 'error');

      setBusy(true);
      try {
        const project = await gdrive.createProject({
          name,
          slug: slugify(slugInput.value || name),
          description: descInput.value.trim()
        });
        close();
        toast(`Created ${project.name}`, 'success');
        renderProjects(view, { status });
      } catch (err) {
        setBusy(false);
        toast(err.message, 'error');
      }
    }
  });

  setTimeout(() => nameInput.focus(), 30);
}

/** Optional ADMIN_KEY, kept only in the owner's browser. */
function linkKey() {
  let key = localStorage.getItem('studio.adminKey');
  if (key === null) {
    key = window.prompt('Admin key (leave blank if ADMIN_KEY is not set on the server)') || '';
    localStorage.setItem('studio.adminKey', key);
  }
  return key;
}
