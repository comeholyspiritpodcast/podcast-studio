/**
 * app.js — router and mount point.
 *
 * Routes:
 *   /                  neutral entry split (creator or guest?) — first visit only
 *   /host              host home: library dashboard once signed in, sign-in
 *                       card otherwise
 *   /guest             guest home: always just a "join a room" landing —
 *                      never projects, creation tools, schedule, or upload
 *   #/scheduled        scheduled sessions (host only, under /host)
 *   #/settings         account and capture defaults (host only)
 *   #/room/:slug       the studio (host or guest, depending on session)
 *
 * A guest is confined to /guest and /room/:slug no matter what URL they
 * land on — any other path just bounces them back to /guest, since a
 * guest's home has nothing on it but a way to join a room.
 *
 * /host, /guest, and /room/:slug all work as clean paths (Express serves
 * index.html for them), which is what invite links and bookmarks use; they
 * are normalised to a hash route here for anything below them.
 */

import { toast, creator, guestMode } from './config.js';
import { renderNavbar, renderSidebar } from './components/Navbar.js';
import { renderProjects } from './components/ProjectManager.js';
import { renderProjectDetail } from './components/ProjectDetail.js';
import { renderScheduler, renderSettings } from './components/RoomScheduler.js';
import { renderStudio, teardownStudio } from './components/StudioRoom.js';
import { renderEntryPortal, renderHostSignIn, renderGuestLanding } from './components/EntryPortal.js';
import { setFooterAudience } from './components/Footer.js';
import { gdrive } from './services/gdriveService.js';

const view = document.getElementById('view');
const navbarEl = document.getElementById('navbar');
const sidebarEl = document.getElementById('sidebar');
let status = { linked: false };

function currentRoute() {
  const path = window.location.pathname;
  const isCleanPath = path.startsWith('/room/') || path === '/host' || path === '/guest';
  if (!window.location.hash && isCleanPath) return path;
  return window.location.hash.slice(1) || '/';
}

async function route() {
  const path = currentRoute();
  teardownStudio();

  const isRoomRoute = path.startsWith('/room/');

  // A guest never sees anything but the room they're in or the "join a
  // room" landing — regardless of which URL they land on. This takes
  // priority over everything else below.
  if (guestMode.isGuest() && !isRoomRoute) {
    navbarEl.style.display = 'none';
    sidebarEl.style.display = 'none';
    setFooterAudience('guest');
    await renderGuestLanding(view);
    return;
  }

  const signedIn = creator.isSignedIn() || guestMode.isGuest();

  // Nobody has picked a side, and this isn't a direct room link (which a
  // guest could still be following without having gone through the portal
  // first) — show the appropriate choice screen instead of guessing.
  if (!signedIn && !isRoomRoute) {
    navbarEl.style.display = 'none';
    sidebarEl.style.display = 'none';

    if (path === '/host') {
      setFooterAudience('host');
      await renderHostSignIn(view);
    } else if (path === '/guest') {
      setFooterAudience('guest');
      await renderGuestLanding(view);
    } else {
      setFooterAudience(null);
      await renderEntryPortal(view);
    }
    return;
  }

  navbarEl.style.display = '';
  sidebarEl.style.display = '';

  if (isRoomRoute) {
    const slug = decodeURIComponent(path.slice('/room/'.length)).replace(/\/+$/, '');
    setFooterAudience(guestMode.isGuest() ? 'guest' : 'host');
    renderNavbar({ title: guestMode.isGuest() ? '' : 'Studio', status });
    renderSidebar({ route: '/', status });
    await renderStudio(view, { slug, status });
    return;
  }

  // Everything below is host-only. A guest can't reach here (handled
  // above), so this is only ever a signed-in creator or someone whose
  // session lapsed.
  if (!creator.isSignedIn()) {
    navbarEl.style.display = 'none';
    sidebarEl.style.display = 'none';
    setFooterAudience('host');
    await renderHostSignIn(view);
    return;
  }

  setFooterAudience('host');

  // /host is the host's home — alias it to the library, same as "/".
  const effectivePath = path === '/host' ? '/' : path;

  if (effectivePath === '/scheduled') {
    renderNavbar({ title: 'Scheduled events', status });
    renderSidebar({ route: '/scheduled', status });
    await renderScheduler(view, { status });
  } else if (effectivePath === '/settings') {
    renderNavbar({ title: 'Settings', status });
    renderSidebar({ route: '/settings', status });
    await renderSettings(view, { status });
  } else if (effectivePath.startsWith('/project/')) {
    const projectSlug = decodeURIComponent(effectivePath.slice('/project/'.length)).replace(/\/+$/, '');
    renderNavbar({ title: '', status });
    renderSidebar({ route: '/', status });
    await renderProjectDetail(view, { slug: projectSlug, status });
  } else {
    renderNavbar({ title: '', status });
    renderSidebar({ route: '/', status });
    await renderProjects(view, { status });
  }

  view.focus({ preventScroll: true });
}

/**
 * If nothing has replaced the placeholder "Loading studio…" text within a
 * few seconds, something upstream (a hung fetch, an uncaught exception
 * before the first render) has stalled navigation. Rather than leave the
 * person staring at a spinner forever, swap in a manual retry — this is the
 * fix for the "stuck on Loading studio" report.
 */
function armLoadingWatchdog() {
  const timer = setTimeout(() => {
    if (view.querySelector('.loading')) {
      view.innerHTML =
        '<div class="empty"><h3>This is taking longer than expected</h3>' +
        '<p>The studio server may be waking up or unreachable.</p>' +
        '<button class="btn btn-primary" id="watchdog-retry">Try again</button></div>';
      const btn = document.getElementById('watchdog-retry');
      if (btn) btn.addEventListener('click', () => window.location.reload());
    }
  }, 9000);
  return () => clearTimeout(timer);
}

async function boot() {
  const disarm = armLoadingWatchdog();

  try {
    status = await gdrive.status();
  } catch {
    status = { linked: false, message: 'The studio API is unreachable.' };
  }

  if (creator.isSignedIn() && !status.linked) {
    toast('Studio Drive is not linked. Recordings will stay in the browser until it is.', 'error');
  }

  window.addEventListener('hashchange', () => route().catch(reportError));

  try {
    await route();
  } finally {
    disarm();
  }
}

function reportError(err) {
  console.error(err);
  toast(err.message || 'Something went wrong', 'error');
}

boot().catch(reportError);