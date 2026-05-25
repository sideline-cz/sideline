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

export interface WeeklyChallengesGridProps {
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
 * WeeklyChallengesGrid — desktop matrix: members × weeks.
 * Columns: sticky member name, then up to 12 weeks (oldest left, newest right).
 * Current week highlighted with bg-primary/5 border-x border-primary/30 + badge.
 */
export function WeeklyChallengesGrid({
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
}: WeeklyChallengesGridProps) {
  const [deletingChallengeId, setDeletingChallengeId] = React.useState<string | null>(null);
  const [editingChallenge, setEditingChallenge] = React.useState<ChallengeView | null>(null);

  // Sort challenges chronologically (oldest first = left-most column)
  const sortedChallenges = React.useMemo(
    () =>
      [...challenges].sort(
        (a, b) =>
          new Date(a.challenge.startDate).getTime() - new Date(b.challenge.startDate).getTime(),
      ),
    [challenges],
  );

  // Sort members alphabetically
  const sortedMembers = React.useMemo(
    () => [...members].sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  if (challenges.length === 0 || members.length === 0) {
    return null;
  }

  // Derive "active" challenge from the server-provided isActive flag (avoids browser-TZ bug).
  // The server already knows the team timezone and computes isActive correctly.
  const activeView = sortedChallenges.find((v) => v.isActive);
  const activeStartDate = activeView?.challenge.startDate.split('T')[0] ?? null;

  const isChallengeCurrentWeek = (view: ChallengeView) => view.isActive;

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
      <div data-testid='challenges-grid' className='overflow-x-auto rounded-lg border'>
        <table className='w-full border-collapse text-sm'>
          <thead>
            <tr className='border-b bg-muted/50'>
              {/* Sticky member column header */}
              <th className='sticky left-0 z-10 bg-muted/50 px-4 py-3 text-left font-medium text-muted-foreground min-w-[160px]'>
                {tr('challenges_grid_memberColumn')}
              </th>
              {sortedChallenges.map((view) => {
                const isCurrentWeek = isChallengeCurrentWeek(view);
                return (
                  <th
                    key={view.challenge.id}
                    className={cn(
                      'px-3 py-2 text-center font-medium min-w-[110px]',
                      isCurrentWeek && 'bg-primary/5 border-x border-primary/30',
                    )}
                  >
                    <div className='flex flex-col items-center gap-1'>
                      <DateRangeLabel
                        startDate={view.challenge.startDate}
                        endDate={view.challenge.endDate}
                      />
                      <ChallengeKindBadge kind={view.challenge.kind} />
                      {isCurrentWeek && (
                        <span className='text-xs font-normal text-primary'>
                          {tr('challenges_thisWeekBadge')}
                        </span>
                      )}
                      <p className='text-xs font-normal text-foreground truncate max-w-[100px]'>
                        {view.challenge.title}
                      </p>
                      {canCreate && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant='ghost' size='icon' className='h-6 w-6'>
                              <MoreHorizontal className='size-3.5' />
                              <span className='sr-only'>Menu</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align='center'>
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
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedMembers.map((member) => (
              <tr key={member.memberId} className='border-b last:border-0 hover:bg-muted/30'>
                {/* Sticky member name column */}
                <td className='sticky left-0 z-10 bg-background px-4 py-2 font-medium'>
                  {member.name}
                </td>
                {sortedChallenges.map((view) => {
                  const isCompleted = view.completedMemberIds.includes(member.memberId);
                  const isCurrentWeek = isChallengeCurrentWeek(view);
                  const isPast = isChallengeInPast(view);
                  const isOwnRowActive = currentMemberId === member.memberId && view.isActive;
                  const isFuture = !view.isActive && !isPast && !isCurrentWeek;

                  return (
                    <td
                      key={view.challenge.id}
                      className={cn(
                        'px-3 py-2 text-center h-12',
                        isCurrentWeek && 'bg-primary/5 border-x border-primary/30',
                      )}
                    >
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
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
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
