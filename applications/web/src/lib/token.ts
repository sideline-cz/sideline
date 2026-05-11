import { BrowserKeyValueStore } from '@effect/platform-browser';
import { Effect, Option } from 'effect';
import { KeyValueStore } from 'effect/unstable/persistence';

const TOKEN = 'api-token';
const PENDING_INVITE = 'pending-invite';
const LAST_TEAM = 'last-team-id';
const PENDING_DISCORD_JOIN = 'pending-discord-join';

const kvLayer = BrowserKeyValueStore.layerLocalStorage;

const get = (key: string) =>
  KeyValueStore.KeyValueStore.asEffect().pipe(
    Effect.flatMap((store) => store.get(key)),
    Effect.map(Option.fromUndefinedOr),
    Effect.provide(kvLayer),
    Effect.tapError((e) => Effect.logDebug(`Failed to read browser storage key "${key}"`, e)),
    Effect.catchTag('KeyValueStoreError', () => Effect.succeed(Option.none<string>())),
  );

const set = (key: string, value: string) =>
  KeyValueStore.KeyValueStore.asEffect().pipe(
    Effect.flatMap((store) => store.set(key, value)),
    Effect.provide(kvLayer),
    Effect.tapError((e) => Effect.logWarning(`Failed to set browser storage key "${key}"`, e)),
    Effect.catchTag('KeyValueStoreError', () => Effect.void),
  );

const remove = (key: string) =>
  KeyValueStore.KeyValueStore.asEffect().pipe(
    Effect.flatMap((store) => store.remove(key)),
    Effect.provide(kvLayer),
    Effect.tapError((e) => Effect.logWarning(`Failed to remove browser storage key "${key}"`, e)),
    Effect.catchTag('KeyValueStoreError', () => Effect.void),
  );

export const finishLogin = (token: string) => set(TOKEN, token);

export const getToken = get(TOKEN);

export const logout = Effect.all([remove(TOKEN), remove(LAST_TEAM)]).pipe(Effect.asVoid);

export const setPendingInvite = (code: string) => set(PENDING_INVITE, code);

export const getPendingInvite = get(PENDING_INVITE);

export const clearPendingInvite = remove(PENDING_INVITE);

export const getLastTeamId = get(LAST_TEAM);

export const setLastTeamId = (teamId: string) => set(LAST_TEAM, teamId);

export interface PendingDiscordJoin {
  readonly acceptanceId: string;
  readonly teamId: string;
  readonly ts: number;
}

export const setPendingDiscordJoin = (entry: PendingDiscordJoin) =>
  set(PENDING_DISCORD_JOIN, JSON.stringify(entry));

export const getPendingDiscordJoin = get(PENDING_DISCORD_JOIN).pipe(
  Effect.map(
    Option.flatMap((raw) => {
      try {
        const parsed = JSON.parse(raw) as PendingDiscordJoin;
        if (
          typeof parsed.acceptanceId === 'string' &&
          typeof parsed.teamId === 'string' &&
          typeof parsed.ts === 'number'
        ) {
          return Option.some(parsed);
        }
        return Option.none<PendingDiscordJoin>();
      } catch {
        return Option.none<PendingDiscordJoin>();
      }
    }),
  ),
);

export const clearPendingDiscordJoin = remove(PENDING_DISCORD_JOIN);
