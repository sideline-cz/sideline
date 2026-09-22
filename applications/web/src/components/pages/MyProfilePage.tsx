import type { Auth, TeamApi } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Option } from 'effect';
import { ArrowLeft } from 'lucide-react';
import React from 'react';

import { DataExportCard } from '~/components/organisms/DataExportCard.js';
import { DiscordConnectCard } from '~/components/organisms/DiscordConnectCard.js';
import {
  EventPreferencesCard,
  EventPreferencesLoadFailed,
} from '~/components/organisms/EventPreferencesCard.js';
import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { ProfileEditForm } from '~/components/organisms/ProfileEditForm';
import { TelemetryPreferenceCard } from '~/components/organisms/TelemetryPreferenceCard.js';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { tr } from '~/lib/translations.js';

function discordAvatarUrl(discordId: string, avatar: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`;
}

/**
 * PR-9 / CC-11 — migrated off PR-5's ad hoc "Join the team Discord" row (which read
 * `getMyPendingDiscordJoin` directly and had no concept of `'unknown'`) onto the SAME
 * `DiscordConnectCard` the dashboard and the sidebar badge read. Exactly one component reads
 * `Auth.UserTeam.discordJoined` now, so this page can never disagree with the others. Renders
 * nothing for a team whose state is `'unknown'` (`DiscordConnectCard` itself decides that).
 *
 * No `myMemberId` here — this is a cross-team list, and resolving each team's dashboard just to
 * get a member id would be a per-team fetch this page has never needed. The "Sync roles"
 * affordance is therefore only wired on `TeamDetailPage`, where the dashboard load already
 * carries `myMemberId`.
 */
function DiscordConnectSection({ teams }: { readonly teams: ReadonlyArray<Auth.UserTeam> }) {
  const connectableTeams = teams.filter((team) => team.discordJoined !== 'unknown');
  if (connectableTeams.length === 0) return null;

  return (
    <Card className='w-full max-w-md mt-4'>
      <CardHeader>
        <CardTitle>{tr('profile_discordJoinTitle')}</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {connectableTeams.map((team) => (
          <DiscordConnectCard key={team.teamId} team={team} />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Nastavitelná docházka (design.md §A.1) — event preferences for the teams the member is
 * actually connected to on Discord. ONE card at a time, with a team switcher above it when
 * there is more than one: the card names the feature and never the team, so rendering one
 * card per team gave a multi-team member several identical-looking cards and no way to tell
 * them apart. DIFFERENT predicate than `DiscordConnectSection` above:
 * `discordJoined === 'connected'`, not `!== 'unknown'`. A member who is `'not_connected'` or
 * `'unknown'` has no personal channel and receives no DM, so every control on the card would
 * be inert — `DiscordConnectSection`'s job is inviting those members to connect, not this
 * one's.
 */
function EventPreferencesSection({
  teams,
  prefs,
  onRefresh,
}: {
  readonly teams: ReadonlyArray<Auth.UserTeam>;
  readonly prefs: Record<string, TeamApi.MemberEventPreferences | null>;
  readonly onRefresh: () => void;
}) {
  const connectedTeams = teams.filter((team) => team.discordJoined === 'connected');
  const [selectedTeamId, setSelectedTeamId] = React.useState<string | undefined>(undefined);

  if (connectedTeams.length === 0) return null;

  // One card at a time, with a team switcher above it — rendering N identical-looking cards
  // gave a member of several teams no way to tell which card belonged to which team, since
  // the card names the feature and never the team.
  const selected =
    connectedTeams.find((team) => team.teamId === selectedTeamId) ?? connectedTeams[0];
  const selectedPrefs = prefs[selected.teamId] ?? null;

  return (
    <>
      {connectedTeams.length > 1 && (
        <div className='w-full max-w-md mt-4'>
          <span id='event-prefs-team-switcher-label' className='text-sm font-medium block mb-2'>
            {tr('eventPrefs_teamSwitcher')}
          </span>
          <ToggleGroup
            type='single'
            variant='outline'
            aria-labelledby='event-prefs-team-switcher-label'
            value={selected.teamId}
            // Radix fires '' when the active item is re-clicked; keep the current team
            // rather than letting the section fall back to the first one.
            onValueChange={(next) => next && setSelectedTeamId(next)}
            className='flex-wrap justify-start'
          >
            {connectedTeams.map((team) => (
              <ToggleGroupItem key={team.teamId} value={team.teamId}>
                {team.teamName}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}

      {/* `key` is load-bearing: `useCardForm` seeds its state ONCE, so without a remount the
          card would carry the previous team's edits over onto the newly selected team's
          baseline — dirty, with Save armed to write one team's settings onto another. The
          same reason the load-failure state is a separate component below. */}
      {selectedPrefs ? (
        <EventPreferencesCard
          key={selected.teamId}
          teamId={selected.teamId}
          prefs={selectedPrefs}
          onRefresh={onRefresh}
        />
      ) : (
        <EventPreferencesLoadFailed key={selected.teamId} onRefresh={onRefresh} />
      )}
    </>
  );
}

interface MyProfilePageProps {
  user: Auth.CurrentUser;
  teams: ReadonlyArray<Auth.UserTeam>;
  onUpdated: () => void;
  prefs: Record<string, TeamApi.MemberEventPreferences | null>;
  onRefresh: () => void;
}

export function MyProfilePage({ user, teams, onUpdated, prefs, onRefresh }: MyProfilePageProps) {
  const router = useRouter();

  const initials = user.displayName.slice(0, 2).toUpperCase();

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4'>
        <Button
          variant='ghost'
          size='icon'
          aria-label={tr('guild_back')}
          onClick={() => router.history.back()}
        >
          <ArrowLeft className='size-5' />
        </Button>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-md'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <Avatar className='size-12'>
                {Option.isSome(user.avatar) && (
                  <AvatarImage
                    src={discordAvatarUrl(user.discordId, user.avatar.value)}
                    alt={tr('profile_discordAvatar')}
                  />
                )}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </div>
            <CardTitle>{tr('profile_title')}</CardTitle>
            <CardDescription>@{user.username}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileEditForm user={user} onSuccess={onUpdated} />
          </CardContent>
        </Card>
        <DiscordConnectSection teams={teams} />
        <EventPreferencesSection teams={teams} prefs={prefs} onRefresh={onRefresh} />
        <TelemetryPreferenceCard />
        <DataExportCard />
      </main>
    </div>
  );
}
