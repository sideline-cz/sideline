import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Expense, type ExpenseApi } from '@sideline/domain';
import { Option, Schema } from 'effect';
import React from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogFooter } from '~/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { dateOnlyToUtc, formatLocalDate } from '~/lib/datetime.js';
import { parseAmount } from '~/lib/finance/parseAmount.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpenseCategory = Expense.ExpenseCategory;

export type ExpenseView = {
  expenseId: string;
  teamId: string;
  amountMinor: number;
  currency: string;
  spentAt: import('effect').DateTime.Utc;
  category: ExpenseCategory;
  description: string;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: import('effect').DateTime.Utc;
  updatedAt: import('effect').DateTime.Utc;
};

type ExpenseFormDialogProps =
  | {
      open: boolean;
      mode: 'create';
      expense?: undefined;
      teamId: string;
      onSubmit: (req: ExpenseApi.CreateExpenseRequest) => void;
      onCancel: () => void;
    }
  | {
      open: boolean;
      mode: 'edit';
      expense?: ExpenseView;
      teamId: string;
      onSubmit: (req: ExpenseApi.UpdateExpenseRequest) => void;
      onCancel: () => void;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: ReadonlyArray<{ value: ExpenseCategory; labelKey: string }> = [
  { value: 'fields', labelKey: 'expense_category_fields' },
  { value: 'equipment', labelKey: 'expense_category_equipment' },
  { value: 'travel', labelKey: 'expense_category_travel' },
  { value: 'tournaments', labelKey: 'expense_category_tournaments' },
  { value: 'other', labelKey: 'expense_category_other' },
];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ExpenseFormSchema = Schema.Struct({
  amountStr: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) =>
        Number(s.trim()) > 0 ? true : tr('expense_form_validation_amountRequired'),
      ),
    ),
  ),
  currency: Schema.Literals(['CZK', 'EUR', 'USD']),
  spentAt: Schema.NonEmptyString,
  category: Expense.ExpenseCategory,
  description: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>(
        (s) => s.length <= 500 || tr('expense_form_validation_descriptionTooLong'),
      ),
    ),
  ),
});

type ExpenseFormValues = Schema.Schema.Type<typeof ExpenseFormSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExpenseFormDialog(props: ExpenseFormDialogProps) {
  const { open, mode, expense, onCancel } = props;
  const isEdit = mode === 'edit';

  const defaults: ExpenseFormValues = {
    amountStr: isEdit && expense ? String(expense.amountMinor / 100) : '',
    currency: isEdit && expense ? (expense.currency as 'CZK' | 'EUR' | 'USD') : 'CZK',
    spentAt: isEdit && expense ? formatLocalDate(expense.spentAt) : '',
    category: isEdit && expense ? expense.category : 'other',
    description: isEdit && expense ? expense.description : '',
  };

  const form = useForm<ExpenseFormValues>({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ExpenseFormSchema)),
    defaultValues: defaults,
  });

  // Capture defaults in a ref so the effect can reference stable values
  // without needing `defaults` (a new object each render) in deps.
  const defaultsRef = React.useRef(defaults);
  defaultsRef.current = defaults;

  // Reset when dialog opens/closes
  React.useEffect(() => {
    if (open) {
      form.reset(defaultsRef.current);
    }
    // `form.reset` is stable; `defaultsRef` is a ref — both safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.reset]);

  // Soft future-date warning (not a validation error)
  const spentAtValue = form.watch('spentAt');
  const isFutureDate = React.useMemo(() => {
    if (!spentAtValue) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const selected = new Date(`${spentAtValue}T00:00:00`);
    return selected > today;
  }, [spentAtValue]);

  const onSubmit = (values: ExpenseFormValues) => {
    let amountMinor = 0;
    try {
      amountMinor = parseAmount(values.amountStr, values.currency);
    } catch {
      form.setError('amountStr', { message: tr('expense_form_validation_amountRequired') });
      return;
    }

    if (amountMinor <= 0) {
      form.setError('amountStr', { message: tr('expense_form_validation_amountRequired') });
      return;
    }

    const spentAtUtc = values.spentAt
      ? dateOnlyToUtc(values.spentAt)
      : dateOnlyToUtc(new Date().toISOString().split('T')[0]);

    if (props.mode === 'edit') {
      props.onSubmit({
        amountMinor: Option.some(Schema.decodeSync(Expense.AmountMinor)(amountMinor)),
        currency: Option.some(Schema.decodeSync(Expense.CurrencyCode)(values.currency)),
        spentAt: Option.some(spentAtUtc),
        category: Option.some(values.category),
        description: Option.some(values.description.trim()),
      });
    } else {
      props.onSubmit({
        amountMinor: Schema.decodeSync(Expense.AmountMinor)(amountMinor),
        currency: Schema.decodeSync(Expense.CurrencyCode)(values.currency),
        spentAt: spentAtUtc,
        category: values.category,
        description: values.description.trim(),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <DialogContent
        aria-label={isEdit ? tr('expense_form_title_edit') : tr('expense_form_title_create')}
        aria-describedby={undefined}
      >
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className='flex flex-col gap-4'>
            {/* Amount + Currency row */}
            <div className='flex gap-3'>
              <FormField
                control={form.control}
                name='amountStr'
                render={({ field }) => (
                  <FormItem className='flex-1'>
                    <FormLabel>{tr('expense_form_amount')}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        id='expense-amount'
                        type='number'
                        step='0.01'
                        min='0.01'
                        placeholder='0.00'
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name='currency'
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr('expense_form_currency')}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger id='expense-currency' className='w-24'>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value='CZK'>CZK</SelectItem>
                        <SelectItem value='EUR'>EUR</SelectItem>
                        <SelectItem value='USD'>USD</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Date */}
            <FormField
              control={form.control}
              name='spentAt'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('expense_form_date')}</FormLabel>
                  <FormControl>
                    <Input {...field} id='expense-spentAt' type='date' />
                  </FormControl>
                  <FormMessage />
                  {isFutureDate && (
                    <p className='text-sm text-muted-foreground'>
                      {tr('expense_form_warning_futureDate')}
                    </p>
                  )}
                </FormItem>
              )}
            />

            {/* Category */}
            <FormField
              control={form.control}
              name='category'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('expense_form_category')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger id='expense-category'>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {tr(c.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Description */}
            <FormField
              control={form.control}
              name='description'
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tr('expense_form_description')}</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      id='expense-description'
                      placeholder={tr('expense_form_descriptionPlaceholder')}
                      maxLength={500}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onCancel}>
                {tr('expense_form_cancel')}
              </Button>
              <Button type='submit'>
                {isEdit ? tr('expense_form_submit_edit') : tr('expense_form_submit_create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
