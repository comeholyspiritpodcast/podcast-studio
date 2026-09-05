/**
 * gdriveService.js — API client.
 *
 * There is no per-user sign-in: everything lands in the studio owner's Drive
 * and the owner links it once at /auth/owner. Guests just record.
 *
 * Uploads no longer pass through here — see uploaderService.js, which sends
 * chunks from the browser straight to Google while the take is still running.
 */

import { API_BASE, ENDPOINTS, api } from '../config.js';

export const gdrive = {
  /** Is the studio's Drive linked? */
  status() {
    return api(ENDPOINTS.status);
  },

  linkDrive(adminKey) {
    window.location.href = `${API_BASE}/auth/owner${adminKey ? `?key=${encodeURIComponent(adminKey)}` : ''}`;
  },

  listProjects() {
    return api(ENDPOINTS.projects);
  },

  creatorLogin(code) {
    return api(ENDPOINTS.creatorLogin, { method: 'POST', body: JSON.stringify({ code }) });
  },

  /** Guest-facing: resolves a room code to the project it belongs to. */
  resolveRoomCode(code) {
    return api(`/api/rooms/${encodeURIComponent(code.trim().toUpperCase())}`);
  },

  createProject({ name, slug, description }) {
    return api(ENDPOINTS.projects, { method: 'POST', body: JSON.stringify({ name, slug, description }) });
  },

  getProject(slug) {
    return api(ENDPOINTS.project(slug));
  },

  /** Renames a project and/or regenerates its room code. */
  updateProject(slug, folderId, patch) {
    return api(ENDPOINTS.project(slug), { method: 'PATCH', body: JSON.stringify({ folderId, ...patch }) });
  },

  /** Trashes a project folder in Drive (recoverable for 30 days). */
  deleteProject(slug, folderId) {
    return api(`${ENDPOINTS.deleteProject(slug)}?folderId=${encodeURIComponent(folderId)}`, { method: 'DELETE' });
  },

  /** Trashes a single recording in Drive. */
  deleteRecording(fileId) {
    return api(ENDPOINTS.deleteRecording(fileId), { method: 'DELETE' });
  },

  listRecordings(slug, folderId) {
    return api(ENDPOINTS.recordings(slug, folderId));
  },

  /**
   * Converts recordings to MP4/MP3 on the server. Off unless
   * ENABLE_SERVER_EXPORT is set — see server.js for why.
   */
  async exportFiles({ fileIds, format, folderId }, onProgress = () => {}) {
    const { jobId } = await api(ENDPOINTS.exportStart, {
      method: 'POST',
      body: JSON.stringify({ fileIds, format, folderId })
    });

    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await api(ENDPOINTS.exportStatus(jobId));

      if (job.state === 'running') onProgress(job.progress || 0);
      if (job.state === 'done') return job.files;
      if (job.state === 'failed') throw new Error(job.error || 'Exporting failed.');
    }
  },

  /**
   * Stitches parts recorded across a drop-out into one file (ffmpeg stream
   * copy on the server). Resolves with the finished Drive file.
   */
  async joinParts({ fileIds, outputName, folderId }, onProgress = () => {}) {
    const { jobId } = await api(ENDPOINTS.join, {
      method: 'POST',
      body: JSON.stringify({ fileIds, outputName, folderId })
    });

    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const job = await api(ENDPOINTS.joinStatus(jobId));

      if (job.state === 'running') onProgress(job.progress || 0);
      if (job.state === 'done') return job.file;
      if (job.state === 'failed') throw new Error(job.error || 'Joining the parts failed.');
    }
  },

  /**
   * A direct download straight from Google's CDN — much faster than proxying
   * bytes back through the API server.
   */
  downloadUrl(fileId) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  }
};
