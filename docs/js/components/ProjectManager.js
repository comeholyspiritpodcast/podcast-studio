/**
 * ProjectManager.js — the library dashboard: list, create, edit, delete.
 * Each project maps 1:1 to a folder inside /Podcast_Studio_Projects in Drive.
 */

import { el, clear, icons, toast, slugify, initials, askText, askDangerConfirm } from '../config.js';
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
  view.append(el('div', { class: 'loading', text: 'Loading…' }));

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
        el('h3', { text: 'Nothing here yet' }),
        el('p', { text: 'A project holds every take from one show. Create one to start recording.' }),
        el('button', { class: 'btn btn-primary', onclick: () => newProjectDialog(view, status) }, [
          'Create your first project'
        ])
      ])
    );
    return;
  }

  for (const project of data.projects) grid.append(projectCard(project, view, status));
  view.append(grid);
}

function projectCard(project, view, status) {
  const card = el('div', { class: 'card' });
  const link = el('a', { href: `#/project/${project.slug}`, style: 'display:contents;color:inherit;text-decoration:none' });

  const count = project.recordings || 0;
  link.append(
    el('div', { class: 'card-meta' }, [
      el('span', { html: icons.folder, style: 'display:inline-flex;width:16px' }),
      `${count} ${count === 1 ? 'recording' : 'recordings'}`,
      project.adHoc ? el('span', { class: 'guest-badge', style: 'margin-left:auto', text: 'Recorded folder' }) : null
    ])
  );

  const frame = el('div', { class: 'thumb-frame' });
  const names = project.name.split(/[,&]/).slice(0, 2);
  names.forEach((n) => frame.append(el('span', { text: initials(n.trim()) })));
  link.append(el('div', { class: 'card-thumb' }, [frame]));

  link.append(
    el('div', {}, [
      el('div', { class: 'card-title', text: project.name }),
      el('div', { class: 'card-slug', text: `Room code: ${project.roomCode || '—'}` })
    ])
  );

  card.append(link);

  card.append(
    el('div', { style: 'display:flex;gap:8px;margin-top:14px' }, [
      el('button', {
        class: 'btn btn-sm',
        html: icons.edit,
        title: 'Rename project or regenerate room code',
        onclick: (e) => { e.preventDefault(); renameDialog(project, view, status); }
      }),
      el('button', {
        class: 'btn btn-sm btn-danger-outline',
        html: icons.trash,
        title: 'Delete project',
        onclick: (e) => { e.preventDefault(); deleteProjectFlow(project, view, status); }
      })
    ])
  );

  return card;
}

async function renameDialog(project, view, status) {
  const nameInput = el('input', { class: 'input', value: project.name, maxlength: '80' });
  const slugInput = el('input', { class: 'input', value: project.slug });

  openModal({
    title: 'Rename project',
    description: 'Changing the room address changes the link immediately — old links stop working.',
    body: el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Project name' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Room address' }), slugInput]),
      el('div', { class: 'field' }, [
        el('label', { text: 'Guest room code' }),
        el('div', { class: 'hint', text: `Currently ${project.roomCode || '—'}. Regenerating invalidates the old code immediately.` })
      ])
    ]),
    confirmLabel: 'Save',
    onConfirm: async (close, setBusy) => {
      setBusy(true);
      try {
        await gdrive.updateProject(project.slug, project.folderId, {
          name: nameInput.value.trim(),
          slug: slugify(slugInput.value || nameInput.value)
        });
        close();
        toast('Project updated', 'success');
        renderProjects(view, { status });
      } catch (err) {
        setBusy(false);
        toast(err.message, 'error');
      }
    }
  });
}

async function deleteProjectFlow(project, view, status) {
  const confirmed = await askDangerConfirm({
    title: `Delete "${project.name}"?`,
    description: 'This moves the whole project — and every recording in it — to Google Drive Trash. Recoverable for 30 days from drive.google.com, not from here.',
    requirePhrase: project.name
  });
  if (!confirmed) return;

  try {
    await gdrive.deleteProject(project.slug, project.folderId);
    toast('Project moved to Drive Trash', 'success');
    renderProjects(view, { status });
  } catch (err) {
    toast(err.message, 'error');
  }
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
      el('button', { class: 'btn btn-primary', onclick: () => linkDrive() }, ['Link studio Drive'])
    ])
  );
}

async function linkDrive() {
  const key = await adminKey();
  gdrive.linkDrive(key);
}

function quickRecord() {
  const slug = `session-${Math.random().toString(36).slice(2, 7)}`;
  window.location.hash = `#/room/${slug}`;
}

export function newProjectDialog(view, status) {
  let slugTouched = false;

  const nameInput = el('input', { class: 'input', placeholder: 'Project name', maxlength: '80' });
  const slugInput = el('input', { class: 'input', placeholder: 'Room address (auto-filled from name)' });
  const descInput = el('input', { class: 'input', placeholder: 'Description (optional)' });

  nameInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = slugify(nameInput.value);
  });
  slugInput.addEventListener('input', () => { slugTouched = true; });

  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'Project name' }), nameInput]),
    el('div', { class: 'field' }, [
      el('label', { text: 'Room address' }),
      slugInput,
      el('div', { class: 'hint', text: 'Guests reach the room at /room/<address>. Letters, numbers and dashes.' })
    ]),
    el('div', { class: 'field' }, [el('label', { text: 'Description' }), descInput])
  ]);

  openModal({
    title: 'New project',
    description: 'Creates a matching folder in your Google Drive, plus a room code for guests.',
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
        toast(`Created ${project.name} — room code ${project.roomCode}`, 'success');
        renderProjects(view, { status });
      } catch (err) {
        setBusy(false);
        toast(err.message, 'error');
      }
    }
  });

  setTimeout(() => nameInput.focus(), 30);
}

/** Optional ADMIN_KEY, kept only in the owner's browser. Custom modal, not window.prompt. */
async function adminKey() {
  let key = localStorage.getItem('studio.adminKey');
  if (key === null) {
    key = (await askText({
      title: 'Admin key',
      description: 'Leave blank if ADMIN_KEY is not set on the server.',
      placeholder: 'Admin key',
      confirmLabel: 'Continue'
    })) || '';
    localStorage.setItem('studio.adminKey', key);
  }
  return key;
}
