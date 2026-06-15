import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { Discord, type GlobalAdminApi, type User } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
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
} from '~/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
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
import { useFormatDate } from '~/hooks/useFormatDate';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ─── Form schema ─────────────────────────────────────────────────────────────

const GrantAdminFormSchema = Schema.Struct({
  discordId: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>(
        (v) => /^\d{17,20}$/.test(v) || tr('admin_globalAdmins_validation_discordIdInvalid'),
      ),
    ),
  ),
});
type GrantAdminFormValues = Schema.Schema.Type<typeof GrantAdminFormSchema>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function discordAvatarUrl(discordId: string, avatar: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=64`;
}

// ─── Main page ────────────────────────────────────────────────────────────────

interface AdminGlobalAdminsPageProps {
  admins: ReadonlyArray<GlobalAdminApi.GlobalAdminListItem>;
}

export function AdminGlobalAdminsPage({ admins }: AdminGlobalAdminsPageProps) {
  const run = useRun();
  const router = useRouter();
  const { formatDateTime } = useFormatDate();

  const [revokeTargetId, setRevokeTargetId] = React.useState<User.UserId | null>(null);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(GrantAdminFormSchema)),
    mode: 'onChange',
    defaultValues: {
      discordId: '',
    },
  });

  const onSubmit = React.useCallback(
    async (values: GrantAdminFormValues) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.globalAdmin.grantGlobalAdmin({
            payload: {
              discordId: Schema.decodeSync(Discord.Snowflake)(values.discordId),
            },
          }),
        ),
        Effect.mapError((e) => {
          if (e._tag === 'GlobalAdminUserNotFound') {
            return ClientError.make(tr('admin_globalAdmins_error_userNotFound'));
          }
          if (e._tag === 'GlobalAdminForbidden') {
            return ClientError.make(tr('admin_globalAdmins_error_forbidden'));
          }
          return ClientError.make(tr('admin_globalAdmins_grantFailed'));
        }),
        run({ success: tr('admin_globalAdmins_granted') }),
      );
      if (Option.isSome(result)) {
        form.reset({ discordId: '' });
        await router.invalidate();
      }
    },
    [run, router, form],
  );

  const handleRevokeConfirm = React.useCallback(async () => {
    if (revokeTargetId === null) return;
    const userId = revokeTargetId;
    setRevokeTargetId(null);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.globalAdmin.revokeGlobalAdmin({ params: { userId } })),
      Effect.mapError((e) => {
        if (e._tag === 'GlobalAdminLastAdminError') {
          return ClientError.make(tr('admin_globalAdmins_error_lastAdmin'));
        }
        if (e._tag === 'GlobalAdminSelfRevokeError') {
          return ClientError.make(tr('admin_globalAdmins_error_selfRevoke'));
        }
        if (e._tag === 'GlobalAdminEnvManaged') {
          return ClientError.make(tr('admin_globalAdmins_error_envManaged'));
        }
        if (e._tag === 'GlobalAdminUserNotFound') {
          return ClientError.make(tr('admin_globalAdmins_error_userNotFound'));
        }
        if (e._tag === 'GlobalAdminForbidden') {
          return ClientError.make(tr('admin_globalAdmins_error_forbidden'));
        }
        return ClientError.make(tr('admin_globalAdmins_revokeFailed'));
      }),
      run({ success: tr('admin_globalAdmins_revoked') }),
    );
    if (Option.isSome(result)) {
      await router.invalidate();
    }
  }, [revokeTargetId, run, router]);

  return (
    <div className='container mx-auto py-8 max-w-3xl space-y-8'>
      <div className='space-y-3'>
        <Link
          to='/'
          className='inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors'
        >
          <ArrowLeft className='size-4' />
          {tr('common_backToDashboard')}
        </Link>
        <div>
          <h1 className='text-2xl font-bold'>{tr('admin_globalAdmins_pageTitle')}</h1>
          <p className='text-muted-foreground'>{tr('admin_globalAdmins_pageDescription')}</p>
        </div>
      </div>

      {/* Grant form */}
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            <ShieldCheck className='size-5' />
            {tr('admin_globalAdmins_grantTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className='space-y-4'>
              <FormField
                {...form.register('discordId')}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tr('admin_globalAdmins_discordIdLabel')}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder='123456789012345678' />
                    </FormControl>
                    <FormDescription>{tr('admin_globalAdmins_discordIdHelp')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type='submit' disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? tr('admin_globalAdmins_granting')
                  : tr('admin_globalAdmins_grantSubmit')}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Admin list */}
      <Card>
        <CardHeader>
          <CardTitle>{tr('admin_globalAdmins_listTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {admins.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{tr('admin_globalAdmins_listEmpty')}</p>
          ) : (
            <div className='space-y-3'>
              {admins.map((admin) => {
                const displayName = Option.isSome(admin.username)
                  ? admin.username.value
                  : admin.discordId;
                const avatarSrc = Option.isSome(admin.avatar)
                  ? discordAvatarUrl(admin.discordId, admin.avatar.value)
                  : undefined;
                const fallback = displayName.slice(0, 2).toUpperCase();
                const grantedAtDisplay = Option.isSome(admin.grantedAt)
                  ? formatDateTime(DateTime.toDate(admin.grantedAt.value))
                  : '—';

                return (
                  <div
                    key={`${admin.source}-${admin.discordId}`}
                    className='flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-3'
                  >
                    <div className='flex items-center gap-3 min-w-0'>
                      <Avatar className='size-9 shrink-0'>
                        {avatarSrc !== undefined && (
                          <AvatarImage src={avatarSrc} alt={displayName} />
                        )}
                        <AvatarFallback>{fallback}</AvatarFallback>
                      </Avatar>
                      <div className='space-y-1 min-w-0'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          <span className='font-medium'>{displayName}</span>
                          {admin.isSelf && (
                            <>
                              <Badge variant='secondary'>
                                {tr('admin_globalAdmins_badge_you')}
                              </Badge>
                              <span className='sr-only'>
                                {tr('admin_globalAdmins_badge_youSrOnly')}
                              </span>
                            </>
                          )}
                          {Option.isNone(admin.username) && (
                            <Badge variant='outline'>
                              {tr('admin_globalAdmins_badge_notLoggedIn')}
                            </Badge>
                          )}
                          {admin.source === 'env' && (
                            <Badge variant='outline'>
                              {tr('admin_globalAdmins_badge_envManaged')}
                            </Badge>
                          )}
                        </div>
                        {Option.isSome(admin.username) && (
                          <div className='text-xs text-muted-foreground'>
                            {tr('admin_globalAdmins_col_discordId')}: {admin.discordId}
                          </div>
                        )}
                        <div className='text-xs text-muted-foreground'>
                          {tr('admin_globalAdmins_col_grantedAt')}: {grantedAtDisplay}
                        </div>
                      </div>
                    </div>
                    <div className='flex items-center gap-2 shrink-0'>
                      {admin.revocable &&
                        !admin.isSelf &&
                        Option.isSome(admin.userId) &&
                        (() => {
                          const uid = admin.userId.value;
                          return (
                            <Button
                              variant='destructive'
                              size='sm'
                              onClick={() => setRevokeTargetId(uid)}
                            >
                              {tr('admin_globalAdmins_revoke')}
                            </Button>
                          );
                        })()}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Revoke confirmation dialog */}
      <AlertDialog
        open={revokeTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('admin_globalAdmins_revokeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr('admin_globalAdmins_revokeConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('admin_globalAdmins_revokeConfirmCancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevokeConfirm}>
              {tr('admin_globalAdmins_revokeConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
