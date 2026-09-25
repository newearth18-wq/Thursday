import { useId } from 'react'
import { colors } from './tokens'

/**
 * The Jupiter mark: a spherical energy core, two orbital rings and two
 * abstract eyes of light (Visual Design Lock v1).
 *
 * It is deliberately static. The animated avatar, whose motion reflects real
 * Core state, arrives in SET 16; until then nothing here moves, so the mark
 * can never suggest activity that is not happening.
 */
export interface JupiterMarkProps {
  readonly size?: number
  /** Accessible name. Omit to mark the image as decorative. */
  readonly label?: string
}

export function JupiterMark({ size = 96, label }: JupiterMarkProps) {
  const id = useId().replace(/:/g, '')
  const coreId = `jp-core-${id}`
  const glowId = `jp-glow-${id}`
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }

  return (
    <svg width={size} height={size} viewBox="0 0 120 120" {...a11y}>
      <defs>
        <radialGradient id={coreId} cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor={colors.iceBlue} />
          <stop offset="45%" stopColor={colors.electricCyan} />
          <stop offset="100%" stopColor={colors.midnightBlue} />
        </radialGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="60%" stopColor={colors.electricCyan} stopOpacity="0.18" />
          <stop offset="100%" stopColor={colors.electricCyan} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="40" fill={`url(#${glowId})`} />
      {/* Back halves of the orbital rings. */}
      <g fill="none" strokeLinecap="round">
        <ellipse
          cx="60"
          cy="60"
          rx="52"
          ry="15"
          stroke={colors.electricCyan}
          strokeOpacity="0.45"
          strokeWidth="2"
          transform="rotate(-16 60 60)"
        />
        <ellipse
          cx="60"
          cy="60"
          rx="46"
          ry="11"
          stroke={colors.violetAccent}
          strokeOpacity="0.4"
          strokeWidth="1.5"
          transform="rotate(22 60 60)"
        />
      </g>
      <circle cx="60" cy="60" r="25" fill={`url(#${coreId})`} />
      {/* Eyes: minimal forms of light, not a humanoid face. */}
      <ellipse cx="52" cy="59" rx="2.6" ry="4.2" fill={colors.textPrimary} />
      <ellipse cx="68" cy="59" rx="2.6" ry="4.2" fill={colors.textPrimary} />
      {/* Front halves of the rings pass in front of the core. */}
      <g fill="none" strokeLinecap="round">
        <path
          d="M8 60 A52 15 0 0 0 112 60"
          stroke={colors.electricCyan}
          strokeWidth="2"
          transform="rotate(-16 60 60)"
        />
        <path
          d="M14 60 A46 11 0 0 0 106 60"
          stroke={colors.violetAccent}
          strokeOpacity="0.85"
          strokeWidth="1.5"
          transform="rotate(22 60 60)"
        />
      </g>
    </svg>
  )
}
