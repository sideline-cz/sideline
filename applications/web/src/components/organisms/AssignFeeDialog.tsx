import type { FinanceApi } from '@sideline/domain';
import { TeamMember } from '@sideline/domain';
import { Option, Schema } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { tr } from '~/lib/translations.js';
import type { FeeView } from '../pages/FeeManagementPage.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssignFeeDialogProps = {
  open: boolean;
  fee: FeeView;
  members: ReadonlyArray<{ teamMemberId: string; name: string }>;
  onSubmit: (req: FinanceApi.AssignFeeRequest) => Promise<void> | void;
  onCancel: () => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssignFeeDialog({ open, fee, members, onSubmit, onCancel }: AssignFeeDialogProps) {
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState<ReadonlyArray<string>>([]);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setSearch('');
      setSelected([]);
      setSubmitting(false);
    }
  }, [open]);

  const filtered = members.filter((m) => m.name.toLowerCase().includes(search.toLowerCase()));

  const toggleMember = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected.length === 0) return;

    setSubmitting(true);
    try {
      const memberIds = selected.map((id) => Schema.decodeSync(TeamMember.TeamMemberId)(id));
      const req: FinanceApi.AssignFeeRequest = {
        memberIds,
        amountMinorOverride: Option.none(),
        dueAtOverride: Option.none(),
      };
      await onSubmit(req);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {tr('assign_fee_dialog_title')} — {fee.name}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Search */}
          <Input
            type='search'
            placeholder={tr('assign_fee_dialog_searchPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {/* Member list */}
          <div className='max-h-64 overflow-y-auto flex flex-col gap-1'>
            {filtered.length === 0 ? (
              <p className='text-sm text-muted-foreground py-2'>
                {tr('assign_fee_dialog_noMembers')}
              </p>
            ) : (
              filtered.map((member) => (
                <label
                  key={member.teamMemberId}
                  className='flex items-center gap-2 text-sm cursor-pointer rounded px-2 py-1 hover:bg-muted/50'
                >
                  <input
                    type='checkbox'
                    checked={selected.includes(member.teamMemberId)}
                    onChange={() => toggleMember(member.teamMemberId)}
                  />
                  {member.name}
                </label>
              ))
            )}
          </div>

          <DialogFooter>
            <Button type='button' variant='outline' onClick={onCancel}>
              {tr('assign_fee_dialog_cancel')}
            </Button>
            <Button type='submit' disabled={selected.length === 0 || submitting}>
              {tr('assign_fee_dialog_submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
