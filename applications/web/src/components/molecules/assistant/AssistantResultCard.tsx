/**
 * Dispatches one `AiChatApi.EntityRef` to its per-kind row (design §3.2 / §3.4). P1 — this
 * renders ONLY server-held typed data via the app's existing helpers
 * (`formatEventDateRange`, `getEventColor`, `eventStatusLabels`/`eventStatusClasses`,
 * `resolveEffectiveRoles`/`sortEffectiveRoles`, `ColorDot`, `RoleBadge`) — never model prose,
 * and never a route derived from anything the model emitted (`ENTITY_ROUTE` only).
 *
 * Each branch builds its own fully-typed `<Link to={ENTITY_ROUTE.<kind>} params={{...}}>` and
 * hands it to `AssistantResultRow` as the `renderLink` closure — see that file's header comment
 * for why (cast-free literal-type propagation, design §3.7).
 */
import type { AiChatApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { Calendar, Dumbbell, UserCog, UsersRound } from 'lucide-react';
import { ColorDot } from '~/components/atoms/ColorDot.js';
import { AssistantResultRow } from '~/components/molecules/assistant/AssistantResultRow.js';
import { RoleBadge } from '~/components/molecules/RoleBadge.js';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { useIsMobile } from '~/hooks/use-mobile.js';
import { ENTITY_ROUTE, entityKindLabels } from '~/lib/assistant/entityRoutes.js';
import { formatEventDateRange } from '~/lib/datetime.js';
import type { TrainingTypeColorMap } from '~/lib/event-colors.js';
import { getEventColor } from '~/lib/event-colors.js';
import { eventStatusClasses, eventStatusLabels, eventTypeLabels } from '~/lib/event-labels.js';
import { resolveEffectiveRoles } from '~/lib/roles/resolveEffectiveRoles.js';
import { sortEffectiveRoles } from '~/lib/roles/role-order.js';
import { tr } from '~/lib/translations.js';

interface AssistantResultCardProps {
  reference: AiChatApi.EntityRef;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}

export function AssistantResultCard({ reference, teamId, colorMap }: AssistantResultCardProps) {
  const isMobile = useIsMobile();

  switch (reference.kind) {
    case 'event': {
      const { event } = reference;
      const trainingTypeName = Option.getOrNull(event.trainingTypeName);
      const color = getEventColor(event.eventType, trainingTypeName, colorMap);
      const { startDate, startTime, end } = formatEventDateRange(
        event.startAt,
        event.endAt,
        event.allDay,
        event.startDate,
        event.endDate,
      );
      const start = event.allDay ? startDate : `${startDate} ${startTime}`;
      const range = Option.match(end, { onNone: () => start, onSome: (e) => `${start} – ${e}` });
      const secondary = [
        range,
        event.allDay ? tr('event_allDayLabel') : undefined,
        eventTypeLabels[event.eventType](),
        Option.getOrUndefined(event.location),
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ');

      return (
        <AssistantResultRow
          kindLabel={entityKindLabels.event()}
          leading={
            <>
              <span className={`w-1 self-stretch rounded-full ${color.dot}`} aria-hidden='true' />
              <Calendar
                className='mx-1.5 size-4 shrink-0 text-muted-foreground'
                aria-hidden='true'
              />
            </>
          }
          primary={event.title}
          secondary={secondary}
          trailing={
            <Badge variant='outline' className={eventStatusClasses[event.status]}>
              {eventStatusLabels[event.status]()}
            </Badge>
          }
          renderLink={(children, className) => (
            <Link
              to={ENTITY_ROUTE.event}
              params={{ teamId, eventId: event.eventId }}
              className={className}
            >
              {children}
            </Link>
          )}
        />
      );
    }
    case 'member': {
      const roles = sortEffectiveRoles(resolveEffectiveRoles(reference));
      const limit = isMobile ? 1 : 2;
      const visibleRoles = roles.slice(0, limit);
      const hiddenCount = roles.length - visibleRoles.length;
      const jerseyLabel = Option.map(reference.jerseyNumber, (n) => `#${n}`);
      const hasSecondary = Option.isSome(jerseyLabel) || roles.length > 0;
      const avatarUrl = Option.getOrUndefined(reference.avatarUrl);
      const initials = reference.displayName.slice(0, 2).toUpperCase();

      return (
        <AssistantResultRow
          kindLabel={entityKindLabels.member()}
          leading={
            <Avatar className='size-8 shrink-0'>
              {avatarUrl !== undefined && (
                <AvatarImage src={avatarUrl} alt={reference.displayName} />
              )}
              <AvatarFallback className='text-xs'>{initials}</AvatarFallback>
            </Avatar>
          }
          primary={reference.displayName}
          secondary={
            hasSecondary ? (
              <span className='flex items-center gap-1'>
                {Option.isSome(jerseyLabel) && <span>{jerseyLabel.value}</span>}
                {visibleRoles.map((role) => (
                  <RoleBadge key={role.roleId} role={role} />
                ))}
                {hiddenCount > 0 && <Badge variant='secondary'>+{hiddenCount}</Badge>}
              </span>
            ) : undefined
          }
          trailing={
            reference.active === false ? (
              <Badge variant='outline'>{tr('roster_inactive')}</Badge>
            ) : undefined
          }
          renderLink={(children, className) => (
            <Link
              to={ENTITY_ROUTE.member}
              params={{ teamId, memberId: reference.memberId }}
              className={className}
            >
              {children}
            </Link>
          )}
        />
      );
    }
    case 'group': {
      const { group } = reference;
      const primary = Option.isSome(group.emoji)
        ? `${group.emoji.value} ${group.name}`
        : group.name;

      return (
        <AssistantResultRow
          kindLabel={entityKindLabels.group()}
          leading={<UserCog className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />}
          primary={primary}
          secondary={tr('group_memberCount', { count: group.memberCount })}
          trailing={<ColorDot color={Option.getOrUndefined(group.color)} />}
          renderLink={(children, className) => (
            <Link
              to={ENTITY_ROUTE.group}
              params={{ teamId, groupId: group.groupId }}
              className={className}
            >
              {children}
            </Link>
          )}
        />
      );
    }
    case 'roster': {
      const { roster } = reference;
      const primary = Option.isSome(roster.emoji)
        ? `${roster.emoji.value} ${roster.name}`
        : roster.name;

      return (
        <AssistantResultRow
          kindLabel={entityKindLabels.roster()}
          leading={
            <UsersRound className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
          }
          primary={primary}
          secondary={tr('roster_memberCount', { count: roster.memberCount })}
          trailing={
            <>
              <ColorDot color={Option.getOrUndefined(roster.color)} />
              <Badge variant={roster.active ? 'success' : 'outline'}>
                {roster.active ? tr('roster_active') : tr('roster_inactive')}
              </Badge>
            </>
          }
          renderLink={(children, className) => (
            <Link
              to={ENTITY_ROUTE.roster}
              params={{ teamId, rosterId: roster.rosterId }}
              className={className}
            >
              {children}
            </Link>
          )}
        />
      );
    }
    case 'trainingType': {
      const { trainingType } = reference;
      const hasGroup =
        Option.isSome(trainingType.ownerGroupName) || Option.isSome(trainingType.memberGroupName);
      const secondary = hasGroup
        ? `${Option.getOrElse(trainingType.ownerGroupName, () => tr('trainingType_noGroup'))} / ${Option.getOrElse(
            trainingType.memberGroupName,
            () => tr('trainingType_noGroup'),
          )}`
        : undefined;

      return (
        <AssistantResultRow
          kindLabel={entityKindLabels.trainingType()}
          leading={
            <Dumbbell className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
          }
          primary={trainingType.name}
          secondary={secondary}
          renderLink={(children, className) => (
            <Link
              to={ENTITY_ROUTE.trainingType}
              params={{ teamId, trainingTypeId: trainingType.trainingTypeId }}
              className={className}
            >
              {children}
            </Link>
          )}
        />
      );
    }
  }
}
