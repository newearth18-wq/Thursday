import { z } from 'zod'

/**
 * The three runtime environments. They never share a data directory, so a
 * development session can never read or modify production user data.
 */
export const JupiterEnvironment = z.enum(['development', 'test', 'production'])
export type JupiterEnvironment = z.infer<typeof JupiterEnvironment>

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error', 'fatal'])
export type LogLevel = z.infer<typeof LogLevel>
