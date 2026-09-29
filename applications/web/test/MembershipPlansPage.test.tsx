// Slice 1 + Slice 2 ("Setup memberships") — `MembershipPlansPage.tsx`. Pattern: `EventTypesPage.test.tsx`
// for the read-only render assertions (module mocks for `~/lib/translations.js` and
// `@tanstack/react-router`, plain render/assert, no network needed). The one Slice 2 case that
// clicks "Choose" needs the API call to actually happen, so `~/lib/runtime` is mocked with the
// REAL Effect pipeline threaded through (pattern from `MemberCreditPopover.test.tsx`), not the
// bare `{ pipe: vi.fn() }` stub the read-only cases use — that stub would make `Effect.flatMap`
// a no-op and `selectMembershipPlanImpl` would never be called.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option } from 'effect';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      membershipPlan_title: 'Membership plans',
      membershipPlan_subtitle: 'Manage the plans members pay under',
      membershipPlan_subtitleMember: 'Choose the plan you want',
      membershipPlan_add: 'Add plan',
      membershipPlan_empty_title: 'No membership plans yet',
      membershipPlan_empty_subtitle: 'Create one to start charging membership fees.',
      membershipPlan_defaultBadge: 'Default',
      membershipPlan_defaultName: 'Standard',
      membershipPlan_makeDefault: 'Make default',
      membershipPlan_edit: 'Edit',
      membershipPlan_archiveAction: 'Archive',
      membershipPlan_priceFree: 'Free',
      membershipPlan_noExpiry: 'No expiry',
      team_backToTeams: 'Back to teams',
      achievement_admin_cancel: 'Cancel',
      common_cancel: 'Cancel',
      validation_required: 'Required',
      membershipPlan_name: 'Name',
      membershipPlan_editTitle: 'Edit membership plan',
      membershipPlan_yourPlanBadge: 'Your plan',
      membershipPlan_choose: 'Choose',
      membershipPlan_chooseFailed: 'Failed to choose plan.',
      membershipPlan_chosen: 'Plan chosen.',
      membershipPlan_selectionClosed: 'Selection is closed.',
      membershipPlan_noDeadlineNotice: 'You can change your plan at any time.',
      membershipPlan_deadlineLabel: 'Selection deadline',
      membershipPlan_deadlineHint: 'Members must choose by this date.',
      membershipPlan_save: 'Save',
      membershipPlan_saving: 'Saving…',
      membershipPlan_deadlineClear: 'Clear',
      membershipPlan_deadlineSaved: 'Deadline saved.',
      membershipPlan_deadlineCleared: 'Deadline cleared.',
      membershipPlan_deadlineSaveFailed: 'Failed to save deadline.',
      // Slice 3 — the member-assignment section (plan Task 5).
      membershipPlan_assign_sectionTitle: 'Member assignments',
      membershipPlan_assign_hint: 'Assign a plan to any member, deadline or not.',
      membershipPlan_assign_empty: 'No active members to assign.',
      membershipPlan_assign_searchPlaceholder: 'Search members',
      membershipPlan_assign_useDefault: 'Use team default',
      membershipPlan_assign_saved: 'Assignment saved.',
      membershipPlan_assign_failed: 'Failed to save the assignment.',
      membershipPlan_bulk_button: 'Move all members',
    };
    if (key === 'membershipPlan_perTraining') {
      return `${String(params?.amount)} per training`;
    }
    if (key === 'membershipPlan_expiresOn') {
      return `Expires ${String(params?.date)}`;
    }
    if (key === 'membershipPlan_makeDefaultAria') {
      return `Make ${String(params?.name)} the default plan`;
    }
    if (key === 'membershipPlan_editAria') {
      return `Edit ${String(params?.name)}`;
    }
    if (key === 'membershipPlan_archiveAria') {
      return `Archive ${String(params?.name)}`;
    }
    if (key === 'membershipPlan_chooseAria') {
      return `Choose ${String(params?.name)}`;
    }
    if (key === 'membershipPlan_assign_selectAria') {
      return `Membership plan for ${String(params?.name)}`;
    }
    if (key === 'membershipPlan_deadlineNotice') {
      return `You can change your plan until ${String(params?.date)} ${String(params?.time)}.`;
    }
    if (key === 'membershipPlan_selectionClosedNotice') {
      return `Selection closed on ${String(params?.date)} ${String(params?.time)}.`;
    }
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// The writers this file exercises via a real click — `selectMembershipPlan` and
// `setMembershipSelectionDeadline` (the latter is `handleSaveDeadline`'s only production
// caller — without a mock for it, clicking Save throws "not a function"). Everything else
// (`setDefaultMembershipPlan`, `deleteMembershipPlan`) is never invoked by these tests, so it
// stays out of the mocked API surface entirely.
const selectMembershipPlanImpl = vi.fn();
const setMembershipSelectionDeadlineImpl = vi.fn();
// Slice 3 — the captain-side single-member write. Mocked for the same reason as the two
// above: without it, changing a row's Select throws "not a function" instead of asserting.
const assignMembershipPlanImpl = vi.fn();
// The free-training allowance tests submit the edit form for real, so the PATCH writer needs a
// mock too — same reason as the three above.
const updateMembershipPlanImpl = vi.fn();

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          membershipPlan: {
            selectMembershipPlan: (args: unknown) => selectMembershipPlanImpl(args),
            setMembershipSelectionDeadline: (args: unknown) =>
              setMembershipSelectionDeadlineImpl(args),
            assignMembershipPlan: (args: unknown) => assignMembershipPlanImpl(args),
            updateMembershipPlan: (args: unknown) => updateMembershipPlanImpl(args),
          },
        }),
    },
    ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
    SilentClientError: class {
      constructor(public props: { message: string }) {}
    },
    useRun: () => () => (effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runPromise(Effect.option(effect)),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// Radix's shadcn `Select` renders through a Portal and needs pointer-capture/scroll APIs jsdom
// does not implement — the same reason `test/setup.ts` mocks the (also Portal-based)
// dropdown-menu primitive globally. Same local mock as `EventTypePicker.test.tsx`, so what is
// under test is the PAGE's own logic (which option is selected, what onValueChange receives),
// never Radix's positioning internals. It also covers the currency Select inside the plan form
// dialog, which no test in this file interacts with.
const SelectCtx = React.createContext<{ onValueChange?: (v: string) => void }>({});

vi.mock('~/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: React.PropsWithChildren<{
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
  }>) => (
    <SelectCtx.Provider value={{ onValueChange }}>
      <div data-testid='select-root' data-value={value} data-disabled={String(!!disabled)}>
        {children}
      </div>
    </SelectCtx.Provider>
  ),
  SelectTrigger: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...rest}>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    disabled,
    children,
  }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) => {
    const { onValueChange } = React.useContext(SelectCtx);
    return (
      <button
        type='button'
        role='option'
        data-value={value}
        disabled={disabled}
        aria-disabled={disabled}
        onClick={() => onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

// Dynamic import AFTER mocks
const { MembershipPlansPage } = await import('~/components/pages/MembershipPlansPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;

function plan(overrides: Record<string, unknown> = {}) {
  return {
    membershipPlanId: 'plan-1',
    teamId: TEAM_ID,
    name: Option.some('Adult membership'),
    priceMinor: 50000,
    currency: 'CZK',
    pricePerTrainingMinor: 0,
    freeTrainingsIncluded: 0,
    expiresAt: Option.none<never>(),
    isDefault: false,
    ...overrides,
  } as any;
}

// Slice 3 — one row of the member-assignment section. `membershipPlanId` is the RAW FK:
// `None` = never picked (falls back to the team default), never "on the default plan".
function assignment(overrides: Record<string, unknown> = {}) {
  return {
    memberId: 'member-1',
    displayName: 'Alice',
    membershipPlanId: Option.none<string>(),
    ...overrides,
  } as any;
}

// Every render call goes through here so the two Slice 2 props (required, no default in the
// component) don't have to be repeated at every call site — only the cases that care about them
// override them.
function renderPage(overrides: Record<string, unknown> = {}) {
  return render(
    <MembershipPlansPage
      teamId={TEAM_ID}
      canManage={true}
      plans={[]}
      selectedPlanId={Option.none()}
      selectionDeadline={Option.none()}
      assignments={[]}
      {...overrides}
    />,
  );
}

// ---------------------------------------------------------------------------
// 1. canManage false hides every mutating control
// ---------------------------------------------------------------------------

describe('MembershipPlansPage — canManage false', () => {
  it('hides Add/Edit/Archive/Make default while still rendering plan names and prices', () => {
    const plans = [
      plan({
        membershipPlanId: 'plan-default',
        name: Option.none<string>(),
        isDefault: true,
      }),
      plan({ membershipPlanId: 'plan-2', name: Option.some('Adult membership') }),
    ];

    renderPage({ canManage: false, plans });

    expect(screen.queryByRole('button', { name: 'Add plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make default' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    expect(screen.getByText('Adult membership')).toBeInTheDocument();
    expect(screen.getAllByText(/500/).length).toBeGreaterThan(0); // 50000 minor -> 500 Kč formatted
  });
});

// ---------------------------------------------------------------------------
// 2. The seeded default plan (name: None) renders the translated built-in label
// ---------------------------------------------------------------------------

describe('MembershipPlansPage — seeded default plan name', () => {
  it('renders the translated built-in label, not an empty string', () => {
    const plans = [
      plan({ membershipPlanId: 'plan-default', name: Option.none<string>(), isDefault: true }),
    ];

    renderPage({ plans });

    expect(screen.getByText('Standard')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Default badge + disabled "Make default"; non-default row is enabled
// ---------------------------------------------------------------------------

describe('MembershipPlansPage — default badge and Make default button state', () => {
  it('shows the Default badge and disables "Make default" on the default row, enables it elsewhere', () => {
    const plans = [
      plan({
        membershipPlanId: 'plan-default',
        name: Option.some('Standard plan'),
        isDefault: true,
      }),
      plan({ membershipPlanId: 'plan-other', name: Option.some('Other plan'), isDefault: false }),
    ];

    renderPage({ plans });

    expect(screen.getByText('Default')).toBeInTheDocument();

    const makeDefaultButtons = screen.getAllByRole('button', { name: /the default plan/ });
    expect(makeDefaultButtons).toHaveLength(2);
    const defaultRowButton = screen.getByRole('button', {
      name: 'Make Standard plan the default plan',
    });
    const otherRowButton = screen.getByRole('button', {
      name: 'Make Other plan the default plan',
    });
    expect(defaultRowButton).toBeDisabled();
    expect(otherRowButton).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 3b. Regression test for the blocker: opening the edit dialog on the seeded default plan
// (name: None) must seed the name input EMPTY, never the translated built-in label.
// ---------------------------------------------------------------------------

describe('MembershipPlansPage — editing the seeded default plan', () => {
  it('opens the edit dialog with an EMPTY name input, not "Standard"', () => {
    const plans = [
      plan({ membershipPlanId: 'plan-default', name: Option.none<string>(), isDefault: true }),
    ];

    renderPage({ plans });

    fireEvent.click(screen.getByRole('button', { name: /^Edit /i }));

    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 4. priceMinor 0 renders "Free", never dropped or "0"
// ---------------------------------------------------------------------------

describe('MembershipPlansPage — zero price', () => {
  it('renders the "Free" label for a plan with priceMinor 0', () => {
    const plans = [plan({ membershipPlanId: 'plan-free', priceMinor: 0 })];

    renderPage({ plans });

    expect(screen.getByText(/Free/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Slice 2 — per-row selection
// ---------------------------------------------------------------------------

const PLAN_A = plan({ membershipPlanId: 'plan-a', name: Option.some('Plan A'), isDefault: true });
const PLAN_B = plan({ membershipPlanId: 'plan-b', name: Option.some('Plan B'), isDefault: false });
const PLAN_C = plan({ membershipPlanId: 'plan-c', name: Option.some('Plan C'), isDefault: false });

describe('MembershipPlansPage — effective plan resolution', () => {
  it('selectedPlanId Some(planB): planB shows "Your plan", planA shows a Choose button', () => {
    renderPage({ plans: [PLAN_A, PLAN_B], selectedPlanId: Option.some(PLAN_B.membershipPlanId) });

    const rowB = screen.getByText('Plan B').closest('div[class*="rounded-lg"]');
    const rowA = screen.getByText('Plan A').closest('div[class*="rounded-lg"]');
    expect(rowB?.textContent).toContain('Your plan');
    expect(rowA?.querySelector('button[aria-label="Choose Plan A"]')).not.toBeNull();
    expect(rowB?.querySelector('button[aria-label="Choose Plan B"]')).toBeNull();
  });

  it('selectedPlanId None (never chose): the badge lands on the default plan', () => {
    renderPage({ plans: [PLAN_A, PLAN_B], selectedPlanId: Option.none() });

    const rowA = screen.getByText('Plan A').closest('div[class*="rounded-lg"]');
    const rowB = screen.getByText('Plan B').closest('div[class*="rounded-lg"]');
    expect(rowA?.textContent).toContain('Your plan');
    expect(rowB?.querySelector('button[aria-label="Choose Plan B"]')).not.toBeNull();
  });

  it('selectedPlanId Some(archived plan not in the list): falls back to the default plan', () => {
    renderPage({
      plans: [PLAN_A, PLAN_B],
      selectedPlanId: Option.some('plan-archived' as any),
    });

    const rowA = screen.getByText('Plan A').closest('div[class*="rounded-lg"]');
    expect(rowA?.textContent).toContain('Your plan');
  });
});

describe('MembershipPlansPage — selection deadline', () => {
  it('a past deadline disables every Choose button and renders the closed notice', () => {
    const past = DateTime.makeUnsafe('2020-01-01T00:00:00Z');
    renderPage({ plans: [PLAN_A, PLAN_B, PLAN_C], selectionDeadline: Option.some(past) });

    expect(screen.getByText(/Selection closed on/)).toBeInTheDocument();
    const chooseButtons = screen.getAllByRole('button', { name: /^Choose / });
    expect(chooseButtons.length).toBeGreaterThan(0);
    for (const button of chooseButtons) {
      expect(button).toBeDisabled();
    }
  });

  it('a future deadline keeps Choose enabled and renders the deadline notice', () => {
    const future = DateTime.makeUnsafe('2999-01-01T00:00:00Z');
    renderPage({ plans: [PLAN_A, PLAN_B, PLAN_C], selectionDeadline: Option.some(future) });

    expect(screen.getByText(/You can change your plan until/)).toBeInTheDocument();
    const chooseButtons = screen.getAllByRole('button', { name: /^Choose / });
    expect(chooseButtons.length).toBeGreaterThan(0);
    for (const button of chooseButtons) {
      expect(button).not.toBeDisabled();
    }
  });

  it('no deadline renders the "any time" notice', () => {
    renderPage({ plans: [PLAN_A, PLAN_B], selectionDeadline: Option.none() });

    expect(screen.getByText('You can change your plan at any time.')).toBeInTheDocument();
  });
});

describe('MembershipPlansPage — player path (canManage false)', () => {
  it('hides the deadline setter input but still shows Choose buttons', () => {
    renderPage({ canManage: false, plans: [PLAN_A, PLAN_B] });

    expect(screen.queryByLabelText('Selection deadline')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose Plan B' })).toBeInTheDocument();
  });
});

describe('MembershipPlansPage — clicking Choose', () => {
  it('calls selectMembershipPlan with the clicked plan id', async () => {
    selectMembershipPlanImpl.mockReturnValueOnce(Effect.succeed(undefined));

    renderPage({ plans: [PLAN_A, PLAN_B] });

    fireEvent.click(screen.getByRole('button', { name: 'Choose Plan B' }));

    await waitFor(() => {
      expect(selectMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = selectMembershipPlanImpl.mock.calls[0][0] as {
      payload: { membershipPlanId: string };
    };
    expect(args.payload.membershipPlanId).toBe('plan-b');
  });
});

// Regression test for the review fix: `handleSaveDeadline` is `dateOnlyToLocalEndOfDay`'s only
// production caller — without `setMembershipSelectionDeadline` mocked, this click would throw
// "not a function" instead of ever reaching the assertion below.
describe('MembershipPlansPage — saving the selection deadline', () => {
  it('sends the local end-of-day instant for the entered date, not a bare date', async () => {
    setMembershipSelectionDeadlineImpl.mockReturnValueOnce(Effect.succeed(undefined));

    renderPage({ plans: [PLAN_A, PLAN_B] });

    fireEvent.change(screen.getByLabelText('Selection deadline'), {
      target: { value: '2026-09-30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(setMembershipSelectionDeadlineImpl).toHaveBeenCalledOnce();
    });
    const args = setMembershipSelectionDeadlineImpl.mock.calls[0][0] as {
      payload: { deadline: Option.Option<DateTime.Utc> };
    };
    expect(Option.isSome(args.payload.deadline)).toBe(true);
    if (Option.isSome(args.payload.deadline)) {
      const expectedEpochMillis = new Date(2026, 8, 30, 23, 59, 59, 999).getTime();
      expect(Number(DateTime.toEpochMillis(args.payload.deadline.value))).toBe(expectedEpochMillis);
    }
  });
});

// The free-training allowance — now an ALL-TIME allowance, not a per-period one. The money math
// is a SQL function and lives entirely in `trainingPeriodCharges.test.ts`; what only exists here
// is the form's own blank -> 0 convention and the 0..999 bound, which mirrors
// `FreeTrainingsIncluded` so the user sees a field error instead of `decodeSync` throwing past the
// submit handler.
//
// NO COPY ASSERTION BELONGS IN THIS FILE. `~/lib/translations.js` is mocked above with a hardcoded
// key -> string map, so `en.json` is never loaded and any assertion about the rendered wording
// asserts against test-local fiction — it would stay green with `"{count} free/month"` still in
// the catalogue. The per-month copy guard lives in `packages/i18n/test/keyParity.test.ts`, where
// the real message files are read.
describe('MembershipPlansPage — free trainings field', () => {
  it('a blank field submits 0, not NaN or undefined', async () => {
    updateMembershipPlanImpl.mockReturnValueOnce(Effect.succeed(plan()));

    renderPage({ plans: [PLAN_A] });
    fireEvent.click(screen.getByLabelText(`Edit ${'Plan A'}`));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = updateMembershipPlanImpl.mock.calls[0][0] as {
      payload: { freeTrainingsIncluded: Option.Option<number> };
    };
    // `Some`, always: the key is optional on the wire only so an OLD bundle gets "keep the stored
    // value" instead of a 400 (`applications/server/AGENTS.md` rule 5). This bundle knows the
    // field, so it must never send `None` — that would silently discard the captain's edit.
    expect(Option.getOrNull(args.payload.freeTrainingsIncluded)).toBe(0);
  });

  it('an entered allowance reaches the payload', async () => {
    updateMembershipPlanImpl.mockReturnValueOnce(Effect.succeed(plan()));

    renderPage({ plans: [PLAN_A] });
    fireEvent.click(screen.getByLabelText(`Edit ${'Plan A'}`));
    fireEvent.change(screen.getByLabelText('membershipPlan_freeTrainings'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = updateMembershipPlanImpl.mock.calls[0][0] as {
      payload: { freeTrainingsIncluded: Option.Option<number> };
    };
    // `Some`, always: the key is optional on the wire only so an OLD bundle gets "keep the stored
    // value" instead of a 400 (`applications/server/AGENTS.md` rule 5). This bundle knows the
    // field, so it must never send `None` — that would silently discard the captain's edit.
    expect(Option.getOrNull(args.payload.freeTrainingsIncluded)).toBe(4);
  });

  // The `max='999'` on the input is the guard that actually fires: native constraint validation
  // refuses the submit before `handleSubmit` runs, so no payload is built and `decodeSync` is
  // never handed a value `FreeTrainingsIncluded` would reject. `handleSubmit`'s own 0..999
  // check stays as the belt for anything that reaches it another way; the DB CHECK and the
  // schema are the real trust boundary.
  it('an out-of-range allowance never reaches the API', async () => {
    renderPage({ plans: [PLAN_A] });
    fireEvent.click(screen.getByLabelText(`Edit ${'Plan A'}`));
    fireEvent.change(screen.getByLabelText('membershipPlan_freeTrainings'), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateMembershipPlanImpl).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Slice 3 ("Add CRUD for managing membership assigned members") — the member-assignment
// section. TDD: written BEFORE the section exists. Every test below FAILS until
// `MembershipPlansPage` takes the `assignments` prop and renders the section (plan Task 4.1-4.7).
//
// Assumed contract:
//   - new required prop `assignments: ReadonlyArray<MembershipPlanApi.MembershipPlanAssignment>`
//   - the section renders iff `canManage` — with an EMPTY STATE when `assignments` is `[]`,
//     never nothing (a repo regression or a rollback must look broken, not absent)
//   - one row per assignment, filtered by the search input and sorted by `displayName`
//   - each row's `<Select>` carries `aria-label` = tr('membershipPlan_assign_selectAria', {name})
//     and `value` = the plan id, or DEFAULT_SENTINEL ('__default__') for `None`
//   - the selects are NOT disabled by a passed deadline (§B.2)
// ---------------------------------------------------------------------------

const DEFAULT_SENTINEL = '__default__';

/** The row `<Select>` for one member — the mock renders `Select` as a div carrying `data-value`
 * and its items as `role="option"` buttons, so the row is found by its aria-labelled trigger. */
function assignmentRow(displayName: string) {
  const trigger = screen.getByLabelText(`Membership plan for ${displayName}`);
  const root = trigger.closest('[data-testid="select-root"]');
  if (root === null) throw new Error(`no select root for ${displayName}`);
  return root;
}

describe('MembershipPlansPage — member assignments section', () => {
  it('does NOT render the section when canManage is false, even with a non-empty assignments', () => {
    renderPage({
      canManage: false,
      plans: [PLAN_A, PLAN_B],
      assignments: [assignment({ memberId: 'member-1', displayName: 'Alice' })],
    });

    expect(screen.queryByText('Member assignments')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Membership plan for Alice')).not.toBeInTheDocument();
  });

  // Gated on `canManage` ALONE, not `canManage && assignments.length > 0` — the latter makes
  // the whole feature vanish silently on a repo regression or a server rollback instead of
  // showing an empty list.
  it('renders the section and its EMPTY STATE — not nothing — when assignments is []', () => {
    renderPage({ canManage: true, plans: [PLAN_A, PLAN_B], assignments: [] });

    expect(screen.getByText('Member assignments')).toBeInTheDocument();
    expect(screen.getByText('No active members to assign.')).toBeInTheDocument();
  });

  it('renders one row per assignment, sorted by displayName', () => {
    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({ memberId: 'member-2', displayName: 'Zoe' }),
        assignment({ memberId: 'member-1', displayName: 'Alice' }),
        assignment({ memberId: 'member-3', displayName: 'Milan' }),
      ],
    });

    const labels = screen
      .getAllByLabelText(/^Membership plan for /)
      .map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Membership plan for Alice',
      'Membership plan for Milan',
      'Membership plan for Zoe',
    ]);
  });

  it('membershipPlanId None selects "use default"; Some(plan-b) selects Plan B', () => {
    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({ memberId: 'member-1', displayName: 'Alice', membershipPlanId: Option.none() }),
        assignment({
          memberId: 'member-2',
          displayName: 'Bob',
          membershipPlanId: Option.some('plan-b'),
        }),
      ],
    });

    expect(assignmentRow('Alice').getAttribute('data-value')).toBe(DEFAULT_SENTINEL);
    expect(assignmentRow('Bob').getAttribute('data-value')).toBe('plan-b');
  });

  it('choosing a plan calls assignMembershipPlan once with Option.some(planId) for that member', async () => {
    assignMembershipPlanImpl.mockReturnValueOnce(Effect.succeed(undefined));

    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({ memberId: 'member-2', displayName: 'Bob', membershipPlanId: Option.none() }),
      ],
    });

    const option = assignmentRow('Bob').querySelector('[data-value="plan-b"]');
    if (option === null) throw new Error('no Plan B option');
    fireEvent.click(option);

    await waitFor(() => {
      expect(assignMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = assignMembershipPlanImpl.mock.calls[0][0] as {
      params: { memberId: string };
      payload: { membershipPlanId: Option.Option<string> };
    };
    expect(args.params.memberId).toBe('member-2');
    expect(Option.isSome(args.payload.membershipPlanId)).toBe(true);
    if (Option.isSome(args.payload.membershipPlanId)) {
      expect(args.payload.membershipPlanId.value).toBe('plan-b');
    }
  });

  it('choosing "use default" sends Option.none(), not the sentinel string', async () => {
    assignMembershipPlanImpl.mockReturnValueOnce(Effect.succeed(undefined));

    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({
          memberId: 'member-2',
          displayName: 'Bob',
          membershipPlanId: Option.some('plan-b'),
        }),
      ],
    });

    const option = assignmentRow('Bob').querySelector(`[data-value="${DEFAULT_SENTINEL}"]`);
    if (option === null) throw new Error('no "use default" option');
    fireEvent.click(option);

    await waitFor(() => {
      expect(assignMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = assignMembershipPlanImpl.mock.calls[0][0] as {
      payload: { membershipPlanId: Option.Option<string> };
    };
    expect(Option.isNone(args.payload.membershipPlanId)).toBe(true);
  });

  // §B.2 AT THE UI. The contrast in the SAME test is the point: the member-facing Choose
  // buttons go grey under a passed deadline while the manager's selects do not. Asserting only
  // "the select is enabled" would stay green if the deadline stopped disabling anything at all.
  it('a PASSED deadline disables the Choose buttons but leaves the assignment selects enabled', () => {
    const past = DateTime.makeUnsafe('2020-01-01T00:00:00Z');
    renderPage({
      plans: [PLAN_A, PLAN_B],
      selectionDeadline: Option.some(past),
      assignments: [assignment({ memberId: 'member-1', displayName: 'Alice' })],
    });

    for (const button of screen.getAllByRole('button', { name: /^Choose / })) {
      expect(button).toBeDisabled();
    }
    expect(assignmentRow('Alice').getAttribute('data-disabled')).toBe('false');
  });

  it('the search input filters the rows by display name', () => {
    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({ memberId: 'member-1', displayName: 'Alice' }),
        assignment({ memberId: 'member-2', displayName: 'Bob' }),
      ],
    });

    fireEvent.change(screen.getByPlaceholderText('Search members'), {
      target: { value: 'ali' },
    });

    expect(screen.getByLabelText('Membership plan for Alice')).toBeInTheDocument();
    expect(screen.queryByLabelText('Membership plan for Bob')).not.toBeInTheDocument();
  });

  // A member whose stored plan was archived: `plans` holds ACTIVE rows only, so the id is not
  // in the list. The row must render the "use default" sentinel (that is how they are BILLED —
  // `training_period_charges` falls back to the default for an archived plan), never a blank
  // select. The bulk dialog still offers their real orphan id as a SOURCE; both are correct
  // for their own job.
  it('a member whose stored plan is not in `plans` renders "use default", not a blank select', () => {
    renderPage({
      plans: [PLAN_A, PLAN_B],
      assignments: [
        assignment({
          memberId: 'member-1',
          displayName: 'Alice',
          membershipPlanId: Option.some('plan-archived'),
        }),
      ],
    });

    expect(assignmentRow('Alice').getAttribute('data-value')).toBe(DEFAULT_SENTINEL);
  });
});
