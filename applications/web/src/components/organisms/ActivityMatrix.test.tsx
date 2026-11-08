// TDD: ActivityMatrix does not exist yet. Props assumed: { teamId, days, rows } (the
// ActivityMatrixResponse fields the page passes down).

import { ActivityLogApi, type Team, type TeamMember } from '@sideline/domain';
import { render, screen, within } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      makanicko_matrix_cellLabel: '{name}, {date}: {types}, {minutes} min',
      makanicko_matrix_cellLabelNoDuration: '{name}, {date}: {types}',
    };
    const template = map[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? k));
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a href={String(props.to ?? '#')}>{children}</a>
  ),
}));

const { ActivityMatrix } = await import('~/components/organisms/ActivityMatrix.js');

const entry = (name: string, minutes: number) =>
  new ActivityLogApi.ActivityMatrixEntry({
    activityTypeName: name,
    activityTypeEmoji: Option.none(),
    totalMinutes: Option.some(minutes),
  });

const days = ['2026-11-06', '2026-11-07', '2026-11-08'];
const rows = [
  new ActivityLogApi.ActivityMatrixRow({
    memberId: '00000000-0000-0000-0000-000000000001' as TeamMember.TeamMemberId,
    displayName: 'Jan Novák',
    cells: [
      new ActivityLogApi.ActivityMatrixCell({
        date: '2026-11-06',
        entries: [entry('Gym', 30), entry('Running', 15)],
      }),
      new ActivityLogApi.ActivityMatrixCell({ date: '2026-11-08', entries: [entry('Gym', 20)] }),
    ],
  }),
  new ActivityLogApi.ActivityMatrixRow({
    memberId: '00000000-0000-0000-0000-000000000002' as TeamMember.TeamMemberId,
    displayName: 'Eva Svobodová',
    cells: [],
  }),
];

const renderMatrix = () =>
  render(
    <ActivityMatrix
      teamId={'00000000-0000-0000-0000-0000000000aa' as Team.TeamId}
      days={days}
      rows={rows}
    />,
  );

const rowOf = (name: RegExp) => {
  const tr = screen.getByRole('rowheader', { name }).closest('tr');
  if (!tr) throw new Error('row header is not inside a <tr>');
  return tr;
};

describe('ActivityMatrix', () => {
  it('renders a row header per member and a dot button only on active days', () => {
    renderMatrix();
    expect(screen.getAllByRole('rowheader')).toHaveLength(2);

    const dots = within(rowOf(/Jan Novák/)).getAllByRole('button');
    expect(dots).toHaveLength(2);
    const label = dots[0]?.getAttribute('aria-label') ?? '';
    expect(label).toContain('Gym');
    expect(label).toContain('Running');
    expect(label).toContain('45');
  });

  it('empty day has no button', () => {
    renderMatrix();
    expect(within(rowOf(/Eva Svobodová/)).queryAllByRole('button')).toHaveLength(0);
  });
});
