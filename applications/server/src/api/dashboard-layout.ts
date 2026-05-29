import { Auth, DashboardLayoutApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { DashboardLayoutsRepository } from '~/repositories/DashboardLayoutsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new DashboardLayoutApi.Forbidden();

// ---------------------------------------------------------------------------
// Default layout (mirrors domain DEFAULT_LAYOUT)
// ---------------------------------------------------------------------------

export const DEFAULT_LAYOUT: ReadonlyArray<DashboardLayoutApi.DashboardWidget> =
  DashboardLayoutApi.DEFAULT_LAYOUT.map(
    (entry) =>
      new DashboardLayoutApi.DashboardWidget({
        id: entry.id,
        visible: entry.visible,
        height: entry.height,
        colSpan: entry.colSpan,
        x: entry.x,
        y: entry.y,
      }),
  );

// ---------------------------------------------------------------------------
// normalizeWidgets
// ---------------------------------------------------------------------------

/** Clamp colSpan to the valid [1, 3] range. */
const clampColSpan = (value: number): 1 | 2 | 3 => {
  if (value <= 1) return 1;
  if (value >= 3) return 3;
  return 2;
};

/** Clamp x to [0, 11]. */
const clampX = (value: number): number => Math.max(0, Math.min(11, value));

/** Clamp y to [0, 999]. */
const clampY = (value: number): number => Math.max(0, Math.min(999, value));

/**
 * Minimum sensible pixel height for a dashboard widget. Anything below this is
 * almost certainly stale data from an earlier schema revision (e.g. row-units
 * stored as a small integer). Snap such values back to the canonical default
 * height for that widget so the dashboard never renders as unusable thin strips.
 */
const MIN_HEIGHT_PX = 60;

const defaultEntryById = new Map<
  DashboardLayoutApi.DashboardWidgetId,
  DashboardLayoutApi.DefaultLayoutEntry
>(DashboardLayoutApi.DEFAULT_LAYOUT.map((entry) => [entry.id, entry]));

const resolveHeight = (widget: DashboardLayoutApi.DashboardWidget): number => {
  if (widget.height >= MIN_HEIGHT_PX) return widget.height;
  return defaultEntryById.get(widget.id)?.height ?? MIN_HEIGHT_PX;
};

export const normalizeWidgets = (
  input: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
): ReadonlyArray<DashboardLayoutApi.DashboardWidget> => {
  const validIds = new Set<DashboardLayoutApi.DashboardWidgetId>(
    DashboardLayoutApi.DASHBOARD_WIDGET_ORDER,
  );
  const seen = new Set<DashboardLayoutApi.DashboardWidgetId>();
  const result: DashboardLayoutApi.DashboardWidget[] = [];

  for (const widget of input) {
    if (!validIds.has(widget.id)) continue;
    if (seen.has(widget.id)) continue;
    seen.add(widget.id);
    result.push(
      new DashboardLayoutApi.DashboardWidget({
        id: widget.id,
        visible: widget.visible,
        height: resolveHeight(widget),
        colSpan: clampColSpan(widget.colSpan),
        x: clampX(widget.x),
        y: clampY(widget.y),
      }),
    );
  }

  // Append any missing canonical widgets using DEFAULT_LAYOUT heights, colSpan, x, y
  for (const defaultEntry of DashboardLayoutApi.DEFAULT_LAYOUT) {
    if (!seen.has(defaultEntry.id)) {
      result.push(
        new DashboardLayoutApi.DashboardWidget({
          id: defaultEntry.id,
          visible: defaultEntry.visible,
          height: defaultEntry.height,
          colSpan: defaultEntry.colSpan,
          x: defaultEntry.x,
          y: defaultEntry.y,
        }),
      );
      seen.add(defaultEntry.id);
    }
  }

  return result;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const DashboardLayoutApiLive = HttpApiBuilder.group(Api, 'dashboardLayout', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('layouts', () => DashboardLayoutsRepository.asEffect()),
    Effect.map(({ members, layouts }) =>
      handlers
        .handle('getDashboardLayout', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('row', ({ currentUser }) => layouts.findByUserTeam(currentUser.id, teamId)),
            Effect.map(({ row }) =>
              Option.match(row, {
                onNone: () => new DashboardLayoutApi.DashboardLayout({ widgets: DEFAULT_LAYOUT }),
                onSome: (r) =>
                  new DashboardLayoutApi.DashboardLayout({
                    widgets: normalizeWidgets(r.widgets),
                  }),
              }),
            ),
          ),
        )
        .handle('updateDashboardLayout', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('normalized', () => normalizeWidgets(payload.widgets)),
            Effect.bind('row', ({ currentUser, normalized }) =>
              layouts.upsert(currentUser.id, teamId, normalized),
            ),
            Effect.map(
              ({ normalized }) =>
                new DashboardLayoutApi.DashboardLayout({
                  widgets: normalized,
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Dashboard layout upsert returned no row'),
            ),
          ),
        ),
    ),
  ),
);
