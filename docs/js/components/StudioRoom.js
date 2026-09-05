/**
 * StudioRoom.js — the recording room.
 *
 * Video grid with self view and remote guests, active-speaker highlight,
 * per-tile level meters, controls bar, host-synchronised recording, and a
 * live indicator showing how far behind Drive is while the take runs.
 *
 * A guest (guestMode.isGuest()) sees a stripped-down version: no device
 * pickers, no rename, no invite link, no delete/export controls in the
 * asset list below.
 */

import { el, clear, icons, toast, formatClock, formatBytes, UPLOAD, askText, guestMode, creator, uploads } from '../config.js';
import { WebRTCService, meterStream } from '../services/webrtcService.js';
import { RecorderService } from '../services/recorderService.js';
import { gdrive } from '../services/gdriveService.js';
import { renderAssets } from './AssetManager.js';
import { copyInvite } from './RoomScheduler.js';

let active = null;

export function teardownStudio() {
  if (!active) return;
  active.stopMeters.forEach((stop) => stop());
  active.rtc.leave();
  clearInterval(active.timer);
  window.removeEventListener('beforeunload', active.beforeUnload);
  active = null;
}

export async function renderStudio(view, { slug, status }) {
  clear(view);
  teardownStudio();

  const isGuest = guestMode.isGuest();

  const displayName = localStorage.getItem('studio.name') || (await askDisplayName());
  const rtc = new WebRTCService();
  const recorder = new RecorderService();
  const tiles = new Map();
  const stopMeters = [];

  let project = null;
  const wasPreExisting = await (async () => {
    try {
      project = await gdrive.getProject(slug);
      return true;
    } catch {
      return false; // ad-hoc room: no project.json yet
    }
  })();

  active = { rtc, recorder, stopMeters, timer: 0, beforeUnload: null };

  /* ---------- header ---------- */

  const titleEl = el('h1', { text: (project && project.name) || slug });

  const recPill = el('span', { class: 'rec-pill', style: 'display:none' }, [
    el('span', { class: 'blink' }),
    el('span', { class: 'clock', text: '00:00:00' })
  ]);

  const cloudPill = el('span', { class: 'rec-pill cloud', style: 'display:none' }, [
    el('span', { class: 'cloud-icon', html: icons.cloud, style: 'width:14px;display:inline-flex' }),
    el('span', { class: 'cloud-text', text: 'Uploading live' })
  ]);

  const headerButtons = [];

  if (isGuest) {
    headerButtons.push(el('span', { class: 'guest-badge' }, [el('span', { html: icons.guest, style: 'width:13px;display:inline-flex' }), 'Guest']));
  } else {
    if (wasPreExisting) {
      headerButtons.push(
        el('button', {
          class: 'btn btn-sm',
          html: icons.edit,
          title: 'Rename room',
          onclick: () => renameRoom(project, slug, titleEl)
        })
      );
    }
    headerButtons.push(
      el('button', { class: 'btn btn-sm', html: icons.link, title: 'Copy invite link', onclick: () => copyInvite(slug) })
    );
  }

  headerButtons.push(el('a', { class: 'btn btn-sm btn-ghost', href: '#/', html: icons.leave, title: 'Leave room' }));

  view.append(
    el('div', { class: 'studio-head' }, [
      el('div', {}, [titleEl, el('p', { class: 'page-sub', text: `/room/${slug}` })]),
      recPill,
      cloudPill,
      el('div', { style: 'flex:1' }),
      ...headerButtons
    ])
  );

  const grid = el('div', { class: 'video-grid' });
  const assetsHost = el('div', { class: 'assets-host' });
  view.append(grid);

  /* ---------- controls ---------- */

  const micBtn = el('button', { class: 'btn ctrl-on', html: icons.mic, title: 'Mute microphone' });
  const camBtn = el('button', { class: 'btn ctrl-on', html: icons.camera, title: 'Turn camera off' });
  const recBtn = el('button', { class: 'btn btn-record' }, [el('span', { class: 'dot' }), 'Start recording']);
  const audioSelect = el('select', { class: 'select', 'aria-label': 'Microphone' });
  const videoSelect = el('select', { class: 'select', 'aria-label': 'Camera' });

  const controlChildren = [micBtn, camBtn];
  // Device pickers are a creator convenience — guests get the simplest
  // possible controls bar (mute, camera, record).
  if (!isGuest) controlChildren.push(audioSelect, videoSelect);
  controlChildren.push(el('div', { class: 'spacer' }), recBtn);

  const controls = el('div', { class: 'controls' }, controlChildren);

  view.append(controls, assetsHost);

  /* ---------- local media ---------- */

  let localStream;
  try {
    localStream = await rtc.startLocalMedia();
  } catch {
    grid.append(
      el('div', { class: 'empty' }, [
        el('h3', { text: 'Camera and microphone are blocked' }),
        el('p', { text: 'Allow access from the icon in your browser’s address bar, then reload this page.' })
      ])
    );
    controls.remove();
    return;
  }

  addTile('self', `${displayName} (you)`, localStream, true);
  if (!isGuest) await populateDevices();

  /* ---------- signalling ---------- */

  rtc.join(slug, displayName);
  rtc.publishState({ muted: false, cameraOff: false, name: displayName });

  rtc.addEventListener('peer', ({ detail }) => addTile(detail.id, detail.name, detail.stream || null, false));

  rtc.addEventListener('peer-left', ({ detail }) => {
    const tile = tiles.get(detail.id);
    if (tile) tile.node.remove();
    tiles.delete(detail.id);
  });

  rtc.addEventListener('state', ({ detail }) => {
    const tile = tiles.get(detail.id);
    if (!tile) return;
    tile.nameEl.textContent = detail.name;
    tile.mutedEl.style.display = detail.muted ? 'inline-flex' : 'none';
    tile.off.style.display = detail.cameraOff ? 'grid' : 'none';
  });

  rtc.addEventListener('error', ({ detail }) => toast(detail.message, 'error'));
  rtc.addEventListener('recording:start', ({ detail }) => beginRecording(detail.sessionId, false));
  rtc.addEventListener('recording:stop', () => endRecording(false));

  /* ---------- upload feedback (per-room pill + dashboard-wide bus) ---------- */

  recorder.addEventListener('upload-progress', ({ detail }) => {
    const backlog = recorder.backlog();
    const text = backlog > UPLOAD.warnBacklogBytes ? `Drive is ${formatBytes(backlog)} behind` : 'Uploading live to Drive';
    cloudPill.querySelector('.cloud-text').textContent = text;
    cloudPill.classList.toggle('lagging', backlog > UPLOAD.warnBacklogBytes);

    const id = `${detail.track}`;
    uploads.start(id, `${displayName} — ${detail.track}`);
    uploads.progress(id, detail.percent || 0);
  });

  recorder.addEventListener('upload-error', ({ detail }) => {
    cloudPill.querySelector('.cloud-text').textContent = 'Live upload stopped — take is safe locally';
    cloudPill.classList.add('lagging');
    toast(`Live upload paused: ${detail.message}`, 'error');
  });

  recorder.addEventListener('uploaded', ({ detail }) => {
    uploads.finish(detail.take.track);
    toast(`${detail.take.filename} is in Drive`, 'success');
    refreshAssets();
    if (!wasPreExisting) transformToRecordedFolder();
  });

  /* ---------- control wiring ---------- */

  let muted = false;
  let cameraOff = false;

  micBtn.addEventListener('click', () => {
    muted = !muted;
    rtc.setMuted(muted);
    micBtn.innerHTML = muted ? icons.micOff : icons.mic;
    micBtn.className = `btn ${muted ? 'ctrl-off' : 'ctrl-on'}`;
    micBtn.title = muted ? 'Unmute microphone' : 'Mute microphone';
    const self = tiles.get('self');
    if (self) self.mutedEl.style.display = muted ? 'inline-flex' : 'none';
  });

  camBtn.addEventListener('click', () => {
    cameraOff = !cameraOff;
    rtc.setCameraOff(cameraOff);
    camBtn.innerHTML = cameraOff ? icons.cameraOff : icons.camera;
    camBtn.className = `btn ${cameraOff ? 'ctrl-off' : 'ctrl-on'}`;
    camBtn.title = cameraOff ? 'Turn camera on' : 'Turn camera off';
    const self = tiles.get('self');
    if (self) self.off.style.display = cameraOff ? 'grid' : 'none';
  });

  const switchDevice = async () => {
    if (recorder.recording) return toast('Finish the take before switching inputs.', 'error');
    try {
      localStream = await rtc.startLocalMedia({
        audioDeviceId: audioSelect.value || undefined,
        videoDeviceId: videoSelect.value || undefined
      });
      const self = tiles.get('self');
      if (self) self.video.srcObject = localStream;
      toast('Input switched', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  audioSelect.addEventListener('change', switchDevice);
  videoSelect.addEventListener('change', switchDevice);

  recBtn.addEventListener('click', () => {
    if (recorder.recording) {
      rtc.broadcastRecordStop();
      endRecording(true);
    } else {
      const sessionId = `take-${Date.now()}`;
      rtc.broadcastRecordStart(sessionId);
      beginRecording(sessionId, true);
    }
  });

  // Browsers no longer show custom beforeunload text (a security measure
  // against fake "are you sure" phishing), but returnValue still triggers
  // the native confirmation dialog itself — which is the actual protection
  // being asked for here. The specific wording is set for browsers that
  // still honour it, and documented in case someone checks the source.
  active.beforeUnload = (e) => {
    if (recorder.recording || recorder.backlog() > 0) {
      e.preventDefault();
      e.returnValue = 'Leaving the recording room will end your side of the recording.';
      return e.returnValue;
    }
  };
  window.addEventListener('beforeunload', active.beforeUnload);

  /* ---------- recording ---------- */

  const sessionName = `${slug}-${new Date().toISOString().slice(0, 10)}`;

  async function beginRecording(sessionId, local) {
    if (recorder.recording) return;

    recBtn.disabled = true;
    try {
      await recorder.start(localStream, {
        sessionId,
        speaker: displayName,
        sessionName,
        projectSlug: slug,
        projectName: (project && project.name) || slug,
        liveUpload: UPLOAD.live && status.linked
      });
    } catch (err) {
      recBtn.disabled = false;
      return toast(err.message, 'error');
    }
    recBtn.disabled = false;

    recBtn.className = 'btn btn-danger';
    recBtn.textContent = 'Stop recording';
    recPill.style.display = 'inline-flex';
    if (UPLOAD.live && status.linked) cloudPill.style.display = 'inline-flex';

    active.timer = setInterval(() => {
      recPill.querySelector('.clock').textContent = formatClock(recorder.elapsed());
    }, 500);

    if (!local) toast('Recording started by another participant', 'success');
  }

  async function endRecording(local) {
    if (!recorder.recording) return;
    clearInterval(active.timer);

    const takes = await recorder.stop();

    recBtn.className = 'btn btn-record';
    clear(recBtn).append(el('span', { class: 'dot' }), document.createTextNode('Start recording'));
    recPill.style.display = 'none';
    cloudPill.querySelector('.cloud-text').textContent = 'Finishing upload…';

    if (takes.length) {
      const behind = recorder.backlog();
      toast(
        behind > 1024 * 1024 ? `Take saved — ${formatBytes(behind)} left to upload` : 'Take saved — upload finishing now',
        'success'
      );
      refreshAssets();
    }
    if (!local) toast('Recording stopped', '');

    setTimeout(() => {
      if (!recorder.recording && !recorder.backlog()) cloudPill.style.display = 'none';
    }, 4000);
  }

  function refreshAssets() {
    renderAssets(assetsHost, { recorder, project, slug, sessionName, status, isGuest });
  }

  /**
   * A room that was never explicitly saved as a project before recording
   * (an ad-hoc /room/whatever link) becomes a "Recorded Folder" once it has
   * a finished take: the live studio chrome collapses to a compact preview
   * plus the file list, since there's nothing left to record toward unless
   * someone re-enters and starts again.
   */
  let folderified = false;
  function transformToRecordedFolder() {
    if (folderified || isGuest) return;
    folderified = true;

    grid.classList.add('folderified');
    for (const [, tile] of tiles) tile.node.classList.add('compact');

    if (!view.querySelector('.folder-banner')) {
      const banner = el('div', { class: 'folder-banner' }, [
        el('span', { html: icons.folder, style: 'width:16px;display:inline-flex' }),
        `This room is now a recorded folder — start recording again any time, or find it later in your library.`
      ]);
      view.insertBefore(banner, grid);
    }
  }

  /* ---------- tiles ---------- */

  function addTile(id, name, stream, isSelf) {
    let tile = tiles.get(id);

    if (!tile) {
      const video = el('video', { autoplay: true, playsinline: true, muted: isSelf ? true : null });
      const off = el('div', { class: 'tile-off', style: 'display:none', text: initialsOf(name) });
      const nameEl = el('span', { class: 'name', text: name });
      const mutedEl = el('span', { class: 'muted-icon', html: icons.micOff, style: 'display:none;width:15px' });
      const meterFill = el('i');

      const node = el('div', { class: `tile${isSelf ? ' self' : ''}` }, [
        video,
        off,
        el('div', { class: 'tile-bar' }, [nameEl, mutedEl, el('div', { class: 'meter' }, [meterFill])])
      ]);

      grid.append(node);
      tile = { node, video, off, nameEl, mutedEl, meterFill, level: 0 };
      tiles.set(id, tile);
    }

    tile.nameEl.textContent = name;

    if (stream && tile.video.srcObject !== stream) {
      tile.video.srcObject = stream;
      if (stream.getAudioTracks().length) {
        stopMeters.push(
          meterStream(stream, (level) => {
            tile.level = level;
            tile.meterFill.style.width = `${Math.round(level * 100)}%`;
            highlightSpeaker();
          })
        );
      }
    }
    return tile;
  }

  function highlightSpeaker() {
    let loudest = null;
    for (const [, tile] of tiles) if (!loudest || tile.level > loudest.level) loudest = tile;
    for (const [, tile] of tiles) tile.node.classList.toggle('speaking', tile === loudest && tile.level > 0.12);
  }

  async function populateDevices() {
    try {
      const devices = await WebRTCService.listDevices();
      const fill = (select, list, label) => {
        clear(select).append(el('option', { value: '', text: `Default ${label}` }));
        list.forEach((d, i) => select.append(el('option', { value: d.deviceId, text: d.label || `${label} ${i + 1}` })));
      };
      fill(audioSelect, devices.audio, 'microphone');
      fill(videoSelect, devices.video, 'camera');
    } catch {
      audioSelect.style.display = 'none';
      videoSelect.style.display = 'none';
    }
  }
}

async function renameRoom(project, slug, titleEl) {
  const name = await askText({
    title: 'Rename room',
    description: 'This is a shortcut for the full rename dialog in your library — room address and code stay the same here.',
    placeholder: 'Room name',
    defaultValue: (project && project.name) || slug,
    confirmLabel: 'Save'
  });
  if (!name || !project) return;

  try {
    await gdrive.updateProject(slug, project.folderId, { name });
    titleEl.textContent = name;
    project.name = name;
    toast('Room renamed', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Custom name entry, replacing window.prompt(). */
async function askDisplayName() {
  const name =
    (await askText({
      title: 'What should others see?',
      description: 'This name shows on your video tile to everyone in the room.',
      placeholder: 'Your name',
      defaultValue: creator.isSignedIn() ? 'Host' : 'Guest',
      confirmLabel: 'Continue'
    })) || 'Guest';

  const trimmed = name.trim().slice(0, 40) || 'Guest';
  localStorage.setItem('studio.name', trimmed);
  return trimmed;
}

const initialsOf = (name) =>
  String(name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
