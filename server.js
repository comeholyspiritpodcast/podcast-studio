'use strict';

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const { google } = require('googleapis');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ROOT_FOLDER_NAME = process.env.DRIVE_ROOT_FOLDER || 'Podcast_Studio_Projects';
const ADMIN_KEY = process.env.ADMIN_KEY || '';

/**
 * Server-side joining is the ONLY feature that moves recording bytes through
 * this host: it pulls every part down from Drive and pushes the joined file
 * back up, so one join costs roughly 2x the combined part size in egress.
 * Everything else here is small JSON. Off by default to protect a metered
 * free tier; the browser offers an editor-side alternative instead.
 */
const JOIN_ENABLED = process.env.ENABLE_SERVER_JOIN === 'true';
const JOIN_MAX_BYTES = Number(process.env.JOIN_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const EGRESS_BUDGET_BYTES = Number(process.env.EGRESS_BUDGET_BYTES || 5 * 1024 * 1024 * 1024);
const TOKEN_PATH = process.env.TOKEN_PATH || path.join(__dirname, '.owner-token.json');
const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * Origins allowed to call this API. The frontend may be served from GitHub
 * Pages or the custom domain while the API lives on Render/Railway.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .concat([PUBLIC_URL, 'http://localhost:3000']);

const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl, same-origin, server-to-server
      cb(null, ALLOWED_ORIGINS.includes(origin.replace(/\/$/, '')));
    },
    credentials: false // no cookies: the owner token lives on the server
  })
);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

/* ------------------------------------------------------------------ *
 * Owner Google account
 *
 * Every recording lands in ONE Drive — the studio owner's. Guests never sign
 * in to Google. The owner authorises once at /auth/owner and the refresh
 * token is persisted (disk in dev, GOOGLE_REFRESH_TOKEN env in production).
 * ------------------------------------------------------------------ */

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.');
  }
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || `${PUBLIC_URL}/auth/google/callback`
  );
}

function loadRefreshToken() {
  if (process.env.GOOGLE_REFRESH_TOKEN) return process.env.GOOGLE_REFRESH_TOKEN;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')).refresh_token || null;
  } catch {
    return null;
  }
}

let ownerClient = null;

function owner() {
  if (ownerClient) return ownerClient;

  const refresh = loadRefreshToken();
  if (!refresh) {
    const err = new Error('Studio Drive is not linked yet. Visit /auth/owner once as the owner.');
    err.code = 'not_linked';
    throw err;
  }

  ownerClient = oauthClient();
  ownerClient.setCredentials({ refresh_token: refresh });
  return ownerClient;
}

const ownerDrive = () => google.drive({ version: 'v3', auth: owner() });

/** A fresh access token, used only server-side to open upload sessions. */
async function ownerAccessToken() {
  const { token } = await owner().getAccessToken();
  if (!token) throw new Error('Could not mint a Drive access token.');
  return token;
}

function fail(res, err) {
  const linked = err && err.code === 'not_linked';
  console.error('[api]', (err && err.message) || err);
  res.status(linked ? 503 : 500).json({
    error: linked ? 'not_linked' : 'request_failed',
    message: String((err && err.message) || err)
  });
}

/* ------------------------------------------------------------------ *
 * Owner auth routes
 * ------------------------------------------------------------------ */

app.get('/auth/owner', (req, res) => {
  if (ADMIN_KEY && req.query.key !== ADMIN_KEY) return res.status(403).send('Forbidden');
  try {
    res.redirect(
      oauthClient().generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent', // force a refresh_token even on re-auth
        scope: OAUTH_SCOPES
      })
    );
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauthClient().getToken(String(req.query.code || ''));

    if (!tokens.refresh_token) {
      return res
        .status(400)
        .send('Google returned no refresh token. Revoke the app at myaccount.google.com/permissions, then retry.');
    }

    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: tokens.refresh_token }, null, 2), { mode: 0o600 });
    ownerClient = null;

    res.send(
      `<pre style="font:14px/1.6 monospace;padding:32px">Studio Drive linked.

For production, set this on your host and redeploy:

GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}

You can close this tab.</pre>`
    );
  } catch (err) {
    res.status(500).send(`OAuth failed: ${err.message}`);
  }
});

app.get('/api/status', async (req, res) => {
  try {
    await ownerAccessToken();
    res.json({ linked: true, joinEnabled: JOIN_ENABLED });
  } catch (err) {
    res.json({ linked: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Drive helpers
 * ------------------------------------------------------------------ */

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const esc = (s) => String(s).replace(/'/g, "\\'");

const folderCache = new Map(); // `${parent}/${name}` -> id

async function findOrCreateFolder(drive, name, parentId) {
  const key = `${parentId || 'root'}/${name}`;
  if (folderCache.has(key)) return folderCache.get(key);

  const q = [
    `name = '${esc(name)}'`,
    `mimeType = '${FOLDER_MIME}'`,
    'trashed = false',
    `'${esc(parentId || 'root')}' in parents`
  ].join(' and ');

  const found = await drive.files.list({ q, fields: 'files(id)', pageSize: 1, spaces: 'drive' });

  const id = found.data.files.length
    ? found.data.files[0].id
    : (
        await drive.files.create({
          requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId || 'root'] },
          fields: 'id'
        })
      ).data.id;

  folderCache.set(key, id);
  return id;
}

const rootFolder = (drive) => findOrCreateFolder(drive, ROOT_FOLDER_NAME, null);

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';

async function writeProjectMeta(drive, folderId, meta) {
  const media = { mimeType: 'application/json', body: Readable.from(Buffer.from(JSON.stringify(meta, null, 2))) };
  const existing = await drive.files.list({
    q: `name = 'project.json' and trashed = false and '${esc(folderId)}' in parents`,
    fields: 'files(id)',
    pageSize: 1
  });

  if (existing.data.files.length) {
    await drive.files.update({ fileId: existing.data.files[0].id, media, fields: 'id' });
  } else {
    await drive.files.create({
      requestBody: { name: 'project.json', parents: [folderId], mimeType: 'application/json' },
      media,
      fields: 'id'
    });
  }
  return meta;
}

async function readProjectMeta(drive, folderId) {
  const list = await drive.files.list({
    q: `name = 'project.json' and trashed = false and '${esc(folderId)}' in parents`,
    fields: 'files(id)',
    pageSize: 1
  });
  if (!list.data.files.length) return null;
  const file = await drive.files.get({ fileId: list.data.files[0].id, alt: 'media' }, { responseType: 'json' });
  return file.data;
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

app.get('/api/projects', async (req, res) => {
  try {
    const drive = ownerDrive();
    const root = await rootFolder(drive);

    const list = await drive.files.list({
      q: `'${esc(root)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id,name,createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 200
    });

    const projects = await Promise.all(
      list.data.files.map(async (folder) => {
        const meta = (await readProjectMeta(drive, folder.id)) || {
          id: folder.id,
          slug: slugify(folder.name),
          name: folder.name,
          createdAt: folder.createdTime
        };
        const children = await drive.files.list({
          q: `'${esc(folder.id)}' in parents and trashed = false and name != 'project.json'`,
          fields: 'files(id)',
          pageSize: 1000
        });
        return Object.assign({}, meta, { folderId: folder.id, recordings: children.data.files.length });
      })
    );

    res.json({ rootFolderId: root, projects });
  } catch (err) {
    fail(res, err);
  }
});

app.post('/api/projects', async (req, res) => {
  try {
    const drive = ownerDrive();
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });

    const root = await rootFolder(drive);
    const folderId = await findOrCreateFolder(drive, name, root);

    const meta = await writeProjectMeta(drive, folderId, {
      id: folderId,
      folderId,
      name,
      slug: slugify(req.body.slug || name),
      description: String(req.body.description || ''),
      createdAt: new Date().toISOString()
    });

    res.status(201).json(Object.assign({ recordings: 0 }, meta));
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/projects/:slug', async (req, res) => {
  try {
    const drive = ownerDrive();
    const root = await rootFolder(drive);
    const list = await drive.files.list({
      q: `'${esc(root)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id,name)',
      pageSize: 200
    });

    for (const folder of list.data.files) {
      const meta = await readProjectMeta(drive, folder.id);
      if ((meta && meta.slug === req.params.slug) || slugify(folder.name) === req.params.slug) {
        return res.json(Object.assign({ name: folder.name, slug: req.params.slug }, meta, { folderId: folder.id }));
      }
    }

    // Ad-hoc rooms get their folder created on first upload instead.
    res.status(404).json({ error: 'not_found' });
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/projects/:slug/recordings', async (req, res) => {
  try {
    const drive = ownerDrive();
    const folderId = String(req.query.folderId || '');
    if (!folderId) return res.status(400).json({ error: 'folderId_required' });

    const list = await drive.files.list({
      q: `'${esc(folderId)}' in parents and trashed = false and name != 'project.json'`,
      fields: 'files(id,name,size,mimeType,createdTime,webViewLink,webContentLink,appProperties)',
      orderBy: 'createdTime desc',
      pageSize: 500
    });

    res.json({ files: list.data.files });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Resumable upload sessions
 *
 * The browser uploads chunks DIRECTLY to Google while recording. The server
 * only opens the session and returns its URI, which carries its own
 * short-lived credential — guests never see the owner's access token.
 * ------------------------------------------------------------------ */

app.post('/api/uploads/session', async (req, res) => {
  try {
    const drive = ownerDrive();
    const { projectSlug, projectName, sessionName, filename, mimeType, speaker, track, part } = req.body || {};

    if (!filename) return res.status(400).json({ error: 'filename_required' });

    const root = await rootFolder(drive);
    const projectFolder = await findOrCreateFolder(drive, String(projectName || projectSlug || 'Untitled'), root);
    const parent = sessionName ? await findOrCreateFolder(drive, String(sessionName), projectFolder) : projectFolder;

    const metadata = {
      name: String(filename),
      parents: [parent],
      mimeType: String(mimeType || 'video/webm'),
      appProperties: {
        speaker: String(speaker || ''),
        track: String(track || 'av'),
        part: String(part || 1),
        sessionName: String(sessionName || ''),
        recordedAt: new Date().toISOString()
      }
    };

    const token = await ownerAccessToken();
    const initiate = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink,webContentLink',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': metadata.mimeType
        },
        body: JSON.stringify(metadata)
      }
    );

    if (!initiate.ok) {
      const detail = await initiate.text();
      throw new Error(`Drive refused the upload session (${initiate.status}): ${detail.slice(0, 300)}`);
    }

    const uploadUrl = initiate.headers.get('location');
    if (!uploadUrl) throw new Error('Drive did not return an upload session URL.');

    res.json({ uploadUrl, folderId: parent, projectFolderId: projectFolder });
  } catch (err) {
    fail(res, err);
  }
});

/** Called once a direct upload finishes, to fetch shareable links. */
app.post('/api/uploads/complete', async (req, res) => {
  try {
    const drive = ownerDrive();
    const fileId = String(req.body.fileId || '');
    if (!fileId) return res.status(400).json({ error: 'fileId_required' });

    const file = await drive.files.get({
      fileId,
      fields: 'id,name,size,mimeType,webViewLink,webContentLink,appProperties'
    });
    res.json({ ok: true, file: file.data });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ *
 * Join parts
 *
 * When someone drops and rejoins, their browser starts a NEW WebM stream with
 * its own header, so parts cannot be concatenated as raw bytes. ffmpeg's
 * concat demuxer stitches them without re-encoding (stream copy) — fast, but
 * it needs temp disk roughly equal to the combined size.
 * ------------------------------------------------------------------ */

const jobs = new Map(); // jobId -> { state, progress, file?, error? }

/**
 * Rough running total of bytes this process has moved on join jobs. Resets on
 * restart, so it's a guard rail rather than accounting — check your host's
 * own dashboard for the real figure.
 */
const egress = { bytes: 0, since: new Date().toISOString() };

const remainingBudget = () => Math.max(0, EGRESS_BUDGET_BYTES - egress.bytes);

function ffmpegPath() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

function ffmpegAvailable() {
  return new Promise((resolve) => {
    const probe = spawn(ffmpegPath(), ['-version']);
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

app.post('/api/join', async (req, res) => {
  try {
    const fileIds = Array.isArray(req.body.fileIds) ? req.body.fileIds.map(String) : [];
    if (fileIds.length < 2) return res.status(400).json({ error: 'need_two_parts' });

    if (!JOIN_ENABLED) {
      return res.status(503).json({
        error: 'join_disabled',
        message:
          'Server-side joining is off, because it would move the whole recording through this host. Drop the numbered parts onto your editor timeline in order instead, or set ENABLE_SERVER_JOIN=true.'
      });
    }

    // Price the job before running it.
    const drive = ownerDrive();
    let totalBytes = 0;
    for (const id of fileIds) {
      const meta = await drive.files.get({ fileId: id, fields: 'size' });
      totalBytes += Number(meta.data.size || 0);
    }
    const cost = totalBytes * 2; // down, then back up

    if (totalBytes > JOIN_MAX_BYTES) {
      return res.status(413).json({
        error: 'too_large',
        message: `These parts total ${(totalBytes / 1e9).toFixed(1)} GB, over the ${(JOIN_MAX_BYTES / 1e9).toFixed(1)} GB per-job limit. Join them in your editor instead.`
      });
    }

    if (cost > remainingBudget()) {
      return res.status(507).json({
        error: 'budget_exceeded',
        message: `This join would use about ${(cost / 1e9).toFixed(1)} GB of bandwidth and only ${(remainingBudget() / 1e9).toFixed(1)} GB of the configured budget is left.`
      });
    }

    if (!(await ffmpegAvailable())) {
      return res.status(501).json({
        error: 'ffmpeg_missing',
        message: 'ffmpeg is not available on this server. Install the ffmpeg-static dependency and redeploy.'
      });
    }

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    jobs.set(jobId, { state: 'running', progress: 0 });
    res.status(202).json({ jobId });

    egress.bytes += cost;

    joinParts(jobId, fileIds, String(req.body.outputName || 'joined.webm'), String(req.body.folderId || '')).catch(
      (err) => jobs.set(jobId, { state: 'failed', error: err.message })
    );
  } catch (err) {
    fail(res, err);
  }
});

app.get('/api/egress', (req, res) => {
  res.json({
    joinEnabled: JOIN_ENABLED,
    usedBytes: egress.bytes,
    budgetBytes: EGRESS_BUDGET_BYTES,
    remainingBytes: remainingBudget(),
    since: egress.since
  });
});

app.get('/api/join/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown_job' });
  res.json(job);
});

async function joinParts(jobId, fileIds, outputName, folderId) {
  const drive = ownerDrive();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
  const localPaths = [];

  try {
    for (let i = 0; i < fileIds.length; i += 1) {
      const target = path.join(work, `part-${String(i).padStart(3, '0')}.webm`);
      const stream = await drive.files.get({ fileId: fileIds[i], alt: 'media' }, { responseType: 'stream' });

      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(target);
        stream.data.pipe(out).on('finish', resolve).on('error', reject);
      });

      localPaths.push(target);
      jobs.set(jobId, { state: 'running', progress: Math.round(((i + 1) / (fileIds.length + 2)) * 100) });
    }

    const listFile = path.join(work, 'parts.txt');
    fs.writeFileSync(listFile, localPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

    const outPath = path.join(work, outputName.replace(/[^\w.-]/g, '_'));

    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      proc.on('error', reject);
      proc.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`))
      );
    });

    jobs.set(jobId, { state: 'running', progress: 90 });

    const created = await drive.files.create({
      requestBody: {
        name: outputName,
        parents: folderId ? [folderId] : undefined,
        appProperties: { joinedFrom: fileIds.join(',') }
      },
      media: { mimeType: 'video/webm', body: fs.createReadStream(outPath) },
      fields: 'id,name,size,webViewLink,webContentLink'
    });

    jobs.set(jobId, { state: 'done', progress: 100, file: created.data });
  } finally {
    fs.rm(work, { recursive: true, force: true }, () => {});
  }
}

/* ------------------------------------------------------------------ *
 * Static assets (same-origin hosting) + SPA fallback
 * ------------------------------------------------------------------ */

app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '1h' : 0 }));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ *
 * Socket.IO signalling
 * ------------------------------------------------------------------ */

const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS, credentials: false }, maxHttpBufferSize: 1e6 });

const rooms = new Map(); // roomId -> Map(socketId -> peer)

const peersIn = (roomId) =>
  rooms.has(roomId) ? [...rooms.get(roomId).entries()].map(([id, p]) => Object.assign({ id }, p)) : [];

io.on('connection', (socket) => {
  let roomId = null;

  socket.on('join', ({ room, name }) => {
    roomId = String(room || '').slice(0, 80);
    if (!roomId) return;

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    socket.join(roomId);
    socket.emit('peers', peersIn(roomId));

    rooms.get(roomId).set(socket.id, { name: String(name || 'Guest').slice(0, 60), muted: false, cameraOff: false });
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: rooms.get(roomId).get(socket.id).name });
  });

  socket.on('signal', ({ to, data }) => to && io.to(to).emit('signal', { from: socket.id, data }));

  socket.on('state', (state) => {
    const peer = rooms.get(roomId) && rooms.get(roomId).get(socket.id);
    if (!peer) return;
    Object.assign(peer, {
      muted: !!state.muted,
      cameraOff: !!state.cameraOff,
      name: state.name ? String(state.name).slice(0, 60) : peer.name
    });
    socket.to(roomId).emit('peer-state', Object.assign({ id: socket.id }, peer));
  });

  socket.on('recording:start', ({ sessionId }) => {
    if (roomId) io.in(roomId).emit('recording:start', { sessionId, startedBy: socket.id, at: Date.now() });
  });

  socket.on('recording:stop', () => {
    if (roomId) io.in(roomId).emit('recording:stop', { stoppedBy: socket.id, at: Date.now() });
  });

  socket.on('disconnect', () => {
    if (!roomId || !rooms.has(roomId)) return;
    rooms.get(roomId).delete(socket.id);
    if (!rooms.get(roomId).size) rooms.delete(roomId);
    socket.to(roomId).emit('peer-left', { id: socket.id });
  });
});

server.listen(PORT, () => {
  console.log(`Podcast Studio on ${PUBLIC_URL} (port ${PORT})`);
  console.log(loadRefreshToken() ? 'Studio Drive: linked' : 'Studio Drive: NOT linked — visit /auth/owner');
});
