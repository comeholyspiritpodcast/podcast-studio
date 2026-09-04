/**
 * app.js — router and mount point.
 *
 * Routes:
 *   #/                 projects dashboard
 *   #/scheduled        scheduled sessions
 *   #/settings         account and capture defaults
 *   #/room/:slug       the studio
 *
 * /room/:slug also works as a clean path (Express serves index.html for it),
 * which is what guest invite links use; it is normalised to a hash route here.
 */

import { toast } from './config.js';
import { renderNavbar, renderSidebar } from './components/Navbar.js';
import { renderProjects } from './components/ProjectManager.js';
import { renderScheduler, renderSettings } from './components/RoomScheduler.js';
import { renderStudio, teardownStudio } from './components/StudioRoom.js';
import { gdrive } from './services/gdriveService.js';

const view = document.getElementById('view');
let status = { linked: false };

function currentRoute() {
  const path = window.location.pathname;
  if (!window.location.hash && path.startsWith('/room/')) return path;
  return window.location.hash.slice(1) || '/';
}

async function route() {
  const path = currentRoute();
  teardownStudio();

  if (path.startsWith('/room/')) {
    const slug = decodeURIComponent(path.slice('/room/'.length)).replace(/\/+$/, '');
    renderNavbar({ title: 'Studio', status });
    renderSidebar({ route: '/', status });
    await renderStudio(view, { slug, status });
  } else if (path === '/scheduled') {
    renderNavbar({ title: 'Scheduled events', status });
    renderSidebar({ route: '/scheduled', status });
    await renderScheduler(view, { status });
  } else if (path === '/settings') {
    renderNavbar({ title: 'Settings', status });
    renderSidebar({ route: '/settings', status });
    await renderSettings(view, { status });
  } else {
    renderNavbar({ title: 'Projects', status });
    renderSidebar({ route: '/', status });
    await renderProjects(view, { status });
  }

  view.focus({ preventScroll: true });
}

async function boot() {
  try {
    status = await gdrive.status();
  } catch {
    status = { linked: false, message: 'The studio API is unreachable.' };
  }

  if (!status.linked) {
    toast('Studio Drive is not linked. Recordings will stay in the browser until it is.', 'error');
  }

  window.addEventListener('hashchange', () => route().catch(reportError));
  await route();
}

function reportError(err) {
  console.error(err);
  toast(err.message || 'Something went wrong', 'error');
}

boot().catch(reportError);
