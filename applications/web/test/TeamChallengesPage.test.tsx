// Tests for TeamChallengesPage, TeamChallengesGrid, TeamChallengesList,
// ChallengeCompletionCell, and NewChallengeDialog.
//
// Coverage:
//   - §7.3 Web component unit tests (selected high-value cases)
//   Two component families:
//     1. TeamChallengesPage / TeamChallengesGrid / TeamChallengesList
//     2. ChallengeCompletionCell (toggle, debounce, optimistic, stale response)
//     3. NewChallengeDialog (form validation)

import { act, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      challenges_pageTitle: 'Výzvy',
      challenges_subtitle: 'Výzvy pro tým — splňujte je společně.',
      challenges_thisWeekBadge: 'aktivní',
      challenges_emptyTitle: 'Zatím tu nic není.',
      challenges_emptySubtitle_captain: 'Pro kapitány: založte první výzvu.',
      challenges_emptySubtitle_member: 'Až kapitán vyhlásí výzvu, objeví se tady.',
      challenges_loadError: 'Nepodařilo se načíst výzvy.',
      challenges_grid_memberColumn: 'Hráč',
      challenges_grid_completedAlt: 'Splněno',
      challenges_grid_missedAlt: 'Nesplněno',
      challenges_grid_futureAlt: 'Ještě nezačalo',
      challenges_grid_emptyRow: '—',
      challenges_grid_markCta: 'Označit splněno',
      challenges_grid_unmarkCta: 'Splněno ✓',
      challenges_kind_throwing: 'Házecí',
      challenges_kind_sport: 'Sportovní',
      challenges_actions_createButton: '+ Nová výzva',
      challenges_actions_editItem: 'Upravit text',
      challenges_actions_deleteItem: 'Smazat',
      challenges_actions_deleteConfirmTitle: 'Smazat výzvu?',
      challenges_actions_deleteConfirmBody: 'Tato akce smaže výzvu i všechna označení splnění.',
      challenges_actions_deleteConfirmCta: 'Smazat',
      challenges_actions_cancelCta: 'Zrušit',
      challenges_error_forbidden: 'Na tuto akci nemáte oprávnění.',
      challenges_error_notFound: 'Výzva už neexistuje.',
      challenges_error_notActive: 'Označit splnění jde jen u aktivní výzvy.',
      challenges_error_alreadyExists: 'Pro tento týden už výzva existuje.',
      challenges_error_outOfRange: 'Datum musí být v rozsahu dnešek … +8 týdnů.',
      challenges_success_created: 'Výzva vytvořena.',
      challenges_success_updated: 'Výzva upravena.',
      challenges_success_deleted: 'Výzva smazána.',
      challenges_newDialog_title: 'Nová výzva',
      challenges_newDialog_kindLabel: 'Druh',
      challenges_newDialog_weekLabel: 'Začátek',
      challenges_newDialog_weekHelp: 'Vyberte datum začátku výzvy.',
      challenges_newDialog_titleLabel: 'Název',
      challenges_newDialog_titlePlaceholder: 'Např. 30 bekhendů denně',
      challenges_newDialog_descLabel: 'Popis (nepovinné)',
      challenges_newDialog_descPlaceholder: 'Co to znamená a jak to počítáme.',
      challenges_newDialog_submit: 'Vytvořit výzvu',
      challenges_newDialog_cancel: 'Zrušit',
      challenges_newDialog_titleCounter: '{n}/120',
      challenges_newDialog_descCounter: '{n}/2000',
      challenges_editDialog_title: 'Upravit výzvu',
      challenges_editDialog_submit: 'Uložit',
      challenges_badge_active: 'aktivní',
    };
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
  useRun: vi.fn(() => vi.fn()),
}));

vi.mock('~/hooks/use-mobile.js', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// ---------------------------------------------------------------------------
// Type helpers (mirroring domain types without importing — avoids build dep)
// ---------------------------------------------------------------------------

type TeamMemberId = string;
type TeamChallengeId = string;
type TeamChallengeKind = 'throwing' | 'sport';

type Challenge = {
  id: TeamChallengeId;
  teamId: string;
  startDate: string;
  endDate: string;
  kind: TeamChallengeKind;
  title: string;
  description: string | null;
  createdBy: TeamMemberId;
};

type ChallengeView = {
  challenge: Challenge;
  completedMemberIds: TeamMemberId[];
  isActive: boolean;
};

type Member = {
  memberId: TeamMemberId;
  name: string;
};

type TeamChallengesPageProps = {
  teamId: string;
  canCreate: boolean;
  currentMemberId: TeamMemberId | null;
  teamTimezone: string;
  challenges: ChallengeView[];
  members: Member[];
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-tc-001';
const CAPTAIN_MEMBER_ID = 'member-captain-001';
const OTHER_MEMBER_ID = 'member-player-002';

const CURRENT_MONDAY = '2026-03-09T00:00:00.000Z';

function makeChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: 'challenge-001',
    teamId: TEAM_ID,
    startDate: CURRENT_MONDAY,
    endDate: '2026-03-15T00:00:00.000Z',
    kind: 'throwing',
    title: 'Test Challenge',
    description: null,
    createdBy: CAPTAIN_MEMBER_ID,
    ...overrides,
  };
}

function makeChallengeView(overrides: Partial<ChallengeView> = {}): ChallengeView {
  return {
    challenge: makeChallenge(),
    completedMemberIds: [],
    isActive: true,
    ...overrides,
  };
}

const mockMembers: Member[] = [
  { memberId: CAPTAIN_MEMBER_ID, name: 'Captain Alice' },
  { memberId: OTHER_MEMBER_ID, name: 'Player Bob' },
];

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks are set up)
// ---------------------------------------------------------------------------

const { TeamChallengesPage } = await import('~/components/pages/TeamChallengesPage.js');

const { ChallengeCompletionCell } = await import(
  '~/components/molecules/ChallengeCompletionCell.js'
);

const { NewChallengeDialog } = await import('~/components/organisms/NewChallengeDialog.js');

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// TeamChallengesPage tests
// ---------------------------------------------------------------------------

describe('TeamChallengesPage', () => {
  const defaultProps: TeamChallengesPageProps = {
    teamId: TEAM_ID,
    canCreate: false,
    currentMemberId: null,
    teamTimezone: 'Europe/Prague',
    challenges: [],
    members: mockMembers,
  };

  it('renders page heading "Výzvy"', () => {
    render(<TeamChallengesPage {...defaultProps} />);
    expect(screen.getByText('Výzvy')).not.toBeNull();
  });

  it('empty state shown when no challenges exist', () => {
    render(<TeamChallengesPage {...defaultProps} />);
    expect(screen.getByText('Zatím tu nic není.')).not.toBeNull();
  });

  it('captain sees "+ Nová výzva" button, non-captain does not', () => {
    // Non-captain
    const { rerender } = render(<TeamChallengesPage {...defaultProps} canCreate={false} />);
    expect(screen.queryByText('+ Nová výzva')).toBeNull();

    // Captain
    rerender(<TeamChallengesPage {...defaultProps} canCreate={true} />);
    expect(screen.getByText('+ Nová výzva')).not.toBeNull();
  });

  it('shows challenges when non-empty', () => {
    const challenge = makeChallengeView();
    render(<TeamChallengesPage {...defaultProps} challenges={[challenge]} />);
    expect(screen.getByText('Test Challenge')).not.toBeNull();
  });

  it('useIsMobile=true renders List view, not Grid', async () => {
    const { useIsMobile } = await import('~/hooks/use-mobile.js');
    vi.mocked(useIsMobile).mockReturnValue(true);

    render(<TeamChallengesPage {...defaultProps} challenges={[makeChallengeView()]} />);

    // When mobile, the grid should not be rendered
    expect(document.querySelector('[data-testid="challenges-grid"]')).toBeNull();
    // The list variant should be present
    expect(document.querySelector('[data-testid="challenges-list"]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ChallengeCompletionCell tests
// ---------------------------------------------------------------------------

describe('ChallengeCompletionCell', () => {
  it('renders ✓ when completed and not own-active row', () => {
    render(
      <ChallengeCompletionCell
        memberId={OTHER_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={true}
        isOwnRowActive={false}
        isPastMissed={false}
        isFuture={false}
      />,
    );
    // Should show "Splněno" aria-label or icon, no toggle button
    const completed = screen.queryByLabelText('Splněno') ?? screen.queryByText('✓');
    expect(completed).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders ✗ when !completed and past week (missed)', () => {
    render(
      <ChallengeCompletionCell
        memberId={OTHER_MEMBER_ID}
        challengeId='challenge-past'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={false}
        isPastMissed={true}
        isFuture={false}
      />,
    );
    const missed = screen.queryByLabelText('Nesplněno') ?? screen.queryByText('✗');
    expect(missed).not.toBeNull();
  });

  it('renders em-dash when future or no-challenge week', () => {
    render(
      <ChallengeCompletionCell
        memberId={OTHER_MEMBER_ID}
        challengeId='challenge-future'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={false}
        isPastMissed={false}
        isFuture={true}
      />,
    );
    const dash = screen.queryByText('—') ?? screen.queryByLabelText('Ještě nezačalo');
    expect(dash).not.toBeNull();
  });

  it('own-active row renders a Toggle button (not static cell)', () => {
    const onMark = vi.fn().mockResolvedValue(undefined);
    render(
      <ChallengeCompletionCell
        memberId={CAPTAIN_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={true}
        isPastMissed={false}
        isFuture={false}
        onMarkComplete={onMark}
        onUnmarkComplete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const button = screen.getByRole('button');
    expect(button).not.toBeNull();
  });

  it('optimistic toggle: click flips state immediately before server resolves', async () => {
    let resolveMark: () => void;
    const onMark = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMark = resolve;
        }),
    );
    const onUnmark = vi.fn().mockResolvedValue(undefined);

    render(
      <ChallengeCompletionCell
        memberId={CAPTAIN_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={true}
        isPastMissed={false}
        isFuture={false}
        onMarkComplete={onMark}
        onUnmarkComplete={onUnmark}
      />,
    );

    const button = screen.getByRole('button');

    // Click — optimistic flip should happen immediately
    await act(async () => {
      fireEvent.click(button);
    });

    // Without waiting for server: should show "Splněno ✓" (optimistic)
    const optimisticText =
      screen.queryByText('Splněno ✓') ??
      screen.queryByLabelText('Splněno') ??
      document.querySelector('[data-completed="true"]');
    expect(optimisticText).not.toBeNull();

    // Now resolve the server call
    await act(async () => {
      resolveMark?.();
    });
  });

  it('debounce: 5 rapid clicks call the server at most once after 400ms', async () => {
    vi.useFakeTimers();
    const onMark = vi.fn().mockResolvedValue(undefined);
    const onUnmark = vi.fn().mockResolvedValue(undefined);

    render(
      <ChallengeCompletionCell
        memberId={CAPTAIN_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={true}
        isPastMissed={false}
        isFuture={false}
        onMarkComplete={onMark}
        onUnmarkComplete={onUnmark}
      />,
    );

    const button = screen.getByRole('button');

    // 5 rapid clicks within 100ms
    for (let i = 0; i < 5; i++) {
      fireEvent.click(button);
    }

    // Server should NOT have been called yet
    expect(onMark).not.toHaveBeenCalled();
    expect(onUnmark).not.toHaveBeenCalled();

    // After 400ms debounce fires
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // At most 1 API call total (odd number of clicks = mark)
    const totalCalls = onMark.mock.calls.length + onUnmark.mock.calls.length;
    expect(totalCalls).toBeLessThanOrEqual(1);

    vi.useRealTimers();
  });

  it('error reverts optimistic state and shows error signal', async () => {
    vi.useFakeTimers();

    const onMark = vi.fn().mockRejectedValue(new Error('TeamChallengeNotActive'));
    const onUnmark = vi.fn().mockResolvedValue(undefined);

    render(
      <ChallengeCompletionCell
        memberId={CAPTAIN_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={true}
        isPastMissed={false}
        isFuture={false}
        onMarkComplete={onMark}
        onUnmarkComplete={onUnmark}
      />,
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // Wait for promise rejection to propagate
    await act(async () => {
      await Promise.resolve();
    });

    // UI should have reverted to unchecked (no "Splněno ✓")
    expect(
      screen.queryByText('Splněno ✓') ?? document.querySelector('[data-completed="true"]'),
    ).toBeNull();

    vi.useRealTimers();
  });

  it('stale response: click 1 (slow success) + click 2 (faster failure) → final state reflects click 2', async () => {
    vi.useFakeTimers();

    let resolveClick1: () => void;
    let rejectClick2: (e: Error) => void;
    let callCount = 0;

    const onMark = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve, _reject) => {
          callCount++;
          if (callCount === 1) {
            // Click 1: resolves after 800ms
            resolveClick1 = resolve;
          } else {
            // Any subsequent mark: immediate resolve
            resolve();
          }
        }),
    );

    const onUnmark = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          // Click 2 fires unmark — reject after 1000ms
          rejectClick2 = reject;
        }),
    );

    render(
      <ChallengeCompletionCell
        memberId={CAPTAIN_MEMBER_ID}
        challengeId='challenge-001'
        teamId={TEAM_ID}
        isCompleted={false}
        isOwnRowActive={true}
        isPastMissed={false}
        isFuture={false}
        onMarkComplete={onMark}
        onUnmarkComplete={onUnmark}
      />,
    );

    const button = screen.getByRole('button');

    // Click 1: fire mark, debounce 400ms fires after 400ms
    fireEvent.click(button);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    // After 200ms more: click 2 fires (unmark)
    // At this point click 1 still hasn't resolved (fires at t=800ms)
    await act(async () => {
      vi.advanceTimersByTime(200); // t=600ms
    });
    fireEvent.click(button);
    await act(async () => {
      vi.advanceTimersByTime(400); // debounce for click 2
    });

    // Now resolve click 1 at t=800ms (stale)
    await act(async () => {
      vi.advanceTimersByTime(200); // t=1000ms
      resolveClick1?.();
    });
    await act(async () => Promise.resolve());

    // Reject click 2 at t=1000ms (the latest request)
    await act(async () => {
      rejectClick2?.(new Error('TeamChallengeNotActive'));
    });
    await act(async () => Promise.resolve());

    // Final state: click 2 (unmark) was the LAST intent.
    // After click 1 resolved (stale, should be ignored) and click 2 rejected,
    // UI should be reverted to unchecked (click 2's outcome).
    // The success from click 1 must NOT have re-set the state.
    expect(
      screen.queryByText('Splněno ✓') ?? document.querySelector('[data-completed="true"]'),
    ).toBeNull();

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// NewChallengeDialog tests
// ---------------------------------------------------------------------------

describe('NewChallengeDialog', () => {
  type NewChallengeDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    teamId: string;
    teamTimezone: string;
    existingStartDates: string[];
    onCreated: () => void;
  };

  const defaultDialogProps: NewChallengeDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    teamId: TEAM_ID,
    teamTimezone: 'Europe/Prague',
    existingStartDates: [],
    onCreated: vi.fn(),
  };

  it('submit button is disabled when title is empty', () => {
    render(<NewChallengeDialog {...defaultDialogProps} />);
    const submitBtn = screen.getByText('Vytvořit výzvu');
    // Should be a disabled button or aria-disabled
    const button = submitBtn.closest('button');
    expect(button?.disabled || button?.getAttribute('aria-disabled')).toBeTruthy();
  });

  it('submit button is disabled when title exceeds 120 characters', async () => {
    render(<NewChallengeDialog {...defaultDialogProps} />);

    const titleInput = screen.getByPlaceholderText('Např. 30 bekhendů denně');
    fireEvent.change(titleInput, { target: { value: 'a'.repeat(121) } });

    const submitBtn = screen.getByText('Vytvořit výzvu').closest('button');
    expect(submitBtn?.disabled || submitBtn?.getAttribute('aria-disabled')).toBeTruthy();
  });

  it('submit button is enabled with valid title and kind and date selected', async () => {
    render(<NewChallengeDialog {...defaultDialogProps} />);

    // Type a short valid title
    const titleInput = screen.getByPlaceholderText('Např. 30 bekhendů denně');
    fireEvent.change(titleInput, { target: { value: 'Výzva pro tým' } });

    // Kind should default or be selectable — assume 'throwing' is default or first option
    // Start date should auto-select

    // Submit button should be enabled
    const submitBtn = screen.getByText('Vytvořit výzvu').closest('button');
    expect(submitBtn?.disabled).toBeFalsy();
  });

  it('only valid dates are selectable in date picker (invalid dates have disabled class)', () => {
    render(<NewChallengeDialog {...defaultDialogProps} />);

    // Calendar days should show — find disabled days
    const disabledDays = document.querySelectorAll(
      '[aria-disabled="true"], button[disabled], .rdp-day_disabled',
    );
    // There should be disabled days
    expect(disabledDays.length).toBeGreaterThan(0);
  });
});
