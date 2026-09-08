/**
 * Footer.js — the small fixed quote bar pinned to the bottom of the page.
 *
 * Two audiences, two quotes:
 *   host  — Daniel & Tom's side (sign-in, library, scheduled, settings,
 *           project detail, and the studio room when recording as host)
 *   guest — the guest's side (the "join a room" landing, and the studio
 *           room when joined as a guest)
 *
 * Neither shows on the neutral entry-portal split, since nobody has picked
 * a side yet there. setFooterAudience(null) hides it entirely.
 */

const QUOTES = {
  host: {
    quote: '“Do not desire to be what you are; desire to be very well what you are.”',
    attribution: '— St. Francis de Sales'
  },
  guest: {
    quote: '“Unfurl the sails, and let God steer us where He will.”',
    attribution: '— St. Bede the Venerable'
  }
};

export function setFooterAudience(audience) {
  const node = document.getElementById('app-footer');
  if (!node) return;

  const copy = QUOTES[audience];
  if (!copy) {
    node.classList.remove('visible');
    node.innerHTML = '';
    return;
  }

  node.innerHTML = '';
  const quote = document.createElement('span');
  quote.className = 'footer-quote';
  quote.textContent = copy.quote;

  const attribution = document.createElement('span');
  attribution.className = 'footer-attribution';
  attribution.textContent = copy.attribution;

  node.append(quote, attribution);
  node.classList.add('visible');
}