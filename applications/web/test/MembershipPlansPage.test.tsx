// Slice 1 ("Setup memberships") — `MembershipPlansPage.tsx`. Pattern: `EventTypesPage.test.tsx`
// (module mocks for `~/lib/translations.js`, `~/lib/runtime`, and `@tanstack/react-router`,
// then a plain render/assert per case — no network, no router, no ApiClient calls needed for
// these read-only render assertions).

import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      membershipPlan_title: 'Membership plans',
      membershipPlan_subtitle: 'Manage the plans members pay under',
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
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: vi.fn(() => ({
      pipe: vi.fn(),
    })),
  },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  SilentClientError: class {
    constructor(public props: { message: string }) {}
  },
  useRun: vi.fn(() => vi.fn(() => new Promise(() => {}))),
}));

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

    render(<MembershipPlansPage teamId={TEAM_ID} canManage={false} plans={plans} />);

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

    render(<MembershipPlansPage teamId={TEAM_ID} canManage={true} plans={plans} />);

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

    render(<MembershipPlansPage teamId={TEAM_ID} canManage={true} plans={plans} />);

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

    render(<MembershipPlansPage teamId={TEAM_ID} canManage={true} plans={plans} />);

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

    render(<MembershipPlansPage teamId={TEAM_ID} canManage={true} plans={plans} />);

    expect(screen.getByText(/Free/)).toBeInTheDocument();
  });
});
