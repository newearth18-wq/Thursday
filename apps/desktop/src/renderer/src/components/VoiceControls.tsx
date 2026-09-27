import { useEffect, useRef } from 'react'
import { Icon } from '@jupiter/ui'
import { useI18n } from '../i18n'
import { useVoice } from '../voice/VoiceProvider'

/**
 * Voice controls shared by the top bar and the Voice panel (SET 12).
 *
 * Push-to-Talk: hold the button with the mouse (or touch), or press it with
 * Space or Enter to start and again to send. Ctrl+Shift+Space does the same
 * from anywhere. The microphone indicator follows the real microphone track
 * and stays visible while it is on.
 */

export function PushToTalkButton({ testId = 'voice-ptt' }: { readonly testId?: string }) {
  const { t } = useI18n()
  const voice = useVoice()
  const held = useRef(false)
  const status = voice.status.state === 'ready' ? voice.status.value : null
  const listening = voice.mode === 'push-to-talk'
  const unavailable = !status?.enabled || !status.engines.stt.available
  // Never disabled while starting: that would take keyboard focus away mid-press.
  const disabled = unavailable

  const toggle = () => {
    if (listening) void voice.releasePushToTalk()
    else if (!voice.busy) void voice.startPushToTalk()
  }

  return (
    <button
      type="button"
      className={`button ${listening ? 'button-danger' : 'button-primary'} voice-ptt`}
      aria-pressed={listening}
      disabled={disabled}
      data-testid={testId}
      data-listening={listening}
      title={t('voice.ptt.hint')}
      aria-busy={voice.busy}
      onPointerDown={(event) => {
        if (event.button !== 0 || listening || voice.busy) return
        held.current = true
        void voice.startPushToTalk()
      }}
      onPointerUp={() => {
        if (!held.current) return
        held.current = false
        void voice.releasePushToTalk()
      }}
      onPointerLeave={() => {
        if (!held.current) return
        held.current = false
        void voice.releasePushToTalk()
      }}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        if (!event.repeat) toggle()
      }}
    >
      <Icon name="microphone" size={16} />
      <span>{t(listening ? 'voice.ptt.release' : 'voice.ptt.hold')}</span>
    </button>
  )
}

/** Always visible while the microphone is on; says so in words, not only in colour. */
export function MicrophoneIndicator() {
  const { t } = useI18n()
  const voice = useVoice()
  if (!voice.capturing) return null
  return (
    <li
      className="indicator indicator-mic"
      data-testid="indicator-microphone"
      data-state="on"
      data-device={voice.device ?? ''}
      role="status"
      title={t('voice.indicator.hint')}
    >
      <Icon name="microphone" size={16} />
      <span>{t(voice.mode === 'wake-word' ? 'voice.indicator.wake' : 'voice.indicator.on')}</span>
    </li>
  )
}

export function StopSpeakingButton({ testId = 'voice-stop' }: { readonly testId?: string }) {
  const { t } = useI18n()
  const voice = useVoice()
  const status = voice.status.state === 'ready' ? voice.status.value : null
  if (status?.state !== 'SPEAKING') return null
  return (
    <button
      type="button"
      className="button voice-stop"
      data-testid={testId}
      onClick={() => {
        void voice.interrupt()
      }}
    >
      <Icon name="stop" size={16} />
      <span>{t('voice.stop')}</span>
    </button>
  )
}

/** Ctrl+Shift+Space: start listening, and again to send; Escape stops Jupiter speaking. */
export function useVoiceShortcuts(): void {
  const voice = useVoice()
  const latest = useRef(voice)
  useEffect(() => {
    latest.current = voice
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latest.current
      if (event.defaultPrevented) return
      if (event.key === 'Escape' && current.status.state === 'ready') {
        if (current.status.value.state === 'SPEAKING') void current.interrupt()
        return
      }
      if (!(event.ctrlKey && event.shiftKey && event.code === 'Space') || event.repeat) return
      if (document.querySelector('dialog[open]')) return
      event.preventDefault()
      if (current.mode === 'push-to-talk') void current.releasePushToTalk()
      else if (current.status.state === 'ready' && current.status.value.enabled)
        void current.startPushToTalk()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
}
