/**
 * The one row skeleton every `EntityRef` kind renders through (design §3.4), modelled on
 * `PlayerCard.tsx`'s compact-entity idiom (`h-12 w-full rounded-md border px-2`). The row is
 * ALWAYS exactly one `<a>` — nothing interactive is ever nested inside it (the
 * `EffectiveRolesList` hazard this design explicitly avoids, §3.4).
 *
 * `renderLink` is a render-prop rather than raw `to`/`params` props: TanStack Router's `<Link
 * to>` is typed as a literal union tied 1:1 to its `params` shape, so a generic pass-through
 * prop here would force either a second generic type parameter threaded through every call site
 * or an `as never` cast — the exact drift design §3.7 forbids. Instead, `AssistantResultCard`'s
 * per-kind `switch` branches build a fully-typed `<Link to={ENTITY_ROUTE.event} params={{...}}>`
 * directly (one call site per kind, zero casts) and hand it to this row as a closure that
 * receives the row's assembled children.
 *
 * `leading` is rendered as a DIRECT child of the row's own `flex items-center h-12` container,
 * not wrapped in an intermediate `<span>` — the event kind's leading colour bar
 * (`w-1 self-stretch rounded-full`, design §3.4) needs `self-stretch` to resolve against the
 * row's own cross-axis height, not a shrink-wrapped wrapper's. Callers are responsible for
 * marking their own leading nodes `shrink-0` (a bare icon already is, via its `size-*` class).
 */
import type React from 'react';

interface AssistantResultRowProps {
  leading: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  trailing?: React.ReactNode;
  kindLabel: string;
  renderLink: (children: React.ReactNode, className: string) => React.ReactElement;
}

const ROW_CLASSNAME =
  'flex items-center gap-2 h-12 w-full rounded-md border bg-card px-2 transition-colors ' +
  'hover:bg-accent hover:border-accent-foreground/20 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1';

export function AssistantResultRow({
  leading,
  primary,
  secondary,
  trailing,
  kindLabel,
  renderLink,
}: AssistantResultRowProps) {
  return renderLink(
    <>
      <span className='sr-only'>{kindLabel}: </span>
      {leading}
      <span className='flex min-w-0 flex-1 flex-col justify-center'>
        <span className='truncate text-sm font-medium leading-tight'>{primary}</span>
        {secondary !== undefined && (
          <span className='truncate text-xs text-muted-foreground leading-tight'>{secondary}</span>
        )}
      </span>
      {trailing !== undefined && (
        <span className='flex shrink-0 items-center gap-1'>{trailing}</span>
      )}
    </>,
    ROW_CLASSNAME,
  );
}
