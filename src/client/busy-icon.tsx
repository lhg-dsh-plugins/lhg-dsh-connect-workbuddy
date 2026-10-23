/**
 * The load-level ICONS, drawn as inline SVG.
 *
 * WHY ICONS HERE AND A CHARACTER IN THE PICKER. The DSH model picker renders
 * the model name verbatim, as a string, with no image slot and no markup
 * support — so a level shown THERE has to be a character (`busySymbol`). This
 * module is the other half: the places the plugin renders itself, where a real
 * picture is possible and therefore better.
 *
 * ONE SHAPE, AND THE COUNT CARRIES THE MEANING — WITH ONE EXCEPTION. The
 * crowded levels are a single person, repeated: one for a healthy model, two
 * when a queue has formed, three when the model is congested.
 *
 * `idle` is the exception and gets a ROCKET: nobody is queuing, so the model is
 * free to run at full speed. A different shape is what makes "nobody is
 * waiting" instantly distinct from "one person is waiting" — at 12px, a colour
 * alone is not enough. The crossed-out person for "unavailable" is the other
 * exception, because "nobody can use this" is not a matter of degree: there is
 * no "one and a half unavailable".
 *
 * THE COLOUR IS A RAMP. Green (idle) → yellow (normal) → orange (busy) → red
 * (congested) is an order the eye already knows, so the severity of one row can
 * be compared with another at a glance, without reading a word.
 *
 * WHY THE PERSON IS DRAWN AND NOT TYPED. The picker shows the `🧍` emoji, so a
 * line-drawn stick figure in the card would read as a DIFFERENT thing entirely
 * — two symbols for one meaning. This person therefore has the emoji's own
 * parts: yellow hair, a skin-toned face, a shirt, trousers and shoes. The
 * colour ramp is applied to the CLOTHES only; the hair and the skin keep their
 * own colours, so the figure stays the same person in every level.
 *
 * The shapes are drawn on their own grid and scaled by CSS, so one source
 * serves the 12px model row and any larger size without a second asset.
 */
import type { ReactElement } from 'react'
import type { WorkBuddyBusyIcon, WorkBuddyBusyLevel } from '../busy.ts'

/** The word for a level, in the card's language, for the tooltip. */
const TITLES_ZH: Readonly<Partial<Record<WorkBuddyBusyIcon, string>>> = {
  idle: '空闲',
  normal: '正常',
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
}

const TITLES_EN: Readonly<Partial<Record<WorkBuddyBusyIcon, string>>> = {
  idle: 'Idle',
  normal: 'Normal',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
}

/**
 * The CLOTHES colour per level, as a CSS custom property.
 *
 * These are the ramp: green → yellow → orange → red. The hair and the skin
 * keep their own colours in every level, so a row is recognisably the same
 * person in a different outfit — which is what makes the COUNT readable as
 * "more people, not different people".
 */
const COLORS: Readonly<Record<WorkBuddyBusyIcon, string>> = {
  idle: 'var(--dsm-workbuddy-busy-idle, #3aa76d)',
  normal: 'var(--dsm-workbuddy-busy-normal, #d9b300)',
  busy: 'var(--dsm-workbuddy-busy-busy, #e08a1e)',
  congested: 'var(--dsm-workbuddy-busy-congested, #d93a2b)',
  unavailable: 'var(--dsm-workbuddy-busy-unavailable, #8a8f98)',
}

/** How many people each level draws. */
const PEOPLE: Readonly<Partial<Record<WorkBuddyBusyIcon, number>>> = {
  normal: 1,
  busy: 2,
  congested: 3,
}

/**
 * The icon for a level, or `undefined` when the level is not drawn.
 *
 * Only `unknown` is left out: it is the plugin's own "the probe did not
 * answer", and a badge that guesses is worse than no badge. Every level the
 * upstream DID report is drawn — `idle` included, in green, because "the model
 * is free right now" is useful information.
 */
export function busyIconOf(level: WorkBuddyBusyLevel | undefined): WorkBuddyBusyIcon | undefined {
  if (level === undefined) return undefined
  if (level === 'unknown') return undefined
  return level as WorkBuddyBusyIcon
}

/**
 * One person, on the icon's own grid: 7.9 units wide, 19.3 units tall.
 *
 * The five parts are the emoji's own — hair, face, shirt, trousers, shoes —
 * because a stick figure would not read as the same mark as the `🧍` the
 * picker shows.
 *
 * NO FACE FEATURES. At the 12px the model row actually uses, an eye is 0.2px
 * wide: drawing it produces a smudge, not a face. So the face is a plain
 * skin-toned shape and the character is carried by the silhouette.
 */
function person(
  x: number,
  key: string,
  shirt: string,
  shirtEdge: string,
  trousers: string,
): ReactElement {
  return (
    <g key={key} transform={`translate(${x} 0)`}>
      {/* 头发：带一撮刘海 */}
      <path
        d="M2.7 3.1c0-1.6 1-2.6 2.5-2.6s2.5 1 2.5 2.6c0 .8-.2 1.4-.6 1.9-.2-1-.7-1.5-1.3-1.7-.5.6-1.3.8-2 .7-.7-.1-1.2-.6-1.3-1.4-.5.1-.8.2-.8.2z"
        fill="#f0c04a"
      />
      {/* 脸：肤色，不画五官 */}
      <path d="M3 3.4h3.4v2.1c0 1.15-.76 2-1.7 2s-1.7-.85-1.7-2z" fill="#ffd9a0" />
      {/* 脖子 */}
      <path d="M4.4 6.6h.6v.9h-.6z" fill="#f3c493" />
      {/* 手臂：在上衣之外 */}
      <path
        d="M1.75 8.9c-.45.45-.65 1.25-.65 2.15v2.9c0 .4.3.7.7.7s.7-.3.7-.7v-2.8c0-.6.1-1 .25-1.35zM7.55 8.9c.45.45.65 1.25.65 2.15v2.9c0 .4-.3.7-.7.7s-.7-.3-.7-.7v-2.8c0-.6-.1-1-.25-1.35z"
        fill="#ffd9a0"
      />
      {/* 上衣 */}
      <path d="M2.8 7.7h3.7c.75 0 1.3.55 1.3 1.3v5.1H1.5V9c0-.75.55-1.3 1.3-1.3z" fill={shirt} />
      {/* 领口 */}
      <path d="M3.9 7.7l.75 1 .75-1" stroke={shirtEdge} strokeWidth=".45" fill="none" strokeLinejoin="round" />
      {/* 裤子 */}
      <path d="M1.9 14.1h2.05l-.3 4.3H1.6zM5.85 14.1h2.05l.3 4.3H5.5z" fill={trousers} />
      {/* 鞋 */}
      <path
        d="M2.15 18.4h1.4v.9H1.7c-.3 0-.45-.3-.3-.6zM5.85 18.4h1.4l.55.55c.2.2 0 .35-.3.35H5.85z"
        fill="#2f3136"
      />
    </g>
  )
}

/**
 * A ROCKET, for the `idle` level: nobody is queuing, so the model is free to
 * run at full speed.
 *
 * A different SHAPE, not a different colour, and that is the point: the level
 * has to be readable at 12px without reading a word, and a rocket next to one,
 * two or three people separates "nobody is waiting" from "one person is
 * waiting" instantly. The people count the queue; the rocket says there is
 * none.
 *
 * SOLID, not outlined: a stroked rocket at this size turns into a smudge. The
 * body is filled in the level's colour, the window is white so it reads at
 * 12px, and the flame is a fixed orange (a flame is a flame).
 */
function rocket(color: string): ReactElement {
  return (
    <g>
      {/* 尾焰 */}
      <path d="M6.1 15.6c.2 1.6.8 2.8 1.9 3.7 1.1-.9 1.7-2.1 1.9-3.7z" fill="#f5a623" />
      {/* 尾翼 */}
      <path d="M4.4 11.8 2 16.1h2.5zM11.6 11.8l2.4 4.3h-2.5z" fill={shadeOf(color)} />
      {/* 机身 */}
      <path d="M8 .9c2.7 2.9 4.2 6.6 4.2 10.4 0 1.7-.4 3.2-1 4.5H4.8c-.6-1.3-1-2.8-1-4.5 0-3.8 1.5-7.5 4.2-10.4z" fill={color} />
      {/* 舷窗 */}
      <circle cx="8" cy="6.6" r="2.1" fill="#ffffff" />
      {/* 机身高光 */}
      <path d="M6.4 3.6c-.7 1.2-1.2 2.6-1.4 4.1" stroke="#ffffff" strokeOpacity=".35" strokeWidth=".7" fill="none" strokeLinecap="round" />
    </g>
  )
}

/** The shaded edge of the clothes, one step darker than the clothes. */
function shadeOf(color: string): string {
  return `color-mix(in srgb, ${color} 78%, #000)`
}

/**
 * The load-level icon for one model row.
 *
 * Returns `null` for a level that is not drawn — including `undefined`, which
 * means "not measured", and `unknown`, which must never be turned into a
 * claim the upstream did not make.
 */
export function busyIcon(
  level: WorkBuddyBusyLevel | undefined,
  language: string = 'zh',
): ReactElement | null {
  const icon = busyIconOf(level)
  if (icon === undefined) return null
  const color = COLORS[icon]
  const isEnglish = language.toLowerCase().startsWith('en')
  const title = (isEnglish ? TITLES_EN : TITLES_ZH)[icon]

  if (icon === 'unavailable') {
    // The one level that is not a matter of degree: nobody can use this model,
    // so a crowd of any size would be a lie. A crossed-out person says it.
    return (
      <span
        className="dsm-workbuddy-busy dsm-workbuddy-busy-unavailable"
        title={title}
        style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
      >
        <svg viewBox="0 0 19.3 19.3" width={12} height={12} aria-hidden="true" focusable="false">
          <g opacity=".5">
            {person(0, 'p', '#8a8f98', '#6f747c', '#6f747c')}
          </g>
          {/* The bar is drawn ACROSS the figure, not over it: a line through the
              middle of a 12px person hides the very thing it is annotating. */}
          <path d="M0.6 19.4 19.4 0.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
      </span>
    )
  }

  if (icon === 'idle') {
    // The one level that is not a queue: nobody is waiting.
    return (
      <span
        className="dsm-workbuddy-busy dsm-workbuddy-busy-idle"
        title={title}
        style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
      >
        <svg viewBox="0 0 16 19.3" width={12} height={12} aria-hidden="true" focusable="false">
          {rocket(color)}
        </svg>
      </span>
    )
  }

  const count = PEOPLE[icon] ?? 1
  // The people stand shoulder to shoulder — 9.6 units apart, about half a body
  // width — so a crowd reads as ONE group. The HEIGHT is fixed and the width
  // grows, so the icon is never squashed: the count stays legible at the 12px
  // the model row actually uses.
  const width = (count - 1) * 9.6 + 7.9
  return (
    <span
      className={`dsm-workbuddy-busy dsm-workbuddy-busy-${icon}`}
      title={title}
      style={{ '--dsm-workbuddy-busy-color': color } as Record<string, string>}
    >
      <svg viewBox={`0 0 ${width} 19.3`} width={12} height={12} aria-hidden="true" focusable="false">
        {Array.from({ length: count }, (_, index) =>
          person(index * 9.6, `p${index}`, color, shadeOf(color), shadeOf(color)))}
      </svg>
    </span>
  )
}
