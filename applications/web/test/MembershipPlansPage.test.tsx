// Slice 1 + Slice 2 ("Setup memberships") — `MembershipPlansPage.tsx`. Pattern: `EventTypesPage.test.tsx`
// for the read-only render assertions (module mocks for `~/lib/translations.js` and
// `@tanstack/react-router`, plain render/assert, no network needed). The one Slice 2 case that
// clicks "Choose" needs the API call to actually happen, so `~/lib/runtime` is mocked with the
// REAL Effect pipeline threaded through (pattern from `MemberCreditPopover.test.tsx`), not the
// bare `{ pipe: vi.fn() }` stub the read-only cases use — that stub would make `Effect.flatMap`
// a no-op and `selectMembershipPlanImpl` would never be called.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DateTime, Effect, Option } from 'effect';
import type React from 'react';
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
    expiresAt: Option.none<never>(),
    isDefault: false,
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
