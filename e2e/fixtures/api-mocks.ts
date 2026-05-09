import type { Page, Route } from '@playwright/test';
import { test as base } from '@playwright/test';
import * as mock from './mock-data.js';

// Wraps a route handler to only intercept fetch/xhr requests (API calls).
// Page navigations (resourceType 'document') are passed through to the dev server.
// This prevents broad glob patterns from hijacking page navigations and returning JSON.
function apiOnly(handler: (route: Route) => Promise<void>): (route: Route) => Promise<void> {
  return async (route) => {
    const type = route.request().resourceType();
    if (type !== 'fetch' && type !== 'xhr') {
      await route.fallback();
      return;
    }
    await handler(route);
  };
}

async function setupApiMocks(page: Page) {
  // Set auth token before page loads
  await page.addInitScript(() => {
    window.localStorage.setItem('api-token', 'mock-token');
  });

  // Register API route intercepts (most specific first)
  // All handlers are wrapped with apiOnly() to avoid intercepting page navigations.

  // Auth endpoints
  await page.route(
    '**/auth/me/teams/auto-join',
    apiOnly(async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      } else {
        await route.fallback();
      }
    }),
  );

  await page.route(
    '**/auth/me/teams',
    apiOnly(async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockUserTeams[0]),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockUserTeams),
        });
      }
    }),
  );

  await page.route(
    '**/auth/me/guilds',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockDiscordGuilds),
      });
    }),
  );

  await page.route(
    '**/auth/me/locale',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockCurrentUser),
      });
    }),
  );

  await page.route(
    '**/auth/me',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockCurrentUser),
      });
    }),
  );

  await page.route(
    '**/auth/login/url',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockLoginUrl),
      });
    }),
  );

  await page.route(
    '**/auth/profile',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockCurrentUser),
      });
    }),
  );

  // Event RSVP endpoints (before generic event routes)
  await page.route(
    '**/teams/*/events/*/rsvps/non-responders',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ nonResponders: [] }),
      });
    }),
  );

  await page.route(
    '**/teams/*/events/*/rsvps',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockEventRsvpDetail),
      });
    }),
  );

  await page.route(
    '**/teams/*/events/*/rsvp',
    apiOnly(async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 204 });
      } else {
        await route.fallback();
      }
    }),
  );

  await page.route(
    '**/teams/*/events/*/cancel',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  // Single event detail (must be before events list)
  await page.route(
    '**/teams/*/events/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/events') || url.endsWith('/events/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockEventDetail),
      });
    }),
  );

  // Events list
  await page.route(
    '**/teams/*/events',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockEventList),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockEventDetail),
        });
      }
    }),
  );

  // Members endpoints
  await page.route(
    '**/teams/*/members/*/roles/*',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/members/*/roles',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/members/*/activity-stats',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          currentStreak: 5,
          longestStreak: 10,
          totalActivities: 42,
          totalDurationMinutes: 1260,
          counts: [],
        }),
      });
    }),
  );

  await page.route(
    '**/teams/*/members/*/activity-logs',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ logs: [] }),
      });
    }),
  );

  await page.route(
    '**/teams/*/activity-types',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ activityTypes: [] }),
      });
    }),
  );

  await page.route(
    '**/teams/*/members/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/members') || url.endsWith('/members/')) {
        await route.fallback();
        return;
      }
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockMembers[0]),
        });
      } else if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 204 });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockMembers[0]),
        });
      }
    }),
  );

  await page.route(
    '**/teams/*/members',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockMembers),
      });
    }),
  );

  // Rosters endpoints
  await page.route(
    '**/teams/*/rosters/*/members/*',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/rosters/*/members',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/rosters/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/rosters') || url.endsWith('/rosters/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mock.mockRosterList.rosters[0], members: mock.mockMembers }),
      });
    }),
  );

  await page.route(
    '**/teams/*/rosters',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockRosterList),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockRosterList.rosters[0]),
        });
      }
    }),
  );

  // Roles endpoints
  await page.route(
    '**/teams/*/roles/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/roles') || url.endsWith('/roles/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mock.mockRoleList.roles[0], permissions: [] }),
      });
    }),
  );

  await page.route(
    '**/teams/*/roles',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockRoleList),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ ...mock.mockRoleList.roles[0], permissions: [] }),
        });
      }
    }),
  );

  // Groups endpoints (discord-channels before generic groups)
  await page.route(
    '**/teams/*/discord-channels',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockDiscordChannels),
      });
    }),
  );

  await page.route(
    '**/teams/*/groups/*/channel-mapping',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    }),
  );

  await page.route(
    '**/teams/*/groups/*/members/*',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/groups/*/members',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/groups/*/roles/*',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/groups/*/roles',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/teams/*/groups/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/groups') || url.endsWith('/groups/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...mock.mockGroups[0], members: mock.mockMembers, roles: [] }),
      });
    }),
  );

  await page.route(
    '**/teams/*/groups',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockGroups),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockGroups[0]),
        });
      }
    }),
  );

  // Training types endpoints
  await page.route(
    '**/teams/*/training-types/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      if (url.endsWith('/training-types') || url.endsWith('/training-types/')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...mock.mockTrainingTypeList.trainingTypes[0],
          ownerGroupId: null,
          memberGroupId: null,
        }),
      });
    }),
  );

  await page.route(
    '**/teams/*/training-types',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockTrainingTypeList),
        });
      } else {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockTrainingTypeList.trainingTypes[0]),
        });
      }
    }),
  );

  // Dashboard
  await page.route(
    '**/teams/*/dashboard',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockDashboardResponse),
      });
    }),
  );

  // Leaderboard
  await page.route(
    '**/teams/*/leaderboard*',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockLeaderboard),
      });
    }),
  );

  // Settings
  await page.route(
    '**/teams/*/settings',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mock.mockTeamSettings),
      });
    }),
  );

  // Notifications
  await page.route(
    '**/notifications/read-all',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/notifications/*/read',
    apiOnly(async (route) => {
      await route.fulfill({ status: 204 });
    }),
  );

  await page.route(
    '**/notifications*',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockNotifications),
        });
      } else {
        await route.fallback();
      }
    }),
  );

  // Invite endpoints
  await page.route(
    '**/invite/*/join',
    apiOnly(async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ teamId: mock.TEAM_ID, roleNames: [], isProfileComplete: true }),
      });
    }),
  );

  await page.route(
    '**/invite/*',
    apiOnly(async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockInviteInfo),
        });
      } else {
        await route.fallback();
      }
    }),
  );

  // Team-scoped invites list / create
  await page.route(
    '**/teams/*/invites',
    apiOnly(async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockCreatedInvite),
        });
      } else if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockInviteList),
        });
      } else {
        await route.fallback();
      }
    }),
  );

  // Team info (catch-all for /teams/:teamId)
  await page.route(
    '**/teams/*',
    apiOnly(async (route) => {
      const url = route.request().url();
      const pathAfterTeams = url.split('/teams/')[1];
      if (pathAfterTeams && !pathAfterTeams.includes('/')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mock.mockTeamInfo),
        });
      } else {
        await route.fallback();
      }
    }),
  );

  // ICal
  await page.route(
    '**/ical/**',
    apiOnly(async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    }),
  );
}

// Authenticated test with full API mocking
export const test = base.extend<{ mockApi: undefined }>({
  mockApi: [
    async ({ page }, use) => {
      await setupApiMocks(page);
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';

// Variant for unauthenticated pages (homepage, language, theme)
// Mocks only auth/me to return 401 quickly, so beforeLoad resolves fast
// without waiting for a real API server timeout.
export const unauthenticatedTest = base.extend<{ fastAuth: undefined }>({
  fastAuth: [
    async ({ page }, use) => {
      await page.route(
        '**/auth/me',
        apiOnly(async (route) => {
          await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
        }),
      );

      await page.route(
        '**/auth/login/url',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mock.mockLoginUrl),
          });
        }),
      );

      await use(undefined);
    },
    { auto: true },
  ],
});

// Variant for incomplete profile testing
export const incompleteProfileTest = base.extend<{ mockApi: undefined }>({
  mockApi: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('api-token', 'mock-token');
      });

      // Override auth/me to return incomplete user
      await page.route(
        '**/auth/me/teams',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([]),
          });
        }),
      );

      await page.route(
        '**/auth/me',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mock.mockIncompleteUser),
          });
        }),
      );

      await page.route(
        '**/auth/login/url',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mock.mockLoginUrl),
          });
        }),
      );

      await page.route(
        '**/auth/profile',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mock.mockCurrentUser),
          });
        }),
      );

      await page.route(
        '**/auth/me/guilds',
        apiOnly(async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mock.mockDiscordGuilds),
          });
        }),
      );

      await use(undefined);
    },
    { auto: true },
  ],
});
