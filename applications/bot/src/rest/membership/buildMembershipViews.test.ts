// Pure builders — call them directly, no Effect.
//
// The custom_id assertions are the point of this file. Discord caps a custom_id at 100
// characters and rejects the ENTIRE message with a 50035 when two components share one, so a
// team with many plans is the case that breaks a per-plan-button design. Twelve plans here.

import type { Fee, MembershipPlan } from '@sideline/domain';
import { MembershipRpcModels } from '@sideline/domain';
import * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildMembershipBoard } from '~/rest/membership/buildMembershipBoard.js';
import { buildMembershipPickView } from '~/rest/membership/buildMembershipPickView.js';

const locale = 'en' as const;

const planId = (n: number): MembershipPlan.MembershipPlanId =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as MembershipPlan.MembershipPlanId;

const makePlan = (
  n: number,
  overrides: Partial<{
    name: Option.Option<MembershipPlan.MembershipPlanName>;
    freeTrainings: number;
    isDefault: boolean;
  }> = {},
): MembershipRpcModels.MembershipPlanView =>
  new MembershipRpcModels.MembershipPlanView({
    plan_id: planId(n),
    name:
      overrides.name ??
      (Option.some(`Plan ${n}`) as Option.Option<MembershipPlan.MembershipPlanName>),
    price_minor: (n * 10000) as Fee.AmountMinor,
    currency: 'CZK' as Fee.CurrencyCode,
    price_per_training_minor: 8000 as Fee.AmountMinor,
    free_trainings_included: (overrides.freeTrainings ?? 0) as MembershipPlan.FreeTrainingsIncluded,
    is_default: overrides.isDefault ?? false,
  });

const makeView = (
  plans: ReadonlyArray<MembershipRpcModels.MembershipPlanView>,
  overrides: Partial<{
    selected: Option.Option<MembershipPlan.MembershipPlanId>;
    deadline: Option.Option<DateTime.Utc>;
    canManage: boolean;
  }> = {},
): MembershipRpcModels.MembershipSelectionView =>
  new MembershipRpcModels.MembershipSelectionView({
    plans,
    selected_plan_id: overrides.selected ?? Option.none(),
    deadline: overrides.deadline ?? Option.none(),
    can_manage: overrides.canManage ?? false,
  });

type Row = { readonly components: ReadonlyArray<Record<string, unknown>> };

const buttonsOf = (components: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown>> =>
  (components as ReadonlyArray<Row>).flatMap((row) => row.components);

const twelvePlans = Array.from({ length: 12 }, (_, i) => makePlan(i + 1));

describe('membership board', () => {
  it('carries only constant custom_ids — no plan id reaches the public message', () => {
    const { components } = buildMembershipBoard(makeView(twelvePlans), locale);
    const ids = buttonsOf(components).map((b) => b.custom_id);

    expect(ids).toEqual(['membership-open', 'membership-mine']);
    for (const plan of twelvePlans) {
      expect(JSON.stringify(components)).not.toContain(plan.plan_id);
    }
  });

  it('lists every plan with its price and marks the default', () => {
    const { embeds } = buildMembershipBoard(
      makeView([makePlan(1, { isDefault: true }), makePlan(2, { freeTrainings: 3 })]),
      locale,
    );
    const fields = embeds[0]?.fields ?? [];

    expect(fields).toHaveLength(2);
    expect(fields[0]?.name).toContain('team default');
    expect(fields[0]?.value).toContain('CZK');
    expect(fields[1]?.value).toContain('3 free trainings included');
    // A zero allowance adds no line — it is not a feature worth a row.
    expect(fields[0]?.value).not.toContain('free trainings included');
  });

  it('disables the picker button once the deadline has passed', () => {
    const past = DateTime.subtract(DateTime.nowUnsafe(), { hours: 1 });
    const { components } = buildMembershipBoard(
      makeView(twelvePlans, { deadline: Option.some(past) }),
      locale,
    );
    const [pick] = buttonsOf(components);

    expect(pick?.custom_id).toBe('membership-open');
    expect(pick?.disabled).toBe(true);
  });

  it('disables the picker button when the team has no plans', () => {
    const { embeds, components } = buildMembershipBoard(makeView([]), locale);

    expect(buttonsOf(components)[0]?.disabled).toBe(true);
    expect(embeds[0]?.description).toContain('No membership plans yet');
  });
});

describe('membership picker', () => {
  it('gives twelve plans twelve unique custom_ids, each well under the 100-char cap', () => {
    const { components } = buildMembershipPickView(makeView(twelvePlans), locale, {
      withButtons: true,
    });
    const ids = buttonsOf(components).map((b) => b.custom_id as string);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) {
      expect(id.length).toBeLessThanOrEqual(100);
      expect(id.startsWith('mp:')).toBe(true);
    }
    // 4 per row.
    expect(components).toHaveLength(3);
  });

  it('highlights the chosen plan and names it', () => {
    const view = makeView(twelvePlans, { selected: Option.some(planId(3)) });
    const { embeds, components } = buildMembershipPickView(view, locale, { withButtons: true });
    const chosen = buttonsOf(components).find((b) => b.custom_id === `mp:${planId(3)}`);

    expect(chosen?.style).toBe(Discord.ButtonStyleTypes.PRIMARY);
    expect(embeds[0]?.description).toContain('Plan 3');
  });

  it('reads a selection pointing at an archived plan as never-picked', () => {
    // The plan list only ever holds ACTIVE plans, so a stale selection resolves to nothing —
    // showing "you follow the team default" is the truthful answer, not a phantom plan name.
    const view = makeView(twelvePlans, { selected: Option.some(planId(99)) });
    const { embeds } = buildMembershipPickView(view, locale, { withButtons: true });

    expect(embeds[0]?.description).toContain("haven't picked a plan");
  });

  it('renders the built-in label for the unnamed default plan', () => {
    const view = makeView([makePlan(1, { name: Option.none(), isDefault: true })], {
      selected: Option.some(planId(1)),
    });
    const { embeds } = buildMembershipPickView(view, locale, { withButtons: true });

    expect(embeds[0]?.description).toContain('Standard');
  });

  it('disables every plan button past the deadline', () => {
    const past = DateTime.subtract(DateTime.nowUnsafe(), { hours: 1 });
    const { components } = buildMembershipPickView(
      makeView(twelvePlans, { deadline: Option.some(past) }),
      locale,
      { withButtons: true },
    );

    for (const button of buttonsOf(components)) {
      expect(button.disabled).toBe(true);
    }
  });

  it('renders no buttons at all in read-only "my plan" mode', () => {
    const view = makeView(twelvePlans, { selected: Option.some(planId(2)) });
    const { embeds, components } = buildMembershipPickView(view, locale, { withButtons: false });

    expect(components).toHaveLength(0);
    expect(embeds[0]?.description).toContain('Plan 2');
  });
});
