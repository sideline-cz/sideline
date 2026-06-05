import { describe, expect, it } from 'vitest';
import { shouldReloadOnControllerChange } from '~/lib/sw-reload.js';

describe('shouldReloadOnControllerChange', () => {
  it('does not reload on first install (no prior controller)', () => {
    // First-ever visit: the freshly installed SW calls clients.claim(), which
    // fires controllerchange even though the page was never controlled before.
    // Reloading here would be a jarring refresh on first load.
    expect(shouldReloadOnControllerChange(false, false)).toBe(false);
  });

  it('reloads once when an updated SW takes control of an already-controlled page', () => {
    expect(shouldReloadOnControllerChange(true, false)).toBe(true);
  });

  it('does not reload again once a reload has already been triggered (loop guard)', () => {
    expect(shouldReloadOnControllerChange(true, true)).toBe(false);
  });

  it('does not reload when there was no prior controller even if flagged reloaded', () => {
    expect(shouldReloadOnControllerChange(false, true)).toBe(false);
  });
});
