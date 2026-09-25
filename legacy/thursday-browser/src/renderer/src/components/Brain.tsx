import { useEffect, useRef } from 'react'
import type { BrainState } from '@shared/schemas.js'

/**
 * The neural brain visual.
 *
 * Everything it draws is a function of the current application state: the
 * palette, how fast signals travel, how many fire at once and whether the
 * network jitters all come from `state`. It is not an idle animation — when
 * Thursday is doing nothing, it visibly does nothing.
 */

interface Profile {
  core: string
  edge: string
  pulse: string
  /** Signals launched per second. */
  rate: number
  /** Fraction of an edge travelled per second. */
  speed: number
  glow: number
  jitter: number
  label: string
}

const PROFILES: Record<BrainState, Profile> = {
  idle:      { core: '#1a8fa8', edge: '#16203a', pulse: '#2ee6ff', rate: 0.6, speed: 0.25, glow: 0.25, jitter: 0,    label: 'Idle' },
  listening: { core: '#2ee6ff', edge: '#1e3450', pulse: '#8ff5ff', rate: 2.5, speed: 0.5,  glow: 0.6,  jitter: 0,    label: 'Listening' },
  thinking:  { core: '#2ee6ff', edge: '#1e3450', pulse: '#2ee6ff', rate: 6,   speed: 0.85, glow: 0.8,  jitter: 0.3,  label: 'Thinking' },
  planning:  { core: '#8b6cff', edge: '#2a2450', pulse: '#b9a5ff', rate: 4,   speed: 0.6,  glow: 0.7,  jitter: 0.2,  label: 'Planning' },
  executing: { core: '#4d7cff', edge: '#20305e', pulse: '#7fa3ff', rate: 9,   speed: 1.2,  glow: 0.95, jitter: 0.4,  label: 'Executing' },
  searching: { core: '#2ee6ff', edge: '#1e3450', pulse: '#34e5a0', rate: 7,   speed: 1.5,  glow: 0.8,  jitter: 0.5,  label: 'Searching' },
  waiting:   { core: '#ffc457', edge: '#3a3020', pulse: '#ffd98a', rate: 1,   speed: 0.3,  glow: 0.45, jitter: 0,    label: 'Waiting' },
  warning:   { core: '#ffc457', edge: '#3a3020', pulse: '#ffc457', rate: 3,   speed: 0.7,  glow: 0.7,  jitter: 1.1,  label: 'Warning' },
  error:     { core: '#ff5d73', edge: '#3d1f28', pulse: '#ff5d73', rate: 2,   speed: 0.4,  glow: 0.8,  jitter: 2.2,  label: 'Error' },
  completed: { core: '#34e5a0', edge: '#1b3a30', pulse: '#7bf3c4', rate: 3,   speed: 0.9,  glow: 0.85, jitter: 0,    label: 'Completed' }
}

interface Node { x: number; y: number; r: number }
interface Edge { a: number; b: number }
interface Signal { edge: number; t: number; dir: 1 | -1 }

/** Deterministic layout: the same brain every launch, no random flicker. */
function buildNetwork(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const rings = [
    { count: 1, radius: 0, size: 7 },
    { count: 6, radius: 0.3, size: 4.5 },
    { count: 10, radius: 0.56, size: 3.6 },
    { count: 14, radius: 0.82, size: 2.8 }
  ]
  for (const ring of rings) {
    for (let i = 0; i < ring.count; i++) {
      const angle = (i / ring.count) * Math.PI * 2 + ring.radius * 3.1
      // Slight vertical squash reads as a brain rather than a plain circle.
      nodes.push({
        x: Math.cos(angle) * ring.radius,
        y: Math.sin(angle) * ring.radius * 0.82,
        r: ring.size
      })
    }
  }

  const edges: Edge[] = []
  const seen = new Set<string>()
  const add = (a: number, b: number): void => {
    if (a === b) return
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ a, b })
  }
  // Connect each node to its two nearest neighbours, plus the hub.
  for (let i = 1; i < nodes.length; i++) {
    const distances = nodes
      .map((node, index) => ({ index, d: Math.hypot(node.x - nodes[i].x, node.y - nodes[i].y) }))
      .filter((entry) => entry.index !== i)
      .sort((left, right) => left.d - right.d)
    add(i, distances[0].index)
    add(i, distances[1].index)
    if (i % 4 === 0) add(i, 0)
  }
  return { nodes, edges }
}

const NETWORK = buildNetwork()

export function Brain({ state, size = 260 }: { state: BrainState; size?: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Read through a ref so a state change never restarts the animation loop.
  const stateRef = useRef<BrainState>(state)
  stateRef.current = state

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = size * dpr
    canvas.height = size * dpr
    context.scale(dpr, dpr)

    const signals: Signal[] = []
    let frame = 0
    let previous = performance.now()
    let signalDebt = 0

    const render = (now: number): void => {
      const dt = Math.min((now - previous) / 1000, 0.1)
      previous = now
      const profile = PROFILES[stateRef.current]
      const centre = size / 2
      const scale = size * 0.38

      context.clearRect(0, 0, size, size)

      const place = (node: Node, index: number): { x: number; y: number } => {
        // Jitter is state-driven, so a healthy brain is perfectly steady.
        const wobble = profile.jitter
        const phase = now / 420 + index
        return {
          x: centre + node.x * scale + (wobble ? Math.sin(phase) * wobble : 0),
          y: centre + node.y * scale + (wobble ? Math.cos(phase * 1.3) * wobble : 0)
        }
      }
      const positions = NETWORK.nodes.map(place)

      // Edges.
      context.lineWidth = 1
      context.strokeStyle = profile.edge
      for (const edge of NETWORK.edges) {
        context.beginPath()
        context.moveTo(positions[edge.a].x, positions[edge.a].y)
        context.lineTo(positions[edge.b].x, positions[edge.b].y)
        context.stroke()
      }

      // Launch new signals at the state's rate.
      signalDebt += profile.rate * dt
      while (signalDebt >= 1) {
        signalDebt -= 1
        signals.push({
          edge: Math.floor(Math.random() * NETWORK.edges.length),
          t: 0,
          dir: Math.random() < 0.5 ? 1 : -1
        })
      }

      // Travelling signals.
      for (let i = signals.length - 1; i >= 0; i--) {
        const signal = signals[i]
        signal.t += profile.speed * dt
        if (signal.t >= 1) {
          signals.splice(i, 1)
          continue
        }
        const edge = NETWORK.edges[signal.edge]
        const from = signal.dir === 1 ? positions[edge.a] : positions[edge.b]
        const to = signal.dir === 1 ? positions[edge.b] : positions[edge.a]
        const x = from.x + (to.x - from.x) * signal.t
        const y = from.y + (to.y - from.y) * signal.t
        const fade = Math.sin(signal.t * Math.PI)

        context.beginPath()
        context.fillStyle = profile.pulse
        context.globalAlpha = fade
        context.arc(x, y, 2, 0, Math.PI * 2)
        context.fill()
        context.globalAlpha = 1
      }

      // Nodes.
      const breath = 0.75 + Math.sin(now / (profile.rate > 4 ? 300 : 900)) * 0.25 * profile.glow
      NETWORK.nodes.forEach((node, index) => {
        const position = positions[index]
        const isHub = index === 0
        context.beginPath()
        context.fillStyle = profile.core
        context.globalAlpha = isHub ? 1 : 0.35 + profile.glow * 0.45
        context.arc(position.x, position.y, node.r * (isHub ? breath : 1), 0, Math.PI * 2)
        context.fill()
      })
      context.globalAlpha = 1

      // Hub glow.
      const hub = positions[0]
      const gradient = context.createRadialGradient(hub.x, hub.y, 0, hub.x, hub.y, scale * 0.9)
      gradient.addColorStop(0, `${profile.core}${Math.round(profile.glow * 70).toString(16).padStart(2, '0')}`)
      gradient.addColorStop(1, 'transparent')
      context.fillStyle = gradient
      context.fillRect(0, 0, size, size)

      frame = requestAnimationFrame(render)
    }

    frame = requestAnimationFrame(render)
    return () => cancelAnimationFrame(frame)
  }, [size])

  const profile = PROFILES[state]
  return (
    <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
      <canvas ref={canvasRef} style={{ width: size, height: size }} aria-label={`Thursday state: ${profile.label}`} />
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: profile.core
        }}
      >
        {profile.label}
      </div>
    </div>
  )
}

export function brainLabel(state: BrainState): string {
  return PROFILES[state].label
}

export function brainColor(state: BrainState): string {
  return PROFILES[state].core
}
