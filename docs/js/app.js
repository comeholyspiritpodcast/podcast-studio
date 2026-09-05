/**
 * app.js — router and mount point.
 *
 * Routes:
 *   #/                 library dashboard (creator only)
 *   #/scheduled        scheduled sessions (creator only)
 *   #/settings         account and capture defaults (creator only)
 *   #/room/:slug       the studio (creator or guest, depending on session)
 *
 * Anyone who hasn't picked a side yet — no creator session, no guest
 * session, and no room in the URL — sees the entry portal instead of any
 * of the above.
 *
 * /room/:slug also works as a clean path (Express serves index.html for it),
 * which is what guest invite links use; it is normalised to a hash route here.
 */

import { toast, creator, guestMode } from './config.js';
import { renderNavbar, renderSidebar } from './components/Navbar.js';
import { renderProjects } from './components/ProjectManager.js';
import { renderProjectDetail } from './components/ProjectDetail.js';
import { renderScheduler, renderSettings } from './components/RoomScheduler.js';
import { renderStudio, teardownStudio } from './components/StudioRoom.js';
import { renderEntryPortal } from './components/EntryPortal.js';
import { gdrive } from './services/gdriveService.js';

const view = document.getElementById('view');
const navbarEl = document.getElementById('navbar');
const sidebarEl = document.getElementById('sidebar');
let status = { linked: false };

function currentRoute() {
  const path = window.location.pathname;
  if (!window.location.hash && path.startsWith('/room/')) return path;
  return window.location.hash.slice(1) || '/';
}

async function route() {
  const path = currentRoute();
  teardownStudio();

  const isRoomRoute = path.startsWith('/room/');
  const signedIn = creator.isSignedIn() || guestMode.isGuest();

  // Nobody has picked a side, and this isn't a direct room link (which a
  // guest could still be following without having gone through the portal
  // first) — show the choice screen instead of guessing.
  if (!signedIn && !isRoomRoute) {
    navbarEl.style.display = 'none';
    sidebarEl.style.display = 'none';
    await renderEntryPortal(view);
    return;
  }

  navbarEl.style.display = '';
  sidebarEl.style.display = '';

  if (isRoomRoute) {
    const slug = decodeURIComponent(path.slice('/room/'.length)).replace(/\/+$/, '');
    renderNavbar({ title: guestMode.isGuest() ? '' : 'Studio', status });
    renderSidebar({ route: '/', status });
    await renderStudio(view, { slug, status });
    return;
  }

  // Everything below is creator-only. A guest who somehow lands on one of
  // these hashes (e.g. browser back button) is bounced to the portal rather
  // than shown an empty or broken dashboard.
  if (!creator.isSignedIn()) {
    navbarEl.style.display = 'none';
    sidebarEl.style.display = 'none';
    await renderEntryPortal(view);
    return;
  }

  if (path === '/scheduled') {
    renderNavbar({ title: 'Scheduled events', status });
    renderSidebar({ route: '/scheduled', status });
    await renderScheduler(view, { status });
  } else if (path === '/settings') {
    renderNavbar({ title: 'Settings', status });
    renderSidebar({ route: '/settings', status });
    await renderSettings(view, { status });
  } else if (path.startsWith('/project/')) {
    const projectSlug = decodeURIComponent(path.slice('/project/'.length)).replace(/\/+$/, '');
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
