/**
 * recorderService.js — local capture engine with live upload.
 *
 * Each participant records their own camera and mic locally at full quality.
 * Two recorders run in parallel:
 *   - "av"    full video + audio
 *   - "audio" audio-only, handy for audio-first shows
 *
 * Each recorder is paired with a LiveUploader, so chunks go to Drive as they
 * are produced. A local copy is still kept in memory so the person can
 * preview the take and download it without waiting on Drive.
 *
 * Part numbering: if someone drops out and rejoins, their next take in the
 * same room is written as part 2, 3, ... of the same session name, which the
 * Join parts action later stitches together.
 */

import { RECORDER_MIME_CANDIDATES } from '../config.js';
import { LiveUploader } from './uploaderService.js';

export function pickMimeType(audioOnly = false) {
  const candidates = audioOnly
    ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    : RECORDER_MIME_CANDIDATES;

  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

const partKey = (sessionName) => `studio.part.${sessionName}`;

/** Survives a reload, so a rejoin picks up at the next part number. */
function nextPart(sessionName) {
  const current = Number(localStorage.getItem(partKey(sessionName)) || 0) + 1;
  localStorage.setItem(partKey(sessionName), String(current));
  return current;
}

export class RecorderService extends EventTarget {
  constructor() {
    super();
    this.recorders = [];
    this.chunks = new Map();
    this.uploaders = new Map();
    this.startedAt = 0;
    this.recording = false;
    this.takes = [];
    this.liveUpload = true;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get isSupported() {
    return typeof window.MediaRecorder !== 'undefined';
  }

  /**
   * @param {MediaStream} stream
   * @param {object} options { sessionId, speaker, projectSlug, projectName, sessionName, liveUpload }
   */
  async start(stream, options = {}) {
    if (this.recording) return;
    if (!this.isSupported) throw new Error('This browser cannot record locally. Use Chrome, Edge or Firefox.');

    this.sessionId = options.sessionId || `take-${Date.now()}`;
    this.speaker = (options.speaker || 'me').replace(/\s+/g, '_');
    this.sessionName = options.sessionName || this.sessionId;
    this.target = {
      projectSlug: options.projectSlug,
      projectName: options.projectName,
      sessionName: this.sessionName,
      speaker: this.speaker
    };
    this.liveUpload = options.liveUpload !== false;
    this.part = nextPart(`${this.sessionName}.${this.speaker}`);

    this.startedAt = Date.now();
    this.chunks.clear();
    this.uploaders.clear();
    this.recorders = [];

    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const videoType = pickMimeType(false);
    const audioType = pickMimeType(true);

    const specs = [
      {
        track: 'av',
        mimeType: videoType,
        stream,
        options: {
          mimeType: videoType || undefined,
          videoBitsPerSecond: options.videoBitsPerSecond || 8_000_000,
          audioBitsPerSecond: 192_000
        }
      }
    ];

    if (stream.getAudioTracks().length) {
      specs.push({
        track: 'audio',
        mimeType: audioType,
        stream: new MediaStream(stream.getAudioTracks()),
        options: { mimeType: audioType || undefined, audioBitsPerSecond: 192_000 }
      });
    }

    // Open every Drive session BEFORE recording starts, so no chunk is
    // produced before there is somewhere to put it.
    for (const spec of specs) {
      const ext = (spec.mimeType || '').includes('mp4') ? (spec.track === 'audio' ? 'm4a' : 'mp4') : 'webm';
      spec.filename = `${this.speaker}_${spec.track}_part${this.part}_${stamp}.${ext}`;

      if (!this.liveUpload) continue;

      try {
        const uploader = new LiveUploader(
          { ...this.target, track: spec.track, part: this.part },
          spec.filename,
          spec.mimeType || 'video/webm'
        );
        await uploader.open();

        uploader.addEventListener('progress', ({ detail }) =>
          this.emit('upload-progress', { track: spec.track, ...detail, backlog: uploader.backlog })
        );
        uploader.addEventListener('error', ({ detail }) =>
          this.emit('upload-error', { track: spec.track, message: detail.message })
        );

        this.uploaders.set(spec.track, uploader);
      } catch (err) {
        // Recording still proceeds; the take can be uploaded manually later.
        this.emit('upload-error', { track: spec.track, message: err.message });
      }
    }

    for (const spec of specs) {
      const recorder = new MediaRecorder(spec.stream, spec.options);
      this.attach(recorder, spec);
    }

    this.recorders.forEach(({ recorder }) => recorder.start(1000));
    this.recording = true;
    this.emit('start', { sessionId: this.sessionId, part: this.part, at: this.startedAt });
  }

  attach(recorder, spec) {
    this.chunks.set(spec.track, []);

    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size) return;
      this.chunks.get(spec.track).push(event.data);

      const uploader = this.uploaders.get(spec.track);
      if (uploader) uploader.push(event.data);
    };

    recorder.onerror = (event) => this.emit('error', { message: String(event.error || 'Recorder failed') });
    this.recorders.push({ recorder, ...spec });
  }

  /** @returns {Promise<Array>} finished takes */
  async stop() {
    if (!this.recording) return [];
    this.recording = false;

    await Promise.all(
      this.recorders.map(
        ({ recorder }) =>
          new Promise((resolve) => {
            if (recorder.state === 'inactive') return resolve();
            recorder.onstop = () => resolve();
            recorder.stop();
          })
      )
    );

    const duration = Date.now() - this.startedAt;
    const fresh = [];

    for (const spec of this.recorders) {
      const parts = this.chunks.get(spec.track) || [];
      if (!parts.length) continue;

      const type = spec.mimeType || parts[0].type || 'application/octet-stream';
      const blob = new Blob(parts, { type });

      fresh.push({
        id: `${this.sessionId}-${spec.track}`,
        sessionId: this.sessionId,
        sessionName: this.sessionName,
        part: this.part,
        track: spec.track,
        speaker: this.speaker,
        blob,
        url: URL.createObjectURL(blob),
        filename: spec.filename,
        mimeType: type,
        size: blob.size,
        duration,
        uploader: this.uploaders.get(spec.track) || null,
        uploaded: false,
        driveFile: null
      });
    }

    this.takes = this.takes.concat(fresh);
    this.chunks.clear();
    this.emit('stop', { takes: fresh, duration });

    // Finalise the live uploads — usually only the last few seconds are left.
    for (const take of fresh) {
      if (!take.uploader) continue;
      this.emit('finalising', { take });

      take.uploader
        .finish()
        .then((file) => {
          take.uploaded = true;
          take.driveFile = file;
          this.emit('uploaded', { take, file });
        })
        .catch((err) => this.emit('upload-error', { track: take.track, message: err.message }));
    }

    return fresh;
  }

  elapsed() {
    return this.recording ? Date.now() - this.startedAt : 0;
  }

  /** Bytes still waiting to reach Drive across all live uploads. */
  backlog() {
    let total = 0;
    for (const [, uploader] of this.uploaders) total += uploader.backlog;
    return total;
  }

  remove(id) {
    const take = this.takes.find((t) => t.id === id);
    if (take) URL.revokeObjectURL(take.url);
    this.takes = this.takes.filter((t) => t.id !== id);
    this.emit('change', { takes: this.takes });
  }

  download(take) {
    const link = document.createElement('a');
    link.href = take.url;
    link.download = take.filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  downloadAll() {
    this.takes.forEach((take, i) => setTimeout(() => this.download(take), i * 400));
  }

  dispose() {
    this.takes.forEach((t) => URL.revokeObjectURL(t.url));
    this.takes = [];
  }
}
