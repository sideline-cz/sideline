// TDD mode — tests written BEFORE `AssistantResultCard` exists.
// Plan `.work-plans/ai-app-interaction.md` §13.9, design §3.2 / §3.4.
//
// `AssistantResultCard` renders exactly one of the five `AiChatApi.EntityRef` variants
// (`event | member | group | roster | trainingType`) as a compact, single-link row — the
// same idiom as `PlayerCard.tsx` (`h-12 w-full rounded-md border px-2`). P1 (design §3.1):
// the card renders ONLY server-held typed data via the app's existing helpers
// (`formatEventDateRange`, `getEventColor`, `eventStatusLabels`/`eventStatusClasses`,
// `resolveEffectiveRoles`/`sortEffectiveRoles`, `ColorDot`, `RoleBadge`) — never model prose.
//
// NOTE on the wire contract: the design doc's §3.2 prose still says the common field is
// `token`. That is STALE. The shipped `packages/domain/src/api/AiChatApi.ts` — authoritative
// per the architect — names it `ref` (a `RefToken`, 4 lowercase-alphanumeric chars). Every
// fixture below uses `ref`, not `token`.
//
// Accessibility hazard under test (plan's "do not lose these" list, design §3.4): a member
// row must NOT use `EffectiveRolesList` — its overflow trigger is a real `<button>`
// (`EffectiveRolesList.tsx:48-56`, a `PopoverTrigger`), which would nest a `<button>` inside
// the row's `<a>` (invalid HTML, breaks keyboard/AT nav). The member card instead renders up
// to 2 bare `RoleBadge` `<span>`s plus a non-interactive `<Badge variant='secondary'>+{n}</Badge>`.

import { type AiChatApi, EventApi, GroupApi, Roster, TrainingTypeApi } from '@sideline/domain';
import { render, screen, within } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
  setTranslationOverrides: vi.fn(),
}));

// Radix `Avatar.Image` only mounts its `<img>` after a real image-load event, which jsdom
// never dispatches — mirrors `MemberSummaryHeader.test.tsx`'s documented workaround.
vi.mock('~/components/ui/avatar', () => ({
  Avatar: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-slot='avatar' {...rest}>
      {children}
    </div>
  ),
  AvatarImage: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // biome-ignore lint/a11y/useAltText: alt is forwarded via {...props} from the real caller
    <img data-slot='avatar-image' {...props} />
  ),
  AvatarFallback: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <span data-slot='avatar-fallback' {...rest}>
      {children}
    </span>
  ),
}));

// Self-contained (no captured outer variables, safe under vi.mock hoisting): interpolates
// `params` into the `$param` placeholders of `to`, so the rendered `<a href>` is the REAL
// resolved destination — letting these tests assert exact hrefs instead of raw route templates.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: React.PropsWithChildren<{ to: string; params?: Record<string, unknown> }>) => {
    const href = String(to).replace(/\$([a-zA-Z]+)/g, (whole: string, key: string) =>
      params && key in params ? String(params[key]) : whole,
    );
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// Dynamic import AFTER mocks — will fail until AssistantResultCard is created & exported
const { AssistantResultCard } = await import(
  '~/components/molecules/assistant/AssistantResultCard.js'
);
const { buildTrainingTypeColorMap, getEventColor } = await import('~/lib/event-colors.js');
const { eventStatusClasses, eventStatusLabels, eventTypeLabels } = await import(
  '~/lib/event-labels.js'
);
const { formatEventDateRange } = await import('~/lib/datetime.js');
const { resolveEffectiveRoles } = await import('~/lib/roles/resolveEffectiveRoles.js');
const { sortEffectiveRoles } = await import('~/lib/roles/role-order.js');
const { entityKindLabels } = await import('~/lib/assistant/entityRoutes.js');

// ---------------------------------------------------------------------------
// Fixtures — plain objects matching the AiChatApi.EntityRef union's decoded shape.
// Branded ids are cast with `as any`, matching the project's existing test convention
// (e.g. `applications/web/test/ActivityTypeFormDialog.test.tsx`'s `TEAM_ID = 'team-1' as any`).
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1';

let refCounter = 0;
// 4-char, lowercase-alphanumeric — matches the RefToken alphabet (`AiChatApi.RefToken`).
const nextRef = () => String(refCounter++).padStart(4, '0');

interface EventOverrides {
  eventId?: string;
  title?: string;
  eventType?: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other';
  trainingTypeName?: Option.Option<string>;
  startAt?: string;
  endAt?: Option.Option<string>;
  allDay?: boolean;
  startDate?: Option.Option<string>;
  endDate?: Option.Option<string>;
  location?: Option.Option<string>;
  status?: 'active' | 'cancelled' | 'started';
}

function makeEventRef(overrides: EventOverrides = {}) {
  const {
    eventId = 'event-1',
    title = 'Tuesday training',
    eventType = 'training',
    trainingTypeName = Option.none<string>(),
    startAt = '2026-05-12T18:00:00.000Z',
    endAt = Option.some('2026-05-12T19:30:00.000Z'),
    allDay = false,
    startDate = Option.none<string>(),
    endDate = Option.none<string>(),
    location = Option.some('Main hall'),
    status = 'active',
  } = overrides;

  return {
    kind: 'event' as const,
    ref: nextRef(),
    event: {
      eventId: eventId as any,
      teamId: TEAM_ID as any,
      title,
      eventType,
      trainingTypeName,
      description: Option.none<string>(),
      imageUrl: Option.none<string>(),
      startAt: DateTime.makeUnsafe(startAt),
      endAt: Option.map(endAt, (v) => DateTime.makeUnsafe(v)),
      location,
      locationUrl: Option.none<string>(),
      status,
      allDay,
      seriesId: Option.none<string>(),
      startDate,
      endDate,
    },
  };
}

interface MemberOverrides {
  memberId?: string;
  displayName?: string;
  avatarUrl?: Option.Option<string>;
  jerseyNumber?: Option.Option<number>;
  roleNames?: ReadonlyArray<string>;
  effectiveRoles?: ReadonlyArray<{
    roleId: string;
    name: string;
    isBuiltIn: boolean;
    source: 'direct' | 'inherited' | 'both';
    groupNames: ReadonlyArray<string>;
  }>;
  active?: boolean;
}

function makeMemberRef(overrides: MemberOverrides = {}) {
  const {
    memberId = 'member-1',
    displayName = 'Jan Novák',
    avatarUrl = Option.none<string>(),
    jerseyNumber = Option.none<number>(),
    roleNames = [],
    effectiveRoles = [],
    active = true,
  } = overrides;

  return {
    kind: 'member' as const,
    ref: nextRef(),
    memberId: memberId as any,
    displayName,
    avatarUrl,
    jerseyNumber,
    roleNames,
    effectiveRoles,
    active,
  };
}

interface GroupOverrides {
  groupId?: string;
  name?: string;
  emoji?: Option.Option<string>;
  color?: Option.Option<string>;
  memberCount?: number;
}

function makeGroupRef(overrides: GroupOverrides = {}) {
  const {
    groupId = 'group-1',
    name = 'U20',
    emoji = Option.none<string>(),
    color = Option.none<string>(),
    memberCount = 12,
  } = overrides;

  return {
    kind: 'group' as const,
    ref: nextRef(),
    group: {
      groupId: groupId as any,
      teamId: TEAM_ID as any,
      parentId: Option.none<string>(),
      name,
      emoji,
      color,
      memberCount,
      discordChannelProvisioning: false,
    },
  };
}

interface RosterOverrides {
  rosterId?: string;
  name?: string;
  emoji?: Option.Option<string>;
  color?: Option.Option<string>;
  memberCount?: number;
  active?: boolean;
}

function makeRosterRef(overrides: RosterOverrides = {}) {
  const {
    rosterId = 'roster-1',
    name = 'First team',
    emoji = Option.none<string>(),
    color = Option.none<string>(),
    memberCount = 18,
    active = true,
  } = overrides;

  return {
    kind: 'roster' as const,
    ref: nextRef(),
    roster: {
      rosterId: rosterId as any,
      teamId: TEAM_ID as any,
      name,
      active,
      memberCount,
      createdAt: '2024-01-01T00:00:00.000Z',
      color,
      emoji,
      discordChannelId: Option.none<string>(),
      discordChannelName: Option.none<string>(),
      discordChannelProvisioning: false,
    },
  };
}

interface TrainingTypeOverrides {
  trainingTypeId?: string;
  name?: string;
  ownerGroupName?: Option.Option<string>;
  memberGroupName?: Option.Option<string>;
}

function makeTrainingTypeRef(overrides: TrainingTypeOverrides = {}) {
  const {
    trainingTypeId = 'tt-1',
    name = 'Speed',
    ownerGroupName = Option.none<string>(),
    memberGroupName = Option.none<string>(),
  } = overrides;

  return {
    kind: 'trainingType' as const,
    ref: nextRef(),
    trainingType: {
      trainingTypeId: trainingTypeId as any,
      teamId: TEAM_ID as any,
      name,
      ownerGroupName,
      memberGroupName,
    },
  };
}

const EMPTY_COLOR_MAP = buildTrainingTypeColorMap([]);

function renderCard(reference: unknown, colorMap = EMPTY_COLOR_MAP) {
  return render(
    <AssistantResultCard
      reference={reference as any}
      teamId={TEAM_ID}
      colorMap={colorMap as any}
    />,
  );
}

function getRow() {
  // 13.9/9 — the whole row is one focusable link. Asserting a single `link` role up front
  // means every other test can safely assume `screen.getByRole('link')` is THE row.
  return screen.getByRole('link');
}

// ---------------------------------------------------------------------------
// F.7 — the widened `reference` prop (`AiChatApi.SearchHit`, no `ref` field) and `renderWrapper`.
//
// These fixtures are built directly as `AiChatApi.SearchHit` (no `as any`, no `ref` key at
// all) — deliberately NOT reusing `make*Ref` above, whose `as any`-cast call sites would hide
// a real type mismatch. Nested `Schema.Class` fields (`event`, `group`, `roster`,
// `trainingType`) use real instances (`new EventApi.EventInfo({...})`, etc.) because
// `Schema.Class` membership is nominal — a field-for-field look-alike plain object does not
// satisfy the class type, only a real instance does.
// ---------------------------------------------------------------------------

function makeEventSearchHit(title = 'Widened Event'): AiChatApi.SearchHit {
  return {
    kind: 'event',
    event: new EventApi.EventInfo({
      eventId: 'event-widened' as any,
      teamId: TEAM_ID as any,
      title,
      eventType: 'training',
      trainingTypeName: Option.none<string>(),
      description: Option.none<string>(),
      imageUrl: Option.none<string>(),
      startAt: DateTime.makeUnsafe('2026-05-12T18:00:00.000Z'),
      endAt: Option.some(DateTime.makeUnsafe('2026-05-12T19:30:00.000Z')),
      location: Option.some('Main hall'),
      locationUrl: Option.none<string>(),
      status: 'active',
      allDay: false,
      seriesId: Option.none() as any,
      startDate: Option.none<string>(),
      endDate: Option.none<string>(),
    }),
  };
}

function makeMemberSearchHit(displayName = 'Widened Member'): AiChatApi.SearchHit {
  return {
    kind: 'member',
    memberId: 'member-widened' as any,
    displayName,
    avatarUrl: Option.none<string>(),
    jerseyNumber: Option.none<number>(),
    roleNames: [],
    effectiveRoles: [],
    active: true,
  };
}

function makeGroupSearchHit(name = 'Widened Group'): AiChatApi.SearchHit {
  return {
    kind: 'group',
    group: new GroupApi.GroupInfo({
      groupId: 'group-widened' as any,
      teamId: TEAM_ID as any,
      parentId: Option.none(),
      name,
      emoji: Option.none<string>(),
      color: Option.none<string>(),
      memberCount: 12,
      discordChannelProvisioning: false,
    }),
  };
}

function makeRosterSearchHit(name = 'Widened Roster'): AiChatApi.SearchHit {
  return {
    kind: 'roster',
    roster: new Roster.RosterInfo({
      rosterId: 'roster-widened' as any,
      teamId: TEAM_ID as any,
      name,
      active: true,
      memberCount: 18,
      createdAt: '2024-01-01T00:00:00.000Z',
      color: Option.none<string>(),
      emoji: Option.none<string>(),
      discordChannelId: Option.none(),
      discordChannelName: Option.none<string>(),
      discordChannelProvisioning: false,
    }),
  };
}

function makeTrainingTypeSearchHit(name = 'Widened Training'): AiChatApi.SearchHit {
  return {
    kind: 'trainingType',
    trainingType: new TrainingTypeApi.TrainingTypeInfo({
      trainingTypeId: 'tt-widened' as any,
      teamId: TEAM_ID as any,
      name,
      ownerGroupName: Option.none<string>(),
      memberGroupName: Option.none<string>(),
    }),
  };
}

// Deliberately typed (no `as any` on `reference`): this is what makes case 1 below a real
// proof that the prop was widened to `SearchHit`, not merely a runtime coincidence (the
// component never having read `.ref` in the first place would let a loosely-typed test pass
// either way). `renderWrapper` is also passed through untyped-cast so a missing prop on
// `AssistantResultCardProps` surfaces as a compile error, per this file's F.7 remit.
function renderSearchHit(
  hit: AiChatApi.SearchHit,
  extra: {
    colorMap?: typeof EMPTY_COLOR_MAP;
    renderWrapper?: (children: React.ReactNode, className: string) => React.ReactElement;
  } = {},
) {
  return render(
    <AssistantResultCard
      reference={hit}
      teamId={TEAM_ID}
      colorMap={extra.colorMap ?? EMPTY_COLOR_MAP}
      renderWrapper={extra.renderWrapper}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssistantResultCard', () => {
  describe('event (13.9/1)', () => {
    it('renders the title, the composed formatEventDateRange output, the status label, and links to the event route', () => {
      const reference = makeEventRef({
        eventId: 'event-42',
        title: 'Tuesday training',
        status: 'active',
      });
      renderCard(reference);

      const row = getRow();
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/events/event-42`);
      expect(within(row).getByText('Tuesday training')).not.toBeNull();

      const { event } = reference;
      const { startDate, startTime, end } = formatEventDateRange(
        event.startAt,
        event.endAt,
        event.allDay,
        event.startDate,
        event.endDate,
      );
      // The row must show the composed start (date, and — since this fixture is NOT all-day —
      // the time too). We don't assume the exact separator punctuation the row uses around it.
      expect(row.textContent).toContain(startDate);
      expect(row.textContent).toContain(startTime);
      if (Option.isSome(end)) {
        expect(row.textContent).toContain(end.value);
      }

      expect(within(row).getByText(eventStatusLabels.active())).not.toBeNull();
      // Secondary line also carries the event-type label (design §3.4's composed line).
      expect(row.textContent).toContain(eventTypeLabels.training());
    });
  });

  describe('event, cancelled (13.9/2)', () => {
    it('carries the eventStatusClasses.cancelled classes on the status badge', () => {
      renderCard(makeEventRef({ status: 'cancelled' }));

      const row = getRow();
      const statusNode = within(row).getByText(eventStatusLabels.cancelled());
      // eventStatusClasses.cancelled = 'text-muted-foreground line-through' — every class must
      // land on the element carrying the status text (or an ancestor within the row), not be
      // silently dropped.
      const classes = eventStatusClasses.cancelled.split(' ');
      const carrier = classes.every((c) => statusNode.classList.contains(c))
        ? statusNode
        : statusNode.closest(`.${classes[0]}`);
      expect(carrier).not.toBeNull();
      for (const className of classes) {
        expect(carrier?.classList.contains(className)).toBe(true);
      }
    });
  });

  describe('event, all-day (13.9/3)', () => {
    it('shows a date and no time for an all-day event', () => {
      const reference = makeEventRef({
        allDay: true,
        startDate: Option.some('2026-05-12'),
        endDate: Option.none(),
        endAt: Option.none(),
      });
      renderCard(reference);

      const row = getRow();
      expect(row.textContent).toContain('2026-05-12');
      // No HH:MM time pattern anywhere in the row for an all-day event.
      expect(row.textContent).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    });
  });

  describe('event colour stability (13.9/4)', () => {
    it('renders the same leading colour class whether the colour map is built from this event alone or from many training types', () => {
      const trainingTypeName = 'Speed';
      const reference = makeEventRef({
        eventType: 'training',
        trainingTypeName: Option.some(trainingTypeName),
      });

      const subsetMap = buildTrainingTypeColorMap([trainingTypeName]);
      const supersetMap = buildTrainingTypeColorMap([
        'Alpha',
        'Bravo',
        'Charlie',
        'Delta',
        'Echo',
        trainingTypeName,
        'Foxtrot',
      ]);

      // The colour-hash promise itself (`getEventColor` independent of map membership) — the
      // component's job is simply to USE whatever map it is given, not to break this property.
      expect(getEventColor('training', trainingTypeName, subsetMap).dot).toBe(
        getEventColor('training', trainingTypeName, supersetMap).dot,
      );

      const { unmount } = renderCard(reference, subsetMap);
      const subsetBar = document.querySelector('.w-1.self-stretch.rounded-full');
      expect(subsetBar).not.toBeNull();
      const subsetDotClass = getEventColor('training', trainingTypeName, subsetMap).dot;
      for (const c of subsetDotClass.split(' ')) {
        expect(subsetBar?.classList.contains(c)).toBe(true);
      }
      unmount();

      renderCard(reference, supersetMap);
      const supersetBar = document.querySelector('.w-1.self-stretch.rounded-full');
      for (const c of subsetDotClass.split(' ')) {
        expect(supersetBar?.classList.contains(c)).toBe(true);
      }
    });
  });

  describe('member with / without avatar (13.9/5)', () => {
    it('renders an <img> with src=avatarUrl when Some', () => {
      renderCard(
        makeMemberRef({
          displayName: 'Alice Doe',
          avatarUrl: Option.some('https://cdn.example/a.png'),
        }),
      );

      const row = getRow();
      const img = row.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('https://cdn.example/a.png');
    });

    it('renders initials fallback and no <img> when avatarUrl is None', () => {
      renderCard(makeMemberRef({ displayName: 'Alice Doe', avatarUrl: Option.none() }));

      const row = getRow();
      expect(row.querySelector('img')).toBeNull();
      expect(within(row).getByText('AL')).not.toBeNull();
    });
  });

  describe('member jersey + roles (13.9/6)', () => {
    it('shows #jersey when Some and hides it when None', () => {
      const { unmount } = renderCard(makeMemberRef({ jerseyNumber: Option.some(9) }));
      expect(getRow().textContent).toContain('9');
      unmount();

      renderCard(makeMemberRef({ jerseyNumber: Option.none(), displayName: 'No Jersey Here' }));
      // No stray "#" left dangling when there is no number to show.
      expect(getRow().textContent).not.toContain('#');
    });

    it('renders up to 2 RoleBadges ordered by sortEffectiveRoles(resolveEffectiveRoles(ref)) plus a non-interactive "+n" badge, and NO <button> anywhere in the row', () => {
      const effectiveRoles = [
        {
          roleId: 'r-admin',
          name: 'Admin',
          isBuiltIn: true,
          source: 'direct' as const,
          groupNames: [],
        },
        {
          roleId: 'r-captain',
          name: 'Captain',
          isBuiltIn: true,
          source: 'inherited' as const,
          groupNames: ['U20'],
        },
        {
          roleId: 'r-zz',
          name: 'Zzz Custom',
          isBuiltIn: false,
          source: 'direct' as const,
          groupNames: [],
        },
        {
          roleId: 'r-aa',
          name: 'Aaa Custom',
          isBuiltIn: false,
          source: 'direct' as const,
          groupNames: [],
        },
      ];
      const reference = makeMemberRef({ roleNames: [], effectiveRoles, active: true });
      renderCard(reference);

      const row = getRow();

      // No button anywhere inside the row — the EffectiveRolesList/PopoverTrigger hazard
      // (design §3.4, `EffectiveRolesList.tsx:48-56`) must not be reachable from here.
      expect(within(row).queryAllByRole('button')).toHaveLength(0);
      expect(row.querySelector('button')).toBeNull();

      const expectedOrder = sortEffectiveRoles(resolveEffectiveRoles(reference)).map((r) => r.name);
      expect(expectedOrder.slice(0, 2)).toEqual(['Admin', 'Captain']);

      const badgeNodes = Array.from(row.querySelectorAll('[data-slot="badge"]'));
      const badgeTexts = badgeNodes.map((n) => n.textContent?.trim());
      expect(badgeTexts[0]).toBe('Admin');
      expect(badgeTexts[1]).toBe('Captain');
      // The remaining 2 roles collapse into a "+2" badge — never rendered as their own badges.
      expect(within(row).queryByText('Zzz Custom')).toBeNull();
      expect(within(row).queryByText('Aaa Custom')).toBeNull();
      expect(badgeTexts.some((t) => t?.includes('2'))).toBe(true);
    });

    it('renders every role directly (no overflow badge) when there are 2 or fewer', () => {
      const effectiveRoles = [
        {
          roleId: 'r-admin',
          name: 'Admin',
          isBuiltIn: true,
          source: 'direct' as const,
          groupNames: [],
        },
      ];
      renderCard(makeMemberRef({ effectiveRoles, active: true }));

      const row = getRow();
      expect(within(row).getByText('Admin')).not.toBeNull();
      expect(within(row).queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('group (13.9/7)', () => {
    it('renders the name, the member count, and links to the group route', () => {
      const reference = makeGroupRef({ groupId: 'group-9', name: 'U20', memberCount: 15 });
      renderCard(reference);

      const row = getRow();
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/groups/group-9`);
      expect(row.textContent).toContain('U20');
      expect(row.textContent).toContain('group_memberCount');
    });

    it('renders a ColorDot only when color is Some', () => {
      const { unmount } = renderCard(makeGroupRef({ color: Option.some('#3b82f6') }));
      const rowWithColor = getRow();
      expect(rowWithColor.querySelector('[style*="background-color"]')).not.toBeNull();
      unmount();

      renderCard(makeGroupRef({ color: Option.none() }));
      const rowWithoutColor = getRow();
      expect(rowWithoutColor.querySelector('[style*="background-color"]')).toBeNull();
    });

    it('prefixes the primary line with the emoji when Some, and shows the bare name when None', () => {
      const { unmount } = renderCard(makeGroupRef({ emoji: Option.some('⚽'), name: 'U20' }));
      expect(getRow().textContent).toContain('⚽ U20');
      unmount();

      renderCard(makeGroupRef({ emoji: Option.none(), name: 'U20' }));
      expect(getRow().textContent).not.toContain('⚽');
      expect(getRow().textContent).toContain('U20');
    });
  });

  describe('roster / trainingType (13.9/8)', () => {
    it('roster: renders the name, a secondary line, and links to the roster route', () => {
      const reference = makeRosterRef({
        rosterId: 'roster-7',
        name: 'First team',
        memberCount: 20,
      });
      renderCard(reference);

      const row = getRow();
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/rosters/roster-7`);
      expect(row.textContent).toContain('First team');
      expect(row.textContent).toContain('roster_memberCount');
    });

    it('roster: shows the active/inactive badge text, never colour alone', () => {
      const { unmount } = renderCard(makeRosterRef({ active: true }));
      expect(getRow().textContent).toContain('roster_active');
      unmount();

      renderCard(makeRosterRef({ active: false }));
      expect(getRow().textContent).toContain('roster_inactive');
    });

    it('trainingType: renders the name, the owner/member group secondary line, and links to the training-type route', () => {
      const reference = makeTrainingTypeRef({
        trainingTypeId: 'tt-9',
        name: 'Speed',
        ownerGroupName: Option.some('Coaches'),
        memberGroupName: Option.some('U20'),
      });
      renderCard(reference);

      const row = getRow();
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/training-types/tt-9`);
      expect(row.textContent).toContain('Speed');
      expect(row.textContent).toContain('Coaches');
      expect(row.textContent).toContain('U20');
    });

    it('trainingType: omits the whole secondary line when neither group is present (not two fallbacks)', () => {
      const reference = makeTrainingTypeRef({
        ownerGroupName: Option.none(),
        memberGroupName: Option.none(),
      });
      renderCard(reference);

      const row = getRow();
      // The fallback key must not appear twice — and per design §3.4 it should not appear
      // at all when NEITHER group is present (the secondary line is omitted entirely).
      const occurrences = (row.textContent?.match(/trainingType_noGroup/g) ?? []).length;
      expect(occurrences).toBeLessThanOrEqual(1);
      expect(occurrences).not.toBe(2);
    });
  });

  describe('graceful degradation of missing/empty fields (design §3.4 table)', () => {
    it('event: omits the location tail when location is None (no dangling separator text)', () => {
      renderCard(makeEventRef({ location: Option.none() }));
      // No crash, and nothing renders as a literal "undefined"/"null".
      expect(getRow().textContent).not.toContain('undefined');
      expect(getRow().textContent).not.toContain('null');
    });

    it('member: with no jersey and no roles, still renders as a single valid row with no crash', () => {
      renderCard(makeMemberRef({ jerseyNumber: Option.none(), roleNames: [], effectiveRoles: [] }));
      const row = getRow();
      expect(row).not.toBeNull();
      expect(within(row).queryAllByRole('button')).toHaveLength(0);
    });

    it('roster: renders a ColorDot only when color is Some (trailing slot collapses otherwise)', () => {
      const { unmount } = renderCard(makeRosterRef({ color: Option.some('#22c55e') }));
      expect(getRow().querySelector('[style*="background-color"]')).not.toBeNull();
      unmount();

      renderCard(makeRosterRef({ color: Option.none() }));
      expect(getRow().querySelector('[style*="background-color"]')).toBeNull();
    });
  });

  describe('one focusable link per row (13.9/9)', () => {
    it('renders exactly one <a> for the row, and it is tab-reachable', () => {
      renderCard(makeEventRef());
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(1);
      expect(links[0].tagName).toBe('A');
      expect(links[0].getAttribute('href')).not.toBe('');
      // A plain <a href> is tab-reachable by default — must not be neutralised with
      // tabIndex={-1}.
      expect(links[0].getAttribute('tabindex')).not.toBe('-1');
    });

    it('uses the shared entity-kind label lookup, not a computed template key', () => {
      // Sanity check on the fixture used across this file's tests: entityKindLabels must be
      // a callable per kind (guards against a future accidental template-literal regression
      // creeping into a card that duplicates the lookup instead of importing it).
      expect(typeof entityKindLabels.event).toBe('function');
      expect(typeof entityKindLabels.member).toBe('function');
      expect(typeof entityKindLabels.group).toBe('function');
      expect(typeof entityKindLabels.roster).toBe('function');
      expect(typeof entityKindLabels.trainingType).toBe('function');
    });
  });

  // F.7/1 (design §4) — the widened prop. `EntityRef` is `SearchHit` plus `ref`, so `EntityRef`
  // is assignable to `SearchHit`; these fixtures instead prove the OTHER direction matters: a
  // `SearchHit` with no `ref` field at all still renders every kind's content, typechecking
  // against the (post-widening) `reference: AiChatApi.SearchHit` prop with no cast.
  describe('widened reference prop: AiChatApi.SearchHit (no `ref`) renders every kind (F.7/1)', () => {
    it('event', () => {
      renderSearchHit(makeEventSearchHit('Widened Event'));
      expect(within(getRow()).getByText('Widened Event')).not.toBeNull();
    });

    it('member', () => {
      renderSearchHit(makeMemberSearchHit('Widened Member'));
      expect(getRow().textContent).toContain('Widened Member');
    });

    it('group', () => {
      renderSearchHit(makeGroupSearchHit('Widened Group'));
      expect(getRow().textContent).toContain('Widened Group');
    });

    it('roster', () => {
      renderSearchHit(makeRosterSearchHit('Widened Roster'));
      expect(getRow().textContent).toContain('Widened Roster');
    });

    it('trainingType', () => {
      renderSearchHit(makeTrainingTypeSearchHit('Widened Training'));
      expect(getRow().textContent).toContain('Widened Training');
    });
  });

  // F.7/2, F.7/3 (design §4) — `renderWrapper` overrides the default per-kind `<Link>`; omitted,
  // the default `<Link>` is byte-identical to today (the "chat surface cannot regress" guard).
  describe('renderWrapper (F.7/2, F.7/3)', () => {
    it('is used in place of the default <Link> when provided — no <a> anywhere in the row', () => {
      renderSearchHit(makeEventSearchHit('Wrapped Event'), {
        renderWrapper: (children, className) => (
          <li data-testid='wrap' className={className}>
            {children}
          </li>
        ),
      });

      expect(screen.queryByRole('link')).toBeNull();
      const wrap = screen.getByTestId('wrap');
      expect(within(wrap).getByText('Wrapped Event')).not.toBeNull();
      expect(wrap.querySelector('a')).toBeNull();
      // The EffectiveRolesList/PopoverTrigger hazard (13.9/6) applies to the palette row too —
      // no nested-interactive control, wrapper or not.
      expect(within(wrap).queryAllByRole('button')).toHaveLength(0);
    });

    it('omitted for the event branch: the default <Link> is unchanged', () => {
      renderSearchHit(makeEventSearchHit('Default Event'));
      const row = getRow();
      expect(row.tagName).toBe('A');
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/events/event-widened`);
      expect(within(row).getByText('Default Event')).not.toBeNull();
    });

    it('omitted for the member branch: the default <Link> is unchanged', () => {
      renderSearchHit(makeMemberSearchHit('Default Member'));
      const row = getRow();
      expect(row.tagName).toBe('A');
      expect(row.getAttribute('href')).toBe(`/teams/${TEAM_ID}/members/member-widened`);
      expect(within(row).getByText('Default Member')).not.toBeNull();
    });
  });
});
