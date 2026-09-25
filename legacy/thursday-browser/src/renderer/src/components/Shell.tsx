import type { Route } from '../state/store.js'
import { useStore } from '../state/store.js'
import { brainColor } from './Brain.js'

/* ------------------------------- nav rail ----------------------------- */

const ROUTES: { id: Route; label: string; glyph: string }[] = [
  { id: 'browser', label: 'Browser', glyph: '🌐' },
  { id: 'command', label: 'Command Center', glyph: '◉' },
  { id: 'workflows', label: 'Workflows', glyph: '⑃' },
  { id: 'plugins', label: 'Plugins', glyph: '⬡' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
  { id: 'diagnostics', label: 'Diagnostics', glyph: '✚' }
]

export function NavRail(): JSX.Element {
  const { route, setRoute, plugins, command } = useStore()
  const unhealthy = plugins.filter((plugin) => plugin.health === 'error' || plugin.health === 'crashed').length
  const warnings = command?.warnings.length ?? 0

  return (
    <nav className="rail">
      <div className="rail-logo" title="Thursday Browser">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
          <circle cx="12" cy="3.5" r="1.6" fill="currentColor" />
          <circle cx="20.5" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="20.5" r="1.6" fill="currentColor" />
          <circle cx="3.5" cy="12" r="1.6" fill="currentColor" />
        </svg>
      </div>

      {ROUTES.map((entry) => (
        <button
          key={entry.id}
          className={`rail-btn${route === entry.id ? ' active' : ''}`}
          title={entry.label}
          aria-label={entry.label}
          onClick={() => setRoute(entry.id)}
        >
          <span style={{ fontSize: 15 }}>{entry.glyph}</span>
          {entry.id === 'plugins' && unhealthy > 0 ? (
            <span className="rail-badge" style={{ background: 'var(--red)' }} />
          ) : null}
          {entry.id === 'command' && warnings > 0 ? (
            <span className="rail-badge" style={{ background: 'var(--amber)' }} />
          ) : null}
        </button>
      ))}
    </nav>
  )
}

/* ------------------------------ status bar ---------------------------- */

export function StatusBar(): JSX.Element {
  const { command, settings, patchSettings, lastError, reportError, setRoute } = useStore()
  const mission = command?.mission ?? null
  const brain = command?.brain ?? 'idle'

  return (
    <footer className="statusbar">
      <span className="status-seg">
        <span className="status-dot" style={{ background: brainColor(brain) }} />
        <span style={{ color: brainColor(brain), fontWeight: 600 }}>{brain.toUpperCase()}</span>
      </span>

      {mission ? (
        <>
          <span className="status-seg" title={mission.goal}>
            <span style={{ color: 'var(--text-faint)' }}>Mission</span>
            <span>{mission.title}</span>
            <span className="badge info">{mission.status}</span>
          </span>
          <div className="status-progress">
            <div style={{ width: `${mission.progress}%` }} />
          </div>
          <span className="status-seg mono">{mission.progress}%</span>
          {command?.activeStepTitle ? (
            <span className="status-seg" style={{ color: 'var(--text-faint)' }}>
              ▸ {command.activeStepTitle}
            </span>
          ) : null}
        </>
      ) : (
        <span className="status-seg" style={{ color: 'var(--text-faint)' }}>
          No active mission
        </span>
      )}

      <span className="status-spacer" />

      {lastError ? (
        <button className="status-seg" style={{ color: 'var(--red)' }} onClick={() => reportError(null)} title="Dismiss">
          ⚠ {lastError}
        </button>
      ) : null}

      {command && command.warnings.length > 0 ? (
        <button className="status-seg" style={{ color: 'var(--amber)' }} onClick={() => setRoute('command')}>
          ⚠ {command.warnings.length} warning{command.warnings.length === 1 ? '' : 's'}
        </button>
      ) : null}

      <span className="status-seg mono" style={{ color: 'var(--text-faint)' }}>
        {command?.activeModel ?? 'no model'}
      </span>

      <button
        className="btn sm"
        onClick={() => void patchSettings({ sidebarOpen: !(settings?.sidebarOpen ?? true) })}
      >
        {settings?.sidebarOpen ?? true ? 'Hide Thursday' : 'Show Thursday'}
      </button>
    </footer>
  )
}
