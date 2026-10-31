import { EventSeries } from '@sideline/domain';
import { useFormContext } from 'react-hook-form';
import { Button } from '~/components/ui/button';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '~/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { DAY_ORDER, dayFullLabels, dayShortLabels, sortDays } from '~/lib/event-labels';
import {
  DAYS_OF_MONTH,
  type RecurrenceFormInput,
  WEEK_OF_MONTH_ORDER,
  weekOfMonthLabels,
} from '~/lib/recurrence';
import { tr } from '~/lib/translations.js';

interface RecurrenceFormFieldsProps {
  frequency: EventSeries.RecurrenceFrequency;
  itemClassName?: string;
}

// The per-frequency fields below the frequency select. Must render inside a `<Form>` whose
// values spread `recurrenceFormFields`.
export function RecurrenceFormFields({ frequency, itemClassName }: RecurrenceFormFieldsProps) {
  const { control } = useFormContext<RecurrenceFormInput>();
  return (
    <>
      {frequency === 'monthly_by_date' && (
        <FormField
          name='dayOfMonth'
          control={control}
          render={({ field }) => (
            <FormItem className={itemClassName}>
              <FormLabel>{tr('event_dayOfMonth')}</FormLabel>
              <Select onValueChange={(v) => field.onChange(Number(v))} value={String(field.value)}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {DAYS_OF_MONTH.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {field.value >= 29 && (
                <p className='text-xs text-muted-foreground'>{tr('event_dayOfMonth_clampHint')}</p>
              )}
              <FormMessage />
            </FormItem>
          )}
        />
      )}
      {frequency === 'monthly_by_weekday' && (
        <>
          <FormField
            name='weekOfMonth'
            control={control}
            render={({ field }) => (
              <FormItem className={itemClassName}>
                <FormLabel>{tr('event_weekOfMonth')}</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(Number(v))}
                  value={String(field.value)}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {WEEK_OF_MONTH_ORDER.map((w) => (
                      <SelectItem key={w} value={String(w)}>
                        {weekOfMonthLabels[w]()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            name='dayOfWeek'
            control={control}
            render={({ field }) => (
              <FormItem className={itemClassName}>
                <FormLabel>{tr('event_dayOfWeek')}</FormLabel>
                <Select
                  onValueChange={(v) => field.onChange(Number(v))}
                  value={String(field.value)}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {DAY_ORDER.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {dayFullLabels[d]()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </>
      )}
      {!EventSeries.isMonthlyFrequency(frequency) && (
        <FormField
          name='daysOfWeek'
          control={control}
          render={({ field }) => (
            <FormItem className={itemClassName}>
              <FormLabel>{tr('event_daysOfWeek')}</FormLabel>
              <div className='flex gap-1'>
                {DAY_ORDER.map((d) => {
                  const selected = field.value.includes(d);
                  return (
                    <Button
                      key={d}
                      type='button'
                      size='sm'
                      variant={selected ? 'default' : 'outline'}
                      className='w-10'
                      aria-pressed={selected}
                      aria-label={dayFullLabels[d]()}
                      onClick={() =>
                        field.onChange(
                          sortDays(
                            selected ? field.value.filter((v) => v !== d) : [...field.value, d],
                          ),
                        )
                      }
                    >
                      {dayShortLabels[d]()}
                    </Button>
                  );
                })}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </>
  );
}
