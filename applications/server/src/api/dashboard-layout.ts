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
        x: entry.x,
        y: entry.y,
        w: entry.w,
        h: entry.h,
      }),
  );

// ---------------------------------------------------------------------------
// normalizeWidgets
// ---------------------------------------------------------------------------

/**
 * Minimum sensible h/w values for the current rowHeight=10 grid. Stored widgets
 * with smaller dimensions are legacy data from an earlier rowHeight=80 scale
 * and would render as unusable tiny cells; we restore canonical positions for
 * those widgets. Anything >= these thresholds is preserved (real user resizes).
 */
const MIN_H = 5;
const MIN_W = 2;

const defaultEntryById = new Map<
  DashboardLayoutApi.DashboardWidgetId,
  DashboardLayoutApi.DefaultLayoutEntry
>(DashboardLayoutApi.DEFAULT_LAYOUT.map((entry) => [entry.id, entry]));

const restoreIfTooSmall = (
  widget: DashboardLayoutApi.DashboardWidget,
): DashboardLayoutApi.DashboardWidget => {
  if (widget.h >= MIN_H && widget.w >= MIN_W) return widget;
  const defaults = defaultEntryById.get(widget.id);
  if (!defaults) return widget;
  return new DashboardLayoutApi.DashboardWidget({
    id: widget.id,
    visible: widget.visible,
    x: defaults.x,
    y: defaults.y,
    w: defaults.w,
    h: defaults.h,
  });
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
    result.push(restoreIfTooSmall(widget));
  }

  // Compute max y+h of existing widgets to place missing ones below
  const maxBottom = result.length > 0 ? Math.max(...result.map((w) => w.y + w.h)) : 0;
  let nextY = maxBottom;

  // Append any missing canonical widgets using DEFAULT_LAYOUT positions (offset below existing)
  for (const defaultEntry of DashboardLayoutApi.DEFAULT_LAYOUT) {
    if (!seen.has(defaultEntry.id)) {
      result.push(
        new DashboardLayoutApi.DashboardWidget({
          id: defaultEntry.id,
          visible: defaultEntry.visible,
          x: defaultEntry.x,
          y: nextY,
          w: defaultEntry.w,
          h: defaultEntry.h,
        }),
      );
      nextY += defaultEntry.h;
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
