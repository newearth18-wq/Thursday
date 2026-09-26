import {
  AvailabilityStatus,
  CostLatencyPreference,
  CredentialInfo,
  EventPayloads,
  FallbackPolicy,
  JupiterEnvironment,
  Locality,
  ExecutionStatus,
  MessageRole,
  MessageStatus,
  MissionAction,
  MissionPriority,
  MissionStatus,
  StepAttempt,
  SkillCategory,
  SkillExecutionStatus,
  SkillHealthStatus,
  SkillProvider,
  ActorType,
  StepStatus,
  ModelCapability,
  OverallRuntimeStatus,
  ProviderState,
  RiskLevel,
  RoutingMode,
  RunningServiceStatus,
  SettingKey
} from '@jupiter/contracts'
import { describe, expect, it } from 'vitest'
import { VIEW_IDS } from '../../../shared/views'
import { STAGE_STATES } from '../components/JupiterStage'
import { DESTINATIONS } from '../destinations'
import { KNOWN_CODES } from '../errorText'
import { KNOWN_STEP_KINDS } from '../missionText'
import { en } from './en'
import { createTranslator, detectLocale, localeFor } from './index'
import { th } from './th'

describe('message catalogs', () => {
  it('define the same keys in English and Thai', () => {
    expect(Object.keys(th).sort()).toEqual(Object.keys(en).sort())
  })

  it('have no empty strings and the same placeholders in both languages', () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), key).not.toBe('')
      expect(th[key].trim(), key).not.toBe('')
      const placeholders = (text: string) =>
        [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      expect(placeholders(th[key]), key).toEqual(placeholders(en[key]))
    }
  })

  it('uses real Thai script for Thai copy', () => {
    expect(th['nav.home']).toMatch(/[฀-๿]/)
    expect(th['availability.COMING_LATER']).toBe('จะมาในภายหลัง')
  })

  it('labels every availability state with the contract vocabulary in English', () => {
    expect(en['availability.COMING_LATER']).toBe('Coming later')
    expect(en['availability.NOT_CONFIGURED']).toBe('Not configured')
    expect(en['availability.UNAVAILABLE']).toBe('Unavailable')
    expect(en['availability.EXPERIMENTAL']).toBe('Experimental')
  })
})

describe('translator', () => {
  it('interpolates values and leaves unknown placeholders visible', () => {
    const t = createTranslator('en')
    expect(t('nav.plannedFor', { set: 9 })).toBe('Planned for SET 9')
    expect(t('nav.plannedFor')).toBe('Planned for SET {set}')
    expect(createTranslator('th')('nav.plannedFor', { set: 9 })).toBe('กำหนดไว้ใน SET 9')
  })

  it('chooses Thai only for Thai locales', () => {
    expect(detectLocale('th')).toBe('th')
    expect(detectLocale('th-TH')).toBe('th')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })
})

describe('keys built at runtime', () => {
  // Components build some keys from data (`status.${status}`); every such family must be complete.
  const has = (key: string) => Object.hasOwn(en, key) && Object.hasOwn(th, key)

  it('covers every value each family can take', () => {
    const families: Record<string, readonly string[]> = {
      'status.': [...RunningServiceStatus.options, ...AvailabilityStatus.options],
      'overall.': OverallRuntimeStatus.options,
      'env.': JupiterEnvironment.options,
      'risk.': RiskLevel.options,
      'settingName.': SettingKey.options,
      'errorCode.': KNOWN_CODES,
      'feature.': VIEW_IDS.filter((view) => !['home', 'settings', 'diagnostics'].includes(view)),
      'locality.': Locality.options,
      'capability.': ModelCapability.options,
      'capabilitySource.': ['provider', 'user', 'none'],
      'routing.mode.': RoutingMode.options,
      'routing.modeHint.': RoutingMode.options,
      'routing.fallback.': FallbackPolicy.options,
      'routing.fallbackHint.': FallbackPolicy.options,
      'routing.cost.': CostLatencyPreference.options,
      'providerState.': ProviderState.options,
      'providerStateHint.': ProviderState.options,
      'keyValidation.': CredentialInfo.shape.validation.options,
      'models.keyRequirement.': ['required', 'optional', 'none'],
      'models.localityHint.': Locality.options,
      'models.preferred.': ['chat', 'reasoning', 'vision', 'embeddings'],
      'activity.provider.': EventPayloads['ai.provider.changed'].shape.change.options,
      'activity.conversation.': EventPayloads['chat.conversation.changed'].shape.change.options,
      'activity.answer.': MessageStatus.options,
      'chat.announce.': MessageStatus.options,
      'chat.role.': MessageRole.options.filter((role) => role !== 'user'),
      'missionStatus.': MissionStatus.options,
      'missionEvent.status.': MissionStatus.options,
      'stepStatus.': StepStatus.options,
      'executionStatus.': ExecutionStatus.options,
      'missionStep.': KNOWN_STEP_KINDS,
      'workflow.outcome.': StepAttempt.shape.outcome.options,
      'skillCategory.': SkillCategory.options,
      'skillProvider.': SkillProvider.options,
      'skillHealth.': SkillHealthStatus.options,
      'skillStatus.': SkillExecutionStatus.options,
      'actor.': ActorType.options,
      'missionPriority.': MissionPriority.options,
      'missions.action.': MissionAction.options,
      'missionCheck.': ['answer-present', 'summary-present', 'non-empty', 'contains'],
      'stage.': STAGE_STATES,
      'indicators.core.': ['running', 'starting', 'stopped', 'unknown'],
      'activity.state.': ['live', 'connecting', 'waiting-for-core', 'error'],
      'language.': ['en', 'th'],
      'coreState.': ['starting', 'running', 'stopping', 'stopped', 'crashed'],
      'service.': [
        'build-metadata',
        'environment',
        'storage',
        'logging',
        'core',
        'database',
        'event-bus',
        'capability-dispatcher',
        'model-router',
        'mission-manager',
        'workflow-engine',
        'skill-registry',
        'permission-engine',
        'agent-runtime',
        'browser-runtime',
        'artifact-manager',
        'identity-gateway',
        'plugin-runtime',
        'secure-storage'
      ]
    }
    for (const [prefix, values] of Object.entries(families)) {
      for (const value of values) expect(has(`${prefix}${value}`), `${prefix}${value}`).toBe(true)
    }
    for (const state of STAGE_STATES) expect(has(`stage.${state}Detail`), state).toBe(true)
    for (const destination of DESTINATIONS)
      expect(has(destination.label), destination.id).toBe(true)
  })

  it('follows the language preference, with the system language for `system`', () => {
    expect(localeFor('system', 'th-TH')).toBe('th')
    expect(localeFor('system', 'en-GB')).toBe('en')
    expect(localeFor('th', 'en-US')).toBe('th')
    expect(localeFor('en', 'th-TH')).toBe('en')
  })
})
