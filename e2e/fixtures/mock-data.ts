export const TEAM_ID = 'test-team-00000001';
export const USER_ID = 'test-user-00000001';
export const MEMBER_ID = 'test-member-00000001';
export const EVENT_ID = 'test-event-00000001';
export const ROSTER_ID = 'test-roster-00000001';
export const ROLE_ID = 'test-role-00000001';
export const GROUP_ID = 'test-group-00000001';
export const TRAINING_TYPE_ID = 'test-training-type-00000001';
export const NOTIFICATION_ID = 'test-notification-00000001';
export const INVITE_CODE = 'test-invite-abc123';

export const mockLoginUrl = 'https://discord.com/oauth2/authorize?fake=true';

export const mockCurrentUser = {
  id: USER_ID,
  discordId: '123456789',
  username: 'testuser',
  avatar: null,
  isProfileComplete: true,
  name: 'Test User',
  birthDate: null,
  gender: null,
  locale: 'en',
  isGlobalAdmin: false,
};

export const mockIncompleteUser = {
  ...mockCurrentUser,
  isProfileComplete: false,
  name: null,
};

export const mockUserTeams = [
  {
    teamId: TEAM_ID,
    teamName: 'Test Team',
    logoUrl: null,
    roleNames: ['Admin'],
    permissions: [
      'team:manage',
      'team:invite',
      'roster:view',
      'roster:manage',
      'member:view',
      'member:edit',
      'member:remove',
      'role:view',
      'role:manage',
      'activity-type:create',
      'activity-type:delete',
      'training-type:create',
      'training-type:delete',
      'event:create',
      'event:edit',
      'event:cancel',
      'group:manage',
      'finance:view',
      'finance:manage_fees',
      'finance:record_payments',
    ],
  },
];

export const mockTeamInfo = {
  teamId: TEAM_ID,
  name: 'Test Team',
  description: 'A test team for e2e testing',
  sport: 'Football',
  logoUrl: null,
  guildId: '987654321',
  welcomeChannelId: null,
  systemLogChannelId: null,
  welcomeMessageTemplate: null,
  rulesChannelId: null,
  onboardingRulesRoleId: null,
  onboardingLocale: 'en',
  onboardingSyncStatus: 'pending',
  onboardingSyncedAt: null,
  onboardingSyncError: null,
  isCommunityEnabled: true,
};

export const mockDashboardResponse = {
  upcomingEvents: [
    {
      eventId: EVENT_ID,
      title: 'Weekly Training',
      eventType: 'training',
      startAt: '2026-04-05T14:00:00.000Z',
      endAt: '2026-04-05T16:00:00.000Z',
      location: 'Main Field',
      locationUrl: null,
      myRsvp: 'yes',
    },
  ],
  awaitingRsvp: [
    {
      eventId: 'test-event-00000002',
      title: 'Friendly Match',
      eventType: 'match',
      startAt: '2026-04-10T18:00:00.000Z',
      endAt: '2026-04-10T20:00:00.000Z',
      location: 'City Stadium',
      locationUrl: null,
    },
  ],
  activitySummary: {
    currentStreak: 5,
    longestStreak: 10,
    totalActivities: 42,
    totalDurationMinutes: 1260,
    leaderboardRank: 3,
    leaderboardTotal: 15,
    recentActivityCount: 7,
  },
  myMemberId: MEMBER_ID,
};

export const mockEventList = {
  canCreate: true,
  events: [
    {
      eventId: EVENT_ID,
      teamId: TEAM_ID,
      title: 'Weekly Training',
      eventType: 'training',
      trainingTypeName: 'Goalkeeping',
      description: null,
      imageUrl: null,
      startAt: '2026-04-05T14:00:00.000Z',
      endAt: '2026-04-05T16:00:00.000Z',
      location: 'Main Field',
      locationUrl: null,
      status: 'active',
      seriesId: null,
    },
    {
      eventId: 'test-event-00000002',
      teamId: TEAM_ID,
      title: 'Friendly Match',
      eventType: 'match',
      trainingTypeName: null,
      description: null,
      imageUrl: null,
      startAt: '2026-04-10T18:00:00.000Z',
      endAt: '2026-04-10T20:00:00.000Z',
      location: 'City Stadium',
      locationUrl: null,
      status: 'active',
      seriesId: null,
    },
  ],
};

export const mockEventDetail = {
  eventId: EVENT_ID,
  teamId: TEAM_ID,
  title: 'Weekly Training',
  eventType: 'training',
  trainingTypeId: TRAINING_TYPE_ID,
  trainingTypeName: 'Goalkeeping',
  description: 'Regular weekly training session',
  imageUrl: null,
  startAt: '2026-04-05T14:00:00.000Z',
  endAt: '2026-04-05T16:00:00.000Z',
  location: 'Main Field',
  locationUrl: null,
  status: 'active',
  createdByName: 'Test User',
  canEdit: true,
  canCancel: true,
  seriesId: null,
  seriesModified: false,
  discordChannelId: null,
  ownerGroupId: null,
  ownerGroupName: null,
  memberGroupId: null,
  memberGroupName: null,
};

export const mockEventRsvpDetail = {
  myResponse: 'yes',
  myMessage: null,
  rsvps: [
    {
      teamMemberId: MEMBER_ID,
      memberName: 'Test User',
      username: 'testuser',
      response: 'yes',
      message: null,
    },
  ],
  yesCount: 1,
  noCount: 0,
  maybeCount: 0,
  canRsvp: true,
  minPlayersThreshold: 10,
};

export const mockMembers = [
  {
    memberId: MEMBER_ID,
    userId: USER_ID,
    discordId: '123456789',
    roleNames: ['Admin'],
    permissions: ['member:edit', 'member:remove'],
    name: 'Test User',
    birthDate: null,
    gender: null,
    jerseyNumber: 7,
    username: 'testuser',
    avatar: null,
  },
  {
    memberId: 'test-member-00000002',
    userId: 'test-user-00000002',
    discordId: '987654321',
    roleNames: ['Player'],
    permissions: [],
    name: 'Jane Player',
    birthDate: '2000-05-15',
    gender: 'female',
    jerseyNumber: 11,
    username: 'janeplayer',
    avatar: null,
  },
];

export const mockRoleList = {
  canManage: true,
  roles: [
    {
      roleId: ROLE_ID,
      teamId: TEAM_ID,
      name: 'Admin',
      isBuiltIn: true,
      permissionCount: 10,
    },
    {
      roleId: 'test-role-00000002',
      teamId: TEAM_ID,
      name: 'Coach',
      isBuiltIn: false,
      permissionCount: 5,
    },
  ],
};

export const mockGroups = [
  {
    groupId: GROUP_ID,
    teamId: TEAM_ID,
    parentId: null,
    name: 'Attackers',
    emoji: null,
    color: null,
    memberCount: 5,
    discordChannelProvisioning: false,
  },
];

export const mockRosterList = {
  canManage: true,
  rosters: [
    {
      rosterId: ROSTER_ID,
      teamId: TEAM_ID,
      name: 'Main Roster',
      active: true,
      memberCount: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
      color: null,
      emoji: null,
      discordChannelId: null,
      discordChannelName: null,
      discordChannelProvisioning: false,
    },
  ],
};

export const mockTrainingTypeList = {
  canAdmin: true,
  trainingTypes: [
    {
      trainingTypeId: TRAINING_TYPE_ID,
      teamId: TEAM_ID,
      name: 'Goalkeeping',
      ownerGroupName: null,
      memberGroupName: null,
    },
  ],
};

export const mockNotifications = [
  {
    notificationId: NOTIFICATION_ID,
    teamId: TEAM_ID,
    type: 'role_assigned',
    title: 'New Event Created',
    body: 'Weekly Training has been scheduled',
    isRead: false,
    createdAt: '2026-03-28T10:00:00.000Z',
  },
];

export const mockInviteInfo = {
  teamName: 'Test Team',
  teamId: TEAM_ID,
  code: INVITE_CODE,
  groupName: null,
  inviterName: null,
};

export const mockInviteList = [
  {
    id: 'test-invite-id-00001',
    code: INVITE_CODE,
    active: true,
    groupId: null,
    groupName: null,
    inviterName: 'Test Captain',
    expiresAt: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    createdBy: USER_ID,
  },
];

export const mockCreatedInvite = {
  code: 'newly-created-code',
  active: true,
};

export const mockTeamSettings = {
  teamId: TEAM_ID,
  eventHorizonDays: 30,
  minPlayersThreshold: 10,
  rsvpRemindersEnabled: true,
  rsvpReminderDaysBefore: 1,
  rsvpReminderTime: '18:00',
  remindersChannelId: null,
  timezone: 'Europe/Prague',
  createDiscordChannelOnGroup: true,
  createDiscordChannelOnRoster: true,
  discordChannelTraining: null,
  discordChannelMatch: null,
  discordChannelTournament: null,
  discordChannelMeeting: null,
  discordChannelSocial: null,
  discordChannelOther: null,
  discordChannelLateRsvp: null,
  discordArchiveCategoryId: null,
  discordChannelCleanupOnGroupDelete: 'delete',
  discordChannelCleanupOnRosterDeactivate: 'delete',
  discordRoleFormat: '{emoji} {name}',
  discordChannelFormat: '{emoji}│{name}',
};

export const mockDiscordChannels: unknown[] = [];

export const mockDiscordGuilds = [
  {
    id: '987654321',
    name: 'Test Guild',
    icon: null,
    owner: true,
    botPresent: true,
  },
];

export const mockLeaderboard = {
  entries: [
    {
      rank: 1,
      teamMemberId: MEMBER_ID,
      userId: USER_ID,
      username: 'testuser',
      name: 'Test User',
      totalActivities: 42,
      totalDurationMinutes: 1260,
      currentStreak: 5,
      longestStreak: 10,
    },
  ],
};
