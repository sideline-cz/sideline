// The "Create Discord channel" paths on the event's Attendance Roster card. Both reuse the
// existing `roster.createChannel` endpoint; channel state comes from the `rosters` prop.

import type { EventRosterApi, Roster } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Effect as EffectType, Option as OptionType } from 'effect';
import { Effect, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${Object.values(params).join(',')}` : key,
  setTranslationOverrides: vi.fn(),
}));

const { createAndLinkSpy, createChannelSpy, patchSpy } = vi.hoisted(() => ({
  createAndLinkSpy: vi.fn(),
  createChannelSpy: vi.fn(),
  patchSpy: vi.fn(),
}));

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect, Option: RealOption } = await import('effect');
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          eventRoster: {
            createAndLinkRoster: (args: unknown) => createAndLinkSpy(args),
            patchEventRosterLink: (args: unknown) => patchSpy(args),
          },
          roster: { createChannel: (args: unknown) => createChannelSpy(args) },
        }),
    },
    ClientError: { make: (message: string) => ({ _tag: 'ClientError' as const, message }) },
    useRun:
      () =>
      () =>
      (effect: EffectType.Effect<unknown, unknown>): Promise<OptionType.Option<unknown>> =>
        RealEffect.runPromise(
          effect.pipe(
            RealEffect.map(RealOption.some),
            RealEffect.catch(() => RealEffect.succeed(RealOption.none())),
          ),
        ),
  };
});

const { EventAttendanceRosterSection } = await import('./EventAttendanceRosterSection.js');

const TEAM_ID = '00000000-0000-0000-0000-000000000001';
const EVENT_ID = '00000000-0000-0000-0000-000000000002';
const ROSTER_ID = '00000000-0000-0000-0000-000000000003';

const link = {
  eventRosterId: 'er-1',
  eventId: EVENT_ID,
  rosterId: ROSTER_ID,
  rosterName: 'Nationals',
  autoApprove: false,
  rsvpAnswers: ['yes', 'coming_later'],
  hasOwnerGroup: true,
  memberCount: 0,
  backfillAdded: Option.none(),
  backfillCancelled: Option.none(),
} as unknown as EventRosterApi.EventRosterLink;

const rosterInfo = (overrides: Partial<Roster.RosterInfo> = {}) =>
  ({
    rosterId: ROSTER_ID,
    name: 'Nationals',
    active: true,
    emoji: Option.none(),
    discordChannelId: Option.none(),
    discordChannelName: Option.none(),
    discordChannelProvisioning: false,
    ...overrides,
  }) as unknown as Roster.RosterInfo;

const onRefresh = vi.fn();

const renderSection = (
  rosters: ReadonlyArray<Roster.RosterInfo>,
  initial: Option.Option<EventRosterApi.EventRosterLink>,
) =>
  render(
    <EventAttendanceRosterSection
      teamId={TEAM_ID}
      eventId={EVENT_ID}
      rosters={rosters}
      initialEventRosterLink={initial}
      onRefresh={onRefresh}
    />,
  );

beforeEach(() => {
  createAndLinkSpy.mockReset().mockReturnValue(Effect.succeed(link));
  createChannelSpy.mockReset().mockReturnValue(Effect.void);
  patchSpy.mockReset().mockReturnValue(Effect.succeed(link));
  onRefresh.mockReset();
});

const createRoster = (withChannel: boolean) => {
  renderSection([], Option.none());
  fireEvent.click(screen.getByText('eventRoster_createNew'));
  fireEvent.change(screen.getByLabelText('eventRoster_createRosterName'), {
    target: { value: 'Nationals' },
  });
  if (withChannel) fireEvent.click(screen.getByLabelText('eventRoster_alsoCreateDiscordChannel'));
  fireEvent.click(screen.getByText('eventRoster_create'));
};

describe('EventAttendanceRosterSection — Discord channel', () => {
  it('creates the channel for the new roster when the option is on', async () => {
    createRoster(true);
    await waitFor(() => expect(createChannelSpy).toHaveBeenCalledTimes(1));
    expect(createChannelSpy.mock.calls[0]?.[0]).toEqual({
      params: { teamId: TEAM_ID, rosterId: ROSTER_ID },
    });
    expect(createAndLinkSpy).toHaveBeenCalledTimes(1);
  });

  it('does not create a channel when the option is off', async () => {
    createRoster(false);
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(createChannelSpy).not.toHaveBeenCalled();
  });

  it('offers channel creation on a linked roster without a channel', async () => {
    renderSection([rosterInfo()], Option.some(link));
    fireEvent.click(screen.getByText('eventRoster_createDiscordChannel'));
    await waitFor(() => expect(createChannelSpy).toHaveBeenCalledTimes(1));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('shows the linked channel instead of the button', () => {
    renderSection(
      [
        rosterInfo({
          discordChannelId: Option.some('123') as Roster.RosterInfo['discordChannelId'],
          discordChannelName: Option.some('nationals'),
        }),
      ],
      Option.some(link),
    );
    expect(screen.getByText('eventRoster_discordChannel:nationals')).toBeTruthy();
    expect(screen.queryByText('eventRoster_createDiscordChannel')).toBeNull();
  });

  it('shows provisioning instead of the button', () => {
    renderSection([rosterInfo({ discordChannelProvisioning: true })], Option.some(link));
    expect(screen.getByText('discord_channelProvisioning')).toBeTruthy();
    expect(screen.queryByText('eventRoster_createDiscordChannel')).toBeNull();
  });
});

describe('EventAttendanceRosterSection — RSVP answers', () => {
  it('creates the roster with the default answers (yes + coming later)', async () => {
    createRoster(false);
    await waitFor(() => expect(createAndLinkSpy).toHaveBeenCalledTimes(1));
    expect(createAndLinkSpy.mock.calls[0]?.[0].payload.rsvpAnswers).toEqual([
      'yes',
      'coming_later',
    ]);
  });

  it('patches the linked roster with the new answer set, keeping auto-approve', async () => {
    renderSection([rosterInfo()], Option.some(link));
    fireEvent.click(screen.getByLabelText('rsvp_maybe'));
    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0]?.[0].payload).toEqual({
      autoApprove: false,
      rsvpAnswers: ['yes', 'coming_later', 'maybe'],
    });
  });

  it('never lets the last answer be unticked', () => {
    renderSection(
      [rosterInfo()],
      Option.some({ ...link, rsvpAnswers: ['yes'] } as unknown as EventRosterApi.EventRosterLink),
    );
    expect((screen.getByLabelText('rsvp_yes') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('rsvp_maybe') as HTMLButtonElement).disabled).toBe(false);
  });
});
