import type { Lang } from '@sideline/rules';
import { text } from '@sideline/rules';
import { CHEAT_SHEET, SIGNALS } from '@sideline/rules/reference';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { tr } from '~/lib/translations.js';

interface RulesCheatSheetProps {
  readonly locale: Lang;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The on-field cheat sheet: the three `CHEAT_SHEET` tables (content, not
 * chrome — see `packages/rules/src/reference.ts`) plus the hand-signal
 * list from `SIGNALS`. Only the section headings and notes go through
 * `tr()`; every cell is localised via `text(..., locale)`.
 *
 * Rendered as a dialog from both the intro and practice screens — never
 * during an exam (`app.js:238` hid the same button in exam mode; here that
 * just means `RulesTrainer.tsx` never renders the trigger, and force-closes
 * this dialog if the screen becomes `'exam'`).
 */
export function RulesCheatSheet({ locale, open, onOpenChange }: RulesCheatSheetProps) {
  const stallHeader = CHEAT_SHEET.cheatStallH[locale];
  const stallRows = CHEAT_SHEET.cheatStallRows[locale];
  const whoRows = CHEAT_SHEET.cheatWhoRows[locale];
  const goldRows = CHEAT_SHEET.cheatGoldRows[locale];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{tr('rules_cheatTitle', undefined, { locale })}</DialogTitle>
        </DialogHeader>

        <div className='flex flex-col gap-6'>
          <section className='flex flex-col gap-2'>
            <h3 className='font-semibold'>{tr('rules_cheatStall', undefined, { locale })}</h3>
            <div className='overflow-hidden rounded-md border'>
              <div className='grid grid-cols-3 bg-muted text-xs font-semibold'>
                {stallHeader.map((cell) => (
                  <div key={cell} className='p-2'>
                    {cell}
                  </div>
                ))}
              </div>
              {stallRows.map((row) => (
                <div key={row.join('|')} className='grid grid-cols-3 border-t text-sm'>
                  {row.map((cell, cellIndex) => (
                    <div key={cell} className='p-2'>
                      {cellIndex === row.length - 1 ? `§ ${cell}` : cell}
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              {tr('rules_cheatStallNote', undefined, { locale })}
            </p>
          </section>

          <section className='flex flex-col gap-2'>
            <h3 className='font-semibold'>{tr('rules_cheatWho', undefined, { locale })}</h3>
            <div className='overflow-hidden rounded-md border'>
              {whoRows.map((row, rowIndex) => (
                <div
                  key={row.join('|')}
                  className={`grid grid-cols-2 text-sm ${rowIndex > 0 ? 'border-t' : ''}`}
                >
                  {row.map((cell) => (
                    <div key={cell} className='p-2'>
                      {cell}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </section>

          <section className='flex flex-col gap-2'>
            <h3 className='font-semibold'>{tr('rules_cheatGold', undefined, { locale })}</h3>
            <div className='flex flex-col gap-3'>
              {goldRows.map((row) => (
                <div key={row.join('|')} className='rounded-md border p-3 text-sm'>
                  <p className='font-medium'>{row[0]}</p>
                  <p className='mt-1 text-muted-foreground'>{row[1]}</p>
                </div>
              ))}
            </div>
          </section>

          <section className='flex flex-col gap-2'>
            <h3 className='font-semibold'>{tr('rules_cheatSig', undefined, { locale })}</h3>
            <div className='flex flex-wrap gap-2'>
              {Object.entries(SIGNALS).map(([id, entry]) => (
                <Badge key={id} variant='outline'>
                  #{id} {text(entry, locale)}
                </Badge>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              {tr('rules_cheatSigNote', undefined, { locale })}
            </p>
          </section>
        </div>

        <DialogFooter>
          <Button type='button' onClick={() => onOpenChange(false)}>
            {tr('rules_close', undefined, { locale })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
