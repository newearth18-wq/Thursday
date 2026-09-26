import { useId, type ReactNode } from 'react'

/** Labelled form controls used by Settings: radio groups, a switch and a select. */

export interface Choice<T extends string> {
  readonly value: T
  readonly label: string
  readonly hint?: string
}

export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
  testId,
  description
}: {
  readonly legend: string
  readonly name: string
  readonly value: T
  readonly choices: readonly Choice<T>[]
  readonly onChange: (value: T) => void
  readonly testId?: string
  readonly description?: ReactNode
}) {
  const descriptionId = useId()
  return (
    <fieldset
      className="field"
      data-testid={testId}
      aria-describedby={description ? descriptionId : undefined}
    >
      <legend>{legend}</legend>
      {description ? (
        <p id={descriptionId} className="muted small">
          {description}
        </p>
      ) : null}
      <div className="choices">
        {choices.map((choice) => (
          <label key={choice.value} className="choice">
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              data-testid={testId ? `${testId}-${choice.value}` : undefined}
              onChange={() => {
                onChange(choice.value)
              }}
            />
            <span>
              {choice.label}
              {choice.hint ? <span className="muted small choice-hint">{choice.hint}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function Switch({
  label,
  checked,
  onChange,
  description,
  disabled,
  testId
}: {
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly description?: ReactNode
  readonly disabled?: boolean
  readonly testId?: string
}) {
  const id = useId()
  const descriptionId = useId()
  return (
    <div className="field field-switch">
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.checked)
        }}
      />
      <div>
        <label htmlFor={id}>{label}</label>
        {description ? (
          <p id={descriptionId} className="muted small">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function Select<T extends string>({
  label,
  value,
  choices,
  onChange,
  description,
  testId
}: {
  readonly label: string
  readonly value: T
  readonly choices: readonly Choice<T>[]
  readonly onChange: (value: T) => void
  readonly description?: ReactNode
  readonly testId?: string
}) {
  const id = useId()
  const descriptionId = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {description ? (
        <p id={descriptionId} className="muted small">
          {description}
        </p>
      ) : null}
      <select
        id={id}
        className="select"
        value={value}
        aria-describedby={description ? descriptionId : undefined}
        data-testid={testId}
        onChange={(event) => {
          const next = choices.find((choice) => choice.value === event.target.value)
          if (next) onChange(next.value)
        }}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  )
}
