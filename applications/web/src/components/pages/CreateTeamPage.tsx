import type { Auth } from '@sideline/domain';
import { Option } from 'effect';
import { Plus } from 'lucide-react';
import React from 'react';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { tr } from '~/lib/translations.js';

type Step = 'select-guild' | 'invite-bot' | 'name-team';

interface CreateTeamPageProps {
  guilds: readonly Auth.DiscordGuild[];
  loadingGuilds: boolean;
  discordClientId: string;
  onCreateTeam: (name: string, guildId: string) => Promise<boolean>;
  onRefreshGuilds: () => Promise<void>;
}

function guildIconUrl(guildId: string, icon: Option.Option<string>): string | undefined {
  if (Option.isNone(icon)) return undefined;
  return `https://cdn.discordapp.com/icons/${guildId}/${icon.value}.png?size=64`;
}

export function CreateTeamPage({
  guilds,
  loadingGuilds,
  discordClientId,
  onCreateTeam,
  onRefreshGuilds,
}: CreateTeamPageProps) {
  const [step, setStep] = React.useState<Step>('select-guild');
  const [selectedGuild, setSelectedGuild] = React.useState<Auth.DiscordGuild | null>(null);
  const [teamName, setTeamName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const handleSelectGuild = React.useCallback((guild: Auth.DiscordGuild) => {
    setSelectedGuild(guild);
    if (guild.botPresent) {
      setStep('name-team');
    } else {
      setStep('invite-bot');
    }
  }, []);

  const handleRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await onRefreshGuilds();
    setRefreshing(false);
  }, [onRefreshGuilds]);

  React.useEffect(() => {
    if (step === 'invite-bot' && selectedGuild) {
      const updated = guilds.find((g) => g.id === selectedGuild.id);
      if (updated) {
        setSelectedGuild(updated);
        if (updated.botPresent) {
          setStep('name-team');
        }
      }
    }
  }, [guilds, step, selectedGuild]);

  const handleCreate = React.useCallback(async () => {
    if (!teamName.trim() || !selectedGuild) return;
    setCreating(true);
    const success = await onCreateTeam(teamName.trim(), selectedGuild.id);
    setCreating(false);
    if (success) {
      setTeamName('');
    }
  }, [teamName, selectedGuild, onCreateTeam]);

  const botInviteUrl = selectedGuild
    ? `https://discord.com/oauth2/authorize?client_id=${discordClientId}&permissions=8&scope=bot%20applications.commands&guild_id=${selectedGuild.id}`
    : '';

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='flex items-center justify-between px-6 py-4 border-b'>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-lg'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <div className='flex size-12 items-center justify-center rounded-full bg-muted'>
                <Plus className='size-6 text-muted-foreground' />
              </div>
            </div>
            <CardTitle>{tr('dashboard_createTeam')}</CardTitle>
          </CardHeader>
          <CardContent>
            {step === 'select-guild' && (
              <div>
                <h2 className='text-sm font-semibold mb-1'>{tr('guild_selectServer')}</h2>
                <CardDescription className='mb-4'>
                  {tr('guild_selectServerDescription')}
                </CardDescription>

                {loadingGuilds ? (
                  <p className='text-sm text-muted-foreground'>{tr('guild_loadingGuilds')}</p>
                ) : guilds.length === 0 ? (
                  <p className='text-sm text-muted-foreground'>{tr('guild_noGuilds')}</p>
                ) : (
                  <div className='space-y-2'>
                    {guilds.map((guild) => (
                      <button
                        key={guild.id}
                        type='button'
                        className='flex items-center gap-3 w-full rounded-lg border p-3 text-left hover:bg-accent transition-colors'
                        onClick={() => handleSelectGuild(guild)}
                      >
                        {guildIconUrl(guild.id, guild.icon) ? (
                          <img
                            src={guildIconUrl(guild.id, guild.icon)}
                            alt=''
                            className='w-10 h-10 rounded-full'
                          />
                        ) : (
                          <div className='w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium'>
                            {guild.name.charAt(0)}
                          </div>
                        )}
                        <div className='flex-1 min-w-0'>
                          <div className='font-medium truncate'>{guild.name}</div>
                          <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                            {guild.owner && <span>{tr('guild_owner')}</span>}
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
                    ))}
                  </div>
                )}
              </div>
            )}

            {step === 'invite-bot' && selectedGuild && (
              <div>
                <h2 className='text-sm font-semibold mb-1'>{tr('guild_inviteBot')}</h2>
                <CardDescription className='mb-4'>
                  {tr('guild_inviteBotDescription')}
                </CardDescription>

                <div className='flex items-center gap-3 rounded-lg border p-3 mb-4'>
                  {guildIconUrl(selectedGuild.id, selectedGuild.icon) ? (
                    <img
                      src={guildIconUrl(selectedGuild.id, selectedGuild.icon)}
                      alt=''
                      className='w-10 h-10 rounded-full'
                    />
                  ) : (
                    <div className='w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium'>
                      {selectedGuild.name.charAt(0)}
                    </div>
                  )}
                  <span className='font-medium'>{selectedGuild.name}</span>
                </div>

                <div className='flex flex-wrap gap-2'>
                  <Button variant='outline' onClick={() => setStep('select-guild')}>
                    {tr('guild_back')}
                  </Button>
                  <Button asChild>
                    <a href={botInviteUrl} target='_blank' rel='noopener noreferrer'>
                      {tr('guild_inviteBotButton')}
                    </a>
                  </Button>
                  <Button variant='secondary' onClick={handleRefresh} disabled={refreshing}>
                    {refreshing ? tr('guild_refreshing') : tr('guild_refreshGuilds')}
                  </Button>
                </div>
              </div>
            )}

            {step === 'name-team' && selectedGuild && (
              <div>
                <h2 className='text-sm font-semibold mb-3'>{tr('guild_nameTeam')}</h2>

                <div className='flex items-center gap-3 rounded-lg border p-3 mb-4'>
                  {guildIconUrl(selectedGuild.id, selectedGuild.icon) ? (
                    <img
                      src={guildIconUrl(selectedGuild.id, selectedGuild.icon)}
                      alt=''
                      className='w-10 h-10 rounded-full'
                    />
                  ) : (
                    <div className='w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium'>
                      {selectedGuild.name.charAt(0)}
                    </div>
                  )}
                  <div>
                    <div className='font-medium'>{selectedGuild.name}</div>
                    <span className='text-xs text-green-600 dark:text-green-400'>
                      {tr('guild_botPresent')}
                    </span>
                  </div>
                </div>

                <div className='flex flex-col gap-2 sm:flex-row'>
                  <Input
                    placeholder={tr('dashboard_teamNamePlaceholder')}
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                    }}
                    className='flex-1'
                  />
                  <Button onClick={handleCreate} disabled={creating || !teamName.trim()}>
                    {creating ? tr('dashboard_creating') : tr('dashboard_createTeam')}
                  </Button>
                </div>

                <div className='mt-2'>
                  <Button variant='ghost' size='sm' onClick={() => setStep('select-guild')}>
                    {tr('guild_back')}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
