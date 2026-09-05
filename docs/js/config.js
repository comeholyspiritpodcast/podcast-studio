/**
 * config.js — endpoints, fetch wrapper and small shared UI helpers.
 *
 * API_BASE lets you serve the frontend from GitHub Pages while the backend
 * lives on Render/Railway: set window.__STUDIO_API__ before loading app.js,
 * or leave it empty when Express serves /public itself.
 */

export const API_BASE = (window.__STUDIO_API__ || '').replace(/\/$/, '');

/**
 * Live-upload tuning. Chunks stream to Drive while recording, so by the time
 * someone presses stop only the tail is left to send.
 */
export const UPLOAD = {
  live: true,
  targetChunkBytes: 8 * 1024 * 1024,
  warnBacklogBytes: 120 * 1024 * 1024 // nudge the user if Drive falls this far behind
};

export const ENDPOINTS = {
  status: '/api/status',
  creatorLogin: '/api/creator/login',
  projects: '/api/projects',
  project: (slug) => `/api/projects/${encodeURIComponent(slug)}`,
  deleteProject: (slug) => `/api/projects/${encodeURIComponent(slug)}`,
  recordings: (slug, folderId) =>
    `/api/projects/${encodeURIComponent(slug)}/recordings?folderId=${encodeURIComponent(folderId)}`,
  deleteRecording: (fileId) => `/api/recordings/${encodeURIComponent(fileId)}`,
  uploadSession: '/api/uploads/session',
  uploadComplete: '/api/uploads/complete',
  join: '/api/join',
  joinStatus: (jobId) => `/api/join/${encodeURIComponent(jobId)}`,
  exportStart: '/api/export',
  exportStatus: (jobId) => `/api/export/${encodeURIComponent(jobId)}`
};

/** Preferred recording formats, best first. */
export const RECORDER_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4'
];

// echoCancellation/noiseSuppression/autoGainControl are requested as hard
// requirements (not just "ideal"), since a browser that can't honour them
// would otherwise silently record raw, echo-prone audio. If a device
// genuinely can't meet them, startLocalMedia() retries with the relaxed
// (non-exact) versions below rather than failing outright.
export const MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: {
    echoCancellation: { exact: true },
    noiseSuppression: { exact: true },
    autoGainControl: { exact: true },
    channelCount: 1
  }
};

export const MEDIA_CONSTRAINTS_FALLBACK = {
  video: MEDIA_CONSTRAINTS.video,
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
};

export const RTC_CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }]
};

/* ---------- network ---------- */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(pathname, options = {}) {
  const res = await fetch(API_BASE + pathname, {
    credentials: 'include',
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options
  });

  if (res.status === 204) return null;

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(payload.error || `Request failed (${res.status})`, res.status);
  return payload;
}

/* ---------- DOM ---------- */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

/* ---------- global upload activity (for the dashboard progress indicator) ---------- */

const uploadBus = new EventTarget();
const activeUploads = new Map(); // id -> { label, percent }

export const uploads = {
  start(id, label) {
    activeUploads.set(id, { label, percent: 0 });
    uploadBus.dispatchEvent(new CustomEvent('change'));
  },
  progress(id, percent) {
    const entry = activeUploads.get(id);
    if (entry) entry.percent = percent;
    uploadBus.dispatchEvent(new CustomEvent('change'));
  },
  finish(id) {
    activeUploads.delete(id);
    uploadBus.dispatchEvent(new CustomEvent('change'));
  },
  list: () => [...activeUploads.values()],
  onChange(fn) {
    uploadBus.addEventListener('change', fn);
    return () => uploadBus.removeEventListener('change', fn);
  }
};

/* ---------- creator session (lightweight access-code gate) ---------- */

export const creator = {
  isSignedIn: () => localStorage.getItem('studio.creatorCode') !== null,
  code: () => localStorage.getItem('studio.creatorCode') || '',
  signIn(code) {
    localStorage.setItem('studio.creatorCode', code);
  },
  signOut() {
    localStorage.removeItem('studio.creatorCode');
  }
};

/** Is this tab in the simplified guest view? Persists across the session. */
export const guestMode = {
  isGuest: () => sessionStorage.getItem('studio.guestView') === '1',
  set(on) {
    if (on) sessionStorage.setItem('studio.guestView', '1');
    else sessionStorage.removeItem('studio.guestView');
  }
};

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const node = el('div', { class: `toast ${kind}`.trim(), text: message });
  root.append(node);
  setTimeout(() => node.remove(), 4200);
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Custom name/text entry, replacing window.prompt(). Resolves the trimmed
 * value, or null if cancelled.
 */
export function askText({ title, description, placeholder = '', defaultValue = '', confirmLabel = 'Continue' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const input = el('input', { class: 'input', placeholder, value: defaultValue, maxlength: '60' });

    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter') finish(input.value.trim() || null);
    };
    document.addEventListener('keydown', onKey);

    const modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('h2', { text: title }),
      description ? el('p', { text: description }) : null,
      el('div', { class: 'field' }, [input]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(null) }),
        el('button', { class: 'btn btn-primary', text: confirmLabel, onclick: () => finish(input.value.trim() || null) })
      ])
    ]);

    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) finish(null); } }, [modal]);
    root.append(backdrop);
    setTimeout(() => input.focus(), 30);
  });
}

/**
 * High-friction destructive confirmation: the person must type the exact
 * phrase shown before the confirm button enables. Resolves true/false.
 */
export function askDangerConfirm({ title, description, requirePhrase, confirmLabel = 'Delete' }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const input = el('input', { class: 'input', placeholder: requirePhrase });
    const confirmBtn = el('button', { class: 'btn btn-danger', text: confirmLabel, disabled: true });

    input.addEventListener('input', () => {
      confirmBtn.disabled = input.value.trim() !== requirePhrase;
    });

    const finish = (value) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };

    const onKey = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    confirmBtn.addEventListener('click', () => finish(true));

    const modal = el('div', { class: 'modal modal-danger', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title }, [
      el('h2', { text: title }),
      description ? el('p', { text: description }) : null,
      el('p', { class: 'hint' }, [`Type `, el('strong', { text: requirePhrase }), ` to confirm.`]),
      el('div', { class: 'field' }, [input]),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-ghost', text: 'Cancel', onclick: () => finish(false) }),
        confirmBtn
      ])
    ]);

    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) finish(false); } }, [modal]);
    root.append(backdrop);
    setTimeout(() => input.focus(), 30);
  });
}

export const slugify = (value) =>
  String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/* ---------- icons (inline, 24px grid) ---------- */

const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const icons = {
  projects: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 9l5 3-5 3z"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.9 1.2v.2a2 2 0 11-4 0v-.1A1.7 1.7 0 005 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.7 1.7 0 002.4 15H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 5L4.5 5a2 2 0 112.8-2.8l.1.1A1.7 1.7 0 009 2.4V2a2 2 0 114 0v.1A1.7 1.7 0 0019 4.6l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 001.2 2.9H22a2 2 0 110 4h-.1"/>'),
  folder: svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M10 11l4 2.5-4 2.5z"/>'),
  upload: svg('<path d="M12 16V4"/><path d="M8 8l4-4 4 4"/><path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>'),
  micOff: svg('<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 004.5 2.6"/><path d="M15 11V6a3 3 0 00-5.6-1.5"/><path d="M5 11a7 7 0 0010.8 5.9M12 18v3"/>'),
  camera: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 11l6-3v8l-6-3z"/>'),
  cameraOff: svg('<path d="M3 3l18 18"/><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 11l6-3v8l-4-2"/>'),
  link: svg('<path d="M10 13a5 5 0 007.5.5l2-2A5 5 0 0012.5 4.5l-1 1"/><path d="M14 11a5 5 0 00-7.5-.5l-2 2A5 5 0 0011.5 19.5l1-1"/>'),
  download: svg('<path d="M12 4v12"/><path d="M8 12l4 4 4-4"/><path d="M4 20h16"/>'),
  leave: svg('<path d="M15 12H4"/><path d="M8 8l-4 4 4 4"/><path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4"/>'),
  cloud: svg('<path d="M7 18a4 4 0 01-.4-8A6 6 0 0118 9.5 3.5 3.5 0 0117.5 18z"/><path d="M12 12v5"/><path d="M9.5 14.5L12 12l2.5 2.5"/>'),
  merge: svg('<path d="M6 4v6a4 4 0 004 4h8"/><path d="M6 20v-4"/><path d="M15 11l3 3-3 3"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  guest: svg('<circle cx="9" cy="8" r="3"/><path d="M4 20a5 5 0 0110 0"/><circle cx="17" cy="9" r="2.3"/><path d="M15 20a4 4 0 016.5-3"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8"/><path d="M16 7l3 3"/><path d="M13 10l2 2"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>')
};
