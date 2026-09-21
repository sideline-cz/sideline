import { format, parse } from 'date-fns';
import { CalendarIcon, XIcon } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Calendar } from '~/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { useDateFnsLocale } from '~/hooks/useDateFnsLocale';
import { cn } from '~/lib/utils';

interface DatePickerProps {
  value?: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  disabled?: boolean;
  fromYear?: number;
  toYear?: number;
  /** Upper bound at DAY granularity — later days are unselectable and unreachable. */
  toDate?: Date;
  defaultMonth?: Date;
}

function DatePicker({
  value,
  onChange,
  onClear,
  placeholder = 'Pick a date',
  disabled,
  fromYear,
  toYear,
  toDate,
  defaultMonth: defaultMonthProp,
}: DatePickerProps) {
  const dateFnsLocale = useDateFnsLocale();
  const selected = value ? parse(value, 'yyyy-MM-dd', new Date()) : undefined;

  return (
    <div className='flex gap-1'>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            disabled={disabled}
            className={cn('w-full justify-start text-left font-normal', !value && 'text-muted-foreground')}
          >
            <CalendarIcon className='mr-2 size-4' />
            {selected ? format(selected, 'PPP', { locale: dateFnsLocale }) : <span>{placeholder}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-auto p-0' align='start'>
          <Calendar
            mode='single'
            selected={selected}
            onSelect={(date) => {
              if (date) {
                onChange(format(date, 'yyyy-MM-dd'));
              }
            }}
            captionLayout={fromYear || toYear ? 'dropdown' : 'label'}
            startMonth={fromYear ? new Date(fromYear, 0) : undefined}
            endMonth={toDate ?? (toYear ? new Date(toYear, 11) : undefined)}
            disabled={toDate ? { after: toDate } : undefined}
            defaultMonth={selected ?? defaultMonthProp}
            autoFocus
          />
        </PopoverContent>
      </Popover>
      {onClear && value && (
        <Button variant='outline' size='icon' disabled={disabled} onClick={onClear} type='button'>
          <XIcon className='size-4' />
        </Button>
      )}
    </div>
  );
}

export { DatePicker };
