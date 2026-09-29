// Slice 3 ("Add CRUD for managing membership assigned members") — the bulk move dialog.
// TDD: written BEFORE the component exists. Every test in this file FAILS on the dynamic
// import until the developer creates
//   applications/web/src/components/organisms/MoveMembersDialog.tsx
//
// Assumed component contract (plan Task 4.8-4.12):
//   MoveMembersDialog({
//     teamId: string,
//     plans: ReadonlyArray<MembershipPlanApi.MembershipPlanInfo>,     // ACTIVE plans only
//     assignments: ReadonlyArray<MembershipPlanApi.MembershipPlanAssignment>,
//     open: boolean,
//     onOpenChange: (open: boolean) => void,
//     onMoved: () => void,                                            // router.invalidate()
//   })
//
// DOM contract these tests rely on (nothing beyond it):
//   - the SOURCE `<SelectTrigger>` carries aria-label = tr('membershipPlan_bulk_fromLabel')
//     and the TARGET one aria-label = tr('membershipPlan_bulk_toLabel');
//   - every option's `value` is the plan id, or DEFAULT_SENTINEL ('__default__') for the team
//     default — Radix `Select` forbids `value=""` on an item;
//   - each SOURCE option's label carries its member count, and each plan option its currency
//     code (§B.5: `Team default (9)` beside `Standard (3)` is what stops a treasurer moving
//     half the team and being confirmed the wrong number).
//
// Deliberately NOT asserted: the exact label format. The load-bearing facts are "two distinct
// entries" and "different counts", not the punctuation between them.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Effect, Option } from 'effect';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before the dynamic import
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      membershipPlan_bulk_button: 'Move all members',
      membershipPlan_bulk_title: 'Move members between plans',
      membershipPlan_bulk_fromLabel: 'Move from',
      membershipPlan_bulk_toLabel: 'Move to',
      membershipPlan_bulk_defaultOption: 'Team default',
      membershipPlan_bulk_archivedSource: 'Archived plan',
      membershipPlan_bulk_currencyWarning:
        'The two plans use different currencies; already-paid members will end the month with two open fees.',
      membershipPlan_bulk_billingNotice:
        'Charges are recalculated lazily, on the next attendance change.',
      membershipPlan_bulk_confirm: 'Move members',
      membershipPlan_bulk_failed: 'Failed to move members.',
      membershipPlan_defaultName: 'Standard',
      common_cancel: 'Cancel',
    };
    if (key === 'membershipPlan_bulk_optionWithCount') {
      return `${String(params?.name)} (${String(params?.count)})`;
    }
    if (key === 'membershipPlan_bulk_affected') {
      return `${String(params?.count)} members will move`;
    }
    if (key === 'membershipPlan_bulk_overwritesChoices') {
      return `${String(params?.count)} of them chose that plan themselves`;
    }
    if (key === 'membershipPlan_bulk_moved') {
      return `Moved ${String(params?.count)} members`;
    }
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

const reassignMembershipPlanImpl = vi.fn();

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          membershipPlan: {
            reassignMembershipPlan: (args: unknown) => reassignMembershipPlanImpl(args),
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

// The moved count is only known AFTER the call returns, so it cannot ride on `run`'s static
// `success` option — the dialog must toast it itself (§B.8). That is exactly what test 14
// pins, so `toast` is mocked rather than stubbed away.
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// Radix's shadcn `Select` portals its content and needs pointer-capture APIs jsdom lacks —
// same local mock as `EventTypePicker.test.tsx` and `MembershipPlansPage.test.tsx`.
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

// Dynamic import AFTER mocks — fails until the component exists.
const { MoveMembersDialog } = await import('~/components/organisms/MoveMembersDialog.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;
const DEFAULT_SENTINEL = '__default__';

function plan(overrides: Record<string, unknown> = {}) {
  return {
    membershipPlanId: 'plan-1',
    teamId: TEAM_ID,
    name: Option.some('Plan'),
    priceMinor: 50000,
    currency: 'CZK',
    pricePerTrainingMinor: 0,
    expiresAt: Option.none<never>(),
    isDefault: false,
    ...overrides,
  } as any;
}

function assignment(memberId: string, membershipPlanId: Option.Option<string>) {
  return { memberId, displayName: memberId, membershipPlanId } as any;
}

// The team DEFAULT plan is a real plan with a real id — a DIFFERENT source population from
// "never picked" (NULL). §B.5's whole "three source populations, not two" point.
const PLAN_DEFAULT = plan({
  membershipPlanId: 'plan-default',
  name: Option.none<string>(),
  isDefault: true,
  currency: 'CZK',
});
const PLAN_B = plan({ membershipPlanId: 'plan-b', name: Option.some('Plan B'), currency: 'CZK' });
const PLAN_EUR = plan({
  membershipPlanId: 'plan-eur',
  name: Option.some('Euro plan'),
  currency: 'EUR',
});

const PLANS = [PLAN_DEFAULT, PLAN_B, PLAN_EUR];

// 3 never picked, 2 explicitly on the default plan's own id, 1 on B, 1 on an ARCHIVED plan
// (its id is absent from `plans`, which holds active rows only).
const ASSIGNMENTS = [
  assignment('m1', Option.none()),
  assignment('m2', Option.none()),
  assignment('m3', Option.none()),
  assignment('m4', Option.some('plan-default')),
  assignment('m5', Option.some('plan-default')),
  assignment('m6', Option.some('plan-b')),
  assignment('m7', Option.some('plan-archived')),
];

function renderDialog(overrides: Record<string, unknown> = {}) {
  const onMoved = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <MoveMembersDialog
      teamId={TEAM_ID}
      plans={PLANS}
      assignments={ASSIGNMENTS}
      open={true}
      onOpenChange={onOpenChange}
      onMoved={onMoved}
      {...overrides}
    />,
  );
  return { onMoved, onOpenChange };
}

const selectRoot = (label: string) => {
  const trigger = screen.getByLabelText(label);
  const root = trigger.closest('[data-testid="select-root"]');
  if (root === null) throw new Error(`no select root for "${label}"`);
  return root as HTMLElement;
};

const sourceSelect = () => selectRoot('Move from');
const targetSelect = () => selectRoot('Move to');

const optionIn = (root: HTMLElement, value: string) =>
  root.querySelector(`[data-value="${value}"]`) as HTMLElement | null;

const pick = (root: HTMLElement, value: string) => {
  const option = optionIn(root, value);
  if (option === null) throw new Error(`no option "${value}"`);
  fireEvent.click(option);
};

const confirmButton = () => screen.getByRole('button', { name: 'Move members' });

// ---------------------------------------------------------------------------
// Source options — counts and the three populations (§B.5)
// ---------------------------------------------------------------------------

describe('MoveMembersDialog — source options', () => {
  // THE MUST-FIX. "Team default" (the never-picked NULLs) and the default plan's OWN id are
  // two different sets that move different people, and both are offered in the same list. With
  // no counts a treasurer picks one, moves half the team, and is confirmed the wrong number.
  it('renders "Team default" and the default plan itself as TWO distinct options with DIFFERENT counts', () => {
    renderDialog();

    const defaultSentinel = optionIn(sourceSelect(), DEFAULT_SENTINEL);
    const defaultPlanOption = optionIn(sourceSelect(), 'plan-default');

    expect(defaultSentinel, 'the never-picked (NULL) population').not.toBeNull();
    expect(defaultPlanOption, "the default plan's own id — a different set").not.toBeNull();
    expect(defaultSentinel).not.toBe(defaultPlanOption);
    expect(defaultSentinel?.textContent, '3 members never picked').toContain('3');
    expect(defaultPlanOption?.textContent, '2 members explicitly chose it').toContain('2');
  });

  // Currency is invisible everywhere else in this screen, and bulk makes that expensive (A.1).
  it('labels every plan option with its currency code', () => {
    renderDialog();

    expect(optionIn(sourceSelect(), 'plan-eur')?.textContent).toContain('EUR');
    expect(optionIn(sourceSelect(), 'plan-b')?.textContent).toContain('CZK');
  });

  // Without this entry the archived-plan sweep — the most valuable bulk case there is (§B.5) —
  // is unreachable: those members' FK is the archived id, not NULL, so the "Team default"
  // source never matches them. As a TARGET it must stay hidden (§B.7).
  it('offers an ARCHIVED-plan source for an assignment whose id is absent from `plans`, and never as a target', () => {
    renderDialog();

    expect(optionIn(sourceSelect(), 'plan-archived')).not.toBeNull();
    expect(optionIn(sourceSelect(), 'plan-archived')?.textContent).toContain('1');
    expect(optionIn(targetSelect(), 'plan-archived')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The affected count — computed locally, mirroring the SQL exactly
// ---------------------------------------------------------------------------

describe('MoveMembersDialog — affected count', () => {
  it('counts the members on the chosen source; the "Team default" source counts the never-picked ones', () => {
    renderDialog();

    pick(sourceSelect(), DEFAULT_SENTINEL);
    pick(targetSelect(), 'plan-b');

    expect(screen.getByText('3 members will move')).toBeInTheDocument();
  });

  it("the default plan's own id as source counts only the members who explicitly picked it", () => {
    renderDialog();

    pick(sourceSelect(), 'plan-default');
    pick(targetSelect(), 'plan-b');

    expect(screen.getByText('2 members will move')).toBeInTheDocument();
  });

  // `keyOf(a) !== target` mirrors the SQL's `IS DISTINCT FROM ${to}`. Source == target
  // therefore yields 0 and disables Confirm through the ORDINARY count rule — there is no
  // separate `source === target` check anywhere, in the UI or the SQL.
  it('disables Confirm when the count is 0, INCLUDING when source === target', () => {
    renderDialog();

    pick(sourceSelect(), 'plan-b');
    pick(targetSelect(), 'plan-b');

    expect(screen.getByText('0 members will move')).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it('disables Confirm for an empty source population', () => {
    renderDialog();

    pick(sourceSelect(), 'plan-eur'); // nobody is on the EUR plan
    pick(targetSelect(), 'plan-b');

    expect(confirmButton()).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe('MoveMembersDialog — warnings', () => {
  // A.1: an already-paid member moved across currencies ends the month holding two open fee
  // rows in two currencies for the same attendance.
  it('renders the currency warning when source and target currencies differ, and not when they match', () => {
    const { onOpenChange } = renderDialog();
    void onOpenChange;

    pick(sourceSelect(), 'plan-b'); // CZK
    pick(targetSelect(), 'plan-eur'); // EUR
    expect(screen.getByText(/different currencies/)).toBeInTheDocument();

    pick(targetSelect(), 'plan-default'); // CZK
    expect(screen.queryByText(/different currencies/)).not.toBeInTheDocument();
  });

  // The single most likely use of this dialog — "sweep everyone who never picked onto the new
  // plan" — is also the one with NO direct plan row to read a currency off: `plans` holds active
  // rows only, so `find(p => p.membershipPlanId === '__default__')` is `undefined`. But the
  // never-picked crowd IS billed, at the TEAM DEFAULT plan's currency
  // (`1793200000_training_period_fees.ts:113-130`), so this move genuinely crosses currencies
  // and must warn. Same hole covers the archived source and the clear-to-default target.
  it('warns for the three shapes with no direct plan row: never-picked → plan, archived → plan, plan → clear-to-default', () => {
    renderDialog();

    // never-picked (CZK by the team default) → EUR plan
    pick(sourceSelect(), DEFAULT_SENTINEL);
    pick(targetSelect(), 'plan-eur');
    expect(screen.getByText(/different currencies/), 'never-picked → EUR').toBeInTheDocument();

    // archived source (CZK by the team default) → EUR plan
    pick(sourceSelect(), 'plan-archived');
    expect(screen.getByText(/different currencies/), 'archived → EUR').toBeInTheDocument();

    // EUR plan → "clear to team default", which bills at the default plan's CZK
    pick(sourceSelect(), 'plan-eur');
    pick(targetSelect(), DEFAULT_SENTINEL);
    expect(screen.getByText(/different currencies/), 'EUR → team default').toBeInTheDocument();

    // ...and still silent when the fallback resolves to the SAME currency, so the assertions
    // above cannot pass by warning unconditionally.
    pick(sourceSelect(), DEFAULT_SENTINEL);
    pick(targetSelect(), 'plan-b');
    expect(screen.queryByText(/different currencies/), 'CZK → CZK').not.toBeInTheDocument();
  });

  // §B.2: a bulk move silently overwrites explicit member choices. Within ONE source, every
  // member being moved picked that plan themselves — which is exactly why the "Team default"
  // (never picked) source must NOT show it.
  it('renders the overwrites-choices warning for a real-plan source, not for "Team default"', () => {
    renderDialog();

    pick(sourceSelect(), 'plan-b');
    pick(targetSelect(), 'plan-eur');
    expect(screen.getByText(/chose that plan themselves/)).toBeInTheDocument();

    pick(sourceSelect(), DEFAULT_SENTINEL);
    expect(screen.queryByText(/chose that plan themselves/)).not.toBeInTheDocument();
  });

  it('does NOT claim an explicit choice for the ARCHIVED-plan source', () => {
    renderDialog();

    pick(sourceSelect(), 'plan-archived');
    pick(targetSelect(), 'plan-b');

    expect(screen.queryByText(/chose that plan themselves/)).not.toBeInTheDocument();
  });

  // §B.6 — the lazy-recompute delay is the "I moved 12 people and this month's numbers did not
  // change" report, stated at the decision point instead of being discovered by a treasurer.
  it('always renders the billing notice', () => {
    renderDialog();

    expect(screen.getByText(/recalculated lazily/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

describe('MoveMembersDialog — confirming', () => {
  it('sends fromMembershipPlanId None and toMembershipPlanId Some for the default -> plan case', async () => {
    reassignMembershipPlanImpl.mockReturnValueOnce(Effect.succeed({ movedCount: 3 }));
    const { onMoved } = renderDialog();

    pick(sourceSelect(), DEFAULT_SENTINEL);
    pick(targetSelect(), 'plan-b');
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(reassignMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = reassignMembershipPlanImpl.mock.calls[0][0] as {
      payload: {
        fromMembershipPlanId: Option.Option<string>;
        toMembershipPlanId: Option.Option<string>;
      };
    };
    expect(Option.isNone(args.payload.fromMembershipPlanId), 'the sentinel maps back to None').toBe(
      true,
    );
    expect(Option.getOrNull(args.payload.toMembershipPlanId)).toBe('plan-b');
    await waitFor(() => {
      expect(onMoved).toHaveBeenCalledOnce();
    });
  });

  it('sends the mirror for the plan -> default case', async () => {
    reassignMembershipPlanImpl.mockReturnValueOnce(Effect.succeed({ movedCount: 1 }));
    renderDialog();

    pick(sourceSelect(), 'plan-b');
    pick(targetSelect(), DEFAULT_SENTINEL);
    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(reassignMembershipPlanImpl).toHaveBeenCalledOnce();
    });
    const args = reassignMembershipPlanImpl.mock.calls[0][0] as {
      payload: {
        fromMembershipPlanId: Option.Option<string>;
        toMembershipPlanId: Option.Option<string>;
      };
    };
    expect(Option.getOrNull(args.payload.fromMembershipPlanId)).toBe('plan-b');
    expect(Option.isNone(args.payload.toMembershipPlanId)).toBe(true);
  });

  // §B.8 — the dialog's own count is ADVISORY: a concurrent single-assign between render and
  // submit changes the set. The toast must carry the number the SERVER moved. The mock
  // deliberately disagrees with the prediction (3 vs 4) so a component that toasts its own
  // count fails here and only here.
  it('toasts the RETURNED movedCount, never the predicted one', async () => {
    reassignMembershipPlanImpl.mockReturnValueOnce(Effect.succeed({ movedCount: 3 }));
    renderDialog({
      assignments: [
        assignment('m1', Option.none()),
        assignment('m2', Option.none()),
        assignment('m3', Option.none()),
        assignment('m4', Option.none()),
      ],
    });

    pick(sourceSelect(), DEFAULT_SENTINEL);
    pick(targetSelect(), 'plan-b');
    expect(screen.getByText('4 members will move'), 'the prediction').toBeInTheDocument();

    fireEvent.click(confirmButton());

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledOnce();
    });
    expect(toastSuccess).toHaveBeenCalledWith('Moved 3 members');
  });
});
