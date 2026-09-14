/**
 * The assistant's input composer (design §2.8). React Hook Form + Effect Schema, per
 * `applications/web/AGENTS.md`'s mandatory forms rule — this codebase's actual, proven
 * convention is `standardSchemaResolver(Schema.toStandardSchemaV1(...))` (all form call sites in
 * this repo use it; `@hookform/resolvers/effect-ts` has zero call sites here), so this component
 * follows that convention rather than the doc's `effectTsResolver` snippet.
 *
 * `<FormControl>` is deliberately NOT used here: it auto-wires `aria-describedby` to the
 * standard `FormDescription`/`FormMessage` ids, but design §2.8 requires the textarea's
 * `aria-describedby` to point at THIS composer's own hint + counter `<p>`s instead. The field is
 * still registered through `<FormField>` (RHF `Controller` wiring, error state via
 * `useFormField()`/`<FormMessage>`), just without the `Slot`-based prop injection.
 *
 * Enter submits on pointer devices; Shift+Enter always inserts a newline; on touch
 * (`useIsMobile()`) Enter is newline-only and the send button is the sole submit path — the
 * soft-keyboard return key IS the newline key there, so hijacking it would send half-typed
 * messages.
 */
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Schema } from 'effect';
import { SendHorizontal } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '~/components/ui/button.js';
import { Form, FormField, FormItem, FormMessage } from '~/components/ui/form.js';
import { Textarea } from '~/components/ui/textarea.js';
import { useIsMobile } from '~/hooks/use-mobile.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

const MAX = 2000;
const COUNTER_THRESHOLD = MAX * 0.8;

const ComposerSchema = Schema.Struct({
  message: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) => (s.trim().length > 0 ? true : tr('validation_required'))),
      Schema.makeFilter<string>((s) =>
        s.length <= MAX ? true : tr('assistant_composer_tooLong', { max: MAX }),
      ),
    ),
  ),
});
type ComposerValues = Schema.Schema.Type<typeof ComposerSchema>;

interface AssistantComposerProps {
  onSend: (message: string) => Promise<void>;
  disabled: boolean;
  presetValue?: string;
}

const HINT_ID = 'assistant-composer-hint';
const COUNTER_ID = 'assistant-composer-counter';

export function AssistantComposer({ onSend, disabled, presetValue }: AssistantComposerProps) {
  const isMobile = useIsMobile();
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(ComposerSchema)),
    mode: 'onChange',
    defaultValues: { message: '' },
  });

  React.useEffect(() => {
    if (presetValue === undefined) return;
    form.setValue('message', presetValue, { shouldValidate: true });
    textareaRef.current?.focus();
  }, [presetValue, form.setValue]);

  const messageValue = form.watch('message');
  const trimmedLength = messageValue.trim().length;
  const overLimit = messageValue.length > MAX;
  const sendDisabled = disabled || trimmedLength === 0 || overLimit;
  const showCounter = messageValue.length >= COUNTER_THRESHOLD;

  const hint = overLimit
    ? tr('assistant_composer_tooLong', { max: MAX })
    : isMobile
      ? tr('assistant_composer_hintMobile')
      : tr('assistant_composer_hintDesktop');

  const onSubmit = async (values: ComposerValues) => {
    const content = values.message.trim();
    if (content.length === 0) return;
    await onSend(content);
    form.reset({ message: '' });
    textareaRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || isMobile) return;
    event.preventDefault();
    void form.handleSubmit(onSubmit)();
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className='mx-auto w-full max-w-3xl'>
        <FormField
          {...form.register('message')}
          render={({ field }) => (
            <FormItem className='gap-1'>
              <div
                className={cn(
                  'flex items-end gap-2 rounded-xl border bg-background p-2',
                  'focus-within:ring-[3px] focus-within:ring-ring/50',
                )}
              >
                <Textarea
                  {...field}
                  ref={(node) => {
                    field.ref(node);
                    textareaRef.current = node;
                  }}
                  rows={1}
                  maxLength={MAX}
                  disabled={disabled}
                  placeholder={tr('assistant_composer_placeholder')}
                  aria-label={tr('assistant_composer_label')}
                  aria-describedby={showCounter ? `${HINT_ID} ${COUNTER_ID}` : HINT_ID}
                  aria-invalid={form.formState.errors.message !== undefined}
                  onKeyDown={handleKeyDown}
                  className='min-h-0 max-h-40 flex-1 resize-none border-0 shadow-none focus-visible:ring-0 overflow-y-auto'
                />
                <Button type='submit' size='icon' disabled={sendDisabled}>
                  <SendHorizontal className='size-4' aria-hidden='true' />
                  <span className='sr-only'>{tr('assistant_composer_send')}</span>
                </Button>
              </div>
              <div className='flex items-center justify-between gap-2 px-1'>
                <p
                  id={HINT_ID}
                  className={cn('text-xs text-muted-foreground', overLimit && 'text-destructive')}
                >
                  {hint}
                </p>
                {showCounter && (
                  <p
                    id={COUNTER_ID}
                    aria-live='polite'
                    className={cn(
                      'text-xs text-muted-foreground tabular-nums',
                      overLimit && 'text-destructive',
                    )}
                  >
                    {tr('members_ratingDescCounter', { count: messageValue.length, max: MAX })}
                  </p>
                )}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}
