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
   - [Activity Stats](#14-activity-stats)
   - [Leaderboard](#15-leaderboard)
   - [Invite](#16-invite)
   - [Notification](#17-notification)
   - [iCal](#18-ical)
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
| `training-type:create` | Create training types |
| `training-type:delete` | Delete training types |
| `event:create` | Create events |
| `event:edit` | Edit events |
| `event:cancel` | Cancel events |

#### Built-in Roles

Three roles are automatically created for every new team and cannot be deleted or renamed:

| Role | Default Permissions |
|---|---|
| **Admin** | All 14 permissions |
| **Captain** | `roster:view`, `roster:manage`, `member:view`, `member:edit`, `role:view`, `event:create`, `event:edit`, `event:cancel` |
| **Player** | `roster:view`, `member:view` |

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
| `members` | `{ memberId: TeamMemberId, name: string \| null, username: string }[]` | No | Members in this group |

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

Age threshold rules define which group a member should belong to based on their age. The `AgeCheckCron` runs daily and automatically moves members between groups based on these rules.

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

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |

---

#### `POST /teams/:teamId/age-thresholds`

Creates a new age threshold rule.

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
| `minAge` | `number \| null` | Yes | Minimum age; null for no lower bound |
| `maxAge` | `number \| null` | Yes | Maximum age; null for no upper bound |

**Response:** `201 Created` — `AgeThresholdInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |
| `AgeThresholdGroupNotFound` | 404 | Group does not exist |
| `AgeThresholdAlreadyExists` | 409 | A rule already exists for this group |

---

#### `PATCH /teams/:teamId/age-thresholds/:ruleId`

Updates an age threshold rule's age bounds.

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
| `minAge` | `number \| null` | Yes | New minimum age; null for no lower bound |
| `maxAge` | `number \| null` | Yes | New maximum age; null for no upper bound |

**Response:** `200 OK` — `AgeThresholdInfo`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `AgeThresholdForbidden` | 403 | Missing `team:manage` permission |
| `AgeThresholdRuleNotFound` | 404 | Rule does not exist |

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

**Response:** `201 Created` — `ActivityLogEntry`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogMemberNotFound` | 404 | Member does not exist |
| `ActivityLogForbidden` | 403 | Not authorized to log for this member |
| `ActivityLogMemberInactive` | 403 | Member is deactivated |

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

**Response:** `200 OK` — `ActivityLogEntry`

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogNotFound` | 404 | Log entry does not exist |
| `ActivityLogForbidden` | 403 | Not authorized |
| `ActivityLogMemberInactive` | 403 | Member is deactivated |
| `ActivityLogAutoSourceForbidden` | 403 | Entry was auto-logged and cannot be edited |

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

#### `GET /teams/:teamId/activity-types`

Lists all activity types available in a team (global built-ins plus any team-specific types).

**Auth:** Bearer token (AuthMiddleware)

**Path Parameters:**

| Name | Type | Description |
|---|---|---|
| `teamId` | `TeamId` (string) | Team ID |

**Response:** `200 OK` — `ActivityTypeListResponse`

| Field | Type | Description |
|---|---|---|
| `activityTypes` | `ActivityTypeEntry[]` | Available activity types |

`ActivityTypeEntry`:

| Field | Type | Nullable | Description |
|---|---|---|---|
| `id` | `ActivityTypeId` | No | Activity type ID |
| `name` | `string` | No | Display name (e.g. `"gym"`, `"running"`) |
| `slug` | `string \| null` | Yes | Machine-readable slug for built-in types |

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityLogForbidden` | 403 | Not a member of this team |

---

### 14. Activity Stats

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

**Errors:**

| Tag | Status | When |
|---|---|---|
| `ActivityStatsMemberNotFound` | 404 | Member does not exist |
| `ActivityStatsForbidden` | 403 | Not authorized to view this member's stats |

---

### 15. Leaderboard

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

**Errors:**

| Tag | Status | When |
|---|---|---|
| `LeaderboardForbidden` | 403 | Not a member of this team |

---

### 16. Invite

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

**Errors:**

| Tag | Status | When |
|---|---|---|
| `InviteNotFound` | 404 | Invite code does not exist or is disabled |
| `AlreadyMember` | 409 | User is already a member of this team |

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

### 17. Notification

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
| `NotificationForbidden` | 403 | Notification does not belong to the authenticated user |
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

### 18. iCal

**Source:** `packages/domain/src/api/ICalApi.ts`

The iCal API provides a personalized calendar feed for each user. The token is user-specific and persists across sessions.

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

---

## RPC API

The RPC API is an internal HTTP endpoint used exclusively for communication between the Discord bot and the server. It is not intended for external consumption.

**Endpoint:** `{RPC_PREFIX}/` (configurable via the `RPC_PREFIX` environment variable; defaults to empty string in development)

**Protocol:** Effect RPC over HTTP (`@effect/rpc`)

**Transport:** All requests are HTTP POST with a JSON payload. The bot acts as the RPC client; the server acts as the RPC handler.

### RPC Groups

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

Manages Discord channel mappings and channel sync outbox processing.

| Method | Payload / Returns | Description |
|---|---|---|
| `Channel/GetUnprocessedEvents` | `limit` → `UnprocessedChannelEvent[]` | Polls for channel sync outbox events |
| `Channel/MarkEventProcessed` | `id` | Marks a channel sync event as processed |
| `Channel/MarkEventFailed` | `id`, `error` | Marks a channel sync event as failed |
| `Channel/GetMapping` | `team_id`, `group_id` → `ChannelMapping \| null` | Gets the Discord channel mapping for a group |
| `Channel/UpsertMapping` | `team_id`, `group_id`, `discord_channel_id`, `discord_role_id` | Creates or updates a channel mapping |
| `Channel/DeleteMapping` | `team_id`, `group_id` | Removes a channel mapping |

#### Activity

Handles activity logging and stats retrieval from the bot.

| Method | Payload / Returns | Description |
|---|---|---|
| `Activity/LogActivity` | `guild_id`, `discord_user_id`, `activity_type`, `duration_minutes`, `note` → `LogActivityResult` | Logs an activity for a member |
| `Activity/GetStats` | `guild_id`, `discord_user_id` → `GetStatsResult` | Returns activity stats for a member |
| `Activity/GetLeaderboard` | `guild_id`, `discord_user_id`, `limit` → `GetLeaderboardResult` | Returns the leaderboard for a guild |

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
| `NotificationForbidden` | 403 | Notification | Not a member of the team |
| `ActivityLogMemberInactive` | 403 | Activity Log | Member has been deactivated |
| `ActivityLogAutoSourceForbidden` | 403 | Activity Log | Attempted to edit/delete an auto-logged entry |
| `Forbidden` | 403 | Invite | Missing `team:invite` permission |
| `PlayerNotFound` | 404 | Roster | Team member does not exist |
| `RosterNotFound` | 404 | Roster | Roster does not exist |
| `RoleNotFound` | 404 | Role | Role does not exist |
| `MemberNotFound` | 404 | Role | Team member does not exist |
| `GroupNotFound` | 404 | Group | Group does not exist |
| `GroupMemberNotFound` | 404 | Group | Member not found in the group context |
| `EventNotFound` | 404 | Event | Event does not exist |
| `EventRsvpEventNotFound` | 404 | Event RSVP | Event does not exist |
| `EventSeriesNotFound` | 404 | Event Series | Series does not exist |
| `TrainingTypeNotFound` | 404 | Training Type | Training type does not exist |
| `AgeThresholdRuleNotFound` | 404 | Age Threshold | Rule does not exist |
| `AgeThresholdGroupNotFound` | 404 | Age Threshold | Target group does not exist |
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
| `RoleNameAlreadyTaken` | 409 | Role | A role with this name already exists |
| `GroupNameAlreadyTaken` | 409 | Group | A group with this name already exists |
| `TrainingTypeNameAlreadyTaken` | 409 | Training Type | A training type with this name exists |
| `AgeThresholdAlreadyExists` | 409 | Age Threshold | A rule already exists for this group |
| `RoleInUse` | 409 | Role | Role is currently assigned to members |
| `AlreadyMember` | 409 | Invite | User is already a member of the team |
