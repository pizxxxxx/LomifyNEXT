import { get } from 'svelte/store';
import { currentArtist, currentView, previousView } from '$lib/stores';

/**
 * Open an author's page.
 *
 * Every list in the app used to inline its own copy of this — `import('$lib/stores')
 * .then(m => { m.currentView.set('artist'); m.currentArtist.set(name); })` — and each
 * copy forgot a different detail: some didn't set `previousView`, so Back landed
 * nowhere; the one in Fullscreen had to special-case the overlay by hand. One function,
 * one set of rules, and `ArtistTag` calls it for every author mention in the app.
 */
export function goToArtist(artist: string | null | undefined) {
  const name = (artist || '').trim();
  if (!name) return;

  currentArtist.set(name);

  // `fullscreen` is an overlay over the current window, not a window of its own. It must
  // never become the "previous" view, or Back / Exit would drop the user straight back
  // into fullscreen mode instead of the page they came from.
  const view = get(currentView);
  if (view === 'fullscreen') {
    if (get(previousView) === 'fullscreen') previousView.set('home');
  } else {
    previousView.set(view);
  }

  currentView.set('artist');
}
