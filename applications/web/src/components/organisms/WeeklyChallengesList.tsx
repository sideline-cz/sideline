import type { TeamChallenge } from '@sideline/domain';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import React from 'react';
import { DateRangeLabel } from '~/components/atoms/DateRangeLabel.js';
import { ChallengeCompletionCell } from '~/components/molecules/ChallengeCompletionCell.js';
import { ChallengeKindBadge } from '~/components/molecules/ChallengeKindBadge.js';
import { EditChallengeDialog } from '~/components/organisms/EditChallengeDialog.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

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

export interface WeeklyChallengesListProps {
  teamId: string;
  canCreate: boolean;
  currentMemberId: string | null;
  challenges: ChallengeView[];
  members: Member[];
  onMarkComplete?: (challengeId: string) => Promise<void>;
  onUnmarkComplete?: (challengeId: string) => Promise<void>;
  onDeleteChallenge?: (challengeId: string) => Promise<void>;
  onUpdateChallenge?: (
    challengeId: string,
    data: { title: string; description: string | null },
  ) => Promise<void>;
  onError?: (message: string) => void;
}

/**
 * WeeklyChallengesList — mobile vertical card list, one card per week.
 * Current week is pinned to the top.
 */
export function WeeklyChallengesList({
  teamId: _teamId,
  canCreate,
  currentMemberId,
  challenges,
  members,
  onMarkComplete,
  onUnmarkComplete,
  onDeleteChallenge,
  onUpdateChallenge,
  onError,
}: WeeklyChallengesListProps) {
  const [deletingChallengeId, setDeletingChallengeId] = React.useState<string | null>(null);
  const [editingChallenge, setEditingChallenge] = React.useState<ChallengeView | null>(null);

  // Sort alphabetically
  const sortedMembers = React.useMemo(
    () => [...members].sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  // Sort: active challenge first, then by start date descending
  const sortedChallenges = React.useMemo(() => {
    return [...challenges].sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return new Date(b.challenge.startDate).getTime() - new Date(a.challenge.startDate).getTime();
    });
  }, [challenges]);

  // Derive "active" challenge from server-provided isActive flag (avoids browser-TZ bug).
  // The server already knows the team timezone and computes isActive correctly.
  const activeView = sortedChallenges.find((v) => v.isActive);
  const activeStartDate = activeView?.challenge.startDate.split('T')[0] ?? null;

  const isChallengeInPast = (view: ChallengeView) => {
    if (activeStartDate === null) return false;
    const d = view.challenge.startDate.split('T')[0];
    return d < activeStartDate;
  };

  const handleDeleteConfirm = async () => {
    if (deletingChallengeId && onDeleteChallenge) {
      await onDeleteChallenge(deletingChallengeId);
      setDeletingChallengeId(null);
    }
  };

  return (
    <>
      <div data-testid='challenges-list' className='flex flex-col gap-4'>
        {sortedChallenges.map((view) => {
          const isPast = isChallengeInPast(view);
          return (
            <Card
              key={view.challenge.id}
              className={cn('p-4', view.isActive && 'border-primary/30 bg-primary/5')}
            >
              {/* Header row */}
              <div className='flex items-start justify-between mb-3'>
                <div className='flex flex-col gap-1'>
                  <div className='flex items-center gap-2'>
                    <DateRangeLabel
                      startDate={view.challenge.startDate}
                      endDate={view.challenge.endDate}
                      className='text-sm text-muted-foreground'
                    />
                    <ChallengeKindBadge kind={view.challenge.kind} />
                    {view.isActive && (
                      <span className='text-xs text-primary font-medium'>
                        {tr('challenges_thisWeekBadge')}
                      </span>
                    )}
                  </div>
                  <h3 className='font-medium'>{view.challenge.title}</h3>
                  {view.challenge.description && (
                    <p className='text-sm text-muted-foreground'>{view.challenge.description}</p>
                  )}
                </div>

                {canCreate && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant='ghost' size='icon' className='h-8 w-8 shrink-0'>
                        <MoreHorizontal className='size-4' />
                        <span className='sr-only'>Menu</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuItem onClick={() => setEditingChallenge(view)}>
                        <Pencil className='size-4 mr-2' />
                        {tr('challenges_actions_editItem')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className='text-destructive focus:text-destructive'
                        onClick={() => setDeletingChallengeId(view.challenge.id)}
                      >
                        <Trash2 className='size-4 mr-2' />
                        {tr('challenges_actions_deleteItem')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>

              {/* Member completion rows */}
              <div className='flex flex-col gap-1.5'>
                {sortedMembers.map((member) => {
                  const isCompleted = view.completedMemberIds.includes(member.memberId);
                  const isOwnRowActive = currentMemberId === member.memberId && view.isActive;
                  const isFuture = !view.isActive && !isPast;

                  return (
                    <div key={member.memberId} className='flex items-center justify-between'>
                      <span className='text-sm'>{member.name}</span>
                      <div className='w-32'>
                        <ChallengeCompletionCell
                          memberId={member.memberId}
                          challengeId={view.challenge.id}
                          teamId={_teamId}
                          isCompleted={isCompleted}
                          isOwnRowActive={isOwnRowActive}
                          isPastMissed={isPast && !isCompleted}
                          isFuture={isFuture}
                          onMarkComplete={
                            isOwnRowActive && onMarkComplete
                              ? () => onMarkComplete(view.challenge.id)
                              : undefined
                          }
                          onUnmarkComplete={
                            isOwnRowActive && onUnmarkComplete
                              ? () => onUnmarkComplete(view.challenge.id)
                              : undefined
                          }
                          onError={onError}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog
        open={deletingChallengeId !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingChallengeId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('challenges_actions_deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr('challenges_actions_deleteConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('challenges_actions_cancelCta')}</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={handleDeleteConfirm}>
              {tr('challenges_actions_deleteConfirmCta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit dialog */}
      {editingChallenge && (
        <EditChallengeDialog
          open={editingChallenge !== null}
          onOpenChange={(open) => {
            if (!open) setEditingChallenge(null);
          }}
          initialTitle={editingChallenge.challenge.title}
          initialDescription={editingChallenge.challenge.description}
          onSaved={() => setEditingChallenge(null)}
          onSubmit={
            onUpdateChallenge
              ? (data) => onUpdateChallenge(editingChallenge.challenge.id, data)
              : undefined
          }
        />
      )}
    </>
  );
}
