import type { FxArrow, FxBubble, FxFlash, FxMark, Lang, Scenario } from '@sideline/rules';
import { actorTeam, createAnimator, text } from '@sideline/rules';
import React from 'react';
import { tr } from '~/lib/translations.js';

// Ported from `~/Projects/frisbee-rules/src/engine/app.js`'s `fieldSVG` /
// `buildFx` / `applyFrame` (lines 81-200). Colours and geometry are kept
// verbatim — this is a straight port to a declarative render driven by `t`,
// not a redesign. Unlike the source, which built the SVG once and then
// imperatively patched attributes on every frame, React just re-renders this
// component whenever `t` changes; there is no separate "build" vs "apply"
// step because there is no persistent DOM to patch.

const PITCH_FILL = '#1c5e3d';
const STRIPE_FILLS = ['#27784f', '#256f4a'] as const;
const ENDZONE_FILL = '#1f6243';
const LINE_STROKE = '#eafff2';
const BRICK_STROKE = '#bfe6d2';
const CORNER_DOT = '#ffd23f';
const OFF_COLOR = '#2f6df6';
const DEF_COLOR = '#e0483d';
const YOU_RING = '#ffd23f';
const DISC_UP_FILL = '#ffe066';
const DISC_UP_STROKE = 'rgba(0,0,0,.35)';
const DISC_DOWN_FILL = '#d9d9cb';
const DISC_DOWN_STROKE = 'rgba(0,0,0,.2)';
const ARROW_COLOR = '#ffd23f';

const STRIPE_X_POSITIONS: readonly number[] = Array.from({ length: 10 }, (_, i) => i * 10);

const CORNER_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 37],
  [100, 0],
  [100, 37],
  [18, 0],
  [18, 37],
  [82, 0],
  [82, 37],
];

/** Stable, content-derived keys for `fx` entries — there is no authored id
 * on `Fx`, and its authored order never changes for a given scenario, but
 * `noArrayIndexKey` wants a key that isn't the bare map index. */
function markOrArrowKey(f: FxMark | FxArrow): string {
  return f.type === 'arrow'
    ? `arrow-${f.t}-${f.x1}-${f.y1}-${f.x2}-${f.y2}`
    : `mark-${f.t}-${f.kind}-${f.x}-${f.y}`;
}

function bubbleOrFlashKey(f: FxBubble | FxFlash): string {
  return f.type === 'bubble' ? `bubble-${f.t}-${f.actor}-${f.style}` : `flash-${f.t}-${f.x}-${f.y}`;
}

interface RulesFieldSvgProps {
  readonly scenario: Scenario;
  readonly t: number;
  readonly locale: Lang;
}

export function RulesFieldSvg({ scenario, t, locale }: RulesFieldSvgProps) {
  const animator = React.useMemo(() => createAnimator(scenario), [scenario]);
  const [vx, vy, vw, vh] = scenario.view;
  const fallbackCenter: readonly [number, number] = [vx + vw / 2, vy + vh / 2];

  const lowFx = scenario.fx.filter(
    (f): f is FxMark | FxArrow => f.type === 'mark' || f.type === 'arrow',
  );
  const highFx = scenario.fx.filter(
    (f): f is FxBubble | FxFlash => f.type === 'bubble' || f.type === 'flash',
  );

  const discPos = animator.discAt(t);
  const discDown = scenario.disc.downAt !== undefined && t >= scenario.disc.downAt;

  return (
    <svg
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      xmlns='http://www.w3.org/2000/svg'
      fontFamily='ui-sans-serif,system-ui,sans-serif'
      role='img'
      aria-label={`${tr('rules_situation', undefined, { locale })}: ${text(scenario.title, locale)}`}
      className='w-full h-auto rounded-md'
    >
      <defs>
        <marker
          id='rules-arrow-head'
          viewBox='0 0 10 10'
          refX={8}
          refY={5}
          markerWidth={4.6}
          markerHeight={4.6}
          orient='auto-start-reverse'
        >
          <path d='M0 0L10 5L0 10z' fill={ARROW_COLOR} />
        </marker>
      </defs>

      <rect x={vx - 2} y={vy - 2} width={vw + 4} height={vh + 4} fill={PITCH_FILL} />
      {STRIPE_X_POSITIONS.map((x) => (
        <rect
          key={`stripe-${x}`}
          x={x}
          y={0}
          width={10}
          height={37}
          fill={STRIPE_FILLS[(x / 10) % 2]}
        />
      ))}
      <rect x={0} y={0} width={18} height={37} fill={ENDZONE_FILL} />
      <rect x={82} y={0} width={18} height={37} fill={ENDZONE_FILL} />
      <rect
        x={0}
        y={0}
        width={100}
        height={37}
        fill='none'
        stroke={LINE_STROKE}
        strokeWidth={0.4}
      />
      <line x1={18} y1={0} x2={18} y2={37} stroke={LINE_STROKE} strokeWidth={0.4} />
      <line x1={82} y1={0} x2={82} y2={37} stroke={LINE_STROKE} strokeWidth={0.4} />
      {[36, 64].map((bx) => (
        <g key={`brick-${bx}`} stroke={BRICK_STROKE} strokeWidth={0.26} opacity={0.85}>
          <line x1={bx - 0.7} y1={18.5} x2={bx + 0.7} y2={18.5} />
          <line x1={bx} y1={17.8} x2={bx} y2={19.2} />
        </g>
      ))}
      {CORNER_POINTS.map(([cx, cy]) => (
        <circle
          key={`corner-${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={0.5}
          fill={CORNER_DOT}
          opacity={0.85}
        />
      ))}

      <g>
        {lowFx.map((f) => (
          <MarkOrArrowFx key={markOrArrowKey(f)} fx={f} scenario={scenario} t={t} locale={locale} />
        ))}
      </g>

      {scenario.actors.map((actor) => {
        const pos = animator.posAt(actor.id, t);
        if (!pos) return null;
        const [x, y] = pos;
        const color = actor.team === 'off' ? OFF_COLOR : DEF_COLOR;
        return (
          <g key={actor.id} transform={`translate(${x} ${y})`}>
            {actor.you === true && (
              <circle r={2.3} fill='none' stroke={YOU_RING} strokeWidth={0.55} />
            )}
            <circle r={1.35} fill={color} stroke='#ffffff' strokeWidth={0.22} />
            <text y={0.45} textAnchor='middle' fontSize={1.15} fontWeight={700} fill='#ffffff'>
              {actor.label}
            </text>
          </g>
        );
      })}

      <g transform={`translate(${discPos[0]} ${discPos[1]})`}>
        <circle
          r={0.78}
          fill={discDown ? DISC_DOWN_FILL : DISC_UP_FILL}
          stroke={discDown ? DISC_DOWN_STROKE : DISC_UP_STROKE}
          strokeWidth={0.12}
        />
        <circle r={0.34} fill='none' stroke='rgba(0,0,0,.2)' strokeWidth={0.1} />
      </g>

      <g>
        {highFx.map((f) => (
          <BubbleOrFlashFx
            key={bubbleOrFlashKey(f)}
            fx={f}
            scenario={scenario}
            t={t}
            locale={locale}
            posAt={animator.posAt}
            fallbackCenter={fallbackCenter}
          />
        ))}
      </g>
    </svg>
  );
}

function MarkOrArrowFx({
  fx,
  scenario,
  t,
  locale,
}: {
  readonly fx: FxMark | FxArrow;
  readonly scenario: Scenario;
  readonly t: number;
  readonly locale: Lang;
}) {
  if (t < fx.t) return null;

  if (fx.type === 'arrow') {
    return (
      <line
        x1={fx.x1}
        y1={fx.y1}
        x2={fx.x2}
        y2={fx.y2}
        stroke={ARROW_COLOR}
        strokeWidth={0.42}
        strokeDasharray='1.3 .8'
        markerEnd='url(#rules-arrow-head)'
      />
    );
  }

  const fsL = scenario.view[2] * 0.019;
  const label = text(fx.label, locale);
  const labelY = fx.kind === 'zone' ? (fx.r ?? 3) + 1.5 : fx.labelAbove === true ? -2.3 : 2.9;

  return (
    <g transform={`translate(${fx.x} ${fx.y})`}>
      {fx.kind === 'x' && (
        <>
          <line
            x1={-1}
            y1={-1}
            x2={1}
            y2={1}
            stroke='#ff8f7a'
            strokeWidth={0.45}
            strokeLinecap='round'
          />
          <line
            x1={-1}
            y1={1}
            x2={1}
            y2={-1}
            stroke='#ff8f7a'
            strokeWidth={0.45}
            strokeLinecap='round'
          />
        </>
      )}
      {fx.kind === 'zone' && (
        <circle
          r={fx.r ?? 3}
          fill='rgba(255,255,255,.07)'
          stroke='#ffffff'
          strokeWidth={0.18}
          strokeDasharray='.9 .7'
          opacity={0.85}
        />
      )}
      {(fx.kind === 'target' || fx.kind === 'dot') && (
        <>
          <circle r={1.25} fill='rgba(255,210,63,.22)' stroke={CORNER_DOT} strokeWidth={0.4} />
          <circle r={0.28} fill={CORNER_DOT} />
        </>
      )}
      {label && (
        <text
          textAnchor='middle'
          y={labelY}
          fontSize={fsL}
          fontWeight={700}
          fill='#ffffff'
          stroke='rgba(10,25,16,.65)'
          strokeWidth={fsL * 0.16}
          paintOrder='stroke'
        >
          {label}
        </text>
      )}
    </g>
  );
}

function BubbleOrFlashFx({
  fx,
  scenario,
  t,
  locale,
  posAt,
  fallbackCenter,
}: {
  readonly fx: FxBubble | FxFlash;
  readonly scenario: Scenario;
  readonly t: number;
  readonly locale: Lang;
  readonly posAt: (actorId: string, t: number) => readonly [number, number] | null;
  readonly fallbackCenter: readonly [number, number];
}) {
  if (fx.type === 'flash') {
    const elapsed = t - fx.t;
    if (elapsed < 0 || elapsed > 0.7) return null;
    const progress = elapsed / 0.7;
    return (
      <g transform={`translate(${fx.x} ${fx.y})`}>
        <circle
          r={0.6 + 3.6 * progress}
          fill='none'
          stroke='#ffffff'
          strokeWidth={0.5}
          opacity={0.95 * (1 - progress)}
        />
        <circle r={0.7} fill='#ffffff' opacity={0.9 * (1 - progress)} />
      </g>
    );
  }

  const on = t >= fx.t && t <= fx.t + (fx.dur || 1.6);
  if (!on) return null;

  const [vx, vy, vw] = scenario.view;
  const fsB = vw * 0.024;
  const txt = text(fx.text, locale);
  const width = txt.length * fsB * 0.62 + fsB * 1.5;
  const height = fsB * 1.8;

  const anchor = posAt(fx.actor, t) ?? fallbackCenter;
  let bx = anchor[0];
  let by = anchor[1] - 2.6 - height * 0.62;
  bx = Math.min(Math.max(bx, vx + width / 2 + 0.8), vx + vw - width / 2 - 0.8);
  if (by - height / 2 < vy + 0.8) by = anchor[1] + 2.6 + height * 0.62;

  const isCall = fx.style === 'call';
  const fill = isCall ? '#ffffff' : 'rgba(18,30,23,.8)';
  const textColor = isCall
    ? actorTeam(scenario, fx.actor) === 'off'
      ? '#1f4fc0'
      : '#b53229'
    : '#ffffff';

  return (
    <g transform={`translate(${bx} ${by})`}>
      <rect
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={height * 0.32}
        fill={fill}
      />
      <text
        textAnchor='middle'
        y={fsB * 0.36}
        fontSize={fsB}
        fontWeight={isCall ? 800 : 600}
        fill={textColor}
      >
        {txt}
      </text>
    </g>
  );
}
