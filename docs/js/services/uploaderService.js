/**
 * uploaderService.js — live upload while recording.
 *
 * MediaRecorder hands us blobs every second. Instead of holding them until
 * the take ends, we push them into a Google Drive resumable upload session
 * as they arrive, straight from the browser to Google — the API server is
 * not in the data path at all.
 *
 * Rules of Drive's resumable protocol that shape this code:
 *   - Chunks must be sent in order, and every chunk except the last must be
 *     a multiple of 256 KB.
 *   - 308 means "keep going"; the Range response header says how many bytes
 *     Google actually committed, which is the source of truth on retry.
 *   - The final PUT is the only one that knows the total size, so the file
 *     stays "incomplete" in Drive until the take stops. That is exactly what
 *     we want: by the time someone hits stop, everything but the last few
 *     seconds is already there.
 */

import { API_BASE } from '../config.js';

const GRANULARITY = 256 * 1024;      // Drive's required chunk multiple
const TARGET_CHUNK = 8 * 1024 * 1024; // aim for 8 MB per request
const MAX_ATTEMPTS = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LiveUploader extends EventTarget {
  /**
   * @param {object} target { projectSlug, projectName, sessionName, speaker, track, part }
   * @param {string} filename
   * @param {string} mimeType
   */
  constructor(target, filename, mimeType) {
    super();
    this.target = target;
    this.filename = filename;
    this.mimeType = mimeType;

    this.uploadUrl = null;
    this.queue = [];       // Blobs waiting to be sent
    this.pending = 0;      // bytes sitting in the queue
    this.committed = 0;    // bytes Drive has confirmed
    this.totalSeen = 0;    // bytes handed to us by the recorder
    this.flushing = false;
    this.finished = false;
    this.failed = false;
    this.file = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Opens the Drive session. Call once, before the first chunk. */
  async open() {
    const res = await fetch(`${API_BASE}/api/uploads/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...this.target,
        filename: this.filename,
        mimeType: this.mimeType
      })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.message || `Could not start the upload (${res.status})`);

    this.uploadUrl = payload.uploadUrl;
    this.folderId = payload.folderId;
    this.emit('open', { folderId: payload.folderId });
    return payload;
  }

  /** Feed a blob from MediaRecorder. Non-blocking. */
  push(blob) {
    if (this.finished || this.failed || !blob || !blob.size) return;
    this.queue.push(blob);
    this.pending += blob.size;
    this.totalSeen += blob.size;

    if (this.pending >= TARGET_CHUNK) this.flush().catch(() => {});
  }

  /** Sends whole 256 KB-aligned chunks while enough data is buffered. */
  async flush() {
    if (this.flushing || this.failed || !this.uploadUrl) return;
    this.flushing = true;

    try {
      while (this.pending >= GRANULARITY && !this.finished) {
        const aligned = Math.floor(Math.min(this.pending, TARGET_CHUNK * 2) / GRANULARITY) * GRANULARITY;
        if (!aligned) break;

        const chunk = this.take(aligned);
        await this.send(chunk, false);
      }
    } catch (err) {
      this.failed = true;
      this.emit('error', { message: err.message });
    } finally {
      this.flushing = false;
    }
  }

  /** Pulls exactly `bytes` off the front of the queue as one Blob. */
  take(bytes) {
    const parts = [];
    let need = bytes;

    while (need > 0 && this.queue.length) {
      const head = this.queue[0];
      if (head.size <= need) {
        parts.push(this.queue.shift());
        need -= head.size;
      } else {
        parts.push(head.slice(0, need));
        this.queue[0] = head.slice(need);
        need = 0;
      }
    }

    this.pending -= bytes;
    return new Blob(parts);
  }

  /**
   * One PUT against the session URI.
   * @param {Blob} chunk
   * @param {boolean} last when true, the total size is declared and Drive finalises the file
   */
  async send(chunk, last) {
    const start = this.committed;
    const end = start + chunk.size - 1;
    const total = last ? start + chunk.size : '*';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let res;
      try {
        res = await fetch(this.uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': chunk.size
              ? `bytes ${start}-${end}/${total}`
              : `bytes */${total}` // zero-length final call
          },
          body: chunk.size ? chunk : null
        });
      } catch (err) {
        // Network blip: wait and re-check what Drive actually has.
        if (attempt === MAX_ATTEMPTS) throw new Error('Upload connection failed repeatedly.');
        await sleep(Math.min(15000, 2 ** attempt * 500));
        const resumed = await this.syncCommitted();
        if (resumed !== null && resumed > start) return; // Drive already has it
        continue;
      }

      if (res.status === 308) {
        this.committed = this.rangeEnd(res) ?? start + chunk.size;
        this.emitProgress();
        return;
      }

      if (res.ok) {
        this.committed = start + chunk.size;
        this.file = await res.json().catch(() => null);
        this.emitProgress();
        return;
      }

      if (res.status === 404) throw new Error('The upload session expired. This take must be uploaded again.');

      if (res.status === 429 || res.status >= 500) {
        if (attempt === MAX_ATTEMPTS) throw new Error(`Drive kept rejecting the chunk (${res.status}).`);
        await sleep(Math.min(15000, 2 ** attempt * 500));
        continue;
      }

      const detail = await res.text().catch(() => '');
      throw new Error(`Upload failed (${res.status}) ${detail.slice(0, 200)}`);
    }
  }

  /**
   * Reads how far Drive got. Requires the Range header to be visible to JS;
   * Google exposes it on the upload endpoint, but if a proxy strips it we
   * fall back to our own count.
   */
  rangeEnd(res) {
    const range = res.headers.get('Range');
    if (!range) return null;
    const match = /bytes=0-(\d+)/.exec(range);
    return match ? Number(match[1]) + 1 : null;
  }

  async syncCommitted() {
    try {
      const res = await fetch(this.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': 'bytes */*' }
      });
      if (res.status === 308) {
        const end = this.rangeEnd(res);
        if (end !== null) this.committed = end;
        return this.committed;
      }
      if (res.ok) {
        this.file = await res.json().catch(() => null);
        this.finished = true;
        return this.committed;
      }
    } catch {
      /* still offline */
    }
    return null;
  }

  emitProgress() {
    this.emit('progress', {
      committed: this.committed,
      seen: this.totalSeen,
      percent: this.totalSeen ? Math.min(100, Math.round((this.committed / this.totalSeen) * 100)) : 0
    });
  }

  /** How far behind live the upload is, in bytes. */
  get backlog() {
    return Math.max(0, this.totalSeen - this.committed);
  }

  /** Flushes everything left and finalises the Drive file. */
  async finish() {
    if (this.finished || this.failed) return this.file;

    // Wait for any in-flight flush to settle.
    while (this.flushing) await sleep(50);

    try {
      // Send remaining full chunks first.
      while (this.pending > TARGET_CHUNK) {
        const aligned = Math.floor(TARGET_CHUNK / GRANULARITY) * GRANULARITY;
        await this.send(this.take(aligned), false);
      }

      const tail = this.take(this.pending);
      await this.send(tail, true);

      this.finished = true;

      if (this.file && this.file.id) {
        // Ask the API for shareable links now the file exists.
        const res = await fetch(`${API_BASE}/api/uploads/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: this.file.id })
        });
        const payload = await res.json().catch(() => ({}));
        if (payload.file) this.file = payload.file;
      }

      this.emit('done', { file: this.file });
      return this.file;
    } catch (err) {
      this.failed = true;
      this.emit('error', { message: err.message });
      throw err;
    }
  }
}
