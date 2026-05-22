import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { Auth } from '@sideline/domain';
import { Discord, OnboardingApi } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { AlertCircle, CheckCircle } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { ApiClient, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type OnboardingStep = 'identity' | 'discord';

export type PreviewResult =
  | { _tag: 'ok'; preview: OnboardingApi.OnboardingTokenPreview }
  | { _tag: 'not-found' }
  | { _tag: 'expired' }
  | { _tag: 'revoked' }
  | { _tag: 'consumed' };

interface OnboardingPageProps {
  token: string;
  previewResult: PreviewResult;
  userOption: Option.Option<Auth.CurrentUser>;
  activeStep: OnboardingStep;
  onStepChange: (step: OnboardingStep) => void;
  onSignIn: () => void;
  onComplete: (values: OnboardingApi.CompleteOnboardingRequest) => Promise<void>;
  discordClientId: string;
}

// ─── Identity step schema ─────────────────────────────────────────────────────

const IdentityFormSchema = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
  description: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
  sport: Schema.String,
  logoUrl: Schema.String.pipe(Schema.check(Schema.isMaxLength(2048))),
});
type IdentityFormValues = Schema.Schema.Type<typeof IdentityFormSchema>;

// ─── Discord step schema ──────────────────────────────────────────────────────

const DiscordFormSchema = Schema.Struct({
  guildId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  welcomeChannelId: Schema.String,
  systemLogChannelId: Schema.String,
  onboardingLocale: Schema.Literals(['en', 'cs']),
});
type DiscordFormValues = Schema.Schema.Type<typeof DiscordFormSchema>;

// ─── Helper: Guild picker ─────────────────────────────────────────────────────

function guildIconUrl(guildId: string, icon: Option.Option<string>): string | undefined {
  if (Option.isNone(icon)) return undefined;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon.value}.png?size=64`;
}

interface GuildPickerProps {
  guilds: ReadonlyArray<Auth.DiscordGuild>;
  loadingGuilds: boolean;
  discordClientId: string;
  selectedGuild: Auth.DiscordGuild | null;
  onSelectGuild: (guild: Auth.DiscordGuild) => void;
  onRefreshGuilds: () => void;
  refreshing: boolean;
}

function GuildPicker({
  guilds,
  loadingGuilds,
  discordClientId,
  selectedGuild,
  onSelectGuild,
  onRefreshGuilds,
  refreshing,
}: GuildPickerProps) {
  const [showBotStep, setShowBotStep] = React.useState(false);

  const botInviteUrl = selectedGuild
    ? `https://discord.com/oauth2/authorize?client_id=${discordClientId}&permissions=8&scope=bot%20applications.commands&guild_id=${selectedGuild.id}`
    : '';

  React.useEffect(() => {
    if (selectedGuild && !selectedGuild.botPresent) {
      setShowBotStep(true);
    } else if (selectedGuild?.botPresent) {
      setShowBotStep(false);
    }
  }, [selectedGuild]);

  if (showBotStep && selectedGuild) {
    return (
      <div className='space-y-3'>
        <p className='text-sm text-muted-foreground'>{tr('guild_inviteBotDescription')}</p>
        <div className='flex items-center gap-3 rounded-lg border p-3'>
          <span className='font-medium'>{selectedGuild.name}</span>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button type='button' variant='outline' onClick={() => setShowBotStep(false)}>
            {tr('guild_back')}
          </Button>
          <Button asChild>
            <a href={botInviteUrl} target='_blank' rel='noopener noreferrer'>
              {tr('guild_inviteBotButton')}
            </a>
          </Button>
          <Button type='button' variant='secondary' onClick={onRefreshGuilds} disabled={refreshing}>
            {refreshing ? tr('guild_refreshing') : tr('guild_refreshGuilds')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-2'>
      {loadingGuilds ? (
        <p className='text-sm text-muted-foreground'>{tr('guild_loadingGuilds')}</p>
      ) : guilds.length === 0 ? (
        <p className='text-sm text-muted-foreground'>{tr('guild_noGuilds')}</p>
      ) : (
        guilds.map((guild) => (
          <button
            key={guild.id}
            type='button'
            className={`flex items-center gap-3 w-full rounded-lg border p-3 text-left transition-colors ${
              selectedGuild?.id === guild.id ? 'border-primary bg-accent' : 'hover:bg-accent'
            }`}
            onClick={() => onSelectGuild(guild)}
          >
            {guildIconUrl(guild.id, guild.icon) ? (
              <img
                src={guildIconUrl(guild.id, guild.icon)}
                alt=''
                className='w-8 h-8 rounded-full'
              />
            ) : (
              <div className='w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium'>
                {guild.name.charAt(0)}
              </div>
            )}
            <div className='flex-1 min-w-0'>
              <div className='font-medium truncate'>{guild.name}</div>
              <div className='text-xs text-muted-foreground'>
                {guild.botPresent ? (
                  <span className='text-green-600 dark:text-green-400'>
                    {tr('guild_botPresent')}
                  </span>
                ) : (
                  <span className='text-amber-600 dark:text-amber-400'>
                    {tr('guild_botNotPresent')}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}

// ─── Error cards ─────────────────────────────────────────────────────────────

function ErrorCard({ titleKey, bodyKey }: { titleKey: string; bodyKey: string }) {
  return (
    <Card className='w-full max-w-sm'>
      <CardHeader className='text-center'>
        <div className='flex justify-center mb-2'>
          <div className='flex size-12 items-center justify-center rounded-full bg-destructive/10'>
            <AlertCircle className='size-6 text-destructive' />
          </div>
        </div>
        <CardTitle>{tr(titleKey)}</CardTitle>
        <CardDescription>{tr(bodyKey)}</CardDescription>
      </CardHeader>
      <CardContent className='flex justify-center'>
        <Button variant='outline' asChild>
          <a href='/'>{tr('onboarding_home')}</a>
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ activeStep }: { activeStep: OnboardingStep }) {
  return (
    <div className='flex items-center gap-2 mb-6'>
      <div
        className={`flex items-center gap-2 text-sm ${
          activeStep === 'identity' ? 'font-semibold text-primary' : 'text-muted-foreground'
        }`}
      >
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
            activeStep === 'discord'
              ? 'bg-primary text-primary-foreground'
              : 'border-2 border-primary text-primary'
          }`}
        >
          {activeStep === 'discord' ? <CheckCircle className='w-4 h-4' /> : '1'}
        </div>
        {tr('onboarding_step_identity')}
      </div>
      <div className='h-px flex-1 bg-border' />
      <div
        className={`flex items-center gap-2 text-sm ${
          activeStep === 'discord' ? 'font-semibold text-primary' : 'text-muted-foreground'
        }`}
      >
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
            activeStep === 'discord' ? 'border-2 border-primary text-primary' : 'bg-muted'
          }`}
        >
          2
        </div>
        {tr('onboarding_step_discord')}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OnboardingPage({
  previewResult,
  userOption,
  activeStep,
  onStepChange,
  onSignIn,
  onComplete,
  discordClientId,
}: OnboardingPageProps) {
  const run = useRun();
  const isAuthenticated = Option.isSome(userOption);
  const currentUser = Option.getOrNull(userOption);

  // Guild state (step 2)
  const [guilds, setGuilds] = React.useState<ReadonlyArray<Auth.DiscordGuild>>([]);
  const [loadingGuilds, setLoadingGuilds] = React.useState(false);
  const [refreshingGuilds, setRefreshingGuilds] = React.useState(false);
  const [selectedGuild, setSelectedGuild] = React.useState<Auth.DiscordGuild | null>(null);

  // Accumulated identity values from step 1
  const [identityValues, setIdentityValues] = React.useState<IdentityFormValues | null>(null);

  // Submission error for step 2
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const fetchGuilds = React.useCallback(async () => {
    setLoadingGuilds(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.auth.myGuilds()),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<Auth.DiscordGuild>)),
      run(),
    );
    if (Option.isSome(result)) {
      setGuilds(result.value);
    }
    setLoadingGuilds(false);
  }, [run]);

  const refreshGuilds = React.useCallback(async () => {
    setRefreshingGuilds(true);
    await fetchGuilds();
    setRefreshingGuilds(false);
  }, [fetchGuilds]);

  React.useEffect(() => {
    if (isAuthenticated && activeStep === 'discord') {
      fetchGuilds();
    }
  }, [isAuthenticated, activeStep, fetchGuilds]);

  // Identity form
  const identityForm = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(IdentityFormSchema)),
    mode: 'onChange',
    defaultValues: {
      name: previewResult._tag === 'ok' ? previewResult.preview.proposedName : '',
      description: '',
      sport: '',
      logoUrl: '',
    },
  });

  // Discord form
  const discordForm = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(DiscordFormSchema)),
    mode: 'onChange',
    defaultValues: {
      guildId: '',
      welcomeChannelId: '',
      systemLogChannelId: '',
      onboardingLocale: 'en' as const,
    },
  });

  // Update guildId when a guild with bot is selected
  React.useEffect(() => {
    if (selectedGuild?.botPresent) {
      discordForm.setValue('guildId', selectedGuild.id, { shouldValidate: true });
    } else {
      discordForm.setValue('guildId', '', { shouldValidate: false });
    }
  }, [selectedGuild, discordForm]);

  const onIdentitySubmit = React.useCallback(
    (values: IdentityFormValues) => {
      setIdentityValues(values);
      onStepChange('discord');
      fetchGuilds();
    },
    [onStepChange, fetchGuilds],
  );

  const onDiscordSubmit = React.useCallback(
    async (values: DiscordFormValues) => {
      if (!identityValues) return;
      setSubmitError(null);

      const toSnowflakeOption = (s: string): Option.Option<Discord.Snowflake> =>
        s.trim() ? Option.some(Schema.decodeSync(Discord.Snowflake)(s.trim())) : Option.none();

      const toStringOption = (s: string): Option.Option<string> =>
        s.trim() ? Option.some(s.trim()) : Option.none();

      const logoUrlRaw = identityValues.logoUrl.trim();
      const logoUrlOption: Option.Option<OnboardingApi.OnboardingLogoUrl> = logoUrlRaw
        ? Option.some(Schema.decodeSync(OnboardingApi.OnboardingLogoUrl)(logoUrlRaw))
        : Option.none();

      const payload: OnboardingApi.CompleteOnboardingRequest = {
        name: identityValues.name,
        description: toStringOption(identityValues.description),
        sport: toStringOption(identityValues.sport),
        logoUrl: logoUrlOption,
        guildId: Schema.decodeSync(Discord.Snowflake)(values.guildId),
        welcomeChannelId: toSnowflakeOption(values.welcomeChannelId),
        systemLogChannelId: toSnowflakeOption(values.systemLogChannelId),
        onboardingLocale: values.onboardingLocale,
      };

      try {
        await onComplete(payload);
      } catch {
        setSubmitError(tr('onboarding_error_submitFailed'));
      }
    },
    [identityValues, onComplete],
  );

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated={isAuthenticated} />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center justify-center px-6 py-12'>
        {/* Error states from loader */}
        {previewResult._tag === 'not-found' && (
          <ErrorCard titleKey='onboarding_invalid_title' bodyKey='onboarding_invalid_description' />
        )}
        {previewResult._tag === 'expired' && (
          <ErrorCard titleKey='onboarding_expired_title' bodyKey='onboarding_expired_description' />
        )}
        {previewResult._tag === 'revoked' && (
          <ErrorCard
            titleKey='onboarding_error_revokedTitle'
            bodyKey='onboarding_error_revokedBody'
          />
        )}
        {previewResult._tag === 'consumed' && (
          <Card className='w-full max-w-sm'>
            <CardHeader className='text-center'>
              <CardTitle>{tr('onboarding_consumed_title')}</CardTitle>
              <CardDescription>{tr('onboarding_consumed_description')}</CardDescription>
            </CardHeader>
            <CardContent className='flex flex-col gap-2'>
              {!isAuthenticated && (
                <Button onClick={onSignIn} className='w-full'>
                  {tr('onboarding_consumed_signIn')}
                </Button>
              )}
              <Button variant='outline' asChild>
                <a href='/'>{tr('onboarding_home')}</a>
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Token is valid — show auth/wizard states */}
        {previewResult._tag === 'ok' && (
          <>
            {/* Not authenticated */}
            {!isAuthenticated && (
              <Card className='w-full max-w-sm'>
                <CardHeader className='text-center'>
                  <CardTitle>{tr('onboarding_signIn_title')}</CardTitle>
                  <CardDescription>{tr('onboarding_signIn_description')}</CardDescription>
                  <p className='text-xs text-muted-foreground pt-1'>
                    {tr('onboarding_signIn_returnHint')}
                  </p>
                </CardHeader>
                <CardContent className='flex flex-col gap-2'>
                  <Button onClick={onSignIn} className='w-full'>
                    {tr('onboarding_signInCta')}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Authenticated but wrong captain */}
            {isAuthenticated &&
              currentUser !== null &&
              currentUser.discordId !== previewResult.preview.boundDiscordId && (
                <Card className='w-full max-w-sm'>
                  <CardHeader className='text-center'>
                    <div className='flex justify-center mb-2'>
                      <div className='flex size-12 items-center justify-center rounded-full bg-destructive/10'>
                        <AlertCircle className='size-6 text-destructive' />
                      </div>
                    </div>
                    <CardTitle>{tr('onboarding_wrongCaptain_title')}</CardTitle>
                    <CardDescription>{tr('onboarding_wrongCaptain_description')}</CardDescription>
                  </CardHeader>
                  <CardContent className='flex flex-col gap-2'>
                    <Button onClick={onSignIn} className='w-full'>
                      {tr('onboarding_wrongCaptain_switchUser')}
                    </Button>
                    <Button variant='outline' asChild>
                      <a href='/'>{tr('onboarding_home')}</a>
                    </Button>
                  </CardContent>
                </Card>
              )}

            {/* Authenticated and right captain — 2-step wizard */}
            {isAuthenticated &&
              currentUser !== null &&
              currentUser.discordId === previewResult.preview.boundDiscordId && (
                <Card className='w-full max-w-lg'>
                  <CardHeader>
                    <StepIndicator activeStep={activeStep} />
                  </CardHeader>
                  <CardContent>
                    {/* Step 1: Identity */}
                    {activeStep === 'identity' && (
                      <>
                        <div className='mb-4'>
                          <h2 className='text-lg font-semibold'>
                            {tr('onboarding_identity_title')}
                          </h2>
                          <p className='text-sm text-muted-foreground'>
                            {tr('onboarding_identity_description')}
                          </p>
                        </div>
                        <Form {...identityForm}>
                          <form
                            onSubmit={identityForm.handleSubmit(onIdentitySubmit)}
                            className='space-y-4'
                          >
                            <FormField
                              {...identityForm.register('name')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_teamNameLabel')}</FormLabel>
                                  <FormControl>
                                    <Input
                                      {...field}
                                      placeholder={tr('onboarding_teamNamePlaceholder')}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...identityForm.register('description')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>
                                    {tr('onboarding_descriptionLabel')}{' '}
                                    <span className='text-muted-foreground text-xs'>
                                      ({tr('onboarding_descriptionOptional')})
                                    </span>
                                  </FormLabel>
                                  <FormControl>
                                    <Textarea {...field} rows={2} />
                                  </FormControl>
                                  <FormDescription>
                                    {tr('onboarding_descriptionHelp')}
                                  </FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...identityForm.register('sport')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_sportLabel')}</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder='e.g. Football' />
                                  </FormControl>
                                  <FormDescription>{tr('onboarding_sportHelp')}</FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...identityForm.register('logoUrl')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_logoLabel')}</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder='https://example.com/logo.png' />
                                  </FormControl>
                                  <FormDescription>{tr('onboarding_logoHelp')}</FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <div className='flex justify-end'>
                              <Button type='submit'>{tr('onboarding_next')}</Button>
                            </div>
                          </form>
                        </Form>
                      </>
                    )}

                    {/* Step 2: Discord */}
                    {activeStep === 'discord' && (
                      <>
                        <div className='mb-4'>
                          <h2 className='text-lg font-semibold'>
                            {tr('onboarding_discord_title')}
                          </h2>
                          <p className='text-sm text-muted-foreground'>
                            {tr('onboarding_discord_description')}
                          </p>
                        </div>
                        <Form {...discordForm}>
                          <form
                            onSubmit={discordForm.handleSubmit(onDiscordSubmit)}
                            className='space-y-4'
                          >
                            <FormField
                              {...discordForm.register('guildId')}
                              render={() => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_guildLabel')}</FormLabel>
                                  <FormControl>
                                    <GuildPicker
                                      guilds={guilds}
                                      loadingGuilds={loadingGuilds}
                                      discordClientId={discordClientId}
                                      selectedGuild={selectedGuild}
                                      onSelectGuild={(guild) => {
                                        setSelectedGuild(guild);
                                      }}
                                      onRefreshGuilds={refreshGuilds}
                                      refreshing={refreshingGuilds}
                                    />
                                  </FormControl>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...discordForm.register('welcomeChannelId')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_welcomeChannelLabel')}</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder='123456789012345678' />
                                  </FormControl>
                                  <FormDescription>
                                    {tr('onboarding_welcomeChannelHelp')}
                                  </FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...discordForm.register('systemLogChannelId')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_systemChannelLabel')}</FormLabel>
                                  <FormControl>
                                    <Input {...field} placeholder='123456789012345678' />
                                  </FormControl>
                                  <FormDescription>
                                    {tr('onboarding_systemChannelHelp')}
                                  </FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />
                            <FormField
                              {...discordForm.register('onboardingLocale')}
                              render={({ field }) => (
                                <FormItem>
                                  <FormLabel>{tr('onboarding_localeLabel')}</FormLabel>
                                  <FormControl>
                                    <div className='flex gap-4'>
                                      {(['en', 'cs'] as const).map((locale) => (
                                        <Label
                                          key={locale}
                                          className='flex items-center gap-2 cursor-pointer'
                                        >
                                          <input
                                            type='radio'
                                            value={locale}
                                            checked={field.value === locale}
                                            onChange={() => field.onChange(locale)}
                                          />
                                          {locale === 'en'
                                            ? tr('onboarding_locale_en')
                                            : tr('onboarding_locale_cs')}
                                        </Label>
                                      ))}
                                    </div>
                                  </FormControl>
                                  <FormDescription>{tr('onboarding_localeHelp')}</FormDescription>
                                  <FormMessage />
                                </FormItem>
                              )}
                            />

                            {submitError && (
                              <Alert variant='destructive'>
                                <AlertTitle>{tr('onboarding_error_submitFailed')}</AlertTitle>
                                <AlertDescription>{submitError}</AlertDescription>
                              </Alert>
                            )}

                            <div className='flex justify-between'>
                              <Button
                                type='button'
                                variant='outline'
                                onClick={() => onStepChange('identity')}
                              >
                                {tr('onboarding_back')}
                              </Button>
                              <Button type='submit' disabled={discordForm.formState.isSubmitting}>
                                {discordForm.formState.isSubmitting
                                  ? tr('onboarding_creating')
                                  : tr('onboarding_create')}
                              </Button>
                            </div>
                          </form>
                        </Form>
                      </>
                    )}
                  </CardContent>
                </Card>
              )}
          </>
        )}
      </main>
    </div>
  );
}
