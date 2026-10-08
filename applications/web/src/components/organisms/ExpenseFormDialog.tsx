import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { type BankTransaction, Expense, type ExpenseApi } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { Download, X } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
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
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { dateOnlyToUtcNoon, formatLocalDate } from '~/lib/datetime.js';
import { parseAmount } from '~/lib/finance/parseAmount.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpenseCategory = Expense.ExpenseCategory;

/** The currencies this form can offer. `Expense.CurrencyCode` is a branded string, not a literal
 * union, so an unrecognised code (a stored expense in a currency we later dropped, or a Fio
 * movement in one we never offered) is narrowed back to the default rather than cast blindly. */
const FORM_CURRENCIES = ['CZK', 'EUR', 'USD'] as const;
type FormCurrency = (typeof FORM_CURRENCIES)[number];

const toFormCurrency = (value: string | undefined): FormCurrency =>
  FORM_CURRENCIES.find((c) => c === value) ?? 'CZK';

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
  attachments: ReadonlyArray<{
    attachmentId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }>;
};

/** Seed values for `mode: 'create'`. `category` is deliberately absent: an expense created from
 * a bank movement still needs a treasurer to file it, and guessing would defeat the point. */
export interface ExpensePrefill {
  readonly amountMinor?: number;
  readonly currency?: string;
  /** `YYYY-MM-DD`. */
  readonly spentAt?: string;
  readonly description?: string;
  /** Provenance link sent with the create request. */
  readonly bankTransactionId?: BankTransaction.BankTransactionId;
}

type ExpenseFormDialogProps =
  | {
      open: boolean;
      mode: 'create';
      expense?: undefined;
      teamId: string;
      prefill?: ExpensePrefill;
      onSubmit: (
        req: ExpenseApi.CreateExpenseRequest,
        files: ReadonlyArray<File>,
      ) => void | Promise<void>;
      onCancel: () => void;
      onDownloadAttachment?: (attachmentId: string, filename: string) => void;
      onDeleteAttachment?: (attachmentId: string) => void;
    }
  | {
      open: boolean;
      mode: 'edit';
      expense?: ExpenseView;
      teamId: string;
      prefill?: undefined;
      onSubmit: (
        req: ExpenseApi.UpdateExpenseRequest,
        files: ReadonlyArray<File>,
      ) => void | Promise<void>;
      onCancel: () => void;
      onDownloadAttachment?: (attachmentId: string, filename: string) => void;
      onDeleteAttachment?: (attachmentId: string) => void;
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
  currency: Schema.Literals(FORM_CURRENCIES),
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
  const { open, mode, expense, prefill, onCancel } = props;
  const isEdit = mode === 'edit';

  const defaults: ExpenseFormValues = {
    amountStr:
      isEdit && expense
        ? String(expense.amountMinor / 100)
        : prefill?.amountMinor !== undefined
          ? String(prefill.amountMinor / 100)
          : '',
    currency: toFormCurrency(isEdit && expense ? expense.currency : prefill?.currency),
    spentAt: isEdit && expense ? formatLocalDate(expense.spentAt) : (prefill?.spentAt ?? ''),
    category: isEdit && expense ? expense.category : 'other',
    description: isEdit && expense ? expense.description : (prefill?.description ?? ''),
  };

  const form = useForm<ExpenseFormValues>({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ExpenseFormSchema)),
    defaultValues: defaults,
  });

  // Capture defaults in a ref so the effect can reference stable values
  // without needing `defaults` (a new object each render) in deps.
  const defaultsRef = React.useRef(defaults);
  defaultsRef.current = defaults;

  const [stagedFiles, setStagedFiles] = React.useState<ReadonlyArray<File>>([]);
  const storedAttachments = expense?.attachments ?? [];
  const isSubmitting = form.formState.isSubmitting;

  // Reset when dialog opens/closes
  React.useEffect(() => {
    if (open) {
      form.reset(defaultsRef.current);
      setStagedFiles([]);
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
      ? dateOnlyToUtcNoon(values.spentAt)
      : dateOnlyToUtcNoon(new Date().toISOString().split('T')[0]);

    // Returned so RHF's `handleSubmit` awaits it and keeps `formState.isSubmitting` true for the
    // whole create-plus-upload window — otherwise a double click creates two expenses.
    if (props.mode === 'edit') {
      return props.onSubmit(
        {
          amountMinor: Option.some(Schema.decodeSync(Expense.AmountMinor)(amountMinor)),
          currency: Option.some(Schema.decodeSync(Expense.CurrencyCode)(values.currency)),
          spentAt: Option.some(spentAtUtc),
          category: Option.some(values.category),
          description: Option.some(values.description.trim()),
        },
        stagedFiles,
      );
    }
    return props.onSubmit(
      {
        amountMinor: Schema.decodeSync(Expense.AmountMinor)(amountMinor),
        currency: Schema.decodeSync(Expense.CurrencyCode)(values.currency),
        spentAt: spentAtUtc,
        category: values.category,
        description: values.description.trim(),
        bankTransactionId: Option.fromNullishOr(props.prefill?.bankTransactionId),
      },
      stagedFiles,
    );
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

            {/* Invoices */}
            <div className='flex flex-col gap-2'>
              <Label htmlFor='expense-attachments'>{tr('expense_attachments_title')}</Label>
              <Input
                id='expense-attachments'
                type='file'
                multiple
                accept='application/pdf,image/jpeg,image/png,image/heic'
                onChange={(e) => setStagedFiles([...(e.target.files ?? [])])}
              />
              <p className='text-sm text-muted-foreground'>{tr('expense_attachments_hint')}</p>
              {storedAttachments.length === 0 && stagedFiles.length === 0 && (
                <p className='text-sm text-muted-foreground'>{tr('expense_attachments_empty')}</p>
              )}
              {storedAttachments.map((attachment) => (
                <div
                  key={attachment.attachmentId}
                  className='flex items-center gap-2 text-sm justify-between'
                >
                  <span className='truncate'>{attachment.filename}</span>
                  <div className='flex items-center gap-1'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      onClick={() =>
                        props.onDownloadAttachment?.(attachment.attachmentId, attachment.filename)
                      }
                    >
                      <Download className='size-3' aria-hidden='true' />
                      <span className='sr-only'>
                        {tr('expense_attachments_downloadAria', { filename: attachment.filename })}
                      </span>
                    </Button>
                    <DeleteAttachmentControl
                      filename={attachment.filename}
                      onConfirm={() => props.onDeleteAttachment?.(attachment.attachmentId)}
                    />
                  </div>
                </div>
              ))}
              {stagedFiles.map((file) => (
                <div key={file.name} className='flex items-center gap-2 text-sm justify-between'>
                  <span className='truncate'>{file.name}</span>
                  <span className='text-muted-foreground'>{tr('expense_attachments_pending')}</span>
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onCancel} disabled={isSubmitting}>
                {tr('expense_form_cancel')}
              </Button>
              <Button type='submit' disabled={isSubmitting}>
                {isSubmitting
                  ? tr('expense_form_saving')
                  : isEdit
                    ? tr('expense_form_submit_edit')
                    : tr('expense_form_submit_create')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation control
// ---------------------------------------------------------------------------

// Deleting an attachment permanently destroys an accounting document with no undo, which
// `applications/web/AGENTS.md:1242` makes an explicit MUST for `AlertDialog`. Staged files get no
// remove control — re-picking in the file input replaces the selection and destroys nothing.
function DeleteAttachmentControl({
  filename,
  onConfirm,
}: {
  filename: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='text-muted-foreground hover:text-destructive'
        >
          <X className='size-3' aria-hidden='true' />
          <span className='sr-only'>{tr('expense_attachments_removeAria', { filename })}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('expense_attachments_deleteConfirm_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {tr('expense_attachments_deleteConfirm_description', { filename })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('expense_form_cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {tr('expense_attachments_deleteConfirm_action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
