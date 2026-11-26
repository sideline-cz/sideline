// `workout.tsx` renders the personal workout page and no <Outlet/>, so a route nested under it is
// never shown: /workout/weekly displayed the parent page. Weekly must hang off `$teamId`, like
// `workout_.team` does.

import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

// Importing the tree wires each file route to its parent.
await import('~/routeTree.gen.js');
const { Route } = await import('./workout_.weekly.js');
const { Route: TeamRoute } = await import('./route.js');
const { Route: WorkoutRoute } = await import('./workout.js');

describe('/teams/$teamId/workout/weekly', () => {
  it('is not a child of the workout page route', () => {
    const parent = Route.options.getParentRoute?.();
    expect(parent).not.toBe(WorkoutRoute);
    expect(parent).toBe(TeamRoute);
  });
});
