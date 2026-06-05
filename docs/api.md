# API Documentation

Sideline exposes a JSON REST API built with [`@effect/platform`](https://github.com/Effect-TS/effect/tree/main/packages/platform) `HttpApi`. Each endpoint is declared with fully typed request schemas, response schemas, error schemas, and middleware, making the source of truth the domain package at `packages/domain/src/api/`.

---

## Table of Contents

1. [General Information](#general-information)
2. [Authentication Flow](#authentication-flow)
3. [API Groups](#api-groups)
   - [Auth](#1-auth)
   - [Team](#2-team)
   - [Team Settings](#3-team-settings)
   - [Dashboard](#4-dashboard)
   - [Roster](#5-roster)
   - [Role](#6-role)
   - [Group](#7-group)
   - [Event](#8-event)
   - [Event RSVP](#9-event-rsvp)
   - [Event Series](#10-event-series)
   - [Training Type](#11-training-type)
   - [Age Threshold](#12-age-threshold)
   - [Activity Log](#13-activity-log)
   - [Activity Type](#14-activity-type)
   - [Activity Stats](#15-activity-stats)
   - [Leaderboard](#16-leaderboard)
   - [Invite](#17-invite)
   - [Notification](#18-notification)
   - [iCal](#19-ical)
   - [Achievement](#20-achievement)
   - [Weekly Summary](#21-weekly-summary)
   - [Translations](#22-translations)
   - [Finance](#23-finance)
   - [Version](#24-version)
   - [Expenses](#25-expenses)
   - [Team Onboarding](#26-team-onboarding)
   - [Weekly Challenge](#27-weekly-challenge)
   - [Dashboard Layout](#28-dashboard-layout)
   - [Channel](#29-channel)
4. [RPC API](#rpc-api)
5. [Error Reference](#error-reference)

---

## General Information

| Property | Value |
|---|---|
| Base path | Configurable via `API_PREFIX` env var (default: `/api` in production) |
| Content-Type | `application/json` for all request and response bodies |
| Authentication | Bearer token in `Authorization: Bearer <token>` header |
| Error format | JSON object with a `_tag` field identifying the error type |
| Nullable fields | Fields that may be absent are sent as `null` in JSON (mapped to `Option` in the type system) |
| ID types | All IDs are branded strings (UUIDs) unless specified otherwise |
| DateTime format | ISO 8601 strings (e.g. `2024-06-15T14:30:00.000Z`) |

### HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | Success with response body |
| 201 | Resource created |
| 204 | Success with no body |
| 302 | Redirect |
| 400 | Bad request / validation error / business rule violation |
| 401 | Unauthenticated |
| 403 | Authenticated but forbidden |
| 404 | Resource not found |
| 409 | Conflict (duplicate, resource in use, etc.) |
| 410 | Gone (resource expired or permanently revoked) |

---

## Authentication Flow

Authentication uses Discord OAuth 2.0. The typical flow is:

1. Call `GET /auth/login/url` to obtain the Discord authorization URL.
2. Redirect the user to that URL.
3. Discord redirects back to `GET /auth/callback?code=...&state=...`.
4. The server exchanges the code for tokens, creates or updates the user record, and issues a session cookie.
5. All subsequent authenticated requests use the session cookie or a `Authorization: Bearer <token>` header.

---

## API Groups

### 1. Auth

**Source:** `packages/domain/src/api/Auth.ts`
**Prefix:** `/auth`

The auth group handles Discord OAuth, user profile management, and team creation. Most endpoints require `AuthMiddleware` (Bearer token), except the three OAuth flow endpoints.

---

#### `GET /auth/login/url`

Returns the Discord OAuth authorization URL to redirect the user to.

**Auth:** None

**Response:** `200 OK`
```
string (URL)
```

---

#### `GET /auth/login`

Initiates the OAuth flow by redirecting the browser to Discord.

**Auth:** None

**Response:** `302 Redirect` — redirects to Discord OAuth page

---

#### `GET /auth/callback`

OAuth callback endpoint. Discord redirects here with the authorization code.

**Auth:** None

**Query Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | No | Authorization code from Discord |
| `state` | `string` | No | CSRF state token |
| `error` | `string` | No | Error code from Discord if authorization was denied |

**Response:** `302 Redirect` — redirects to the frontend application after handling the code exchange

---

#### `GET /auth/me`

Returns the currently authenticated user's profile.

**Auth:** Bearer token (AuthMiddleware)

**Response:** `200 OK` — `CurrentUser`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `UserId` (string) | No | Internal user ID |
| `discordId` | `string` | No | Discord user snowflake |
| `username` | `string` | No | Discord username |
| `avatar` | `string \| null` | Yes | Discord avatar hash |
| `isProfileComplete` | `boolean` | No | Whether the user has completed their profile |
| `name` | `string \| null` | Yes | Display name from profile |
| `birthDate` | `string \| null` | Yes | Birth date (ISO 8601 date string) |
| `gender` | `"male" \| "female" \| "other" \| null` | Yes | Gender |
| `locale` | `"en" \| "cs"` | No | Preferred locale |
| `isGlobalAdmin` | `boolean` | No | Whether the user is a global admin (Discord ID listed in `APP_GLOBAL_ADMIN_DISCORD_IDS`). Global admins can manage translation overrides. |
| `displayName` | `string` | No | Server-resolved display name. Precedence: profile name → Discord nickname → Discord display name → Discord username. Always non-empty. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `POST /auth/profile`

Completes a user's profile for the first time. Required after first login before joining teams.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:** `CompleteProfileRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | Non-empty | Display name |
| `birthDate` | `string` | Yes | Valid date after 1900-01-01; user must be at least 6 years old | Birth date (ISO 8601 date string) |
| `gender` | `"male" \| "female" \| "other"` | Yes | One of the enum values | Gender |

**Response:** `200 OK` — `CurrentUser` (see `GET /auth/me` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `PATCH /auth/me/locale`

Updates the authenticated user's preferred locale.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:** `UpdateLocaleRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `locale` | `"en" \| "cs"` | Yes | One of the enum values | New locale preference |

**Response:** `200 OK` — `CurrentUser` (see `GET /auth/me` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `PATCH /auth/me`

Updates the authenticated user's profile fields. All fields are optional; only provided fields are changed.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:** `UpdateProfileRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string \| null` | No | — | Display name (null clears the field) |
| `birthDate` | `string \| null` | No | Valid date after 1900-01-01; user must be at least 6 years old | Birth date (null clears the field) |
| `gender` | `"male" \| "female" \| "other" \| null` | No | — | Gender (null clears the field) |

**Response:** `200 OK` — `CurrentUser` (see `GET /auth/me` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `GET /auth/me/teams`

Lists all teams the authenticated user is a member of, including their roles and permissions in each team.

**Auth:** Bearer token (AuthMiddleware)

**Response:** `200 OK` — `UserTeam[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamId` | `TeamId` (string) | No | Team ID |
| `teamName` | `string` | No | Team display name |
| `roleNames` | `string[]` | No | Names of roles assigned to the user in this team |
| `permissions` | `Permission[]` | No | Aggregated permissions from all assigned roles |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `GET /auth/me/guilds`

Lists all Discord guilds where the authenticated user is a member, with information about whether the Sideline bot is present.

**Auth:** Bearer token (AuthMiddleware)

**Response:** `200 OK` — `DiscordGuild[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `Snowflake` (string) | No | Discord guild (server) ID |
| `name` | `string` | No | Guild name |
| `icon` | `string \| null` | Yes | Guild icon hash |
| `owner` | `boolean` | No | Whether the user is the guild owner |
| `botPresent` | `boolean` | No | Whether the Sideline bot is in this guild |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

#### `POST /auth/me/teams`

Creates a new team linked to a Discord guild.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:** `CreateTeamRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | 1–100 characters | Team name |
| `guildId` | `Snowflake` (string) | Yes | Valid Discord snowflake | Discord guild to link the team to |

**Response:** `200 OK` — `UserTeam` (see `GET /auth/me/teams` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |

---

### 2. Team

**Source:** `packages/domain/src/api/TeamApi.ts`

Manages team profile information.

---

#### `GET /teams/:teamId`

Returns the team's public profile information.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `TeamInfo`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Team name |
| `description` | `string \| null` | Yes | Team description |
| `sport` | `string \| null` | Yes | Sport or activity type |
| `logoUrl` | `string \| null` | Yes | URL to team logo |
| `guildId` | `Snowflake` | No | Linked Discord guild ID |
| `welcomeChannelId` | `Snowflake \| null` | Yes | Discord channel where the bot posts welcome embeds for new members |
| `achievementChannelId` | `Snowflake \| null` | Yes | Discord channel where the bot posts achievement congratulatory embeds; null means notifications are disabled |
| `systemLogChannelId` | `Snowflake \| null` | Yes | Private Discord channel where the bot logs every member join |
| `welcomeMessageTemplate` | `string \| null` | Yes | Template string for the welcome embed description (max 500 characters; supports `{memberMention}`, `{memberName}`, `{inviterMention}`, `{inviterName}`, `{groupName}`, `{teamName}`) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |

---

#### `PATCH /teams/:teamId`

Updates the team's profile information. All fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `UpdateTeamRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | No | 1–100 characters | New team name |
| `description` | `string \| null` | No | Max 500 characters; null clears the field | Team description |
| `sport` | `string \| null` | No | Max 50 characters; null clears the field | Sport or activity type |
| `logoUrl` | `string \| null` | No | Max 2048 characters; null clears the field | URL to team logo |
| `welcomeChannelId` | `Snowflake \| null` | No | null clears the field | Discord channel for welcome embeds |
| `achievementChannelId` | `Snowflake \| null` | No | null disables achievement notifications | Discord channel for achievement congratulatory embeds |
| `systemLogChannelId` | `Snowflake \| null` | No | null clears the field | Private Discord channel for join logs |
| `welcomeMessageTemplate` | `string \| null` | No | Max 500 characters; null clears the field | Template for welcome embed description |

**Response:** `200 OK` — `TeamInfo` (see `GET /teams/:teamId` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `team:manage` permission |

---

### 3. Team Settings

**Source:** `packages/domain/src/api/TeamSettingsApi.ts`

Manages operational settings for a team, including event horizon, RSVP reminders, and Discord channel routing.

---

#### `GET /teams/:teamId/settings`

Returns the team's current settings.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `TeamSettingsInfo`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamId` | `TeamId` | No | Team ID |
| `eventHorizonDays` | `integer` | No | How many days ahead to generate events from active series |
| `minPlayersThreshold` | `integer` | No | Minimum players for an event to show a warning |
| `rsvpReminderHours` | `integer` | No | Hours before an event when the RSVP reminder is sent |
| `discordChannelTraining` | `Snowflake \| null` | Yes | Default Discord channel for training events |
| `discordChannelMatch` | `Snowflake \| null` | Yes | Default Discord channel for match events |
| `discordChannelTournament` | `Snowflake \| null` | Yes | Default Discord channel for tournament events |
| `discordChannelMeeting` | `Snowflake \| null` | Yes | Default Discord channel for meeting events |
| `discordChannelSocial` | `Snowflake \| null` | Yes | Default Discord channel for social events |
| `discordChannelOther` | `Snowflake \| null` | Yes | Default Discord channel for other events |
| `discordChannelLateRsvp` | `Snowflake \| null` | Yes | Discord channel where late-RSVP notifications are posted |
| `createDiscordChannelOnGroup` | `boolean` | No | Auto-create Discord channel when a group is created |
| `createDiscordChannelOnRoster` | `boolean` | No | Auto-create Discord channel when a roster is created |
| `discordArchiveCategoryId` | `Snowflake \| null` | Yes | Discord category channel used when cleanup mode is `archive` |
| `discordChannelCleanupOnGroupDelete` | `'nothing' \| 'delete' \| 'archive'` | No | What to do with the Discord channel when a group is deleted: keep it (`nothing`), delete it (`delete`), or move it to the archive category (`archive`) |
| `discordChannelCleanupOnRosterDeactivate` | `'nothing' \| 'delete' \| 'archive'` | No | What to do with the Discord channel when a roster is deactivated: keep it (`nothing`), delete it (`delete`), or move it to the archive category (`archive`) |
| `discordRoleFormat` | `string` | No | Template string for Discord role names (must contain `{name}`; may contain `{emoji}`) |
| `discordChannelFormat` | `string` | No | Template string for Discord channel names (must contain `{name}`; may contain `{emoji}`) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |

---

#### `PATCH /teams/:teamId/settings`

Updates the team's settings. `eventHorizonDays` is required; all other fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `UpdateTeamSettingsRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `eventHorizonDays` | `integer` | Yes | 1–365 | Days ahead to generate scheduled events |
| `minPlayersThreshold` | `integer` | No | 0–100 | Minimum player threshold |
| `rsvpReminderHours` | `integer` | No | 0–168 | Hours before event for RSVP reminder |
| `discordChannelTraining` | `Snowflake \| null` | No | — | Channel for training events |
| `discordChannelMatch` | `Snowflake \| null` | No | — | Channel for match events |
| `discordChannelTournament` | `Snowflake \| null` | No | — | Channel for tournament events |
| `discordChannelMeeting` | `Snowflake \| null` | No | — | Channel for meeting events |
| `discordChannelSocial` | `Snowflake \| null` | No | — | Channel for social events |
| `discordChannelOther` | `Snowflake \| null` | No | — | Channel for other events |
| `discordChannelLateRsvp` | `Snowflake \| null` | No | — | Channel for late-RSVP notifications |
| `discordArchiveCategoryId` | `Snowflake \| null` | No | — | Discord category used when cleanup mode is `archive` |
| `discordChannelCleanupOnGroupDelete` | `'nothing' \| 'delete' \| 'archive'` | No | — | Cleanup mode applied when a group is deleted |
| `discordChannelCleanupOnRosterDeactivate` | `'nothing' \| 'delete' \| 'archive'` | No | — | Cleanup mode applied when a roster is deactivated |
| `discordRoleFormat` | `string` | No | Must contain `{name}` | Template string for Discord role names |
| `discordChannelFormat` | `string` | No | Must contain `{name}` | Template string for Discord channel names |

**Response:** `200 OK` — `TeamSettingsInfo` (see `GET /teams/:teamId/settings` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `team:manage` permission |

---

### 4. Dashboard

**Source:** `packages/domain/src/api/DashboardApi.ts`

---

#### `GET /teams/:teamId/dashboard`

Returns a summary view for the authenticated user within a team: upcoming events, events awaiting their RSVP, and their activity stats.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `DashboardResponse`

| Field | Type | Description |
|---|---|---|
| `upcomingEvents` | `DashboardUpcomingEvent[]` | Next upcoming events for the team |
| `awaitingRsvp` | `DashboardUpcomingEvent[]` | Events the user has not responded to yet |
| `activitySummary` | `DashboardActivitySummary` | Activity stats for the user |
| `myMemberId` | `TeamMemberId` | The user's team member ID in this team |

`DashboardUpcomingEvent`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `eventId` | `EventId` | No | Event ID |
| `title` | `string` | No | Event title |
| `eventType` | `EventType` | No | Type of event |
| `startAt` | `string` (ISO 8601) | No | Start date/time |
| `endAt` | `string \| null` | Yes | End date/time |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | Yes | Optional location URL (public `https://`, max 2048 chars) |
| `myRsvp` | `"yes" \| "no" \| "maybe" \| null` | Yes | User's current RSVP response |

`DashboardActivitySummary`:

| Field | Type | Description |
|---|---|---|
| `currentStreak` | `integer` | Current consecutive-day activity streak |
| `longestStreak` | `integer` | Longest streak ever achieved |
| `totalActivities` | `integer` | Total number of activity log entries |
| `totalDurationMinutes` | `integer` | Total time logged across all activities |
| `leaderboardRank` | `integer \| null` | Current rank on the team leaderboard |
| `leaderboardTotal` | `integer` | Total number of members on the leaderboard |
| `recentActivityCount` | `integer` | Activity count in a recent window |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `DashboardForbidden` | 403 | Not a member of this team |

---

### 5. Roster

**Source:** `packages/domain/src/api/Roster.ts`

Manages team members (players) and named roster lists.

#### Member Sub-group

---

#### `GET /teams/:teamId/members`

Lists all active members of a team with their profile and role information.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:view` or `member:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `RosterPlayer[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `memberId` | `TeamMemberId` | No | Team member ID |
| `userId` | `UserId` | No | User ID |
| `discordId` | `string` | No | Discord user snowflake |
| `roleNames` | `string[]` | No | Assigned role names |
| `permissions` | `Permission[]` | No | Aggregated permissions |
| `name` | `string \| null` | Yes | Display name |
| `birthDate` | `string \| null` | Yes | Birth date |
| `gender` | `"male" \| "female" \| "other" \| null` | Yes | Gender |
| `jerseyNumber` | `number \| null` | Yes | Jersey number |
| `username` | `string` | No | Discord username |
| `avatar` | `string \| null` | Yes | Discord avatar hash |
| `displayName` | `string` | No | Server-resolved display name. Precedence: profile name → Discord nickname → Discord display name → Discord username. Always non-empty. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing required permission |

---

#### `GET /teams/:teamId/members/:memberId`

Returns a single member's details.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:view` or `member:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — `RosterPlayer` (see `GET /teams/:teamId/members` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing required permission |
| `PlayerNotFound` | 404 | Member does not exist in this team |

---

#### `PATCH /teams/:teamId/members/:memberId`

Updates a member's profile fields. All fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `member:edit`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Request Body:** `UpdatePlayerRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string \| null` | No | Display name (null clears) |
| `birthDate` | `string \| null` | No | Birth date ISO string (null clears) |
| `gender` | `"male" \| "female" \| "other" \| null` | No | Gender (null clears) |
| `jerseyNumber` | `number \| null` | No | Jersey number (null clears) |

**Response:** `200 OK` — `RosterPlayer`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `member:edit` permission |
| `PlayerNotFound` | 404 | Member does not exist |

---

#### `DELETE /teams/:teamId/members/:memberId`

Deactivates a team member (removes them from active roster).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `member:remove`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `member:remove` permission |
| `PlayerNotFound` | 404 | Member does not exist |

---

#### Roster Sub-group

---

#### `GET /teams/:teamId/rosters`

Lists all rosters for a team with member counts.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `RosterListResponse`

| Field | Type | Description |
|---|---|---|
| `canManage` | `boolean` | Whether the authenticated user can manage rosters |
| `rosters` | `RosterInfo[]` | List of rosters |

`RosterInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `rosterId` | `RosterId` | No | Roster ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Roster name |
| `active` | `boolean` | No | Whether the roster is active |
| `memberCount` | `number` | No | Number of members on this roster |
| `createdAt` | `string` | No | Creation timestamp |
| `color` | `string \| null` | Yes | Hex colour string (e.g. `#3498db`), used for Discord role colour |
| `emoji` | `string \| null` | Yes | Optional emoji for display |
| `discordChannelId` | `string` | Yes | Linked Discord channel ID |
| `discordChannelName` | `string` | Yes | Resolved Discord channel name |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:view` permission |

---

#### `POST /teams/:teamId/rosters`

Creates a new roster.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateRosterRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Roster name |
| `color` | `string \| null` | Yes | Hex colour string (null for none) |
| `emoji` | `string \| null` | Yes | Optional emoji (null for none) |

**Response:** `201 Created` — `RosterInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:manage` permission |

---

#### `GET /teams/:teamId/rosters/:rosterId`

Returns full roster details including the member list.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `rosterId` | `RosterId` (string) | Roster ID |

**Response:** `200 OK` — `RosterDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `rosterId` | `RosterId` | No | Roster ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Roster name |
| `active` | `boolean` | No | Whether the roster is active |
| `createdAt` | `string` | No | Creation timestamp |
| `color` | `string \| null` | Yes | Hex colour string (e.g. `#3498db`) |
| `emoji` | `string \| null` | Yes | Optional emoji for display |
| `members` | `RosterPlayer[]` | No | Members on this roster |
| `canManage` | `boolean` | No | Whether the user can manage this roster |
| `discordChannelId` | `string` | Yes | Linked Discord channel ID |
| `discordChannelName` | `string` | Yes | Resolved Discord channel name |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:view` permission |
| `RosterNotFound` | 404 | Roster does not exist |

---

#### `PATCH /teams/:teamId/rosters/:rosterId`

Updates a roster's name, active status, or linked Discord channel.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `rosterId` | `RosterId` (string) | Roster ID |

**Request Body:** `UpdateRosterRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string \| null` | No | New name (null keeps current) |
| `active` | `boolean \| null` | No | Active status (null keeps current) |
| `color` | `string \| null` | No | Hex colour string (null clears) |
| `emoji` | `string \| null` | No | Emoji (null clears) |
| `discordChannelId` | `string \| null` | No | Discord channel ID (null clears, omit to keep current) |

**Response:** `200 OK` — `RosterInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:manage` permission |
| `RosterNotFound` | 404 | Roster does not exist |

---

#### `DELETE /teams/:teamId/rosters/:rosterId`

Deletes a roster.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `rosterId` | `RosterId` (string) | Roster ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:manage` permission |
| `RosterNotFound` | 404 | Roster does not exist |

---

#### `POST /teams/:teamId/rosters/:rosterId/members`

Adds a team member to a roster.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `rosterId` | `RosterId` (string) | Roster ID |

**Request Body:** `AddRosterMemberRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `memberId` | `TeamMemberId` | Yes | Team member ID to add |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:manage` permission |
| `RosterNotFound` | 404 | Roster does not exist |
| `PlayerNotFound` | 404 | Member does not exist in this team |

---

#### `DELETE /teams/:teamId/rosters/:rosterId/members/:memberId`

Removes a member from a roster.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `roster:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `rosterId` | `RosterId` (string) | Roster ID |
| `memberId` | `TeamMemberId` (string) | Member ID to remove |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `roster:manage` permission |
| `RosterNotFound` | 404 | Roster does not exist |
| `PlayerNotFound` | 404 | Member does not exist |

---

### 6. Role

**Source:** `packages/domain/src/api/RoleApi.ts`

Manages roles and their permission assignments. Roles control what members can do within a team.

#### Permission Reference

| Permission | Description |
|---|---|
| `team:manage` | Edit team profile and settings |
| `team:invite` | Manage invite links |
| `roster:view` | View rosters and roster members |
| `roster:manage` | Create, edit, and delete rosters; add/remove roster members |
| `member:view` | View member profiles |
| `member:edit` | Edit member profiles |
| `member:remove` | Deactivate members |
| `role:view` | View roles and their permissions |
| `role:manage` | Create, edit, and delete custom roles; assign/unassign roles |
| `activity-type:create` | Create team-specific activity types |
| `activity-type:delete` | Delete team-specific activity types |
| `training-type:create` | Create training types |
| `training-type:delete` | Delete training types |
| `event:create` | Create events |
| `event:edit` | Edit events |
| `event:cancel` | Cancel events |

#### Built-in Roles

Four roles are automatically created for every new team and cannot be deleted or renamed:

| Role | Default Permissions |
|---|---|
| **Admin** | All permissions |
| **Captain** | `roster:view`, `roster:manage`, `member:view`, `member:edit`, `role:view`, `activity-type:create`, `activity-type:delete`, `training-type:create`, `event:create`, `event:edit`, `event:cancel`, `group:manage`, `finance:view` |
| **Player** | `roster:view`, `member:view` |
| **Treasurer** | `finance:view`, `finance:manage_fees`, `finance:record_payments` |

---

#### `GET /teams/:teamId/roles`

Lists all roles for a team.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `RoleListResponse`

| Field | Type | Description |
|---|---|---|
| `canManage` | `boolean` | Whether the user can manage roles |
| `roles` | `RoleInfo[]` | List of roles |

`RoleInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `roleId` | `RoleId` | No | Role ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Role name |
| `isBuiltIn` | `boolean` | No | Whether this is a built-in role |
| `permissionCount` | `number` | No | Number of permissions granted |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:view` permission |

---

#### `POST /teams/:teamId/roles`

Creates a new custom role.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateRoleRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty role name (must be unique) |
| `permissions` | `Permission[]` | Yes | List of permissions to grant |

**Response:** `201 Created` — `RoleDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `roleId` | `RoleId` | No | Role ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Role name |
| `isBuiltIn` | `boolean` | No | Always `false` for custom roles |
| `permissions` | `Permission[]` | No | Granted permissions |
| `canManage` | `boolean` | No | Whether the user can manage this role |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:manage` permission |
| `RoleNameAlreadyTaken` | 409 | A role with this name already exists |

---

#### `GET /teams/:teamId/roles/:roleId`

Returns full details for a specific role.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `roleId` | `RoleId` (string) | Role ID |

**Response:** `200 OK` — `RoleDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:view` permission |
| `RoleNotFound` | 404 | Role does not exist |

---

#### `PATCH /teams/:teamId/roles/:roleId`

Updates a custom role's name and/or permissions. Cannot update built-in roles.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `roleId` | `RoleId` (string) | Role ID |

**Request Body:** `UpdateRoleRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string \| null` | No | New name (null keeps current) |
| `permissions` | `Permission[] \| null` | No | New permissions list (null keeps current) |

**Response:** `200 OK` — `RoleDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:manage` permission |
| `RoleNotFound` | 404 | Role does not exist |
| `CannotModifyBuiltIn` | 400 | Attempted to update a built-in role |
| `RoleNameAlreadyTaken` | 409 | Another role already has this name |

---

#### `DELETE /teams/:teamId/roles/:roleId`

Deletes a custom role. Cannot delete built-in roles or roles currently assigned to members.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `roleId` | `RoleId` (string) | Role ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:manage` permission |
| `RoleNotFound` | 404 | Role does not exist |
| `CannotModifyBuiltIn` | 400 | Attempted to delete a built-in role |
| `RoleInUse` | 409 | Role is currently assigned to one or more members |

---

#### `POST /teams/:teamId/members/:memberId/roles`

Assigns a role to a team member.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Request Body:** `AssignRoleRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `roleId` | `RoleId` | Yes | ID of the role to assign |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:manage` permission |
| `MemberNotFound` | 404 | Member does not exist |
| `RoleNotFound` | 404 | Role does not exist |

---

#### `DELETE /teams/:teamId/members/:memberId/roles/:roleId`

Unassigns a role from a team member.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `role:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |
| `roleId` | `RoleId` (string) | Role ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `RoleForbidden` | 403 | Missing `role:manage` permission |
| `MemberNotFound` | 404 | Member does not exist |
| `RoleNotFound` | 404 | Role does not exist |

---

### 7. Group

**Source:** `packages/domain/src/api/GroupApi.ts`

Groups are hierarchical sub-divisions of a team (e.g. age groups, squads). Groups can have roles assigned to them (members in the group inherit those roles) and can be linked to Discord channels.

---

#### `GET /teams/:teamId/groups`

Lists all groups for a team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `GroupInfo[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `groupId` | `GroupId` | No | Group ID |
| `teamId` | `TeamId` | No | Team ID |
| `parentId` | `GroupId \| null` | Yes | Parent group ID (for nested groups) |
| `name` | `string` | No | Group name |
| `emoji` | `string \| null` | Yes | Optional emoji for display |
| `color` | `string \| null` | Yes | Hex colour string (e.g. `#3498db`), used for Discord role colour |
| `memberCount` | `number` | No | Number of members in this group |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/groups`

Creates a new group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateGroupRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty group name (must be unique) |
| `parentId` | `GroupId \| null` | Yes | Parent group ID (null for top-level) |
| `emoji` | `string \| null` | Yes | Optional emoji (null for none) |
| `color` | `string \| null` | Yes | Hex colour string (null for none) |

**Response:** `201 Created` — `GroupInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNameAlreadyTaken` | 409 | A group with this name already exists |

---

#### `GET /teams/:teamId/groups/:groupId`

Returns full group details including members and assigned roles.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Response:** `200 OK` — `GroupDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `groupId` | `GroupId` | No | Group ID |
| `teamId` | `TeamId` | No | Team ID |
| `parentId` | `GroupId \| null` | Yes | Parent group ID |
| `name` | `string` | No | Group name |
| `emoji` | `string \| null` | Yes | Optional emoji |
| `color` | `string \| null` | Yes | Hex colour string (e.g. `#3498db`) |
| `roles` | `{ roleId: RoleId, roleName: string }[]` | No | Roles assigned to this group |
| `members` | `{ memberId: TeamMemberId, name: string \| null, username: string, displayName: string }[]` | No | Members in this group. `displayName` is server-resolved (profile name → Discord nickname → Discord display name → username). |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Not a member of this team |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `PATCH /teams/:teamId/groups/:groupId`

Updates a group's name, emoji, and/or colour.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** `UpdateGroupRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty group name |
| `emoji` | `string \| null` | Yes | Emoji (null clears) |
| `color` | `string \| null` | Yes | Hex colour string (null clears) |

**Response:** `200 OK` — `GroupInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |
| `GroupNameAlreadyTaken` | 409 | Another group already has this name |

---

#### `DELETE /teams/:teamId/groups/:groupId`

Deletes a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `POST /teams/:teamId/groups/:groupId/members`

Adds a team member to a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** `AddGroupMemberRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `memberId` | `TeamMemberId` | Yes | Member ID to add |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |
| `GroupMemberNotFound` | 404 | Member does not exist in this team |

---

#### `DELETE /teams/:teamId/groups/:groupId/members/:memberId`

Removes a member from a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |
| `GroupMemberNotFound` | 404 | Member is not in this group |

---

#### `POST /teams/:teamId/groups/:groupId/roles`

Assigns a role to a group. All group members will inherit this role's permissions.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** `AssignGroupRoleRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `roleId` | `RoleId` | Yes | Role ID to assign |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `DELETE /teams/:teamId/groups/:groupId/roles/:roleId`

Unassigns a role from a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |
| `roleId` | `RoleId` (string) | Role ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `PATCH /teams/:teamId/groups/:groupId/parent`

Moves a group to a different parent (or to the top level).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** `MoveGroupRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `parentId` | `GroupId \| null` | Yes | New parent group ID (null for top-level) |

**Response:** `200 OK` — `GroupInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `GET /teams/:teamId/groups/:groupId/channel-mapping`

Returns the Discord channel mapping for a group, if one exists.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Response:** `200 OK` — `ChannelMappingInfo | null`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `discordChannelId` | `Snowflake` | No | Linked Discord channel ID |
| `discordChannelName` | `string \| null` | Yes | Channel name (if available) |
| `discordRoleId` | `Snowflake \| null` | Yes | Associated Discord role ID (if any) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Not a member of this team |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `PUT /teams/:teamId/groups/:groupId/channel-mapping`

Sets (creates or replaces) the Discord channel mapping for a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** `SetChannelMappingRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `discordChannelId` | `Snowflake` | Yes | Discord channel ID to link |

**Response:** `200 OK` — `ChannelMappingInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `DELETE /teams/:teamId/groups/:groupId/channel-mapping`

Removes the Discord channel mapping from a group.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `POST /teams/:teamId/groups/:groupId/create-channel`

Instructs the bot to create a Discord channel for the group and establish the mapping.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `groupId` | `GroupId` (string) | Group ID |

**Request Body:** None

**Response:** `201 Created` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Missing `team:manage` permission |
| `GroupNotFound` | 404 | Group does not exist |

---

#### `GET /teams/:teamId/discord-channels`

Lists all known Discord channels for the team's linked guild.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `DiscordChannelInfo[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `Snowflake` | No | Discord channel ID |
| `name` | `string` | No | Channel name |
| `type` | `number` | No | Discord channel type integer |
| `parentId` | `Snowflake \| null` | Yes | Parent category channel ID |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `GroupForbidden` | 403 | Not a member of this team |

---

### 8. Event

**Source:** `packages/domain/src/api/EventApi.ts`

#### Enums

**EventType:** `"training"`, `"match"`, `"tournament"`, `"meeting"`, `"social"`, `"other"`

**EventStatus:** `"active"`, `"cancelled"`, `"started"`

---

#### `GET /teams/:teamId/events`

Lists all events for a team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `EventListResponse`

| Field | Type | Description |
|---|---|---|
| `canCreate` | `boolean` | Whether the user can create events |
| `events` | `EventInfo[]` | List of events |

`EventInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `eventId` | `EventId` | No | Event ID |
| `teamId` | `TeamId` | No | Team ID |
| `title` | `string` | No | Event title |
| `eventType` | `EventType` | No | Type of event |
| `trainingTypeName` | `string \| null` | Yes | Training type name (for training events) |
| `description` | `string \| null` | Yes | Description |
| `imageUrl` | `string \| null` | Yes | Cover image URL (must be `https://`, max 2048 chars, public host only) |
| `startAt` | `string` (ISO 8601) | No | Start date/time |
| `endAt` | `string \| null` | Yes | End date/time |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | Yes | Optional location URL (public `https://`, max 2048 chars) |
| `status` | `EventStatus` | No | `"active"`, `"cancelled"`, or `"started"` |
| `seriesId` | `EventSeriesId \| null` | Yes | Linked series ID (if part of a series) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/events`

Creates a new event.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:create`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateEventRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | Yes | Non-empty event title |
| `eventType` | `EventType` | Yes | Type of event |
| `trainingTypeId` | `TrainingTypeId \| null` | Yes | Training type (for training events; null otherwise) |
| `description` | `string \| null` | Yes | Optional description |
| `imageUrl` | `string \| null` | No | Optional cover image URL (must be `https://`, max 2048 chars, public host only) |
| `startAt` | `string` (ISO 8601) | Yes | Start date/time |
| `endAt` | `string \| null` | Yes | End date/time (null if open-ended) |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | No | Optional location URL (public `https://`, max 2048 chars); requires `location` to be non-empty |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel for the event embed |
| `ownerGroupId` | `GroupId \| null` | Yes | Group that owns/manages the event |
| `memberGroupId` | `GroupId \| null` | Yes | Group whose members are eligible to RSVP |

**Response:** `201 Created` — `EventInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:create` permission |

---

#### `GET /teams/:teamId/events/:eventId`

Returns full details for a specific event.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Response:** `200 OK` — `EventDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `eventId` | `EventId` | No | Event ID |
| `teamId` | `TeamId` | No | Team ID |
| `title` | `string` | No | Event title |
| `eventType` | `EventType` | No | Type of event |
| `trainingTypeId` | `TrainingTypeId \| null` | Yes | Training type ID |
| `trainingTypeName` | `string \| null` | Yes | Training type name |
| `description` | `string \| null` | Yes | Description |
| `imageUrl` | `string \| null` | Yes | Cover image URL (must be `https://`, max 2048 chars, public host only) |
| `startAt` | `string` (ISO 8601) | No | Start date/time |
| `endAt` | `string \| null` | Yes | End date/time |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | Yes | Optional location URL (public `https://`, max 2048 chars) |
| `status` | `EventStatus` | No | `"active"`, `"cancelled"`, or `"started"` |
| `createdByName` | `string \| null` | Yes | Name of the member who created the event |
| `canEdit` | `boolean` | No | Whether the user can edit this event |
| `canCancel` | `boolean` | No | Whether the user can cancel this event |
| `seriesId` | `EventSeriesId \| null` | Yes | Series ID if part of a series |
| `seriesModified` | `boolean` | No | Whether this event differs from the series template |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel ID |
| `ownerGroupId` | `GroupId \| null` | Yes | Owner group ID |
| `ownerGroupName` | `string \| null` | Yes | Owner group name |
| `memberGroupId` | `GroupId \| null` | Yes | Member group ID |
| `memberGroupName` | `string \| null` | Yes | Member group name |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |
| `EventNotFound` | 404 | Event does not exist |

---

#### `PATCH /teams/:teamId/events/:eventId`

Updates an event's fields. All fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:edit`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Request Body:** `UpdateEventRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | No | Non-empty event title |
| `eventType` | `EventType` | No | Type of event |
| `trainingTypeId` | `TrainingTypeId \| null` | No | Training type ID |
| `description` | `string \| null` | No | Description |
| `imageUrl` | `string \| null` | No | Cover image URL (must be `https://`, max 2048 chars, public host only) |
| `startAt` | `string` (ISO 8601) | No | Start date/time |
| `endAt` | `string \| null` | No | End date/time |
| `location` | `string \| null` | No | Location |
| `locationUrl` | `string \| null` | No | Optional location URL (public `https://`, max 2048 chars); requires `location` to be non-empty when setting a URL |
| `discordChannelId` | `Snowflake \| null` | No | Discord channel ID |
| `ownerGroupId` | `GroupId \| null` | No | Owner group ID |
| `memberGroupId` | `GroupId \| null` | No | Member group ID |

**Response:** `200 OK` — `EventDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:edit` permission |
| `EventNotFound` | 404 | Event does not exist |
| `EventCancelled` | 400 | Event is already cancelled |

---

#### `POST /teams/:teamId/events/:eventId/cancel`

Cancels an event. This action is irreversible.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:cancel`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Request Body:** None

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:cancel` permission |
| `EventNotFound` | 404 | Event does not exist |
| `EventCancelled` | 400 | Event is already cancelled |

---

### 9. Event RSVP

**Source:** `packages/domain/src/api/EventRsvpApi.ts`

#### Enums

**RsvpResponse:** `"yes"`, `"no"`, `"maybe"`

---

#### `GET /teams/:teamId/events/:eventId/rsvps`

Returns RSVP details for an event including all responses and counts.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Response:** `200 OK` — `EventRsvpDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `myResponse` | `RsvpResponse \| null` | Yes | The authenticated user's response |
| `myMessage` | `string \| null` | Yes | The authenticated user's message |
| `rsvps` | `RsvpEntry[]` | No | All RSVP entries |
| `yesCount` | `number` | No | Number of "yes" responses |
| `noCount` | `number` | No | Number of "no" responses |
| `maybeCount` | `number` | No | Number of "maybe" responses |
| `canRsvp` | `boolean` | No | Whether the user can submit/update their RSVP |
| `minPlayersThreshold` | `number` | No | Team's minimum players threshold |

`RsvpEntry`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamMemberId` | `TeamMemberId` | No | Member ID |
| `memberName` | `string \| null` | Yes | Display name |
| `username` | `string \| null` | Yes | Discord username |
| `response` | `RsvpResponse` | No | RSVP response |
| `message` | `string \| null` | Yes | Optional message |
| `displayName` | `string` | No | Server-resolved display name. Precedence: profile name → Discord nickname → Discord display name → Discord username. Always non-empty. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventRsvpForbidden` | 403 | Not a member of this team |
| `EventRsvpEventNotFound` | 404 | Event does not exist |

---

#### `PUT /teams/:teamId/events/:eventId/rsvp`

Submits or updates the authenticated user's RSVP for an event.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Request Body:** `SubmitRsvpRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `response` | `RsvpResponse` | Yes | `"yes"`, `"no"`, or `"maybe"` |
| `message` | `string \| null` | Yes | Optional message to accompany the RSVP |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventRsvpForbidden` | 403 | Not eligible to RSVP (not a group member or not a team member) |
| `EventRsvpEventNotFound` | 404 | Event does not exist |
| `RsvpDeadlinePassed` | 400 | The RSVP deadline has passed |

---

#### `GET /teams/:teamId/events/:eventId/rsvps/non-responders`

Returns the list of eligible members who have not yet submitted an RSVP.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `eventId` | `EventId` (string) | Event ID |

**Response:** `200 OK` — `NonRespondersResponse`

| Field | Type | Description |
|---|---|---|
| `nonResponders` | `NonResponderEntry[]` | Members who have not responded |

`NonResponderEntry`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamMemberId` | `TeamMemberId` | No | Member ID |
| `memberName` | `string \| null` | Yes | Display name |
| `username` | `string \| null` | Yes | Discord username |
| `displayName` | `string` | No | Server-resolved display name. Precedence: profile name → Discord nickname → Discord display name → Discord username. Always non-empty. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventRsvpForbidden` | 403 | Not a member of this team |
| `EventRsvpEventNotFound` | 404 | Event does not exist |

---

### 10. Event Series

**Source:** `packages/domain/src/api/EventSeriesApi.ts`

Event series define recurrence rules. The `EventHorizonCron` runs daily and generates individual events from active series up to the team's event horizon.

#### Enums

**RecurrenceFrequency:** `"weekly"`, `"biweekly"`

**EventSeriesStatus:** `"active"`, `"cancelled"`

**DaysOfWeek:** Array of integers 0–6 (0 = Sunday, 1 = Monday, ..., 6 = Saturday). Must contain at least 1 and at most 7 values.

---

#### `POST /teams/:teamId/event-series`

Creates a new recurring event series.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:create`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateEventSeriesRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | Yes | Non-empty series title |
| `trainingTypeId` | `TrainingTypeId \| null` | Yes | Training type (for training series) |
| `description` | `string \| null` | Yes | Optional description |
| `frequency` | `RecurrenceFrequency` | Yes | `"weekly"` or `"biweekly"` |
| `daysOfWeek` | `integer[]` | Yes | Days to schedule (0=Sun, 1–6 for Mon–Sat) |
| `startDate` | `string` (ISO 8601) | Yes | Series start date |
| `endDate` | `string \| null` | Yes | Series end date (null for open-ended) |
| `startTime` | `string` | Yes | Start time (e.g. `"14:30"`) |
| `endTime` | `string \| null` | Yes | End time (null if open-ended) |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | No | Optional location URL (public `https://`, max 2048 chars); requires `location` to be non-empty |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel for event embeds |
| `ownerGroupId` | `GroupId \| null` | Yes | Owner group ID |
| `memberGroupId` | `GroupId \| null` | Yes | Member group ID |

**Response:** `201 Created` — `EventSeriesInfo`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `seriesId` | `EventSeriesId` | No | Series ID |
| `teamId` | `TeamId` | No | Team ID |
| `title` | `string` | No | Series title |
| `frequency` | `RecurrenceFrequency` | No | Recurrence frequency |
| `daysOfWeek` | `integer[]` | No | Days of week |
| `startDate` | `string` (ISO 8601) | No | Start date |
| `endDate` | `string \| null` | Yes | End date |
| `status` | `EventSeriesStatus` | No | `"active"` or `"cancelled"` |
| `trainingTypeId` | `TrainingTypeId \| null` | Yes | Training type ID |
| `trainingTypeName` | `string \| null` | Yes | Training type name |
| `startTime` | `string` | No | Start time string |
| `endTime` | `string \| null` | Yes | End time string |
| `location` | `string \| null` | Yes | Location |
| `locationUrl` | `string \| null` | Yes | Optional location URL (public `https://`, max 2048 chars) |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel ID |
| `ownerGroupId` | `GroupId \| null` | Yes | Owner group ID |
| `ownerGroupName` | `string \| null` | Yes | Owner group name |
| `memberGroupId` | `GroupId \| null` | Yes | Member group ID |
| `memberGroupName` | `string \| null` | Yes | Member group name |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:create` permission |

---

#### `GET /teams/:teamId/event-series`

Lists all event series for a team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `EventSeriesInfo[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |

---

#### `GET /teams/:teamId/event-series/:seriesId`

Returns full details for a specific event series.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `seriesId` | `EventSeriesId` (string) | Series ID |

**Response:** `200 OK` — `EventSeriesDetail` (all `EventSeriesInfo` fields, plus):

| Field | Type | Description |
|---|---|---|
| `description` | `string \| null` | Series description |
| `canEdit` | `boolean` | Whether the user can edit this series |
| `canCancel` | `boolean` | Whether the user can cancel this series |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Not a member of this team |
| `EventSeriesNotFound` | 404 | Series does not exist |

---

#### `PATCH /teams/:teamId/event-series/:seriesId`

Updates a series. Changes apply only to future generated events. All fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:edit`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `seriesId` | `EventSeriesId` (string) | Series ID |

**Request Body:** `UpdateEventSeriesRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | No | Non-empty series title |
| `trainingTypeId` | `TrainingTypeId \| null` | No | Training type ID |
| `description` | `string \| null` | No | Description |
| `daysOfWeek` | `integer[]` | No | Days of week |
| `startTime` | `string` | No | Start time |
| `endTime` | `string \| null` | No | End time |
| `location` | `string \| null` | No | Location |
| `locationUrl` | `string \| null` | No | Optional location URL (public `https://`, max 2048 chars); requires `location` to be non-empty when setting a URL |
| `endDate` | `string \| null` | No | Series end date |
| `discordChannelId` | `Snowflake \| null` | No | Discord channel ID |
| `ownerGroupId` | `GroupId \| null` | No | Owner group ID |
| `memberGroupId` | `GroupId \| null` | No | Member group ID |

**Response:** `200 OK` — `EventSeriesDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:edit` permission |
| `EventSeriesNotFound` | 404 | Series does not exist |
| `EventSeriesCancelled` | 400 | Series is already cancelled |

---

#### `POST /teams/:teamId/event-series/:seriesId/cancel`

Cancels a series. Future events will not be generated. This action is irreversible.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `event:cancel`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `seriesId` | `EventSeriesId` (string) | Series ID |

**Request Body:** None

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `EventForbidden` | 403 | Missing `event:cancel` permission |
| `EventSeriesNotFound` | 404 | Series does not exist |
| `EventSeriesCancelled` | 400 | Series is already cancelled |

---

### 11. Training Type

**Source:** `packages/domain/src/api/TrainingTypeApi.ts`

Training types categorize training events and can be scoped to groups (owner group manages them, member group attends).

---

#### `GET /teams/:teamId/training-types`

Lists all training types for a team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `TrainingTypeListResponse`

| Field | Type | Description |
|---|---|---|
| `canAdmin` | `boolean` | Whether the user can administer training types |
| `trainingTypes` | `TrainingTypeInfo[]` | List of training types |

`TrainingTypeInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `trainingTypeId` | `TrainingTypeId` | No | Training type ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Training type name |
| `ownerGroupName` | `string \| null` | Yes | Name of the group that manages this type |
| `memberGroupName` | `string \| null` | Yes | Name of the group whose members attend |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TrainingTypeForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/training-types`

Creates a new training type.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `training-type:create`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateTrainingTypeRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty, unique name |
| `ownerGroupId` | `GroupId \| null` | Yes | Owner group ID (null for team-wide) |
| `memberGroupId` | `GroupId \| null` | Yes | Member group ID (null for all members) |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel for training events of this type |

**Response:** `201 Created` — `TrainingTypeInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TrainingTypeForbidden` | 403 | Missing `training-type:create` permission |
| `TrainingTypeNameAlreadyTaken` | 409 | A training type with this name already exists |

---

#### `GET /teams/:teamId/training-types/:trainingTypeId`

Returns full details for a training type.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `trainingTypeId` | `TrainingTypeId` (string) | Training type ID |

**Response:** `200 OK` — `TrainingTypeDetail`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `trainingTypeId` | `TrainingTypeId` | No | Training type ID |
| `teamId` | `TeamId` | No | Team ID |
| `name` | `string` | No | Name |
| `ownerGroupId` | `GroupId \| null` | Yes | Owner group ID |
| `ownerGroupName` | `string \| null` | Yes | Owner group name |
| `memberGroupId` | `GroupId \| null` | Yes | Member group ID |
| `memberGroupName` | `string \| null` | Yes | Member group name |
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel ID |
| `canAdmin` | `boolean` | No | Whether the user can administer this type |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TrainingTypeForbidden` | 403 | Not a member of this team |
| `TrainingTypeNotFound` | 404 | Training type does not exist |

---

#### `PATCH /teams/:teamId/training-types/:trainingTypeId`

Updates a training type.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `training-type:create`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `trainingTypeId` | `TrainingTypeId` (string) | Training type ID |

**Request Body:** `UpdateTrainingTypeRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty, unique name |
| `ownerGroupId` | `GroupId \| null` | No | Owner group ID |
| `memberGroupId` | `GroupId \| null` | No | Member group ID |
| `discordChannelId` | `Snowflake \| null` | No | Discord channel ID |

**Response:** `200 OK` — `TrainingTypeInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TrainingTypeForbidden` | 403 | Missing `training-type:create` permission |
| `TrainingTypeNotFound` | 404 | Training type does not exist |
| `TrainingTypeNameAlreadyTaken` | 409 | Another training type has this name |

---

#### `DELETE /teams/:teamId/training-types/:trainingTypeId`

Deletes a training type.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `training-type:delete`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `trainingTypeId` | `TrainingTypeId` (string) | Training type ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TrainingTypeForbidden` | 403 | Missing `training-type:delete` permission |
| `TrainingTypeNotFound` | 404 | Training type does not exist |

---

### 12. Age Threshold

**Source:** `packages/domain/src/api/AgeThresholdApi.ts`

Automatic group rules define which group a member should belong to based on automatic group criteria (age range, gender, required pre-existing group membership, or any combination). All criteria on a rule must match simultaneously (AND semantics). The `AgeCheckCron` runs daily and automatically adds or removes members from groups based on these rules.

---

#### `GET /teams/:teamId/age-thresholds`

Lists all age threshold rules for a team.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `AgeThresholdInfo[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `ruleId` | `AgeThresholdRuleId` | No | Rule ID |
| `teamId` | `TeamId` | No | Team ID |
| `groupId` | `GroupId` | No | Target group ID |
| `groupName` | `string` | No | Target group name |
| `minAge` | `number \| null` | Yes | Minimum age (inclusive); null for no lower bound |
| `maxAge` | `number \| null` | Yes | Maximum age (inclusive); null for no upper bound |
| `gender` | `'male' \| 'female' \| 'other' \| null` | Yes | Gender filter; null means any gender matches |
| `requiredGroupId` | `GroupId \| null` | Yes | If set, only members who are already in this group qualify; null means any member qualifies |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |

---

#### `POST /teams/:teamId/age-thresholds`

Creates a new automatic group rule.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateAgeThresholdRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `groupId` | `GroupId` | Yes | Target group ID |
| `minAge` | `number` | No | Minimum age; omit (or send `undefined`) for no lower bound |
| `maxAge` | `number` | No | Maximum age; omit (or send `undefined`) for no upper bound |
| `gender` | `'male' \| 'female' \| 'other'` | No | Gender filter; omit (or send `undefined`) for any gender |
| `requiredGroupId` | `GroupId` | No | Required pre-existing group; omit (or send `undefined`) for no group requirement |

At least one of `minAge`, `maxAge`, `gender`, or `requiredGroupId` must be provided (non-null / present).

**Response:** `201 Created` — `AgeThresholdInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdEmptyCriteria` | 400 | All criteria are absent (minAge, maxAge, gender, and requiredGroupId all omitted) |
| `AgeThresholdSelfRequired` | 400 | `requiredGroupId` equals `groupId` (a rule cannot require its own target group) |
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |
| `AgeThresholdGroupNotFound` | 404 | Target group (`groupId`) or required group (`requiredGroupId`) does not exist or belongs to a different team |
| `AgeThresholdAlreadyExists` | 409 | A rule with the same group and criteria tuple already exists |

---

#### `PATCH /teams/:teamId/age-thresholds/:ruleId`

Updates an automatic group rule's criteria.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `ruleId` | `AgeThresholdRuleId` (string) | Rule ID |

**Request Body:** `UpdateAgeThresholdRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `minAge` | `number` | No | New minimum age; omit (or send `undefined`) for no lower bound |
| `maxAge` | `number` | No | New maximum age; omit (or send `undefined`) for no upper bound |
| `gender` | `'male' \| 'female' \| 'other'` | No | New gender filter; omit (or send `undefined`) for any gender |
| `requiredGroupId` | `GroupId` | No | New required pre-existing group; omit (or send `undefined`) for no group requirement |

Any subset of fields may be provided — all fields are optional and the request is accepted as long as at least one criterion is non-null / present in the updated rule. **Note:** the handler currently treats an omitted key as `Option.none` and overwrites the corresponding column with NULL, so omitting a key clears that criterion rather than leaving it unchanged. Resend the existing value to preserve it. (A future change may switch to merge-on-write semantics; tracked as a follow-up.)

**Response:** `200 OK` — `AgeThresholdInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdEmptyCriteria` | 400 | All criteria are absent (minAge, maxAge, gender, and requiredGroupId all omitted) |
| `AgeThresholdSelfRequired` | 400 | `requiredGroupId` equals the rule's target `groupId` |
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |
| `AgeThresholdRuleNotFound` | 404 | Rule does not exist |
| `AgeThresholdGroupNotFound` | 404 | `requiredGroupId` does not exist or belongs to a different team |
| `AgeThresholdAlreadyExists` | 409 | A rule with the same group and criteria tuple already exists |

---

#### `DELETE /teams/:teamId/age-thresholds/:ruleId`

Deletes an age threshold rule.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `ruleId` | `AgeThresholdRuleId` (string) | Rule ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |
| `AgeThresholdRuleNotFound` | 404 | Rule does not exist |

---

#### `POST /teams/:teamId/age-thresholds/evaluate`

Manually triggers age threshold evaluation for all members. Moves members between groups as needed and returns a summary of all changes made.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** None

**Response:** `200 OK` — `AgeGroupChange[]`

| Field | Type | Description |
|---|---|---|
| `memberId` | `TeamMemberId` | Member ID |
| `memberName` | `string` | Member display name |
| `groupId` | `GroupId` | Group ID affected |
| `groupName` | `string` | Group name |
| `action` | `"added" \| "removed"` | Whether the member was added to or removed from the group |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |

---

### 13. Activity Log

**Source:** `packages/domain/src/api/ActivityLogApi.ts`

Activity logs track physical activities for individual members. Entries can be created manually or automatically (e.g. via `TrainingAutoLogCron` when a member RSVPs "yes" to a training event that ends).

#### Enums

**ActivitySource:** `"manual"`, `"auto"`

> **Note:** Entries with `source: "auto"` cannot be edited or deleted via the API. Attempting to do so returns `ActivityLogAutoSourceForbidden` (403).

---

#### `GET /teams/:teamId/members/:memberId/activity-logs`

Lists all activity log entries for a member.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — `ActivityLogListResponse`

| Field | Type | Description |
|---|---|---|
| `logs` | `ActivityLogEntry[]` | Log entries |

`ActivityLogEntry`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `ActivityLogId` | No | Log entry ID |
| `activityTypeId` | `ActivityTypeId` | No | Activity type ID |
| `activityTypeName` | `string` | No | Activity type name |
| `activityTypeEmoji` | `string \| null` | Yes | Emoji for the activity type, if set |
| `loggedAt` | `string` (ISO 8601) | No | Timestamp when logged |
| `durationMinutes` | `integer \| null` | Yes | Duration in minutes (1–1440) |
| `note` | `string \| null` | Yes | Optional note |
| `source` | `ActivitySource` | No | `"manual"` or `"auto"` |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogMemberNotFound` | 404 | Member does not exist |
| `ActivityLogForbidden` | 403 | Not authorized to view this member's logs |

---

#### `POST /teams/:teamId/members/:memberId/activity-logs`

Creates a new activity log entry for a member.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Request Body:** `CreateActivityLogRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `activityTypeId` | `ActivityTypeId` | Yes | — | Type of activity |
| `durationMinutes` | `integer \| null` | Yes | 1–1440 if provided | Duration in minutes |
| `note` | `string \| null` | Yes | — | Optional note |
| `loggedAtDate` | `string \| null` | No | `YYYY-MM-DD`; within ±2 years of today | Date to record the entry against (defaults to today if omitted or null) |

**Response:** `201 Created` — `ActivityLogEntry`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogMemberNotFound` | 404 | Member does not exist |
| `ActivityLogForbidden` | 403 | Not authorized to log for this member |
| `ActivityLogMemberInactive` | 403 | Member is deactivated |
| `ActivityLogInvalidLoggedAtDate` | 400 | `loggedAtDate` is not a valid `YYYY-MM-DD` date or is outside the ±2-year window |

---

#### `PATCH /teams/:teamId/members/:memberId/activity-logs/:logId`

Updates an existing activity log entry. Cannot update auto-sourced entries.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |
| `logId` | `ActivityLogId` (string) | Log entry ID |

**Request Body:** `UpdateActivityLogRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `activityTypeId` | `ActivityTypeId` | No | — | New activity type |
| `durationMinutes` | `integer \| null` | No | 1–1440 if provided | New duration |
| `note` | `string \| null` | No | — | New note |
| `loggedAtDate` | `string \| null` | No | `YYYY-MM-DD`; within ±2 years of today | New date for the entry (null or omit to keep existing) |

**Response:** `200 OK` — `ActivityLogEntry`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogNotFound` | 404 | Log entry does not exist |
| `ActivityLogForbidden` | 403 | Not authorized |
| `ActivityLogMemberInactive` | 403 | Member is deactivated |
| `ActivityLogAutoSourceForbidden` | 403 | Entry was auto-logged and cannot be edited |
| `ActivityLogInvalidLoggedAtDate` | 400 | `loggedAtDate` is not a valid `YYYY-MM-DD` date or is outside the ±2-year window |

---

#### `POST /teams/:teamId/members/:memberId/activity-logs/:logId/delete`

Deletes an activity log entry. Cannot delete auto-sourced entries.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |
| `logId` | `ActivityLogId` (string) | Log entry ID |

**Request Body:** None

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogNotFound` | 404 | Log entry does not exist |
| `ActivityLogForbidden` | 403 | Not authorized |
| `ActivityLogMemberInactive` | 403 | Member is deactivated |
| `ActivityLogAutoSourceForbidden` | 403 | Entry was auto-logged and cannot be deleted |

---

---

### 14. Activity Type

**Source:** `packages/domain/src/api/ActivityTypeApi.ts`

Activity types are the catalogue of activity kinds members can log. The four global built-ins (gym, running, stretching, training) are seeded on installation and cannot be deleted. Team admins and captains can define additional team-specific types. The `canAdmin` flag in list responses tells the caller whether the authenticated user has permission to create/update/delete types in this team.

#### Schemas

`ActivityTypeInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `ActivityTypeId` | No | Activity type ID |
| `teamId` | `TeamId \| null` | Yes | Owning team; `null` for global built-ins |
| `name` | `string` | No | Display name |
| `slug` | `string \| null` | Yes | Machine-readable slug for built-in types |
| `emoji` | `string \| null` | Yes | Single grapheme-cluster emoji |
| `description` | `string \| null` | Yes | Short description (max 200 characters) |
| `usageCount` | `number` | No | Number of activity log entries using this type |

---

#### `GET /teams/:teamId/activity-types`

Lists all activity types available in a team (global built-ins plus any team-specific custom types).

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `ActivityTypeListResponse`

| Field | Type | Description |
|---|---|---|
| `canAdmin` | `boolean` | Whether the caller may create/update/delete types in this team |
| `activityTypes` | `ActivityTypeInfo[]` | Available activity types |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityTypeForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/activity-types`

Creates a new team-specific activity type. Requires `activity-type:create` permission (granted to Admin and Captain by default).

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateActivityTypeRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `ActivityTypeName` | Yes | 1–50 characters | Display name (unique within team, case-insensitive) |
| `emoji` | `string \| null` | Yes | Single grapheme-cluster emoji | Optional emoji |
| `description` | `string \| null` | Yes | Max 200 characters | Optional description |

**Response:** `201 Created` — `ActivityTypeInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityTypeForbidden` | 403 | Missing `activity-type:create` permission |
| `ActivityTypeNameAlreadyTaken` | 409 | Name already used in this team (case-insensitive) |

---

#### `GET /teams/:teamId/activity-types/:activityTypeId`

Returns a single activity type.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `activityTypeId` | `ActivityTypeId` (string) | Activity type ID |

**Response:** `200 OK` — `ActivityTypeInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityTypeForbidden` | 403 | Not a member of this team |
| `ActivityTypeNotFound` | 404 | Activity type does not exist |

---

#### `PATCH /teams/:teamId/activity-types/:activityTypeId`

Updates a team-specific activity type. Global built-ins (`team_id IS NULL`) cannot be updated and return `ActivityTypeProtected`.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `activityTypeId` | `ActivityTypeId` (string) | Activity type ID |

**Request Body:** `UpdateActivityTypeRequest` (all fields optional)

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `ActivityTypeName` | No | 1–50 characters | New display name |
| `emoji` | `string \| null` | No | Single grapheme-cluster emoji | New emoji; `null` clears it |
| `description` | `string \| null` | No | Max 200 characters | New description; `null` clears it |

**Response:** `200 OK` — `ActivityTypeInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityTypeForbidden` | 403 | Missing `activity-type:create` permission |
| `ActivityTypeNotFound` | 404 | Activity type does not exist |
| `ActivityTypeProtected` | 422 | Cannot update a global built-in type |
| `ActivityTypeNameAlreadyTaken` | 409 | Name already used in this team (case-insensitive) |

---

#### `DELETE /teams/:teamId/activity-types/:activityTypeId`

Deletes a team-specific activity type. Built-in types and types with existing log entries cannot be deleted.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `activityTypeId` | `ActivityTypeId` (string) | Activity type ID |

**Request Body:** None

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityTypeForbidden` | 403 | Missing `activity-type:delete` permission |
| `ActivityTypeNotFound` | 404 | Activity type does not exist |
| `ActivityTypeProtected` | 422 | Cannot delete a global built-in type |
| `ActivityTypeHasLogs` | 409 | Type has activity log entries and cannot be deleted |

---

### 15. Activity Stats

**Source:** `packages/domain/src/api/ActivityStatsApi.ts`

---

#### `GET /teams/:teamId/members/:memberId/activity-stats`

Returns aggregated activity statistics for a specific member.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — `ActivityStatsResponse`

| Field | Type | Description |
|---|---|---|
| `currentStreak` | `integer` | Current consecutive-day activity streak |
| `longestStreak` | `integer` | Longest streak ever achieved |
| `totalActivities` | `integer` | Total number of logged activities |
| `totalDurationMinutes` | `integer` | Total duration across all logged activities |
| `counts` | `{ activityTypeId: string, activityTypeName: string, count: integer }[]` | Per-activity-type breakdown |
| `achievements` | `{ slug: AchievementSlug, earned_at: string }[]` | Achievements the member has earned, ordered by `earned_at` ascending. `slug` is one of the fixed values defined in `Achievement.AchievementSlug`; `earned_at` is an ISO 8601 timestamp string. Empty array when no achievements have been earned yet. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityStatsMemberNotFound` | 404 | Member does not exist |
| `ActivityStatsForbidden` | 403 | Not authorized to view this member's stats |

---

### 16. Leaderboard

**Source:** `packages/domain/src/api/LeaderboardApi.ts`

#### Enums

**LeaderboardTimeframe:** `"all"`, `"week"`

---

#### `GET /teams/:teamId/leaderboard`

Returns the activity leaderboard for a team. Members are ranked by total activity count (with total duration as a tiebreaker).

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Query Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `timeframe` | `"all" \| "week"` | No | Filter by time window (default: `"all"`) |
| `activityTypeId` | `ActivityTypeId` (string) | No | Filter by a specific activity type |

**Response:** `200 OK` — `LeaderboardResponse`

| Field | Type | Description |
|---|---|---|
| `entries` | `LeaderboardEntry[]` | Ranked leaderboard entries |

`LeaderboardEntry`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `rank` | `integer` (positive) | No | Position on the leaderboard |
| `teamMemberId` | `TeamMemberId` | No | Team member ID |
| `userId` | `UserId` | No | User ID |
| `username` | `string` | No | Discord username |
| `name` | `string \| null` | Yes | Display name |
| `avatar` | `string \| null` | Yes | Discord avatar hash |
| `totalActivities` | `integer` | No | Total activity count |
| `totalDurationMinutes` | `integer` | No | Total duration in minutes |
| `currentStreak` | `integer` | No | Current streak |
| `longestStreak` | `integer` | No | Longest streak |
| `displayName` | `string` | No | Server-resolved display name. Precedence: profile name → Discord nickname → Discord display name → Discord username. Always non-empty. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `LeaderboardForbidden` | 403 | Not a member of this team |

---

### 17. Invite

**Source:** `packages/domain/src/api/Invite.ts`

Manages team invite links. Invite codes allow new users to join a team without being manually added.

---

#### `GET /invite/:code`

Returns information about an invite code. This endpoint does not require authentication and is used to display a join page.

**Auth:** None

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `code` | `string` | The invite code |

**Response:** `200 OK` — `InviteInfo`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `teamName` | `string` | No | Name of the team |
| `teamId` | `TeamId` | No | Team ID |
| `code` | `string` | No | The invite code |
| `groupName` | `string \| null` | Yes | Name of the group the invite targets (null if not group-scoped) |
| `inviterName` | `string \| null` | Yes | Discord username of the user who created the invite |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `InviteNotFound` | 404 | Invite code does not exist or is disabled |

---

#### `POST /invite/:code/join`

Joins a team using an invite code. The authenticated user becomes a new member of the team with default (Player) role.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `code` | `string` | The invite code |

**Request Body:** None

**Response:** `200 OK` — `JoinResult`

| Field | Type | Description |
|---|---|---|
| `teamId` | `TeamId` | ID of the joined team |
| `roleNames` | `string[]` | Roles assigned to the new member |
| `isProfileComplete` | `boolean` | Whether the user's profile is complete |
| `requiresReauth` | `boolean` | `true` when the user's OAuth token lacks the `guilds.join` scope; the user must re-authenticate before the bot can add them to the Discord server automatically. Discord guild enqueue is skipped when this is `true`. |
| `acceptanceId` | `InviteAcceptanceId \| null` | ID of the newly created `invite_acceptances` row. `null` when the user is already a member (handled by the `AlreadyMember` error path). The web app polls `GET /invite/acceptances/:acceptanceId` to obtain the per-acceptance Discord invite URL once the bot has generated it. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `InviteNotFound` | 404 | Invite code does not exist or is disabled |
| `AlreadyMember` | 409 | User is already a member of this team |

---

#### `GET /invite/acceptances/:acceptanceId`

Polls the status of a single invite acceptance. The web app calls this endpoint repeatedly (≤ 1s cadence) after `POST /invite/:code/join` returns an `acceptanceId` to obtain the Discord invite URL as soon as the bot generates it.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `acceptanceId` | `InviteAcceptanceId` | The acceptance ID returned by `POST /invite/:code/join` |

**Response:** `200 OK` — `JoinStatus`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `acceptanceId` | `InviteAcceptanceId` | No | The acceptance ID |
| `discordInviteUrl` | `string \| null` | Yes | Full Discord invite URL (e.g. `https://discord.gg/<code>`). `null` while the bot is still generating the invite. |
| `errorCode` | `InviteGeneratorErrorCode \| null` | Yes | Set when the bot could not generate the Discord invite (e.g. `missing_welcome_channel`, `discord_api_error`). `null` on success or while pending. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `InviteNotFound` | 404 | No acceptance row found for the given ID |

---

#### `POST /teams/:teamId/invites`

Creates a new invite code for the team. Unlike `regenerateInvite`, this endpoint does **not** deactivate existing codes, allowing multiple active invites at the same time (e.g. one per group). Optionally scopes the invite to a group and sets an expiry date.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:invite`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateInviteInput`

| Field | Type | Required | Description |
|---|---|---|---|
| `groupId` | `GroupId \| null` | No | If set, the new member is auto-added to this group when they join. Must belong to the same team. |
| `expiresAt` | `Date \| null` | No | Optional UTC expiry timestamp. After this time the invite is inactive. |

**Response:** `200 OK` — `InviteCode`

| Field | Type | Description |
|---|---|---|
| `code` | `string` | New invite code |
| `active` | `boolean` | Always `true` for a newly created code |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `team:invite` permission |
| `InvalidGroup` | 422 | `groupId` does not exist or belongs to a different team |

---

#### `GET /teams/:teamId/invites`

Lists all invite codes for the team (active and inactive).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:invite`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `InviteListItem[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `TeamInviteId` | No | Invite ID |
| `code` | `string` | No | Invite code |
| `active` | `boolean` | No | Whether the invite is currently active |
| `groupId` | `GroupId \| null` | Yes | Target group ID (null if not group-scoped) |
| `groupName` | `string \| null` | Yes | Target group name |
| `inviterName` | `string \| null` | Yes | Discord username of the creator |
| `expiresAt` | `Date \| null` | Yes | Expiry timestamp (null = no expiry) |
| `createdAt` | `Date` | No | Creation timestamp |
| `createdBy` | `UserId` | No | ID of the user who created the invite |

**Note:** The `discordCode` field that previously appeared on `InviteListItem` has been removed. Discord invite codes are now tracked per acceptance (one per member who clicks "Accept"), not per invite link.

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `team:invite` permission |

---

#### `POST /teams/:teamId/invite/regenerate` (deprecated)

Generates a new invite code for the team (invalidating any previous code). Prefer `POST /teams/:teamId/invites` for new integrations — this endpoint deactivates all existing codes and sets a fixed 14-day expiry.

**Deprecated:** use `POST /teams/:teamId/invites` instead.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:invite`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** None

**Response:** `200 OK` — `InviteCode`

| Field | Type | Description |
|---|---|---|
| `code` | `string` | New invite code |
| `active` | `boolean` | Always `true` for a newly generated code |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `team:invite` permission |

---

#### `POST /teams/:teamId/invites/:inviteId/deactivate`

Deactivates a single invite by ID. The invite remains in the list (for audit purposes) but can no longer be used.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:invite`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `inviteId` | `TeamInviteId` (string) | Invite ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `team:invite` permission |
| `InviteNotFound` | 404 | Invite does not exist or belongs to a different team |

---

#### `DELETE /teams/:teamId/invite`

Disables the current invite code. The team will have no active invite until a new code is regenerated.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:invite`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Forbidden` | 403 | Missing `team:invite` permission |

---

### 18. Notification

**Source:** `packages/domain/src/api/NotificationApi.ts`

#### Enums

**NotificationType:** `"age_group_added"`, `"age_group_removed"`, `"role_assigned"`, `"role_removed"`

---

#### `GET /notifications`

Lists notifications for the authenticated user in a specific team.

**Auth:** Bearer token (AuthMiddleware)

**Query Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `teamId` | `TeamId` | Yes | Team to retrieve notifications for |

**Response:** `200 OK` — `NotificationInfo[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `notificationId` | `NotificationId` | No | Notification ID |
| `teamId` | `TeamId` | No | Team ID |
| `type` | `NotificationType` | No | Type of notification |
| `title` | `string` | No | Notification title |
| `body` | `string` | No | Notification body text |
| `isRead` | `boolean` | No | Whether the notification has been read |
| `createdAt` | `string` | No | Creation timestamp |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `NotificationForbidden` | 403 | Not a member of the specified team |

---

#### `PATCH /notifications/:notificationId/read`

Marks a single notification as read.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `notificationId` | `NotificationId` (string) | Notification ID |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `NotificationForbidden` | 403 | Notification does not belong to the authenticated user, or the user is no longer an active member of the notification's team |
| `NotificationNotFound` | 404 | Notification does not exist |

---

#### `POST /notifications/read-all`

Marks all notifications as read for the authenticated user in a specific team.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `teamId` | `TeamId` | Yes | Team to mark notifications as read for |

**Response:** `200 OK` — empty body

**Errors:**

| Tag | Status | When |
|---|---|---|
| `NotificationForbidden` | 403 | Not a member of the specified team |

---

### 19. iCal

**Source:** `packages/domain/src/api/ICalApi.ts`

The iCal API provides a personalized calendar feed for each user. The token is user-specific and persists across sessions. The feed contains both team event VEVENTs and payment VEVENTs (one all-day event per unpaid or overdue fee assignment, capped to the past 180 days). Each payment VEVENT includes a VALARM that fires one day before the due date. The calendar's `PRODID` is `-//Sideline//Calendar//EN`; all VEVENTs include a `DTSTAMP` field (RFC 5545 compliance).

---

#### `GET /me/ical-token`

Returns the authenticated user's current iCal token and the corresponding feed URL.

**Auth:** Bearer token (AuthMiddleware)

**Response:** `200 OK` — `ICalTokenResponse`

| Field | Type | Description |
|---|---|---|
| `token` | `string` | The iCal token |
| `url` | `string` | The full URL to the iCal feed |

---

#### `POST /me/ical-token/regenerate`

Generates a new iCal token (invalidating any previous token). Use this if the current token is compromised.

**Auth:** Bearer token (AuthMiddleware)

**Request Body:** None

**Response:** `200 OK` — `ICalTokenResponse`

---

#### `GET /ical/:token`

Returns the iCal calendar feed. This endpoint does not require authentication — it is token-based and intended to be used directly by calendar applications.

**Auth:** None (token-based)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `token` | `string` | The iCal token obtained from `GET /me/ical-token` |

**Response:** `200 OK` — iCalendar data (`text/calendar` format)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ICalTokenNotFound` | 404 | Token does not exist or has been regenerated |

### 20. Achievement

**Source:** `packages/domain/src/api/AchievementApi.ts`

Manages achievement settings for a team — lists built-in and custom achievements, adjusts thresholds, links Discord roles, and creates/updates/deletes custom achievements. All endpoints require the `team:manage` permission.

---

#### `GET /teams/:teamId/achievements`

Returns all achievements for the team: the 11 built-in achievements (with any per-team threshold overrides and Discord role mappings applied) followed by any custom achievements defined by the team.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Response:** `200 OK` — `AchievementOverview[]`

| Field | Type | Description |
|---|---|---|
| `keyOrId` | `string` | For built-in achievements: the `AchievementSlug` (e.g. `fifty_activities`). For custom achievements: the `CustomAchievementId` (UUID). |
| `name` | `string` | Display name. For built-in achievements this is the English fallback name; use `titleKey` for the localised title. |
| `description` | `string` | Description text (empty for built-in achievements; use `descriptionKey` for the localised description). |
| `titleKey` | `string \| null` | i18n key for the title (built-in only; `null` for custom). |
| `descriptionKey` | `string \| null` | i18n key for the description (built-in only; `null` for custom). |
| `kind` | `"built_in" \| "custom"` | Whether this is a system achievement or a team-defined custom one. |
| `ruleKind` | `"total_activities" \| "longest_streak" \| "total_duration" \| "activity_type_count"` | The metric the achievement is based on. |
| `effectiveThreshold` | `number` | The threshold in effect (override for built-in, stored threshold for custom). |
| `defaultThreshold` | `number \| null` | The built-in default threshold (`null` for custom achievements). |
| `discordRoleId` | `string \| null` | Discord role ID that is granted when the achievement is earned, or `null` if no role mapping is configured. |
| `isBuiltIn` | `boolean` | `true` for built-in achievements. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Not a team member or missing `team:manage` permission |

---

#### `GET /teams/:teamId/achievements/built-in/:slug/preview`

Returns a preview of how many members would qualify if the built-in achievement threshold were changed to the given value, and which members who currently hold the achievement would lose it.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Path parameters:** `teamId`, `slug` — an `AchievementSlug` value

**Query parameters:**

| Name | Type | Description |
|---|---|---|
| `threshold` | `integer > 0` | The candidate threshold to preview |

**Response:** `200 OK` — `PreviewResponse`

| Field | Type | Description |
|---|---|---|
| `qualifyingCount` | `number` | Number of current members who would earn the achievement at the given threshold |
| `removedMembers` | `{ teamMemberId, memberName }[]` | Members who already hold the achievement but would no longer qualify at the new threshold |
| `botCanManageRoles` | `boolean` | Whether the bot currently has the Discord Manage Roles permission in the team's guild |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `AchievementNotFound` | 404 | `slug` does not exist |

---

#### `PUT /teams/:teamId/achievements/built-in/:slug/threshold`

Updates the threshold override for a built-in achievement. The new threshold replaces the default for all future evaluations for this team.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Path parameters:** `teamId`, `slug`

**Request Body:** `SetBuiltInThresholdRequest`

| Field | Type | Description |
|---|---|---|
| `threshold` | `integer > 0` | The new threshold value |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `AchievementNotFound` | 404 | `slug` does not exist |
| `InvalidThreshold` | 400 | Threshold is zero or negative |

---

#### `PUT /teams/:teamId/achievements/:keyOrId/role-mapping`

Sets the Discord role that is granted when a member earns this achievement. Works for both built-in achievements (pass the `AchievementSlug` as `keyOrId`) and custom achievements (pass the `CustomAchievementId` UUID).

When `source` is `auto_create`, the server enqueues a `discord_role_provision_events` row; the bot's Role Provision worker picks it up, creates (or reuses) the Discord role by name, and writes the resulting role ID back via `Achievement/UpsertBuiltInRoleMapping` or `Achievement/UpsertCustomRoleMapping`.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Path parameters:** `teamId`, `keyOrId`

**Request Body:** `SetRoleMappingRequest` (union)

| Variant | Fields | Description |
|---|---|---|
| `existing` | `source: "existing"`, `roleId: Snowflake` | Link to an existing Discord role by ID |
| `auto_create` | `source: "auto_create"` | Ask the bot to auto-create (or reuse) a role with the achievement's name |
| `none` | `source: "none"` | Remove any existing role mapping |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `AchievementNotFound` | 404 | `keyOrId` does not match any known achievement |
| `NoGuildLinked` | 400 | `auto_create` requested but the team has no linked Discord guild |

---

#### `POST /teams/:teamId/achievements/custom`

Creates a new custom achievement for the team.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Request Body:** `CreateCustomRequest`

| Field | Type | Description |
|---|---|---|
| `name` | `string` (non-empty) | Display name; must be unique within the team |
| `description` | `string` (non-empty) | Description shown to members |
| `emoji` | `string \| null` | Optional emoji prefix |
| `ruleKind` | `CustomRuleKind` | Metric the achievement tracks |
| `threshold` | `integer > 0` | Qualifying threshold |
| `activityTypeSlug` | `string \| null` | Required when `ruleKind` is `activity_type_count`; the activity type slug to count |
| `discordRoleId` | `string \| null` | Optional Discord role ID to grant on earn |

**Response:** `201 Created`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `CustomAchievementNameTaken` | 409 | A custom achievement with this name already exists for the team |
| `InvalidCustomRule` | 400 | `ruleKind` is `activity_type_count` but `activityTypeSlug` is null, or the slug does not exist |

---

#### `PATCH /teams/:teamId/achievements/custom/:customId`

Updates an existing custom achievement. All fields are optional; omitted fields are left unchanged.

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Path parameters:** `teamId`, `customId` — `CustomAchievementId` (UUID)

**Request Body:** `UpdateCustomRequest` (all fields optional/nullable)

| Field | Type | Description |
|---|---|---|
| `name` | `string \| null` | New display name |
| `description` | `string \| null` | New description |
| `emoji` | `string \| null` | New emoji (pass `null` to clear) |
| `ruleKind` | `CustomRuleKind \| null` | New rule kind |
| `threshold` | `integer > 0 \| null` | New threshold |
| `activityTypeSlug` | `string \| null` | New activity type slug (pass `null` to clear) |
| `discordRoleId` | `string \| null` | New Discord role ID (pass `null` to remove) |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `CustomAchievementNotFound` | 404 | `customId` does not exist or belongs to a different team |
| `CustomAchievementNameTaken` | 409 | The new name is already taken by another custom achievement on this team |
| `InvalidCustomRule` | 400 | Invalid `ruleKind`/`activityTypeSlug` combination |

---

#### `DELETE /teams/:teamId/achievements/custom/:customId`

Deletes a custom achievement. Any `earned_achievements` rows referencing this achievement are also removed (cascaded via the custom achievement's UUID key).

**Auth:** Bearer token (AuthMiddleware), `team:manage` required

**Path parameters:** `teamId`, `customId`

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AchievementForbidden` | 403 | Missing `team:manage` permission |
| `CustomAchievementNotFound` | 404 | `customId` does not exist or belongs to a different team |

---

### 21. Weekly Summary

**Source:** `packages/domain/src/api/WeeklySummaryApi.ts`

Returns a weekly activity summary for the authenticated member and, optionally, for the whole team. All members can retrieve their own player summary; the team-level summary is only included when `includeTeam=true` is requested **and** the caller holds the `roster:manage` permission.

---

#### `GET /teams/:teamId/weekly-summary`

Returns the weekly activity summary for the authenticated team member. By default returns data for the current ISO week; pass `week` to retrieve a historical week.

**Auth:** Bearer token (AuthMiddleware) — caller must be a member of `teamId`

**Path parameters:** `teamId`

**Query parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `week` | `string` (`YYYY-Www`) | No | ISO week identifier, e.g. `2026-W20`. Defaults to the current week in the team's configured timezone. |
| `includeTeam` | `"true"` \| `"false"` | No | When `true`, and the caller has `roster:manage`, also returns the team-level breakdown. Defaults to `false`. |

**Response:** `200 OK` — `WeeklySummaryResponse`

`WeeklySummaryResponse`:

| Field | Type | Description |
|---|---|---|
| `week` | `WeekRange` | The ISO week the summary covers. |
| `player` | `PlayerWeeklySummary \| null` | The authenticated member's personal summary. `null` if the member has no activity data for the week. |
| `team` | `TeamWeeklySummary \| null` | Team-level summary. `null` when `includeTeam` is `false` or the caller lacks `roster:manage`. |

`WeekRange`:

| Field | Type | Description |
|---|---|---|
| `startAt` | `DateTime` | Monday 00:00:00 of the week in UTC. |
| `endAt` | `DateTime` | Sunday 23:59:59.999 of the week in UTC. |
| `isoYear` | `integer` | ISO year (may differ from the calendar year for week 1 / week 52–53 boundary weeks). |
| `isoWeek` | `integer` | ISO week number (1–53). |

`PlayerWeeklySummary`:

| Field | Type | Description |
|---|---|---|
| `teamMemberId` | `UUID` | The member's ID. |
| `totalActivities` | `integer` | Number of activities logged during the week. |
| `totalDurationMinutes` | `integer` | Total logged duration in minutes for the week. |
| `activitiesByType` | `ActivityTypeBreakdown[]` | Per-activity-type counts for the week. |
| `currentStreak` | `integer` | Current consecutive-day activity streak (all-time, not week-scoped). |
| `longestStreak` | `integer` | Longest consecutive-day streak ever achieved by the member. |
| `previousWeekActivities` | `integer` | Number of activities the member logged in the immediately preceding ISO week. |
| `newAchievements` | `{ slug, earnedAt }[]` | Achievements earned during this week. |

`ActivityTypeBreakdown`:

| Field | Type | Description |
|---|---|---|
| `activityTypeId` | `UUID` | Activity type ID. |
| `activityTypeName` | `string` | Display name of the activity type. |
| `count` | `integer` | Number of activities of this type logged during the week. |

`TeamWeeklySummary`:

| Field | Type | Description |
|---|---|---|
| `totalActivities` | `integer` | Total activity logs across the entire team for the week. |
| `totalDurationMinutes` | `integer` | Summed duration across all team members for the week. |
| `activeMemberCount` | `integer` | Number of team members who logged at least one activity during the week. |
| `totalMemberCount` | `integer` | Total number of team members at the time of the request. |
| `topContributors` | `TopContributor[]` | Members ranked by activity count (descending). |
| `newAchievementsCount` | `integer` | Total achievements earned by any team member during the week. |
| `previousWeekActivities` | `integer` | Team-total activity count for the preceding ISO week. |

`TopContributor`:

| Field | Type | Description |
|---|---|---|
| `teamMemberId` | `UUID` | The member's ID. |
| `displayName` | `string` | The member's display name. |
| `totalActivities` | `integer` | Their activity count for the week. |
| `totalDurationMinutes` | `integer` | Their total logged duration for the week. |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklySummaryForbidden` | 403 | Caller is not a member of the team |
| `WeeklySummaryNotFound` | 404 | The `week` parameter is syntactically invalid |

---

### 22. Translations

**Source:** `packages/domain/src/api/Translations.ts`

Manages global UI translation overrides. All endpoints require `AuthMiddleware`. Write endpoints (`PATCH`, `POST import`, `GET export`) additionally require the caller to be a global admin (Discord ID in `APP_GLOBAL_ADMIN_DISCORD_IDS`). Read endpoints (`GET /api/translations`) are available to any authenticated user and are used by the web frontend to load active overrides at startup.

---

#### `GET /api/translations`

Returns the current cache version and all active translation overrides.

**Auth:** Bearer token (AuthMiddleware)

**Response:** `200 OK` — `TranslationsResponse`

`TranslationsResponse`:

| Field | Type | Description |
|---|---|---|
| `version` | `number` | Monotonically increasing cache version. Incremented on every write. |
| `overrides` | `TranslationOverride[]` | All active override rows. |

`TranslationOverride`:

| Field | Type | Description |
|---|---|---|
| `key` | `string` | Translation key (non-empty string). |
| `locale` | `"en" \| "cs"` | Locale this override applies to. |
| `value` | `string` | Override text (may be an empty string, which suppresses the compiled default). |
| `updatedAt` | `DateTime` | When this override was last written. |
| `updatedBy` | `UserId \| null` | ID of the user who last wrote this override, or `null` if the row was imported without an auth context. |

---

#### `PATCH /api/translations/:key`

Upserts or deletes the EN and/or CS override for a single translation key. Global-admin only.

**Auth:** Bearer token (AuthMiddleware), global admin required

**Path parameters:** `key` — translation key (non-empty string)

**Request Body:** `UpsertTranslationPayload`

| Field | Type | Required | Description |
|---|---|---|---|
| `en` | `string \| null` | No (omit = leave unchanged) | `null` deletes the EN override; any string (including `""`) upserts it. |
| `cs` | `string \| null` | No (omit = leave unchanged) | `null` deletes the CS override; any string (including `""`) upserts it. |

**Response:** `200 OK` — `TranslationsResponse` (full updated state; see `GET /api/translations`)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TranslationForbidden` | 403 | Caller is not a global admin |

---

#### `POST /api/translations/import`

Bulk-imports translation overrides from a structured payload. Existing overrides for keys included in the payload are overwritten; keys not included are left untouched. Global-admin only.

**Auth:** Bearer token (AuthMiddleware), global admin required

**Request Body:** `ImportTranslationsPayload`

| Field | Type | Description |
|---|---|---|
| `overrides` | `Array<{ key: string; locale: "en" \| "cs"; value: string }>` | List of overrides to upsert. All keys must exist in the compiled message registry. |

**Response:** `200 OK` — `TranslationsResponse` (full updated state; see `GET /api/translations`)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TranslationForbidden` | 403 | Caller is not a global admin |
| `UnknownTranslationKeys` | 400 | One or more `key` values are not present in the compiled message registry. The error body contains a `keys` array listing the unknown keys. |

---

#### `GET /api/translations/export.json`

Returns the full merged translation bundle — compiled defaults with active overrides applied — as a JSON object keyed by locale. Global-admin only. Useful for exporting, reviewing, and round-tripping translations via the import endpoint.

**Auth:** Bearer token (AuthMiddleware), global admin required

**Response:** `200 OK` — `Record<"en" | "cs", Record<string, string>>`

The response shape is:
```json
{
  "en": { "key": "translated value", ... },
  "cs": { "key": "translated value", ... }
}
```

**Errors:**

| Tag | Status | When |
|---|---|---|
| `TranslationForbidden` | 403 | Caller is not a global admin |

---

### 23. Finance

**Source:** `packages/domain/src/api/FinanceApi.ts`
**Prefix:** `/teams/:teamId`

The Finance group exposes fee management and payment tracking. Permissions follow the treasurer pattern: `finance:view` grants read-only access to team-wide finance data; `finance:manage_fees` is required to create, update, or archive fees and to assign them to members; `finance:record_payments` is required to record or void payments. By default Admin holds all three finance permissions; Captain holds `finance:view` only; the built-in Treasurer role holds all three; Player holds none of the named permissions. Two endpoints — `myStatus` and `myPaymentHistory` — are an exception: they are gated on team membership only (no `finance:view` required) and always return data scoped to the invoking member.

**View types (response DTOs):**

`FeeView` — a fee definition with aggregated assignment counts.

| Field | Type | Description |
|---|---|---|
| `feeId` | `FeeId` (string) | Fee ID |
| `teamId` | `TeamId` (string) | Team ID |
| `name` | `string` | Fee name |
| `description` | `string \| null` | Optional description |
| `amountMinor` | `integer ≥ 0` | Default amount in minor currency units (e.g. cents) |
| `currency` | `string (3 chars)` | ISO 4217 currency code |
| `dueAt` | `DateTime \| null` | Default due date |
| `targetScope` | `'all_members' \| 'custom'` | Whether the fee targets all members or a custom list |
| `archivedAt` | `DateTime \| null` | Archive timestamp; `null` if active |
| `assignmentCount` | `number` | Total assignments |
| `paidCount` | `number` | Assignments with status `paid` |
| `pendingCount` | `number` | Assignments with status `pending` |
| `overdueCount` | `number` | Assignments with status `overdue` |

`FeeAssignmentView` — an individual fee assignment with computed status.

| Field | Type | Description |
|---|---|---|
| `assignmentId` | `FeeAssignmentId` (string) | Assignment ID |
| `feeId` | `FeeId` (string) | Parent fee |
| `teamMemberId` | `TeamMemberId` (string) | Assigned member |
| `memberName` | `string \| null` | Member display name |
| `feeName` | `string` | Fee name (denormalised) |
| `currency` | `string (3 chars)` | ISO 4217 currency code |
| `dueMinor` | `integer ≥ 0` | Amount due (assignment-level override or fee default) |
| `paidMinor` | `integer ≥ 0` | Amount already paid (maintained by trigger) |
| `status` | `'pending' \| 'partial' \| 'paid' \| 'overdue' \| 'waived'` | Computed status |
| `effectiveDueAt` | `DateTime \| null` | Assignment-level override due date, or fee-level due date |
| `waivedReason` | `string \| null` | Reason for waiver (if waived) |

`PaymentView` — an individual payment record.

| Field | Type | Description |
|---|---|---|
| `paymentId` | `PaymentId` (string) | Payment ID |
| `feeAssignmentId` | `FeeAssignmentId` (string) | Parent assignment |
| `teamMemberId` | `TeamMemberId` (string) | Member who paid |
| `memberName` | `string \| null` | Member display name |
| `amountMinor` | `integer ≥ 0` | Payment amount in minor units |
| `method` | `'cash' \| 'bank_transfer'` | Payment method |
| `paidAt` | `DateTime` | When the payment was made |
| `note` | `string \| null` | Optional note |
| `recorderName` | `string \| null` | Name of the user who recorded the payment |
| `voidedAt` | `DateTime \| null` | Void timestamp; `null` if active |
| `voidReason` | `string \| null` | Reason for voiding |

`FinanceOverviewMemberRow` — per-member summary for the overview page.

| Field | Type | Description |
|---|---|---|
| `teamMemberId` | `TeamMemberId` (string) | Member ID |
| `memberName` | `string \| null` | Member display name |
| `currency` | `string (3 chars)` | ISO 4217 currency code |
| `totalDueMinor` | `number` | Total amount due across all assignments |
| `totalPaidMinor` | `number` | Total amount paid across all assignments |
| `overdueCount` | `number` | Number of overdue assignments |
| `pendingCount` | `number` | Number of pending assignments |
| `paidCount` | `number` | Number of paid assignments |

`MyFinanceStatus` — the invoking member's own status grouped by currency.

| Field | Type | Description |
|---|---|---|
| `currency` | `string (3 chars)` | ISO 4217 currency code |
| `assignments` | `FeeAssignmentView[]` | All assignments in this currency |
| `totalOutstandingMinor` | `number` | Sum of `dueMinor - paidMinor` for non-waived assignments |

---

#### `GET /teams/:teamId/fees`

Lists all fees for the team (including archived).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `FeeView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |

---

#### `POST /teams/:teamId/fees`

Creates a new fee.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateFeeRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string (non-empty)` | Yes | Fee name |
| `description` | `string \| null` | No | Optional description |
| `amountMinor` | `integer ≥ 0` | Yes | Default amount in minor units |
| `currency` | `string (3 chars)` | Yes | ISO 4217 currency code |
| `dueAt` | `DateTime \| null` | No | Default due date |
| `targetScope` | `'all_members' \| 'custom'` | Yes | Scope |

**Response:** `201 Created` — `FeeView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:manage_fees` permission |
| `InvalidAmount` | 400 | Amount is negative |

---

#### `GET /teams/:teamId/fees/:feeId`

Returns a single fee.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |

**Response:** `200 OK` — `FeeView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |
| `FeeNotFound` | 404 | Fee does not exist |

---

#### `PATCH /teams/:teamId/fees/:feeId`

Updates fee metadata. All fields are optional.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |

**Request Body:** `UpdateFeeRequest` (all fields optional)

| Field | Type | Description |
|---|---|---|
| `name` | `string (non-empty)` | New fee name |
| `description` | `string \| null` | New description (or `null` to clear) |
| `amountMinor` | `integer ≥ 0` | New default amount |
| `currency` | `string (3 chars)` | New currency code |
| `dueAt` | `DateTime \| null` | New default due date (or `null` to clear) |
| `targetScope` | `'all_members' \| 'custom'` | New scope |

**Response:** `200 OK` — `FeeView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:manage_fees` permission |
| `FeeNotFound` | 404 | Fee does not exist |
| `FeeArchived` | 409 | Fee is archived; updates are not permitted |
| `InvalidAmount` | 400 | Amount is negative |

---

#### `DELETE /teams/:teamId/fees/:feeId`

Archives a fee (soft-delete). Assignments are preserved.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:manage_fees` permission |
| `FeeNotFound` | 404 | Fee does not exist |

---

#### `GET /teams/:teamId/fees/:feeId/assignments`

Lists all assignments for a fee.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |

**Response:** `200 OK` — `FeeAssignmentView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |
| `FeeNotFound` | 404 | Fee does not exist |

---

#### `POST /teams/:teamId/fees/:feeId/assignments`

Assigns a fee to one or more members.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |

**Request Body:** `AssignFeeRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `memberIds` | `TeamMemberId[]` | Yes | Members to assign |
| `amountMinorOverride` | `integer ≥ 0 \| null` | No | Per-assignment amount override (uses fee default if `null`) |
| `dueAtOverride` | `DateTime \| null` | No | Per-assignment due date override (uses fee default if `null`) |

**Response:** `201 Created` — `FeeAssignmentView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:manage_fees` permission |
| `FeeNotFound` | 404 | Fee does not exist |
| `FeeArchived` | 409 | Fee is archived |
| `InvalidAmount` | 400 | Amount override is negative |

---

#### `PATCH /teams/:teamId/fees/:feeId/assignments/:assignmentId`

Updates an individual fee assignment (amount, due date, or waiver state).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |
| `assignmentId` | `FeeAssignmentId` (string) | Assignment ID |

**Request Body:** `UpdateAssignmentRequest` (all fields optional)

| Field | Type | Description |
|---|---|---|
| `amountMinor` | `integer ≥ 0` | New amount due |
| `dueAt` | `DateTime \| null` | New due date override (or `null` to clear, falling back to the fee-level date) |
| `waived` | `boolean` | Set to `true` to waive, `false` to re-activate |
| `waivedReason` | `string \| null` | Reason for waiving (or `null` to clear) |

**Response:** `200 OK` — `FeeAssignmentView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:manage_fees` permission |
| `FeeNotFound` | 404 | Fee does not exist |
| `AssignmentNotFound` | 404 | Assignment does not exist |
| `FeeArchived` | 409 | Fee is archived |
| `InvalidAmount` | 400 | Amount is negative |

---

#### `GET /teams/:teamId/members/:memberId/assignments`

Returns all fee assignments for a single team member.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `memberId` | `TeamMemberId` (string) | Member ID |

**Response:** `200 OK` — `FeeAssignmentView[]`

Returns an empty array if `memberId` does not belong to `teamId`.

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |

---

#### `GET /teams/:teamId/payments`

Lists payments for the team. By default returns all non-voided payments; use query parameters to narrow results.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Query Parameters (all optional):**

| Name | Type | Description |
|---|---|---|
| `memberId` | `TeamMemberId` (string) | Filter to payments whose assignment belongs to this member |
| `feeId` | `FeeId` (string) | Filter to payments whose assignment belongs to this fee |
| `from` | `DateTime` (ISO 8601) | Include only payments with `paidAt ≥ from` |
| `to` | `DateTime` (ISO 8601) | Include only payments with `paidAt ≤ to` |
| `includeVoided` | `'true' \| 'false'` | When `'true'`, include voided payments (default: `'false'`) |

**Response:** `200 OK` — `PaymentView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |

---

#### `POST /teams/:teamId/fees/:feeId/assignments/:assignmentId/payments`

Records a payment against an assignment.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:record_payments`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `feeId` | `FeeId` (string) | Fee ID |
| `assignmentId` | `FeeAssignmentId` (string) | Assignment ID |

**Request Body:** `RecordPaymentRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `amountMinor` | `integer ≥ 0` | Yes | Amount paid in minor units |
| `method` | `'cash' \| 'bank_transfer'` | Yes | Payment method |
| `paidAt` | `DateTime` | Yes | When the payment was made |
| `note` | `string \| null` | No | Optional note |

**Response:** `201 Created` — `PaymentView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:record_payments` permission |
| `FeeNotFound` | 404 | Fee does not exist |
| `AssignmentNotFound` | 404 | Assignment does not exist |
| `FeeArchived` | 409 | Fee is archived |
| `InvalidAmount` | 400 | Amount is zero or negative |

---

#### `DELETE /teams/:teamId/payments/:paymentId`

Voids a payment. The payment record is preserved but marked as voided; the assignment's `paidMinor` is recomputed automatically by the database trigger.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:record_payments`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `paymentId` | `PaymentId` (string) | Payment ID |

**Request Body:** `VoidPaymentRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `reason` | `string (non-empty)` | Yes | Reason for voiding |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:record_payments` permission |
| `PaymentNotFound` | 404 | Payment does not exist |

---

#### `GET /teams/:teamId/finance/overview`

Returns per-member finance summary rows for the team overview page.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `finance:view`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `FinanceOverviewMemberRow[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Missing `finance:view` permission |

---

#### `GET /teams/:teamId/finance/my-status`

Returns the invoking member's own fee assignment status grouped by currency.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** membership in the team (bearer token must belong to a team member)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `MyFinanceStatus[]` (one element per currency)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Caller is not a member of this team |

---

#### `GET /teams/:teamId/finance/my-payments`

Returns the invoking member's individual payment records, optionally filtered to a specific fee.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** membership in the team (bearer token must belong to a team member)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Query Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `feeId` | `FeeId` (string) | No | When provided, only payments for that fee are returned |

**Response:** `200 OK` — `PaymentView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `FinanceForbidden` | 403 | Caller is not a member of this team |

---

### 24. Version

**Source:** `packages/domain/src/api/VersionApi.ts`
**Prefix:** `/version`

The Version group exposes the running versions of the server and the Discord bot. It is intentionally unauthenticated so health dashboards and the web frontend can query it without a session.

---

#### `GET /api/version`

Returns the currently running server version and the most recently reported bot version.

**Auth:** None (unauthenticated endpoint)

**Response:** `200 OK` — `VersionInfo`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `server` | `string` | No | Server application version string (from `package.json#version` at startup) |
| `bot` | `string` | No | Bot application version string as last reported by the bot via `BotInfo/ReportBotInfo` RPC; `"unknown"` if the bot has not yet reported |

**Errors:** None — the endpoint always returns 200.

---

### 25. Expenses

**Source:** `packages/domain/src/api/ExpenseApi.ts`
**Prefix:** `/teams/:teamId`

The Expenses group lets authorised members record and manage team expenditures. Expenses are categorised as one of: `fields`, `equipment`, `travel`, `tournaments`, or `other`. Read operations require `finance:view`; write operations (create, update, delete) require `finance:manage_fees` — no new permission literal was introduced. The `balanceSummary` endpoint returns a per-currency breakdown that aggregates both fee income and expenses to produce a net figure.

#### Shared types

`ExpenseView` — a single expense record.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `expenseId` | `ExpenseId` (string) | No | Expense ID |
| `teamId` | `TeamId` (string) | No | Owning team |
| `amountMinor` | `integer > 0` | No | Amount in minor currency units |
| `currency` | `string (CHAR 3)` | No | ISO 4217 currency code |
| `spentAt` | `DateTime` | No | When the expense was incurred |
| `category` | `'fields' \| 'equipment' \| 'travel' \| 'tournaments' \| 'other'` | No | Expense category |
| `description` | `string (max 500 chars)` | No | Free-text description |
| `createdByUserId` | `UserId` (string) | No | User who created the record |
| `createdByName` | `string \| null` | Yes | Display name of the creator |
| `updatedByUserId` | `UserId` (string) | No | User who last modified the record |
| `updatedByName` | `string \| null` | Yes | Display name of the last modifier |
| `createdAt` | `DateTime` | No | Row creation timestamp |
| `updatedAt` | `DateTime` | No | Row update timestamp |

`BalanceSummary` — aggregated income vs. expenses for a team and optional date range.

| Field | Type | Nullable | Description |
|---|---|---|---|
| `currency` | `string (CHAR 3)` | No | ISO 4217 currency code |
| `incomeMinor` | `integer ≥ 0` | No | Total payments received in this currency |
| `expensesMinor` | `integer ≥ 0` | No | Total expenses recorded in this currency |
| `netMinor` | `integer` | No | `incomeMinor − expensesMinor` (may be negative) |

---

#### `GET /teams/:teamId/expenses`

Lists all expenses for the team.

**Auth:** Bearer token required

**Required Permission:** `finance:view`

**Query Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | `ExpenseCategory` | No | Filter by category |
| `from` | `DateTime` | No | Include only expenses on or after this date |
| `to` | `DateTime` | No | Include only expenses before or on this date |

**Response:** `200 OK` — `ExpenseView[]`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:view` permission |

---

#### `GET /teams/:teamId/expenses/:expenseId`

Returns a single expense.

**Auth:** Bearer token required

**Required Permission:** `finance:view`

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `expenseId` | `ExpenseId` (string) | Expense ID |

**Response:** `200 OK` — `ExpenseView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:view` permission |
| `ExpenseNotFound` | 404 | Expense does not exist or belongs to a different team |

---

#### `POST /teams/:teamId/expenses`

Creates a new expense.

**Auth:** Bearer token required

**Required Permission:** `finance:manage_fees`

**Request Body:** `CreateExpenseRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `amountMinor` | `integer > 0` | Yes | Amount in minor currency units |
| `currency` | `string (CHAR 3)` | Yes | ISO 4217 currency code |
| `spentAt` | `DateTime` | Yes | When the expense was incurred |
| `category` | `ExpenseCategory` | Yes | One of `fields`, `equipment`, `travel`, `tournaments`, `other` |
| `description` | `string (max 500 chars)` | Yes | Free-text description |

**Response:** `201 Created` — `ExpenseView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:manage_fees` permission |
| `InvalidExpenseAmount` | 400 | `amountMinor` is zero or negative |

---

#### `PATCH /teams/:teamId/expenses/:expenseId`

Partially updates an existing expense. All body fields are optional; omitted fields are left unchanged. If `currency` is supplied, `amountMinor` must also be supplied.

**Auth:** Bearer token required

**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `expenseId` | `ExpenseId` (string) | Expense ID |

**Request Body:** `UpdateExpenseRequest` (all fields optional)

| Field | Type | Description |
|---|---|---|
| `amountMinor` | `integer > 0` | New amount in minor currency units |
| `currency` | `string (CHAR 3)` | New ISO 4217 currency code |
| `spentAt` | `DateTime` | New expense date |
| `category` | `ExpenseCategory` | New category |
| `description` | `string (max 500 chars)` | New description |

**Response:** `200 OK` — `ExpenseView`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:manage_fees` permission |
| `ExpenseNotFound` | 404 | Expense does not exist or belongs to a different team |
| `InvalidExpenseAmount` | 400 | `amountMinor` is zero or negative, or `currency` supplied without `amountMinor` |

---

#### `DELETE /teams/:teamId/expenses/:expenseId`

Permanently deletes an expense. The deletion is recorded in `expense_history` via a Postgres trigger before the row is removed.

**Auth:** Bearer token required

**Required Permission:** `finance:manage_fees`

**Path Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `expenseId` | `ExpenseId` (string) | Expense ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:manage_fees` permission |
| `ExpenseNotFound` | 404 | Expense does not exist or belongs to a different team |

---

#### `GET /teams/:teamId/finances/balance-summary`

Returns a per-currency breakdown of total income (fee payments) versus total expenses and the resulting net balance. Accepts an optional date range to scope both sides of the summary.

**Auth:** Bearer token required

**Required Permission:** `finance:view`

**Query Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `from` | `DateTime` | No | Include only records on or after this date |
| `to` | `DateTime` | No | Include only records before or on this date |

**Response:** `200 OK` — `BalanceSummary[]` (one element per currency)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ExpenseForbidden` | 403 | Missing `finance:view` permission |

---

### 26. Team Onboarding

**Source:** `packages/domain/src/api/OnboardingApi.ts`
**Prefix:** `/auth`

Provides the global-admin token-management surface and the public captain-facing onboarding wizard. Token creation, listing, and revocation require the caller to be a global admin (`isGlobalAdmin = true`). The preview endpoint is unauthenticated (the plaintext token in the URL acts as the credential). Completing onboarding requires the captain to be authenticated via Discord OAuth.

---

#### `POST /auth/onboarding/tokens`

Creates a new single-use onboarding token.

**Auth:** Bearer token (AuthMiddleware) + `isGlobalAdmin`

**Request Body:** `CreateOnboardingTokenRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `proposedName` | `string` | Yes | 1–100 characters | Suggested name for the team (captain can change it) |
| `boundDiscordId` | `string` | Yes | Valid Discord snowflake | Discord user ID of the captain who may use this link |
| `ttl` | `"24h" \| "72h" \| "7d"` | Yes | One of three string values | Token expiry window |

**Response:** `201 Created` — `CreateOnboardingTokenResponse`

| Field | Type | Description |
|---|---|---|
| `plaintextToken` | `string` | The raw token value embedded in the onboarding URL (shown only once) |
| `onboardingUrl` | `string` | The full one-time URL to send to the captain |
| `expiresAt` | `string` (ISO 8601) | When the token expires |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |
| `OnboardingForbidden` | 403 | Caller is not a global admin |

---

#### `GET /auth/onboarding/tokens`

Lists all onboarding tokens with their current status.

**Auth:** Bearer token (AuthMiddleware) + `isGlobalAdmin`

**Response:** `200 OK` — `OnboardingTokenListItem[]`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `TeamOnboardingTokenId` (string) | No | Token record ID (UUID) |
| `proposedName` | `string` | No | Proposed team name set at creation |
| `boundDiscordId` | `string` | No | Discord user ID the token is bound to |
| `status` | `'active' \| 'consumed' \| 'expired' \| 'revoked'` | No | Current lifecycle state (derived at query time) |
| `createdAt` | `string` (ISO 8601) | No | When the token was created |
| `expiresAt` | `string` (ISO 8601) | No | When the token expires |
| `consumedAt` | `string \| null` | Yes | When the captain completed onboarding (null if not yet used) |
| `consumedBy` | `UserId \| null` | Yes | User ID of the captain who consumed the token |
| `resultingTeamId` | `TeamId \| null` | Yes | ID of the team created from this token |
| `createdByUsername` | `string` | No | Discord username of the global admin who minted the token |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |
| `OnboardingForbidden` | 403 | Caller is not a global admin |

---

#### `DELETE /auth/onboarding/tokens/:tokenId`

Revokes an active onboarding token.

**Auth:** Bearer token (AuthMiddleware) + `isGlobalAdmin`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `tokenId` | `TeamOnboardingTokenId` (string) | UUID of the token record to revoke |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |
| `OnboardingForbidden` | 403 | Caller is not a global admin |
| `OnboardingTokenNotFound` | 404 | Token does not exist |

---

#### `GET /auth/onboarding/tokens/:plaintextToken/preview`

Validates a token and returns its public metadata. Used by the onboarding wizard to display the proposed team name and check validity before the captain authenticates.

**Auth:** None

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `plaintextToken` | `string` | The raw token value from the onboarding URL |

**Response:** `200 OK` — `OnboardingTokenPreview`

| Field | Type | Description |
|---|---|---|
| `proposedName` | `string` | Proposed team name |
| `boundDiscordId` | `string` | Discord user ID the token is bound to |
| `expiresAt` | `string` (ISO 8601) | When the token expires |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `OnboardingTokenNotFound` | 404 | Token does not exist |
| `OnboardingTokenExpired` | 410 | Token TTL has elapsed |
| `OnboardingTokenRevoked` | 410 | Token was revoked by a global admin |
| `OnboardingTokenAlreadyConsumed` | 409 | Token was already used to complete onboarding |

---

#### `POST /auth/onboarding/tokens/:plaintextToken/complete`

Completes the onboarding wizard. Creates the team inside a transaction alongside built-in roles and the captain's membership, then marks the token consumed atomically. The calling user's Discord ID must match `boundDiscordId`.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `plaintextToken` | `string` | The raw token value from the onboarding URL |

**Request Body:** `CompleteOnboardingRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | 1–100 characters | Team name |
| `description` | `string \| null` | No | — | Team description |
| `sport` | `string \| null` | No | — | Sport |
| `logoUrl` | `string \| null` | No | Max 2048 characters; public `https://` only (SSRF-guarded) | Logo URL |
| `guildId` | `Snowflake` (string) | Yes | Valid Discord snowflake | Discord guild to link |
| `welcomeChannelId` | `Snowflake \| null` | No | — | Welcome channel ID |
| `systemLogChannelId` | `Snowflake \| null` | No | — | System log channel ID |
| `onboardingLocale` | `"en" \| "cs"` | Yes | — | Default locale for automated messages on this server |

**Response:** `201 Created` — `UserTeam` (see `GET /auth/me/teams` for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `Unauthorized` | 401 | No valid session |
| `OnboardingTokenNotFound` | 404 | Token does not exist |
| `OnboardingTokenExpired` | 410 | Token has expired |
| `OnboardingTokenAlreadyConsumed` | 409 | Token was already consumed |
| `OnboardingTokenRevoked` | 410 | Token was revoked |
| `OnboardingWrongCaptain` | 403 | Authenticated user's Discord ID does not match `boundDiscordId` |
| `OnboardingGuildAlreadyClaimed` | 409 | The selected Discord guild is already linked to another team |

---

### 27. Weekly Challenge

**Source:** `packages/domain/src/api/WeeklyChallengeApi.ts`

Manages weekly challenges for a team. Captains create, edit, and delete challenges. Any team member can mark or unmark their own completion for the current week. The list endpoint returns the last 12 weeks of challenges together with a completion grid for all members.

---

#### `GET /teams/:teamId/weekly-challenges`

Returns the weekly challenge list with per-member completion data.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Query Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `limit` | `integer` | No | Maximum number of challenges to return (defaults to 12) |

**Response:** `200 OK` — `WeeklyChallengeListResponse`

| Field | Type | Nullable | Description |
|---|---|---|---|
| `team.id` | `TeamId` | No | Team ID |
| `team.timezone` | `string` | No | Team timezone (IANA name, e.g. `Europe/Prague`) — used by the UI to determine the current week |
| `canCreate` | `boolean` | No | Whether the authenticated user may create challenges (`team:manage` permission) |
| `currentMemberId` | `TeamMemberId \| null` | Yes | The authenticated user's team member ID; `null` when the user is not an active member |
| `challenges` | `WeeklyChallengeView[]` | No | List of challenges, newest week first |

Each `WeeklyChallengeView`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `challenge.id` | `WeeklyChallengeId` (string) | No | Challenge ID |
| `challenge.team_id` | `TeamId` | No | Team ID |
| `challenge.week_start_date` | `string` (ISO 8601 date) | No | Monday date for the challenge's week |
| `challenge.kind` | `"throwing" \| "sport"` | No | Challenge kind |
| `challenge.title` | `string` | No | Challenge title (max 120 characters) |
| `challenge.description` | `string \| null` | Yes | Optional description (max 2000 characters) |
| `challenge.created_by` | `TeamMemberId` | No | Member who created the challenge |
| `challenge.created_at` | `string` (ISO 8601) | No | Creation timestamp |
| `challenge.updated_at` | `string` (ISO 8601) | No | Last update timestamp |
| `completedMemberIds` | `TeamMemberId[]` | No | IDs of members who have marked this challenge complete for its week |
| `isActive` | `boolean` | No | Whether the challenge's week is the current week (determined using the team's timezone) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/weekly-challenges`

Creates a new weekly challenge.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateWeeklyChallengeRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `weekStart` | `string` (ISO 8601 date) | Yes | Must be a Monday; not more than one week in the past or more than one week in the future | Start date of the challenge's week |
| `kind` | `"throwing" \| "sport"` | Yes | One of the enum values | Challenge kind |
| `title` | `string` | Yes | 1–120 characters | Challenge title |
| `description` | `string \| null` | Yes | Max 2000 characters; null for no description | Optional description |

**Response:** `201 Created` — `WeeklyChallenge`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Missing `team:manage` permission |
| `WeeklyChallengeAlreadyExistsForWeek` | 409 | A challenge already exists for the given `weekStart` |
| `WeeklyChallengeWeekOutOfRange` | 422 | `weekStart` is more than one week in the past or future, or is not a Monday |

---

#### `PATCH /teams/:teamId/weekly-challenges/:challengeId`

Updates the title and/or description of a weekly challenge.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `challengeId` | `WeeklyChallengeId` (string) | Challenge ID |

**Request Body:** `UpdateWeeklyChallengeRequest`

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `title` | `string` | Yes | 1–120 characters | New challenge title |
| `description` | `string \| null` | Yes | Max 2000 characters; null clears the description | New description |

**Response:** `200 OK` — `WeeklyChallenge`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Missing `team:manage` permission |
| `WeeklyChallengeNotFound` | 404 | Challenge does not exist in this team |

---

#### `DELETE /teams/:teamId/weekly-challenges/:challengeId`

Deletes a weekly challenge and all its completion records.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `team:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `challengeId` | `WeeklyChallengeId` (string) | Challenge ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Missing `team:manage` permission |
| `WeeklyChallengeNotFound` | 404 | Challenge does not exist in this team |

---

#### `POST /teams/:teamId/weekly-challenges/:challengeId/complete`

Marks the authenticated member's completion of a challenge for its week.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `challengeId` | `WeeklyChallengeId` (string) | Challenge ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Not a member of this team |
| `WeeklyChallengeNotFound` | 404 | Challenge does not exist in this team |
| `WeeklyChallengeNotActive` | 409 | The challenge's week is not the current week |

---

#### `DELETE /teams/:teamId/weekly-challenges/:challengeId/complete`

Removes the authenticated member's completion mark for a challenge.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `challengeId` | `WeeklyChallengeId` (string) | Challenge ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `WeeklyChallengeForbidden` | 403 | Not a member of this team |
| `WeeklyChallengeNotFound` | 404 | Challenge does not exist in this team |
| `WeeklyChallengeNotActive` | 409 | The challenge's week is not the current week |

---

### 28. Dashboard Layout

**Source:** `packages/domain/src/api/DashboardLayoutApi.ts`

Manages the per-user, per-team widget layout for the team dashboard. Each user has an independent layout per team. If no row is stored, the server returns the default layout (all four widgets visible in canonical order).

---

#### `GET /teams/:teamId/dashboard-layout`

Returns the authenticated user's current dashboard widget layout for the team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `DashboardLayout`

| Field | Type | Description |
|---|---|---|
| `widgets` | `DashboardWidget[]` | Ordered list of dashboard widgets with visibility flags |

`DashboardWidget`:

| Field | Type | Description |
|---|---|---|
| `id` | `'stats' \| 'upcomingEvents' \| 'activity' \| 'teamManagement'` | Widget identifier |
| `visible` | `boolean` | Whether the widget is shown on the dashboard |

**Normalization:** The server normalises the stored value on read — it deduplicates, drops unknown widget IDs, and appends any missing canonical widgets as visible. This means the response is always the complete set of four widgets in a stable order even if the stored payload was created by an older client.

**Default:** When no layout row exists for the user/team pair, all four widgets are returned as visible in canonical order (`stats`, `upcomingEvents`, `activity`, `teamManagement`).

**Errors:**

| Tag | Status | When |
|---|---|---|
| `DashboardLayoutForbidden` | 403 | Not a member of this team |

---

#### `PUT /teams/:teamId/dashboard-layout`

Saves the authenticated user's dashboard widget layout for the team.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `UpdateDashboardLayoutPayload`

| Field | Type | Required | Description |
|---|---|---|---|
| `widgets` | `DashboardWidget[]` | Yes | New widget order and visibility state |

**Response:** `200 OK` — `DashboardLayout` (same shape as `GET`; server returns the normalised result after saving)

**Normalization:** The server applies the same normalization as `GET` before persisting — unknown IDs are dropped, duplicates are removed, and missing widgets are appended as visible.

**Errors:**

| Tag | Status | When |
|---|---|---|
| `DashboardLayoutForbidden` | 403 | Not a member of this team |

---

### 29. Channel

**Source:** `packages/domain/src/api/ChannelApi.ts`

Manages Discord text channels for a team. The channel list merges two sources: Sideline-managed channels (`managed = true`, `team_channels` rows) and any other Discord channels already present in the guild (`managed = false`, from the `discord_channels` mirror), grouped by their Discord category. Creating, renaming, and access management only apply to managed channels; archiving is available for all channels. All write endpoints require the `group:manage` permission.

---

#### `GET /teams/:teamId/channels`

Lists all channels for a team — both managed (Sideline-created) and unmanaged (synced from Discord). Available to any team member; the `canManage` flag indicates whether the caller can mutate channels.

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `ChannelListResponse`

| Field | Type | Description |
|---|---|---|
| `canManage` | `boolean` | Whether the authenticated user has `group:manage` |
| `guildLinked` | `boolean` | Whether the team's Discord guild is currently linked to the bot |
| `archiveCategoryId` | `Snowflake \| null` | The team's configured Discord archive category ID (`team_settings.discord_archive_category_id`); `null` when not set |
| `channels` | `ChannelInfo[]` | All channels — active managed, archived managed, and Discord-only channels |

`ChannelInfo`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `discordChannelId` | `Snowflake \| null` | Yes | Discord channel snowflake; `null` for managed channels not yet provisioned by the bot |
| `teamChannelId` | `TeamChannelId \| null` | Yes | Sideline channel ID; `null` for Discord-only (unmanaged) channels |
| `name` | `string` | No | Channel name |
| `category` | `string \| null` | Yes | Category label — for managed channels this is the Sideline-side category; for Discord channels this is the parent Discord category name |
| `managed` | `boolean` | No | `true` for Sideline-created channels; `false` for Discord-only channels shown for visibility |
| `type` | `number` | No | Discord channel type integer (e.g. `0` = text channel, `4` = category) |
| `archived` | `boolean` | No | Whether the channel is archived; channels under the team's archive category are shown as archived |
| `accessCount` | `number` | No | Number of group access grants (always `0` for unmanaged channels) |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Not a member of this team |

---

#### `POST /teams/:teamId/channels`

Creates a new managed channel. Emits a `channel_created` / `managed` sync event; the bot creates the Discord channel and writes back the snowflake.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `CreateChannelRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Non-empty channel name (must be unique among active channels for this team) |
| `category` | `string \| null` | Yes | Sideline-side category label (null for no category) |

**Response:** `201 Created` — `ChannelDetail`

`ChannelDetail` extends `ChannelInfo` (same fields) with:

| Field | Type | Description |
|---|---|---|
| `grants` | `ChannelAccessGrant[]` | Current access grants (always empty for unmanaged channels) |

`ChannelAccessGrant`:

| Field | Type | Description |
|---|---|---|
| `groupId` | `GroupId` | Group ID |
| `accessLevel` | `'VIEW' \| 'EDIT' \| 'ADMIN'` | Access tier |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNameAlreadyTaken` | 409 | Active channel with this name already exists |

---

#### `GET /teams/:teamId/channels/:channelId`

Returns full details for a single managed channel, including all access grants.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `channelId` | `TeamChannelId` (string) | Channel ID |

**Response:** `200 OK` — `ChannelDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | Channel does not exist or belongs to a different team |

---

#### `PATCH /teams/:teamId/channels/:channelId/name`

Renames a managed channel (Sideline read-model only; no Discord sync in v1 — a bot-side rename handler is planned but not yet implemented).

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `channelId` | `TeamChannelId` (string) | Channel ID |

**Request Body:** `RenameChannelRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | New non-empty channel name |

**Response:** `200 OK` — `ChannelDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | Channel does not exist or belongs to a different team |
| `ChannelNameAlreadyTaken` | 409 | Active channel with this name already exists |

---

#### `POST /teams/:teamId/channels/:channelId/archive`

Archives a managed channel. Sets `archived = true`; emits a `channel_archived` / `managed` sync event. If an archive category is configured in team settings the bot moves the Discord channel there; otherwise the bot deletes the Discord channel (delete-fallback). The `discord_channel_id` is cleared from the Sideline record after the bot processes the event.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `channelId` | `TeamChannelId` (string) | Channel ID |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | Channel does not exist or belongs to a different team |

---

#### `POST /teams/:teamId/discord-channels/:discordChannelId/archive`

Archives any Discord channel that belongs to this team's guild — not just Sideline-managed ones. Requires the team's archive category to be configured in team settings. Emits a `channel_archived` / `discord` sync event; the bot moves the channel to the archive category. Unlike the managed-channel archive, there is no delete-fallback — the bot will never delete a Discord-native channel.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `discordChannelId` | `Snowflake` (string) | Discord channel snowflake |

**Response:** `204 No Content`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | The Discord channel is not found in this team's guild |
| `ArchiveCategoryNotConfigured` | 409 | `team_settings.discord_archive_category_id` is not set |
| `ChannelNotArchivable` | 409 | The channel is already in the archive category or is itself a category channel |

---

#### `POST /teams/:teamId/discord-channels/:discordChannelId/adopt`

Adopts a previously-unmanaged Discord channel into Sideline management. Creates a `team_channels` row for the channel and emits a `channel_updated` / `managed` sync event; the bot does a full permission-overwrite replace on the Discord channel, setting `@everyone deny ViewChannel` (wiping any existing overwrites), and then applies the group access grants via the existing `setAccess` pipeline. The operation is text-only (type `0`) and idempotent — calling it again on an already-managed channel returns the existing `ChannelDetail` without emitting a duplicate event.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `discordChannelId` | `Snowflake` (string) | Discord channel snowflake to adopt |

**Response:** `200 OK` — `ChannelDetail` (same shape as `POST /teams/:teamId/channels`; see above for field descriptions)

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | The Discord channel is not found in this team's guild |
| `ChannelNotAdoptable` | 409 | The channel is not a text channel (type ≠ 0); categories, voice channels, and other types cannot be adopted |
| `ChannelAdoptionNameConflict` | 409 | An active managed channel with the same name already exists for this team |

---

#### `POST /teams/:teamId/discord-channels/bulk-archive`

Archives multiple Discord channels in a single call. Each channel is processed independently; failures for individual channels do not abort the remaining ones. Requires the team's archive category to be configured. Duplicate IDs in the payload are de-duped before processing.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Request Body:** `BulkArchiveDiscordChannelsRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `discordChannelIds` | `Snowflake[]` | Yes | IDs of the Discord channels to archive |

**Response:** `200 OK` — `ChannelBulkArchiveResult`

| Field | Type | Description |
|---|---|---|
| `archived` | `Snowflake[]` | IDs of channels successfully queued for archiving |
| `skipped` | `{ discordChannelId: Snowflake, reason: string }[]` | Channels skipped without error; see skip reasons below |
| `failed` | `{ discordChannelId: Snowflake }[]` | Channels that encountered an unexpected error during processing |

**Skip reasons:**

| Reason | When |
|---|---|
| `already_archived` | Channel is already in the archive category, or the managed row is already marked archived |
| `is_category` | Channel is a category (type 4) |
| `is_archive_category` | Channel is the configured archive category itself |
| `not_found` | Channel ID is not present in this guild's channel mirror |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ArchiveCategoryNotConfigured` | 409 | `team_settings.discord_archive_category_id` is not set |

---

#### `PUT /teams/:teamId/channels/:channelId/access`

Replaces the complete set of access grants for a channel. Groups in the payload are upserted; groups absent from the payload have their grant revoked. Emits `member_added` / `managed` events for new or changed grants and `member_removed` / `managed` events for revoked grants; the bot translates these into Discord permission overwrites on the channel.

**Auth:** Bearer token (AuthMiddleware)
**Required Permission:** `group:manage`

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |
| `channelId` | `TeamChannelId` (string) | Channel ID |

**Request Body:** `SetChannelAccessRequest`

| Field | Type | Required | Description |
|---|---|---|---|
| `grants` | `ChannelAccessGrant[]` | Yes | Complete desired access list; empty array revokes all grants |

**Response:** `200 OK` — `ChannelDetail`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ChannelForbidden` | 403 | Missing `group:manage` permission |
| `ChannelNotFound` | 404 | Channel does not exist or belongs to a different team |

---

## RPC API

The RPC API is an internal HTTP endpoint used exclusively for communication between the Discord bot and the server. It is not intended for external consumption.

**Endpoint:** `{RPC_PREFIX}/` (configurable via the `RPC_PREFIX` environment variable; defaults to empty string in development)

**Protocol:** Effect RPC over HTTP (`@effect/rpc`)

**Transport:** All requests are HTTP POST with a JSON payload. The bot acts as the RPC client; the server acts as the RPC handler.

### RPC Groups

#### BotInfo

Allows the Discord bot to report its running version to the server and retrieve the server version.

| Method | Payload / Returns | Description |
|---|---|---|
| `BotInfo/ReportBotInfo` | `{ version: string }` → `void` | Called by the bot at startup to store the bot's running version in the server's `BotInfoStore`. The stored value is served via `GET /api/version`. |
| `BotInfo/GetServerVersion` | `void` → `string` | Called by the bot's `/info` slash command to retrieve the server's running version (`APP_VERSION`). |

#### Guild

Handles Discord guild lifecycle events.

| Method | Payload | Description |
|---|---|---|
| `Guild/RegisterGuild` | `guild_id`, `guild_name` | Registers a new guild (team) when the bot joins a server |
| `Guild/UnregisterGuild` | `guild_id` | Unregisters a guild when the bot is removed |
| `Guild/IsGuildRegistered` | `guild_id` | Checks whether a guild is registered; returns `boolean` |
| `Guild/SyncGuildChannels` | `guild_id`, `channels[]` | Syncs the channel list for a guild |
| `Guild/ReconcileMembers` | `guild_id`, `members[]` | Reconciles the server member list with the database |
| `Guild/RegisterMember` | `guild_id`, `discord_id`, `username`, `avatar`, `roles[]` | Registers a new member who joined the server |

#### Event

Manages event embeds, RSVPs, and event sync outbox processing.

| Method | Payload / Returns | Description |
|---|---|---|
| `Event/GetUnprocessedEvents` | `limit` → `UnprocessedEventSyncEvent[]` | Polls for outbox events to process |
| `Event/MarkEventProcessed` | `id` | Marks an outbox event as processed |
| `Event/MarkEventFailed` | `id`, `error` | Marks an outbox event as failed |
| `Event/SaveDiscordMessageId` | `event_id`, `discord_channel_id`, `discord_message_id` | Stores the Discord message ID for an event embed |
| `Event/GetDiscordMessageId` | `event_id` → `EventDiscordMessage \| null` | Retrieves the stored Discord message for an event |
| `Event/SubmitRsvp` | `event_id`, `team_id`, `discord_user_id`, `response`, `message` → `SubmitRsvpResult` | Submits an RSVP from the bot; result includes late-RSVP flag and optional notification channel |
| `Event/GetRsvpCounts` | `event_id` → `RsvpCountsResult` | Returns yes/no/maybe counts for an event |
| `Event/GetEventEmbedInfo` | `event_id` → `EventEmbedInfo \| null` | Retrieves info needed to render the Discord embed |
| `Event/GetChannelEvents` | `discord_channel_id` → `ChannelEventEntry[]` | Lists events posted in a Discord channel |
| `Event/GetRsvpAttendees` | `event_id`, `offset`, `limit` → `RsvpAttendeesResult` | Returns paginated RSVP attendee list |
| `Event/GetRsvpReminderSummary` | `event_id` → `RsvpReminderSummary` | Returns RSVP reminder data including non-responders and yes-attendee list |
| `Event/GetUpcomingGuildEvents` | `guild_id`, `offset`, `limit` → `GuildEventListResult` | Lists upcoming events for a guild (guild-scoped, no per-user RSVP data) |
| `Event/GetUpcomingEventsForUser` | `guild_id`, `discord_user_id`, `offset`, `limit` → `UpcomingEventsForUserResult` | Lists upcoming events with the invoking user's RSVP status; used by `/event list`, the overview show button, and per-user embed pagination |
| `Event/GetTrainingTypesByGuild` | `guild_id` → `TrainingTypeChoice[]` | Lists training types for a guild (for autocomplete) |
| `Event/CreateEvent` | `guild_id`, `discord_user_id`, `event_type`, `title`, `start_at`, ... → `CreateEventResult` | Creates an event from the bot slash command |

#### Role

Manages Discord role mappings and role sync outbox processing.

| Method | Payload / Returns | Description |
|---|---|---|
| `Role/GetUnprocessedEvents` | `limit` → `UnprocessedRoleEvent[]` | Polls for role sync outbox events |
| `Role/MarkEventProcessed` | `id` | Marks a role sync event as processed |
| `Role/MarkEventFailed` | `id`, `error` | Marks a role sync event as failed |
| `Role/GetMapping` | `team_id`, `role_id` → `RoleMapping \| null` | Gets the Discord role ID for an app role |
| `Role/UpsertMapping` | `team_id`, `role_id`, `discord_role_id` | Creates or updates a role mapping |
| `Role/DeleteMapping` | `team_id`, `role_id` | Removes a role mapping |

#### Channel

Manages Discord channel mappings and channel sync outbox processing. The outbox uses `entity_type` values `'group'`, `'roster'`, `'managed'`, and `'discord'`. The `'discord'` entity type is emitted exclusively for `channel_archived` events triggered by `POST /teams/:teamId/discord-channels/:discordChannelId/archive` — it carries a `discord_channel_archived` event tag and no `team_channel_id`. The `'managed'` entity type with `event_type = 'channel_updated'` is emitted by `POST /teams/:teamId/discord-channels/:discordChannelId/adopt` (`managed_channel_adopted` event).

| Method | Payload / Returns | Description |
|---|---|---|
| `Channel/GetUnprocessedEvents` | `limit` → `UnprocessedChannelEvent[]` | Polls for channel sync outbox events |
| `Channel/MarkEventProcessed` | `id` | Marks a channel sync event as processed |
| `Channel/MarkEventFailed` | `id`, `error` | Marks a channel sync event as failed |
| `Channel/GetMapping` | `team_id`, `group_id` → `ChannelMapping \| null` | Gets the Discord channel mapping for a group |
| `Channel/UpsertMapping` | `team_id`, `group_id`, `discord_channel_id`, `discord_role_id` | Creates or updates a channel mapping |
| `Channel/DeleteMapping` | `team_id`, `group_id` | Removes a channel mapping |
| `Channel/GetManagedChannel` | `team_channel_id` → `ManagedChannelMapping \| null` | Returns the `team_id` and current `discord_channel_id` for a managed channel row |
| `Channel/UpsertManagedChannel` | `team_channel_id`, `discord_channel_id` | Writes the provisioned Discord channel ID to `team_channels`; then replays any access grants that were created before the channel was provisioned |
| `Channel/ClearManagedChannel` | `team_channel_id` | Clears the `discord_channel_id` column on the managed channel row (called after archive or delete) |
| `Channel/DeleteManagedChannel` | `team_channel_id` | Hard-deletes the `team_channels` row (reserved for future delete endpoint) |

#### Activity

Handles activity logging and stats retrieval from the bot.

| Method | Payload / Returns | Description |
|---|---|---|
| `Activity/LogActivity` | `guild_id`, `discord_user_id`, `activity_type`, `duration_minutes`, `note`, `logged_at_date` (optional `YYYY-MM-DD`) → `LogActivityResult` | Logs an activity for a member |
| `Activity/GetStats` | `guild_id`, `discord_user_id` → `GetStatsResult` | Returns activity stats for a member |
| `Activity/GetLeaderboard` | `guild_id`, `discord_user_id`, `limit` → `GetLeaderboardResult` | Returns the leaderboard for a guild |

#### Achievement

Manages achievement role mappings and drains the achievement sync outbox.

| Method | Payload / Returns | Description |
|---|---|---|
| `Achievement/GetUnprocessedEvents` | `limit` → `UnprocessedAchievementEvent[]` | Polls for pending achievement outbox events |
| `Achievement/MarkEventProcessed` | `id` | Marks an achievement outbox event as processed |
| `Achievement/MarkEventFailed` | `id`, `error` | Marks an achievement outbox event as permanently failed (not retried) |
| `Achievement/GetRoleMapping` | `team_id`, `achievement_slug` → `Snowflake \| null` | Looks up the Discord role ID mapped to a built-in achievement slug for a team |
| `Achievement/UpsertRoleMapping` | `team_id`, `achievement_slug`, `discord_role_id` | Creates or updates the role mapping for a built-in achievement (legacy; prefer `UpsertBuiltInRoleMapping`) |
| `Achievement/UpsertBuiltInRoleMapping` | `team_id`, `achievement_slug`, `discord_role_id` | Creates or updates the role mapping for a built-in achievement (called by the Role Provision worker after auto-creating the Discord role) |
| `Achievement/UpsertCustomRoleMapping` | `team_id`, `custom_achievement_id`, `discord_role_id` | Creates or updates the role mapping for a custom achievement (called by the Role Provision worker after auto-creating the Discord role) |

#### RoleProvision

Drains the `discord_role_provision_events` outbox. When an admin selects `auto_create` for an achievement's Discord role, the server inserts a provision event; the bot's Role Provision worker picks it up, finds or creates the Discord role by name, and writes the result back.

| Method | Payload / Returns | Description |
|---|---|---|
| `RoleProvision/GetUnprocessedEvents` | `limit` → `UnprocessedRoleProvisionEvent[]` | Polls for pending provision events |
| `RoleProvision/MarkProcessed` | `id` | Marks a provision event as successfully processed |
| `RoleProvision/MarkFailed` | `id`, `error` | Records a provisioning failure |

`UnprocessedRoleProvisionEvent` fields: `id`, `team_id`, `guild_id`, `kind` (`"builtin_achievement" | "custom_achievement"`), `ref_id` (slug or UUID), `desired_name` (role name to create/find).

#### WeeklyChallenge

Drains the `weekly_challenge_sync_events` outbox. Each Monday at 09:00 local team time the server inserts one row per team (for the current week's challenge); the bot's Weekly Challenge Sync worker picks it up, builds an embed, posts it to the configured Discord channel, and marks the event delivered.

| Method | Payload / Returns | Description |
|---|---|---|
| `WeeklyChallenge/GetUnprocessedWeeklyChallengeEvents` | — → `UnprocessedWeeklyChallengeEvent[]` | Polls for outbox events that have not yet been delivered (no client-side limit) |
| `WeeklyChallenge/MarkWeeklyChallengeProcessed` | `eventId`, `deliveredAt` | Marks an event as successfully delivered; records the delivery timestamp |
| `WeeklyChallenge/MarkWeeklyChallengeFailed` | `eventId`, `error` | Records a delivery failure and increments the attempt counter; server enforces a 5-attempt cap |

`UnprocessedWeeklyChallengeEvent` fields: `id` (`UUIDString`), `teamId` (`TeamId`), `challengeId` (`WeeklyChallengeId`), `channelId` (`Discord.Snowflake`), `scheduledFor` (`DateTime.Utc`), `attempts` (`Int`), `title` (`WeeklyChallengeTitle`), `kind` (`"throwing" | "sport"`), `description` (`Option<WeeklyChallengeDescription>` — `OptionFromNullOr`, absent when `null`), `weekStartDate` (`string`, `YYYY-MM-DD`), `weekEndDate` (`string`, `YYYY-MM-DD`).

#### WeeklySummary

Drains the `weekly_summary_sync_events` outbox. Each Sunday at 20:00 local team time the server cron inserts one row per team; the bot's Weekly Summary worker picks it up, builds the embed, posts it to the configured Discord channel, and marks the event delivered.

| Method | Payload / Returns | Description |
|---|---|---|
| `WeeklySummary/GetUnprocessedEvents` | — → `UnprocessedWeeklySummaryEvent[]` | Polls for outbox events that have not yet been delivered |
| `WeeklySummary/MarkEventProcessed` | `id`, `deliveredAt` | Marks an event as successfully delivered; records the delivery timestamp |
| `WeeklySummary/MarkEventFailed` | `id`, `error` | Records a delivery failure and increments the attempt counter |

`UnprocessedWeeklySummaryEvent` fields: `id`, `team_id`, `channel_id` (Discord channel snowflake), `week_start`, `week_end`, `payload` (encoded `WeeklySummaryDigest` JSON).

#### Finance

Handles the `/finance status` slash command and the payment reminder delivery pipeline.

| Method | Payload / Returns | Description |
|---|---|---|
| `Finance/GetMyStatus` | `guild_id`, `discord_user_id` → `GetMyStatusResult` | Fetches the invoking member's fee assignments grouped by currency; errors: `FinanceGuildNotFound`, `FinanceMemberNotFound` |
| `Finance/GetUnprocessedPaymentReminders` | `limit` → `UnprocessedPaymentReminderEvent[]` | Polls `payment_reminder_sync_events` for rows where `processed_at IS NULL` (up to `limit`). Called by the bot's Finance Sync worker on a 5-second cadence. |
| `Finance/MarkPaymentReminderProcessed` | `id` | Sets `processed_at = now()` on the outbox row after the bot successfully dispatches the DM. |
| `Finance/MarkPaymentReminderFailed` | `id`, `error` | Sets `processed_at = now()` and records the error string. Failed events are not retried (permanent failure semantics). |
| `Finance/MarkReminderSent` | `assignment_id`, `kind` | Inserts a row into `payment_reminders_sent` (PK `(assignment_id, kind)`). Only called after the Discord DM was accepted. Subsequent calls for the same pair are no-ops (idempotent upsert). |

`GetMyStatusResult` shape: `{ groups: FinanceStatusCurrencyGroup[] }`. Each group: `{ currency, total_outstanding_minor, assignments: FinanceStatusAssignment[] }`. Each assignment: `{ assignment_id, fee_name, status, due_minor, paid_minor, effective_due_at }`.

`UnprocessedPaymentReminderEvent` fields: `id`, `team_id`, `guild_id`, `assignment_id`, `kind` (`"due_in_3d" | "due_today" | "overdue_3d" | "overdue_10d" | "overdue_21d"`), `fee_name`, `effective_due_at`, `currency`, `amount_minor`, `paid_minor`, `user_discord_id`.

---

## Error Reference

The following table consolidates all error tags across all API groups.

| Tag | Status | Group(s) | When it occurs |
|---|---|---|---|
| `Unauthorized` | 401 | Auth | No valid session token |
| `EventForbidden` | 403 | Team, Team Settings, Event, Event Series | Insufficient permissions or not a team member |
| `DashboardForbidden` | 403 | Dashboard | Not a member of the team |
| `Forbidden` | 403 | Roster | Insufficient permissions |
| `RoleForbidden` | 403 | Role | Insufficient permissions for role operations |
| `GroupForbidden` | 403 | Group | Insufficient permissions for group operations |
| `EventRsvpForbidden` | 403 | Event RSVP | Not authorized to view/submit RSVPs |
| `TrainingTypeForbidden` | 403 | Training Type | Insufficient permissions |
| `AgeThresholdForbidden` | 403 | Age Threshold | Missing `team:manage` permission |
| `ActivityLogForbidden` | 403 | Activity Log | Not authorized for this member's logs |
| `ActivityStatsForbidden` | 403 | Activity Stats | Not authorized for this member's stats |
| `LeaderboardForbidden` | 403 | Leaderboard | Not a member of this team |
| `NotificationForbidden` | 403 | Notification | Notification does not belong to the authenticated user, or the user is no longer an active member of the notification's team |
| `ActivityLogMemberInactive` | 403 | Activity Log | Member has been deactivated |
| `ActivityLogAutoSourceForbidden` | 403 | Activity Log | Attempted to edit/delete an auto-logged entry |
| `ActivityLogInvalidLoggedAtDate` | 400 | Activity Log | `loggedAtDate` is not a valid `YYYY-MM-DD` date or is outside the ±2-year window |
| `Forbidden` | 403 | Invite | Missing `team:invite` permission |
| `PlayerNotFound` | 404 | Roster | Team member does not exist |
| `RosterNotFound` | 404 | Roster | Roster does not exist |
| `RoleNotFound` | 404 | Role | Role does not exist |
| `MemberNotFound` | 404 | Role | Team member does not exist |
| `GroupNotFound` | 404 | Group | Group does not exist |
| `AgeThresholdGroupNotFound` | 404 | Age Threshold | Target group (`groupId`) or required group (`requiredGroupId`) does not exist or belongs to a different team |
| `GroupMemberNotFound` | 404 | Group | Member not found in the group context |
| `EventNotFound` | 404 | Event | Event does not exist |
| `EventRsvpEventNotFound` | 404 | Event RSVP | Event does not exist |
| `EventSeriesNotFound` | 404 | Event Series | Series does not exist |
| `TrainingTypeNotFound` | 404 | Training Type | Training type does not exist |
| `AgeThresholdRuleNotFound` | 404 | Age Threshold | Rule does not exist |
| `ActivityLogMemberNotFound` | 404 | Activity Log | Member does not exist |
| `ActivityLogNotFound` | 404 | Activity Log | Log entry does not exist |
| `ActivityStatsMemberNotFound` | 404 | Activity Stats | Member does not exist |
| `InviteNotFound` | 404 | Invite | Invite code does not exist or is disabled |
| `NotificationNotFound` | 404 | Notification | Notification does not exist |
| `ICalTokenNotFound` | 404 | iCal | iCal token is invalid |
| `CannotModifyBuiltIn` | 400 | Role | Attempted to edit or delete a built-in role |
| `EventCancelled` | 400 | Event | Attempted to update an already-cancelled event |
| `EventSeriesCancelled` | 400 | Event Series | Attempted to update an already-cancelled series |
| `RsvpDeadlinePassed` | 400 | Event RSVP | RSVP deadline has passed for this event |
| `AgeThresholdSelfRequired` | 400 | Age Threshold | `requiredGroupId` equals the rule's target `groupId` |
| `RoleNameAlreadyTaken` | 409 | Role | A role with this name already exists |
| `GroupNameAlreadyTaken` | 409 | Group | A group with this name already exists |
| `TrainingTypeNameAlreadyTaken` | 409 | Training Type | A training type with this name exists |
| `AgeThresholdAlreadyExists` | 409 | Age Threshold | A rule already exists for this group |
| `RoleInUse` | 409 | Role | Role is currently assigned to members |
| `AlreadyMember` | 409 | Invite | User is already a member of the team |
| `AchievementForbidden` | 403 | Achievement | Not a team member or missing `team:manage` permission |
| `AchievementNotFound` | 404 | Achievement | Built-in achievement slug does not exist |
| `CustomAchievementNotFound` | 404 | Achievement | Custom achievement ID does not exist or belongs to a different team |
| `CustomAchievementNameTaken` | 409 | Achievement | A custom achievement with the given name already exists for the team |
| `InvalidThreshold` | 400 | Achievement | Threshold value is zero or negative |
| `InvalidCustomRule` | 400 | Achievement | Invalid `ruleKind`/`activityTypeSlug` combination (e.g. `activity_type_count` without a slug) |
| `NoGuildLinked` | 400 | Achievement | `auto_create` role mapping requested but the team has no linked Discord guild |
| `WeeklySummaryForbidden` | 403 | Weekly Summary | Caller is not a member of the team |
| `WeeklySummaryNotFound` | 404 | Weekly Summary | The `week` query parameter is syntactically invalid |
| `TranslationForbidden` | 403 | Translations | Caller is not a global admin |
| `FinanceForbidden` | 403 | Finance | Missing required finance permission (`finance:view`, `finance:manage_fees`, or `finance:record_payments`) |
| `FeeNotFound` | 404 | Finance | Fee does not exist or does not belong to this team |
| `AssignmentNotFound` | 404 | Finance | Fee assignment does not exist |
| `PaymentNotFound` | 404 | Finance | Payment does not exist |
| `InvalidAmount` | 400 | Finance | Amount is negative (or zero for payments) |
| `FeeArchived` | 409 | Finance | Fee is archived; the operation requires an active fee |
| `UnknownTranslationKeys` | 400 | Translations | Import payload contains key(s) not present in the compiled message registry |
| `ExpenseForbidden` | 403 | Expenses | Missing required finance permission (`finance:view` for reads, `finance:manage_fees` for writes) |
| `ExpenseNotFound` | 404 | Expenses | Expense does not exist or does not belong to this team |
| `InvalidExpenseAmount` | 400 | Expenses | `amountMinor` is zero or negative, or `currency` was supplied without `amountMinor` on a partial update |
| `OnboardingForbidden` | 403 | Team Onboarding | Caller is not a global admin (mint/list/revoke token endpoints) |
| `OnboardingTokenNotFound` | 404 | Team Onboarding | Token does not exist |
| `OnboardingTokenExpired` | 410 | Team Onboarding | Token TTL has elapsed |
| `OnboardingTokenAlreadyConsumed` | 409 | Team Onboarding | Token was already used to complete onboarding |
| `OnboardingTokenRevoked` | 410 | Team Onboarding | Token was manually revoked by a global admin |
| `OnboardingWrongCaptain` | 403 | Team Onboarding | Authenticated user's Discord ID does not match the token's `boundDiscordId` |
| `OnboardingGuildAlreadyClaimed` | 409 | Team Onboarding | Another team is already linked to the selected Discord guild |
| `WeeklyChallengeForbidden` | 403 | Weekly Challenge | Not a member of the team, or missing `team:manage` permission for write operations |
| `WeeklyChallengeNotFound` | 404 | Weekly Challenge | Challenge does not exist or does not belong to this team |
| `WeeklyChallengeNotActive` | 409 | Weekly Challenge | Mark/unmark attempted on a challenge whose week is not the current week |
| `WeeklyChallengeAlreadyExistsForWeek` | 409 | Weekly Challenge | A challenge already exists for the given `weekStart` |
| `WeeklyChallengeWeekOutOfRange` | 422 | Weekly Challenge | `weekStart` is not a Monday, or is more than one week outside the allowed window |
| `DashboardLayoutForbidden` | 403 | Dashboard Layout | Not a member of this team |
| `ChannelForbidden` | 403 | Channel | Not a member of this team, or missing `group:manage` permission |
| `ChannelNotFound` | 404 | Channel | Channel does not exist or belongs to a different team |
| `ChannelNameAlreadyTaken` | 409 | Channel | An active channel with this name already exists for this team |
| `ArchiveCategoryNotConfigured` | 409 | Channel | `archiveDiscordChannel` or `bulkArchiveDiscordChannels` was called but `team_settings.discord_archive_category_id` is not set |
| `ChannelNotArchivable` | 409 | Channel | The target Discord channel is already in the archive category or is a category channel |
| `ChannelNotAdoptable` | 409 | Channel | `adoptDiscordChannel` was called on a non-text channel (type ≠ 0) |
| `ChannelAdoptionNameConflict` | 409 | Channel | `adoptDiscordChannel` would create a name conflict with an existing active managed channel |
