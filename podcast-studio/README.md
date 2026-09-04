# Podcast Studio

A self-hosted, browser-based multitrack podcast studio. Everyone in the room is recorded **locally** at full quality by their own browser, so a bad connection degrades the live conversation but never the footage. Each track uploads straight into the host's own Google Drive while recording is still running.

- Mesh WebRTC video room with active-speaker highlighting and level meters
- Local dual recording per person: full video+audio track and an audio-only track
- **Live upload:** chunks stream to Google Drive *while* recording, browser → Google directly
- **One Drive for everything:** the owner links their account once; guests never sign in
- Automatic part numbering for drop-outs, joined in your editor (or on the server if you enable it)
- Vanilla ES-module frontend — no build step, so nothing needs compiling before deploy

This guide assumes you never run anything locally: everything happens through github.com, a Codespace, Render, and Google Cloud Console, all in a browser tab.

---

## 1. Get the code into a GitHub repo

1. On github.com, click **New repository**. Name it `podcast-studio`, keep it empty (no README/license — you already have those files).
2. Open the repo, click **Add file → Create new file**... actually, don't — for a folder this size, use a Codespace instead of the upload button. It handles nested folders and dotfiles (`.gitignore`, `.env.example`) correctly, where drag-and-drop upload often loses them.
3. On the new repo's page: **Code → Codespaces → Create codespace on main**. This opens a full VS Code in your browser, backed by a real Linux machine — no install, nothing local.
4. In the Codespace's file explorer (left sidebar), drag the entire unzipped `podcast-studio` folder in. Confirm `.gitignore` made it in — some file pickers hide dotfiles, so check the explorer tree.
5. Open the terminal (**Terminal → New Terminal**) and run:

   ```bash
   git add .
   git commit -m "Initial commit"
   git push
   ```

That's your whole codebase on GitHub. You can close the Codespace — you won't need to run the server there; Render runs it.

---

## 2. Google Cloud Console setup

You need an OAuth 2.0 client so the app can write to your Drive.

### 2.1 Create a project

1. Go to <https://console.cloud.google.com/>.
2. Open the project picker in the top bar → **New project**.
3. Name it (e.g. `podcast-studio`) → **Create**.

### 2.2 Enable the Google Drive API

1. **APIs & Services → Library**.
2. Search **Google Drive API** → open it → **Enable**.

### 2.3 Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. Choose **External** (unless everyone is inside one Google Workspace — then **Internal**, which skips the test-user step below).
3. Fill in app name, support email, developer contact email.
4. **Scopes** step: add only `.../auth/drive.file` — create and manage only the files this app creates.
5. **Test users** step: add **your own Google account only**. It's the sole account that ever signs in.

> **Publish the app before you go live.** While the consent screen is in *Testing*, Google expires refresh tokens after 7 days and uploads will start failing a week after launch. Click **Publish app**. Because `drive.file` is a non-sensitive scope, publishing does not trigger Google's verification review — it's instant.

### 2.4 Create OAuth client credentials

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorised JavaScript origins** — every origin the *frontend* is served from:
   - `https://<you>.github.io`
   - `https://comeholyspirit.com`
   - `https://api.comeholyspirit.com` (your Render domain, or Render's own `.onrender.com` URL until you attach the custom one)
4. **Authorised redirect URIs** — only the *API* origin handles this:
   - `https://api.comeholyspirit.com/auth/google/callback`
5. **Create**, then copy the **Client ID** and **Client secret** — you'll paste these into Render next.

Redirect URIs must match byte for byte: no trailing slash, correct scheme.

---

## 3. Deploy the API to Render

The API server (`server.js`) needs a real process running continuously, which is what Render is for.

1. <https://render.com> → **New → Web Service** → connect your GitHub account and pick the `podcast-studio` repo.
2. Settings:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free, to start
3. Under **Environment**, add these variables:

   | Key | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `PUBLIC_URL` | `https://api.comeholyspirit.com` (or your `.onrender.com` URL for now) |
   | `ALLOWED_ORIGINS` | `https://<you>.github.io,https://comeholyspirit.com,https://www.comeholyspirit.com` |
   | `GOOGLE_CLIENT_ID` | from step 2.4 |
   | `GOOGLE_CLIENT_SECRET` | from step 2.4 |
   | `GOOGLE_REDIRECT_URI` | `https://api.comeholyspirit.com/auth/google/callback` |
   | `ADMIN_KEY` | any random string you make up |
   | `DRIVE_ROOT_FOLDER` | `Podcast_Studio_Projects` |
   | `ENABLE_SERVER_JOIN` | `false` |

   Leave `GOOGLE_REFRESH_TOKEN` unset for now — you'll get it in the next step. Don't set `PORT`; Render injects it.

4. Click **Create Web Service**. Render builds and deploys — watch the log tab; when it says the server is listening, it's live at something like `https://podcast-studio-xxxx.onrender.com`.

### 3.1 Link your Google Drive (one-time, in the browser)

Visit, in any browser, signed in as the Google account you want everything saved to:

```
https://<your-render-url>/auth/owner?key=<your ADMIN_KEY>
```

Approve the consent screen. The callback page prints something like:

```
GOOGLE_REFRESH_TOKEN=1//0g...
```

Copy that whole value. Go back to Render → your service → **Environment**, add `GOOGLE_REFRESH_TOKEN` with that value, and save — Render redeploys automatically.

Confirm it worked by visiting `https://<your-render-url>/api/status` — it should show `{"linked":true}`.

### 3.2 Attach your custom domain (optional, do this whenever)

1. Render → your service → **Settings → Custom Domain** → add `api.comeholyspirit.com`.
2. Render shows you a CNAME record — add it at your DNS provider.
3. Once it's verified, update `PUBLIC_URL` and `GOOGLE_REDIRECT_URI` in Render's environment to use `api.comeholyspirit.com`, and update the redirect URI in Google Cloud (step 2.4) to match.

---

## 4. Publish the frontend on GitHub Pages

1. Back in your Codespace (or **Add file → Edit** directly on github.com), open `public/index.html` and set your live API URL:

   ```html
   <script>
     window.__STUDIO_API__ = 'https://api.comeholyspirit.com';
   </script>
   ```

2. Copy that same file over `public/404.html` so guest links keep working — Pages has no server-side routing, so without this, `/room/some-slug` 404s instead of loading the app:

   ```bash
   cp public/index.html public/404.html
   ```

   (In the Codespace terminal, then `git add`, `git commit`, `git push`.)

3. On github.com: repo → **Settings → Pages**. Source: **Deploy from a branch**, branch `main`, folder — pick `/public` if offered. If GitHub only offers `/` or `/docs`, either rename `public/` to `docs/` in the Codespace and push, or create a `gh-pages` branch from the terminal:

   ```bash
   git subtree push --prefix public origin gh-pages
   ```

   and point Pages at that branch instead.

4. Once it deploys, your site is live at `https://<you>.github.io/podcast-studio/`.

### 4.1 Point comeholyspirit.com at it

1. In the Codespace, add a file `public/CNAME` (no extension) containing one line: `comeholyspirit.com`. Commit and push.
2. At your domain's DNS provider, add either:
   - four `A` records for the apex domain pointing at GitHub Pages' IPs (`185.199.108.153`, `.109.153`, `.110.153`, `.111.153`), or
   - a `CNAME` record for `www` pointing at `<you>.github.io`
3. Back in repo **Settings → Pages**, enter `comeholyspirit.com` as the custom domain and wait for DNS to verify, then tick **Enforce HTTPS**.
4. Add `https://comeholyspirit.com` to `ALLOWED_ORIGINS` in Render and to the OAuth client's JavaScript origins in Google Cloud, if you haven't already.

---

## 5. Try it

Open your site, click **New project**, name it, then open it to enter the studio. Allow camera and microphone when prompted. Press **Record**, talk for a few seconds, press stop — the take should show "In Google Drive" within moments. Copy the invite link and open it in a different browser or incognito window to test a second guest (two tabs in the same profile fight over the camera).

---

## 6. Bandwidth: what actually crosses your Render service

The architecture keeps recording bytes off your host entirely.

| Traffic | Path | Cost to Render |
| --- | --- | --- |
| Recording uploads | Browser → Google Drive | none |
| Live video between guests | Peer-to-peer WebRTC | none |
| Frontend assets | GitHub Pages | none |
| Downloading finished files | Google's CDN | none |
| Socket.IO signalling | Through Render | ~50 KB per session |
| API JSON | Through Render | a few KB per call |

A four-hour session with three guests costs roughly **200 KB** of egress — a 5 GB monthly allowance covers tens of thousands of sessions.

**The one exception is server-side "Join parts,"** which pulls each part down from Drive and pushes the joined file back up — about **twice the combined part size**. It ships **disabled** (`ENABLE_SERVER_JOIN=false` above). With it off, the studio tells you to drop the numbered parts onto one timeline track in your editor in order — part 2 starts exactly where part 1 stopped, so this is equivalent to the server join, done for free on your machine.

If you ever want it on: set `ENABLE_SERVER_JOIN=true` in Render, plus `JOIN_MAX_BYTES` and `EGRESS_BUDGET_BYTES` to cap how much any single job or month can cost. `GET /api/egress` reports usage since the last restart — a guard rail, not real accounting; check Render's own dashboard for the true figure.

### Cold starts

Render's free tier sleeps after 15 minutes idle. Hit `/healthz` from a free uptime pinger (e.g. UptimeRobot) a few minutes before a scheduled session so the first guest isn't waiting ~30 seconds for a cold start.

---

## 7. How recording works

1. Someone presses **Start recording**. The client emits `recording:start` over Socket.IO with a shared session ID.
2. Each browser asks the API for a **resumable upload session** per track and gets back a Google-issued session URL.
3. Each browser starts its own `MediaRecorder` on its own local stream — nothing is recorded from the network.
4. Chunks arrive every second, buffer to roughly 8 MB, then `PUT` **directly to Google**. The API server never sees the bytes.
5. On stop, only the last few seconds are left to send, so the file finishes in Drive almost immediately. A local copy stays in the tab for instant preview and offline download.

### Drop-outs vs. rejoins

- **Network blip, tab stays open:** the uploader retries with backoff and resumes at Drive's confirmed byte offset. One continuous file, no gap.
- **Tab closes and the guest rejoins:** `MediaRecorder` can't be resumed, so the new take starts a new file — saved as `part2`, `part3`, etc. in the same session folder. Part numbers persist in the browser so a reload doesn't lose count.

WebM parts can't be safely byte-concatenated (each has its own container header), which is why rejoin parts are numbered files rather than one growing file — join them in your editor, or turn on server-side joining if you have bandwidth to spare.

### Sync

Each track is recorded locally, so takes start within a few frames of each other but aren't sample-accurate. The shared session ID, folder-per-session layout, and start timestamps give your editor a sync point. A clap at the top of the take still helps.

### Memory

The in-tab preview copy holds the whole take in memory — roughly 1 GB/hour at 1080p. For multi-hour shows, stop and restart the take every 30–45 minutes; each restart just becomes the next part.

---

## 8. Project structure

```
├── package.json
├── server.js                  Socket.IO signalling, Drive OAuth, upload sessions, ffmpeg join
├── .env.example                reference only — you set these in Render's dashboard instead
├── README.md
└── public/
    ├── index.html              App shell — set window.__STUDIO_API__ here
    ├── 404.html                Copy of index.html, for GitHub Pages routing
    ├── CNAME                   Your custom domain (add this yourself)
    ├── css/
    │   ├── main.css            Shell, sidebar, dashboard
    │   └── studio.css          Video grid, controls, assets
    └── js/
        ├── config.js           Endpoints, fetch wrapper, DOM helpers, icons
        ├── components/
        │   ├── Navbar.js
        │   ├── ProjectManager.js
        │   ├── RoomScheduler.js
        │   ├── StudioRoom.js
        │   └── AssetManager.js
        ├── services/
        │   ├── webrtcService.js     Mesh peer connections
        │   ├── recorderService.js   MediaRecorder + part numbering
        │   ├── uploaderService.js   Live chunked upload direct to Drive
        │   └── gdriveService.js     API client, join jobs, download links
        └── app.js              Router and mounting
```

## 9. Limits worth knowing

- **Mesh WebRTC** scales to about 4–5 participants. Beyond that, an SFU (mediasoup, LiveKit) would be needed.
- **No TURN server** is configured, only public STUN — roughly one connection in ten fails behind strict corporate NATs. Add a TURN server (Twilio, Metered, or self-hosted coturn) to `RTC_CONFIG` in `public/js/config.js` if that matters to you.
- **One Drive, no guest accounts.** Anyone with a room link can record into your Drive. Room slugs are the only access control — treat them as secrets.
- **Refresh tokens expire after 7 days** while the OAuth consent screen is in *Testing* — publish it (step 2.3).
- **Scheduled events** live in each browser's `localStorage`, not on the server.

## License

MIT
