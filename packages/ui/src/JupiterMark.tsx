import { useId } from 'react'
import { colors } from './tokens'

/**
 * The Jupiter mark: a spherical energy core, two orbital rings and two
 * abstract eyes of light (Visual Design Lock v1).
 *
 * The mark itself never moves. It exposes its parts as classes
 * (`jp-mark-core`, `jp-mark-glow`, `jp-mark-orbit-a`, `jp-mark-orbit-b`) so a
 * stage can animate them — and only a stage that knows Jupiter Core's real
 * state may do so. `tone` changes colour accents, never identity: the same
 * core, rings and eyes in every state.
 */
export type JupiterMarkTone = 'normal' | 'concerned' | 'error' | 'dim'

export interface JupiterMarkProps {
  readonly size?: number
  /** Accessible name. Omit to mark the image as decorative. */
  readonly label?: string
  readonly tone?: JupiterMarkTone
}

const RINGS: Record<JupiterMarkTone, { a: string; b: string; aOpacity: number }> = {
  normal: { a: colors.electricCyan, b: colors.violetAccent, aOpacity: 1 },
  concerned: { a: colors.warning, b: colors.violetAccent, aOpacity: 0.85 },
  error: { a: colors.error, b: colors.violetAccent, aOpacity: 0.7 },
  dim: { a: colors.electricCyan, b: colors.violetAccent, aOpacity: 0.55 }
}

export function JupiterMark({ size = 96, label, tone = 'normal' }: JupiterMarkProps) {
  const id = useId().replace(/:/g, '')
  const coreId = `jp-core-${id}`
  const glowId = `jp-glow-${id}`
  const rings = RINGS[tone]
  const muted = tone === 'dim' || tone === 'error'
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }

  return (
    <svg
      className={`jp-mark jp-mark-${tone}`}
      data-tone={tone}
      width={size}
      height={size}
      viewBox="0 0 120 120"
      {...a11y}
    >
      <defs>
        <radialGradient id={coreId} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor={colors.iceBlue} stopOpacity={muted ? 0.7 : 1} />
          <stop offset="45%" stopColor={colors.electricCyan} stopOpacity={muted ? 0.55 : 1} />
          <stop offset="100%" stopColor={colors.midnightBlue} />
        </radialGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop
            offset="60%"
            stopColor={tone === 'error' ? colors.error : colors.electricCyan}
            stopOpacity={tone === 'dim' ? 0.08 : 0.18}
          />
          <stop offset="100%" stopColor={colors.electricCyan} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="jp-mark-glow" cx="60" cy="60" r="40" fill={`url(#${glowId})`} />
      {/* Back halves of the orbital rings. */}
      <g fill="none" strokeLinecap="round">
        <g className="jp-mark-orbit-a">
          <ellipse
            cx="60"
            cy="60"
            rx="52"
            ry="15"
            stroke={rings.a}
            strokeOpacity={0.45 * rings.aOpacity}
            strokeWidth="2"
            transform="rotate(-16 60 60)"
          />
        </g>
        <g className="jp-mark-orbit-b">
          <ellipse
            cx="60"
            cy="60"
            rx="46"
            ry="11"
            stroke={rings.b}
            strokeOpacity="0.4"
            strokeWidth="1.5"
            transform="rotate(22 60 60)"
          />
        </g>
      </g>
      <g className="jp-mark-core">
        <circle cx="60" cy="60" r="25" fill={`url(#${coreId})`} />
        {/* Eyes: minimal forms of light, not a humanoid face. */}
        <ellipse
          cx="52"
          cy="59"
          rx="2.6"
          ry="4.2"
          fill={colors.textPrimary}
          fillOpacity={muted ? 0.6 : 1}
        />
        <ellipse
          cx="68"
          cy="59"
          rx="2.6"
          ry="4.2"
          fill={colors.textPrimary}
          fillOpacity={muted ? 0.6 : 1}
        />
      </g>
      {/* Front halves of the rings pass in front of the core. */}
      <g fill="none" strokeLinecap="round">
        <g className="jp-mark-orbit-a">
          <path
            d="M8 60 A52 15 0 0 0 112 60"
            stroke={rings.a}
            strokeOpacity={rings.aOpacity}
            strokeWidth="2"
            transform="rotate(-16 60 60)"
          />
        </g>
        <g className="jp-mark-orbit-b">
          <path
            d="M14 60 A46 11 0 0 0 106 60"
            stroke={rings.b}
            strokeOpacity="0.85"
            strokeWidth="1.5"
            transform="rotate(22 60 60)"
          />
        </g>
      </g>
    </svg>
  )
}
