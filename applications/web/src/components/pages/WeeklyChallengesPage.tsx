import type { TeamChallenge } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import React from 'react';
import { toast } from 'sonner';
import { NewChallengeDialog } from '~/components/organisms/NewChallengeDialog.js';
import { WeeklyChallengesGrid } from '~/components/organisms/WeeklyChallengesGrid.js';
import { WeeklyChallengesList } from '~/components/organisms/WeeklyChallengesList.js';
import { Button } from '~/components/ui/button';
import { useIsMobile } from '~/hooks/use-mobile.js';
import { tr } from '~/lib/translations.js';

type TeamChallengeKind = TeamChallenge.TeamChallengeKind;

interface Challenge {
  id: string;
  teamId: string;
  startDate: string;
  endDate: string;
  kind: TeamChallengeKind;
  title: string;
  description: string | null;
  createdBy: string;
}

interface ChallengeView {
  challenge: Challenge;
  completedMemberIds: string[];
  isActive: boolean;
}

interface Member {
  memberId: string;
  name: string;
}

export interface WeeklyChallengesPageProps {
  teamId: string;
  canCreate: boolean;
  currentMemberId: string | null;
  teamTimezone: string;
  challenges: ChallengeView[];
  members: Member[];
  onMarkComplete?: (challengeId: string) => Promise<void>;
  onUnmarkComplete?: (challengeId: string) => Promise<void>;
  onDeleteChallenge?: (challengeId: string) => Promise<void>;
  onUpdateChallenge?: (
    challengeId: string,
    data: { title: string; description: string | null },
  ) => Promise<void>;
  onCreateChallenge?: (data: {
    startDate: Date;
    endDate: Date;
    kind: TeamChallengeKind;
    title: string;
    description: string | null;
  }) => Promise<{ _tag?: string } | undefined>;
}

export function WeeklyChallengesPage({
  teamId,
  canCreate,
  currentMemberId,
  teamTimezone,
  challenges,
  members,
  onMarkComplete,
  onUnmarkComplete,
  onDeleteChallenge,
  onUpdateChallenge,
  onCreateChallenge,
}: WeeklyChallengesPageProps) {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [newDialogOpen, setNewDialogOpen] = React.useState(false);

  // S3: surface ChallengeCompletionCell errors via toast
  const handleCellError = React.useCallback((message: string) => {
    toast.error(message);
  }, []);

  // Post-midnight / focus-based refetch (plan §5.3 / §9 risk 6)
  React.useEffect(() => {
    const handleFocus = () => router.invalidate();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [router]);

  const existingStartDates = challenges.map((v) => {
    const d = v.challenge.startDate;
    // Normalise to YYYY-MM-DD
    return d.split('T')[0];
  });

  const handleCreated = () => {
    router.invalidate();
  };

  return (
    <div className='flex flex-col gap-6'>
      {/* Page header */}
      <header className='flex items-start justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold'>{tr('challenges_pageTitle')}</h1>
          <p className='text-muted-foreground mt-1'>{tr('challenges_subtitle')}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setNewDialogOpen(true)} className='shrink-0'>
            {tr('challenges_actions_createButton')}
          </Button>
        )}
      </header>

      {/* Content area */}
      {challenges.length === 0 ? (
        <div className='flex flex-col items-center justify-center py-16 text-center gap-2'>
          <p className='text-lg font-medium'>{tr('challenges_emptyTitle')}</p>
          <p className='text-muted-foreground'>
            {canCreate
              ? tr('challenges_emptySubtitle_captain')
              : tr('challenges_emptySubtitle_member')}
          </p>
        </div>
      ) : isMobile ? (
        <WeeklyChallengesList
          teamId={teamId}
          canCreate={canCreate}
          currentMemberId={currentMemberId}
          challenges={challenges}
          members={members}
          onMarkComplete={onMarkComplete}
          onUnmarkComplete={onUnmarkComplete}
          onDeleteChallenge={onDeleteChallenge}
          onUpdateChallenge={onUpdateChallenge}
          onError={handleCellError}
        />
      ) : (
        <WeeklyChallengesGrid
          teamId={teamId}
          canCreate={canCreate}
          currentMemberId={currentMemberId}
          challenges={challenges}
          members={members}
          onMarkComplete={onMarkComplete}
          onUnmarkComplete={onUnmarkComplete}
          onDeleteChallenge={onDeleteChallenge}
          onUpdateChallenge={onUpdateChallenge}
          onError={handleCellError}
        />
      )}

      {/* New challenge dialog */}
      {canCreate && (
        <NewChallengeDialog
          open={newDialogOpen}
          onOpenChange={setNewDialogOpen}
          teamId={teamId}
          teamTimezone={teamTimezone}
          existingStartDates={existingStartDates}
          onCreated={handleCreated}
          onSubmit={onCreateChallenge}
        />
      )}
    </div>
  );
}
