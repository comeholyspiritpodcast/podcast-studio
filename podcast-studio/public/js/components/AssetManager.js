/**
 * AssetManager.js — takes from this session, plus everything already in the
 * project's Drive folder.
 *
 * With live upload on, a take is usually already in Drive by the time it
 * appears here; the row shows the tail finishing rather than a fresh upload.
 * Downloads link straight to Google's CDN rather than proxying through the
 * API server.
 */

import { el, clear, icons, toast, formatBytes, formatClock } from '../config.js';
import { gdrive } from '../services/gdriveService.js';

export function renderAssets(host, ctx) {
  clear(host);

  const { recorder } = ctx;
  if (!recorder.takes.length) return;

  host.append(
    el('div', { class: 'studio-head', style: 'margin-top:8px' }, [
      el('h1', { text: 'This session’s takes' }),
      el('div', { style: 'flex:1' }),
      el('button', {
        class: 'btn btn-sm',
        html: icons.download,
        title: 'Save every take to this computer',
        onclick: () => recorder.downloadAll()
      }),
      el('button', {
        class: 'btn btn-sm',
        html: icons.merge,
        title: 'Join parts recorded across a drop-out',
        onclick: () => joinDialog(host, ctx)
      })
    ])
  );

  const list = el('div', { class: 'assets' });
  for (const take of recorder.takes) list.append(assetRow(take, ctx, host));

  host.append(
    list,
    el('p', {
      class: 'hint',
      text: 'Takes upload to Drive while you record. The copy in this tab is only for instant preview and offline download.'
    })
  );
}

function assetRow(take, ctx, host) {
  const isAudio = take.track === 'audio';

  const preview = isAudio
    ? el('audio', { controls: true, src: take.url, style: 'width:100%' })
    : el('video', { controls: true, src: take.url, preload: 'metadata' });

  const progressFill = el('i');
  const progress = el('div', { class: 'progress' }, [progressFill]);
  const status = el('div', { class: 'asset-meta' });

  const meta = el('div', {}, [
    el('div', { class: 'asset-name', text: take.filename }),
    el('div', {
      class: 'asset-meta',
      text: `${isAudio ? 'Audio only' : 'Video + audio'} · part ${take.part} · ${formatBytes(take.size)} · ${formatClock(take.duration)}`
    }),
    status,
    progress
  ]);

  const actions = el('div', { class: 'asset-actions' });

  const localBtn = el('button', {
    class: 'btn btn-sm',
    html: icons.download,
    title: 'Save this copy to your computer',
    onclick: () => ctx.recorder.download(take)
  });

  const driveBtn = el('a', {
    class: 'btn btn-sm btn-primary',
    target: '_blank',
    rel: 'noopener',
    text: 'Open in Drive',
    style: 'display:none'
  });

  actions.append(localBtn, driveBtn);

  /* live state */

  const paint = () => {
    if (take.uploaded && take.driveFile) {
      status.className = 'status-uploaded';
      status.textContent = 'In Google Drive';
      progress.style.display = 'none';
      driveBtn.href = take.driveFile.webViewLink || gdrive.downloadUrl(take.driveFile.id);
      driveBtn.style.display = 'inline-flex';
      return;
    }

    if (!take.uploader) {
      status.className = 'status-error';
      status.textContent = 'Not uploaded — download it before closing this tab.';
      progress.style.display = 'none';
      return;
    }

    const percent = take.size ? Math.min(100, Math.round((take.uploader.committed / take.size) * 100)) : 0;
    progressFill.style.width = `${percent}%`;
    status.className = 'asset-meta';
    status.textContent = take.uploader.failed
      ? 'Upload interrupted — the local copy is intact.'
      : `Finishing upload… ${percent}%`;
  };

  paint();

  if (take.uploader && !take.uploaded) {
    take.uploader.addEventListener('progress', paint);
    take.uploader.addEventListener('done', paint);
    take.uploader.addEventListener('error', paint);
  }

  actions.append(
    el('button', {
      class: 'btn btn-sm btn-ghost',
      text: 'Discard local copy',
      onclick: () => {
        if (!take.uploaded && !window.confirm('This take is not confirmed in Drive yet. Discard the local copy?')) return;
        ctx.recorder.remove(take.id);
        renderAssets(host, ctx);
      }
    })
  );

  return el('div', { class: 'asset' }, [preview, meta, actions]);
}

/* ------------------------------------------------------------------ *
 * Joining parts
 * ------------------------------------------------------------------ */

async function joinDialog(host, ctx) {
  const { openModal } = await import('./RoomScheduler.js');

  let files = [];
  try {
    const res = await gdrive.listRecordings(ctx.slug, ctx.project && ctx.project.folderId);
    files = res.files || [];
  } catch (err) {
    return toast(`Could not read the project folder: ${err.message}`, 'error');
  }

  // Parts of one speaker's one track, in order.
  const groups = new Map();
  for (const file of files) {
    const props = file.appProperties || {};
    if (!props.speaker) continue;
    const key = `${props.speaker}|${props.track}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  const joinable = [...groups.entries()]
    .map(([key, list]) => [key, list.sort((a, b) => Number((a.appProperties || {}).part || 0) - Number((b.appProperties || {}).part || 0))])
    .filter(([, list]) => list.length > 1);

  if (!joinable.length) {
    return toast('Nothing to join — every speaker recorded in one continuous part.', '');
  }

  // Joining on the server moves the whole recording through the API host, so
  // when it's switched off we show the editor route instead of a dead button.
  if (ctx.status && ctx.status.joinEnabled === false) {
    return openModal({
      title: 'Join these parts in your editor',
      description:
        'Server-side joining is off so recordings never pass through the API host. The parts are already separate, correctly ordered files in Drive.',
      body: el('div', {}, [
        ...joinable.map(([key, list]) => {
          const [speaker, track] = key.split('|');
          return el('div', { class: 'field' }, [
            el('label', { text: `${speaker} — ${track}`, style: 'color:var(--text)' }),
            el('div', { class: 'hint', text: list.map((f) => f.name).join('  →  ') })
          ]);
        }),
        el('p', {
          class: 'hint',
          text:
            'Drop each speaker’s parts onto one timeline track in that order. There is no overlap — part 2 starts where part 1 stopped — so butting them end to end is correct. Premiere, Resolve, Final Cut and Audition all handle this natively.'
        })
      ]),
      confirmLabel: 'Got it',
      onConfirm: (close) => close()
    });
  }

  const body = el('div', {});
  const chosen = new Set();

  for (const [key, list] of joinable) {
    const [speaker, track] = key.split('|');
    const id = `join-${key.replace(/\W/g, '')}`;
    const input = el('input', { type: 'checkbox', id, style: 'margin-right:8px' });
    input.addEventListener('change', () => (input.checked ? chosen.add(key) : chosen.delete(key)));

    body.append(
      el('div', { class: 'field' }, [
        el('label', { for: id, style: 'display:flex;align-items:center;color:var(--text)' }, [
          input,
          `${speaker} — ${track} · ${list.length} parts`
        ]),
        el('div', { class: 'hint', text: list.map((f) => f.name).join('  →  ') })
      ])
    );
  }

  const progressText = el('div', { class: 'hint' });
  body.append(progressText);

  openModal({
    title: 'Join parts',
    description:
      'Stitches each speaker’s parts into one continuous file on the server, without re-encoding. The original parts are left untouched.',
    body,
    confirmLabel: 'Join selected',
    onConfirm: async (close, setBusy) => {
      if (!chosen.size) return toast('Pick at least one track to join.', 'error');
      setBusy(true);

      for (const key of chosen) {
        const list = groups.get(key);
        const [speaker, track] = key.split('|');
        progressText.textContent = `Joining ${speaker} — ${track}…`;

        try {
          const file = await gdrive.joinParts(
            {
              fileIds: list.map((f) => f.id),
              outputName: `${speaker}_${track}_JOINED.webm`,
              folderId: (ctx.project && ctx.project.folderId) || undefined
            },
            (percent) => { progressText.textContent = `Joining ${speaker} — ${track}… ${percent}%`; }
          );
          toast(`${file.name} is ready in Drive`, 'success');
        } catch (err) {
          toast(err.message, 'error');
          setBusy(false);
          return;
        }
      }

      close();
    }
  });
}
