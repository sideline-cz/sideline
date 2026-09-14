/**
 * One resolved `[[ref:<token>]]` marker, rendered as a real `<Link>` styled to look like a
 * `Badge` (design §3.6). `badgeVariants` ships `[a&]:hover:` variants precisely so an anchor can
 * be styled like a badge without becoming one — `Badge` itself is a bare, non-interactive
 * `<span>` (`AGENTS.md` "Interactive Triggers" rule), so an inline citation MUST be a `<Link>`,
 * never a `Badge` with a click handler.
 *
 * P1 (design §3.1) — the visible label is always the reference's own typed data
 * (`title` / `displayName` / `name`), never prose the model wrote around the marker.
 *
 * Owns the single exhaustive `switch (reference.kind)` that builds each of the five routes'
 * `params` objects, so every branch is narrowed and typed by the router (design §3.7).
 */
import type { AiChatApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Calendar, Dumbbell, UserCog, Users, UsersRound } from 'lucide-react';
import { badgeVariants } from '~/components/ui/badge';
import { ENTITY_ROUTE, entityKindLabels } from '~/lib/assistant/entityRoutes.js';
import { cn } from '~/lib/utils';

interface AssistantEntityLinkProps {
  reference: AiChatApi.EntityRef;
  teamId: string;
  className?: string;
}

const LINK_CLASSNAME =
  'gap-1 align-baseline hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function AssistantEntityLink({ reference, teamId, className }: AssistantEntityLinkProps) {
  const linkClassName = cn(badgeVariants({ variant: 'outline' }), LINK_CLASSNAME, className);

  switch (reference.kind) {
    case 'event':
      return (
        <Link
          to={ENTITY_ROUTE.event}
          params={{ teamId, eventId: reference.event.eventId }}
          className={linkClassName}
        >
          <Calendar className='size-3' aria-hidden='true' />
          <span className='sr-only'>{entityKindLabels.event()}: </span>
          {reference.event.title}
        </Link>
      );
    case 'member':
      return (
        <Link
          to={ENTITY_ROUTE.member}
          params={{ teamId, memberId: reference.memberId }}
          className={linkClassName}
        >
          <Users className='size-3' aria-hidden='true' />
          <span className='sr-only'>{entityKindLabels.member()}: </span>
          {reference.displayName}
        </Link>
      );
    case 'group':
      return (
        <Link
          to={ENTITY_ROUTE.group}
          params={{ teamId, groupId: reference.group.groupId }}
          className={linkClassName}
        >
          <UserCog className='size-3' aria-hidden='true' />
          <span className='sr-only'>{entityKindLabels.group()}: </span>
          {reference.group.name}
        </Link>
      );
    case 'roster':
      return (
        <Link
          to={ENTITY_ROUTE.roster}
          params={{ teamId, rosterId: reference.roster.rosterId }}
          className={linkClassName}
        >
          <UsersRound className='size-3' aria-hidden='true' />
          <span className='sr-only'>{entityKindLabels.roster()}: </span>
          {reference.roster.name}
        </Link>
      );
    case 'trainingType':
      return (
        <Link
          to={ENTITY_ROUTE.trainingType}
          params={{ teamId, trainingTypeId: reference.trainingType.trainingTypeId }}
          className={linkClassName}
        >
          <Dumbbell className='size-3' aria-hidden='true' />
          <span className='sr-only'>{entityKindLabels.trainingType()}: </span>
          {reference.trainingType.name}
        </Link>
      );
  }
}
