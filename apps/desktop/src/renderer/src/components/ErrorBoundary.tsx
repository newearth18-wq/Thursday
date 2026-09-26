import { Component, type ErrorInfo, type ReactNode } from 'react'
import { I18nContext, type I18n } from '../i18n'

export type ErrorReporter = (error: Error, componentStack: string | null) => Promise<string | null>

interface Props {
  readonly children: ReactNode
  readonly report: ErrorReporter
}

interface State {
  readonly error: Error | null
  /** undefined while the report is in flight; null if it could not be recorded. */
  readonly reference: string | null | undefined
}

/**
 * Catches rendering errors anywhere below it and replaces the broken UI with
 * a truthful recovery screen: what happened, whether it was logged (with the
 * real log reference), and a working Reload action.
 */
export class ErrorBoundary extends Component<Props, State> {
  static override contextType = I18nContext
  declare context: I18n

  override state: State = { error: null, reference: undefined }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, reference: undefined }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void this.props.report(error, info.componentStack ?? null).then((reference) => {
      this.setState({ reference })
    })
  }

  override render(): ReactNode {
    const { error, reference } = this.state
    if (!error) return this.props.children
    const { t } = this.context
    return (
      <div className="boundary" role="alert">
        <h1>{t('boundary.title')}</h1>
        <p>{t('boundary.body')}</p>
        <pre className="boundary-message">{error.message.slice(0, 500)}</pre>
        {reference === undefined ? null : (
          <p className="muted" data-testid="boundary-reference">
            {reference ? t('boundary.reference', { reference }) : t('boundary.notRecorded')}
          </p>
        )}
        <button
          type="button"
          className="button button-primary"
          onClick={() => {
            window.location.reload()
          }}
        >
          {t('boundary.reload')}
        </button>
      </div>
    )
  }
}
