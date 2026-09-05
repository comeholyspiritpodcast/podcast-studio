/**
 * ProjectDetail.js — what a project card opens to now: the finished
 * recordings in that project, not the live room. "Record" from here starts
 * a fresh session in the same room (which still goes through the pre-join
 * device check, same as any other entry into a room).
 */

import { el, clear, icons, toast, formatBytes, askDangerConfirm, askText, slugify } from '../config.js';
import { gdrive } from '../services/gdriveService.js';
import { openModal } from './RoomScheduler.js';

export async function renderProjectDetail(view, { slug, status }) {
  clear(view);

  let project;
  try {
    project = await gdrive.getProject(slug);
  } catch (err) {
    view.append(
      el('div', { class: 'empty' }, [
        el('h3', { text: 'Project not found' }),
        el('p', { text: err.message || 'It may have been deleted, or the link is out of date.' }),
        el('a', { class: 'btn btn-primary', href: '#/', text: 'Back to library' })
      ])
    );
    return;
  }

  view.append(
    el('div', { class: 'studio-head' }, [
      el('div', {}, [
        el('h1', { text: project.name }),
        el('p', { class: 'page-sub', text: `Room code: ${project.roomCode || '—'}` })
      ]),
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn btn-sm', html: icons.edit, title: 'Rename', onclick: () => renameDialog(project, view, status) }),
      el('button', { class: 'btn btn-sm btn-danger-outline', html: icons.trash, title: 'Delete project', onclick: () => deleteFlow(project, view, status) }),
      el('a', { class: 'btn btn-sm btn-record', href: `#/room/${project.slug}` }, [el('span', { class: 'dot' }), 'Record'])
    ])
  );

  view.append(el('div', { class: 'loading', text: 'Loading recordings…' }));

  let files = [];
  try {
    const res = await gdrive.listRecordings(project.slug, project.folderId);
    files = (res.files || []).filter((f) => f.name !== 'project.json');
  } catch (err) {
    view.querySelector('.loading').remove();
    return toast(err.message, 'error');
  }
  view.querySelector('.loading').remove();

  if (!files.length) {
    view.append(
      el('div', { class: 'empty' }, [
        el('h3', { text: 'No recordings yet' }),
        el('p', { text: 'Press Record above to start this room\u2019s first session.' })
      ])
    );
    return;
  }

  const videoFiles = files.filter((f) => (f.mimeType || '').startsWith('video/'));
  if (videoFiles.length) {
    const featured = videoFiles[0];
    view.append(
      el('div', { class: 'asset', style: 'grid-template-columns: 1fr' }, [
        el('video', {
          controls: true,
          preload: 'metadata',
          poster: '',
          src: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(featured.id)}`
        })
      ])
    );
  }

  view.append(el('h1', { style: 'margin-top:24px', text: 'Recording files' }));

  const list = el('div', { class: 'assets' });
  for (const file of files) list.append(fileRow(file, project, view, status));
  view.append(list);
}

function fileRow(file, project, view, status) {
  const isAudio = (file.mimeType || '').startsWith('audio/');
  const isVideo = (file.mimeType || '').startsWith('video/');

  const meta = el('div', {}, [
    el('div', { class: 'asset-name', text: file.name }),
    el('div', {
      class: 'asset-meta',
      text: `${isAudio ? 'Audio' : isVideo ? 'Video' : 'File'} · ${formatBytes(file.size)} · ${new Date(file.createdTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
    })
  ]);

  const downloadUrl = gdrive.downloadUrl(file.id);

  const actions = el('div', { class: 'asset-actions' }, [
    el('a', { class: 'btn btn-sm', href: downloadUrl, html: icons.download, title: 'Download' }),
    file.webViewLink ? el('a', { class: 'btn btn-sm', href: file.webViewLink, target: '_blank', rel: 'noopener', text: 'Open in Drive' }) : null,
    el('button', {
      class: 'btn btn-sm btn-danger-outline',
      html: icons.trash,
      title: 'Delete recording',
      onclick: async () => {
        const ok = await askDangerConfirm({
          title: 'Delete this recording?',
          description: 'Moves the file to Google Drive Trash. Recoverable for 30 days from drive.google.com.',
          requirePhrase: 'DELETE'
        });
        if (!ok) return;
        try {
          await gdrive.deleteRecording(file.id);
          toast('Moved to Drive Trash', 'success');
          renderProjectDetail(view, { slug: project.slug, status });
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    })
  ]);

  return el('div', { class: 'asset', style: 'grid-template-columns:1fr auto' }, [meta, actions]);
}

async function renameDialog(project, view, status) {
  const nameInput = el('input', { class: 'input', value: project.name, maxlength: '80' });
  const slugInput = el('input', { class: 'input', value: project.slug });

  openModal({
    title: 'Rename project',
    description: 'Changing the room address changes the link immediately — old links stop working.',
    body: el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Project name' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Room address' }), slugInput])
    ]),
    confirmLabel: 'Save',
    onConfirm: async (close, setBusy) => {
      setBusy(true);
      try {
        const updated = await gdrive.updateProject(project.slug, project.folderId, {
          name: nameInput.value.trim(),
          slug: slugify(slugInput.value || nameInput.value)
        });
        close();
        toast('Project updated', 'success');
        window.location.hash = `#/project/${updated.slug}`;
        renderProjectDetail(view, { slug: updated.slug, status });
      } catch (err) {
        setBusy(false);
        toast(err.message, 'error');
      }
    }
  });
}

async function deleteFlow(project, view, status) {
  const ok = await askDangerConfirm({
    title: `Delete "${project.name}"?`,
    description: 'Moves the whole project — and every recording in it — to Google Drive Trash. Recoverable for 30 days from drive.google.com, not from here.',
    requirePhrase: project.name
  });
  if (!ok) return;

  try {
    await gdrive.deleteProject(project.slug, project.folderId);
    toast('Project moved to Drive Trash', 'success');
    window.location.hash = '#/';
  } catch (err) {
    toast(err.message, 'error');
  }
}
