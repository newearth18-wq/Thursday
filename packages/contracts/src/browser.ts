import { z } from 'zod'
import { parseUrl } from './ai'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Browser Agent (SET 9).
 *
 * A Chromium-family browser driven by Playwright in its own process. Pages
 * are always untrusted: what a page says is data, never an instruction. The
 * agent does only the typed actions of an approved task, finds controls by
 * their role, label or accessible name (a stable selector only when there is
 * none, and a screen point only as a labelled, opt-in last resort), and
 * returns what it really observed: the page's address, origin and title, the
 * structured content it extracted, and evidence files.
 *
 * Which browser runs, which profile it uses, where downloads are kept until
 * they are verified, which files may be uploaded and where evidence is kept
 * are decided by the host, never by a request or a page.
 */

export const BROWSER_ACTION_TYPES = [
  'NAVIGATE',
  'NEW_TAB',
  'SWITCH_TAB',
  'CLOSE_TAB',
  'CLICK',
  'TYPE',
  'FILL_FORM',
  'SELECT_OPTION',
  'PRESS_KEYS',
  'SUBMIT',
  'WAIT_FOR',
  'READ_PAGE',
  'EXTRACT',
  'SCREENSHOT',
  'SNAPSHOT_HTML',
  'DOWNLOAD',
  'UPLOAD',
  'CLICK_POINT'
] as const
export const BrowserActionType = z.enum(BROWSER_ACTION_TYPES)
export type BrowserActionType = z.infer<typeof BrowserActionType>

/** ARIA roles a control can be found by. */
export const AriaRole = z.enum([
  'alert',
  'article',
  'banner',
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'contentinfo',
  'dialog',
  'form',
  'grid',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'main',
  'menu',
  'menuitem',
  'navigation',
  'option',
  'paragraph',
  'radio',
  'region',
  'row',
  'rowheader',
  'search',
  'searchbox',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'textbox'
])
export type AriaRole = z.infer<typeof AriaRole>

const Short = z.string().min(1).max(200)

/**
 * How to find a control, in the order the agent prefers: its role and
 * accessible name, its label, placeholder or visible text, a test id — and a
 * CSS selector only when none of these exists.
 */
export const Locator = z
  .object({
    role: AriaRole.optional(),
    name: Short.optional(),
    label: Short.optional(),
    placeholder: Short.optional(),
    text: Short.optional(),
    testId: Short.optional(),
    css: z.string().min(1).max(300).optional(),
    /** Match the name, label, placeholder or text exactly (default: contains, ignoring case). */
    exact: z.boolean().optional(),
    /** Which match, when several match (0 = first). */
    index: z.number().int().min(0).max(50).optional()
  })
  .strict()
  .refine(
    (locator) =>
      [
        locator.role,
        locator.label,
        locator.placeholder,
        locator.text,
        locator.testId,
        locator.css
      ].some((value) => value !== undefined),
    { message: 'Name at least one of role, label, placeholder, text, testId or css' }
  )
  .refine((locator) => locator.name === undefined || locator.role !== undefined, {
    message: 'An accessible name needs a role'
  })
export type Locator = z.infer<typeof Locator>

/** An absolute http(s) address. Credentials in the address are refused. */
export const WebAddress = z
  .string()
  .max(2000)
  .refine((value) => {
    const url = parseUrl(value)
    return (
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === ''
    )
  }, 'Expected an http(s) address without a user name or password')

/** The origin of an http(s) address (`https://example.com`), or null. */
export function originOf(address: string): string | null {
  const url = parseUrl(address)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return null
  return url.origin
}

/** An origin such as `https://example.com` or `http://127.0.0.1:4100`. */
export const WebOrigin = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[a-z0-9.[\]:-]+$/i, 'Expected an origin such as https://example.com')

const KEY =
  '(?:[A-Za-z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)'
/** A key or chord, e.g. `Enter`, `Control+A`, `Shift+Tab`. */
export const BrowserKey = z
  .string()
  .regex(
    new RegExp(`^(?:Control\\+)?(?:Shift\\+)?(?:Alt\\+)?${KEY}$`),
    'Expected a key such as Enter or Control+A'
  )

/** What a SUBMIT does, which decides the permission it needs. */
export const SubmitKind = z.enum(['search', 'login', 'message', 'form', 'purchase'])
export type SubmitKind = z.infer<typeof SubmitKind>

/** A file name in a folder the host chose (never a path). */
export const BrowserFileName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}$/, 'Expected a plain file name such as "report.pdf"')
  .refine((name) => !name.includes('..'), 'A file name cannot contain ".."')

/** File types a download may be, checked against the file's own content. */
export const DownloadType = z.enum(['txt', 'csv', 'json', 'pdf', 'png', 'jpg', 'zip'])
export type DownloadType = z.infer<typeof DownloadType>

const Text = z.string().max(10_000)
const Timeout = z.number().int().min(100).max(120_000)

export const ExtractField = z
  .object({
    /** The key in the extracted object. */
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),
    target: Locator,
    /** What to take from each match. */
    take: z.enum(['text', 'href', 'value']),
    /** All matches as a list, or only the first. */
    all: z.boolean()
  })
  .strict()
export type ExtractField = z.infer<typeof ExtractField>

export const BrowserAction = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('NAVIGATE'), url: WebAddress, timeoutMs: Timeout.optional() })
    .strict(),
  z.object({ type: z.literal('NEW_TAB'), url: WebAddress.nullable() }).strict(),
  z.object({ type: z.literal('SWITCH_TAB'), index: z.number().int().min(0).max(20) }).strict(),
  z
    .object({ type: z.literal('CLOSE_TAB'), index: z.number().int().min(0).max(20).nullable() })
    .strict(),
  z.object({ type: z.literal('CLICK'), target: Locator }).strict(),
  z.object({ type: z.literal('TYPE'), target: Locator, text: Text }).strict(),
  z
    .object({
      type: z.literal('FILL_FORM'),
      fields: z
        .array(z.object({ target: Locator, value: Text }).strict())
        .min(1)
        .max(20)
    })
    .strict(),
  z
    .object({ type: z.literal('SELECT_OPTION'), target: Locator, value: z.string().max(500) })
    .strict(),
  z
    .object({
      type: z.literal('PRESS_KEYS'),
      target: Locator.nullable(),
      keys: z.array(BrowserKey).min(1).max(10)
    })
    .strict(),
  z
    .object({
      type: z.literal('SUBMIT'),
      /** The button (or the field to press Enter in) that submits. */
      target: Locator,
      kind: SubmitKind
    })
    .strict(),
  z
    .object({
      type: z.literal('WAIT_FOR'),
      target: Locator.nullable(),
      urlContains: z.string().min(1).max(500).nullable(),
      state: z.enum(['load', 'domcontentloaded', 'networkidle']).nullable(),
      timeoutMs: Timeout
    })
    .strict()
    .refine((wait) => wait.target !== null || wait.urlContains !== null || wait.state !== null, {
      message: 'Wait for a control, an address or a page state'
    }),
  z
    .object({ type: z.literal('READ_PAGE'), maxChars: z.number().int().min(100).max(100_000) })
    .strict(),
  z.object({ type: z.literal('EXTRACT'), fields: z.array(ExtractField).min(1).max(30) }).strict(),
  z.object({ type: z.literal('SCREENSHOT'), fullPage: z.boolean() }).strict(),
  z.object({ type: z.literal('SNAPSHOT_HTML') }).strict(),
  z
    .object({
      type: z.literal('DOWNLOAD'),
      /** The link or button that starts the download. */
      target: Locator,
      /** What the file must be; anything else is rejected and removed. */
      expect: z
        .object({
          types: z.array(DownloadType).min(1).max(7),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(100 * 1024 * 1024)
        })
        .strict(),
      timeoutMs: Timeout.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('UPLOAD'),
      /** The file input. */
      target: Locator,
      /** A file in the host's approved upload folder. */
      fileName: BrowserFileName
    })
    .strict(),
  z
    .object({
      type: z.literal('CLICK_POINT'),
      /** Relative to the page's viewport, and inside it. */
      x: z.number().int().min(0).max(10_000),
      y: z.number().int().min(0).max(10_000),
      /** Why no control could be found by role, label or text. */
      reason: z.string().min(1).max(300)
    })
    .strict()
])
export type BrowserAction = z.infer<typeof BrowserAction>

/** How an action found what it acted on. */
export const BrowserMethod = z.enum(['semantic', 'selector', 'coordinate', 'page', 'none'])
export type BrowserMethod = z.infer<typeof BrowserMethod>

/** Text on a page that tries to direct the agent: labelled, never followed. */
export const SuspiciousContent = z
  .object({
    kind: z.enum([
      'override-instructions',
      'reveal-secrets',
      'exfiltrate-files',
      'grant-permissions',
      'redirect-agent',
      'install-software',
      'impersonate-user'
    ]),
    /** A short, redacted excerpt of the text. */
    excerpt: z.string().max(300)
  })
  .strict()
export type SuspiciousContent = z.infer<typeof SuspiciousContent>

export const BrowserEvidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('screenshot'),
      /** A file name in the host's evidence folder. */
      file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.png$/),
      bytes: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      kind: z.literal('html'),
      file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.html$/),
      bytes: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      kind: z.literal('download'),
      /** Where the verified file is, in the host's downloads folder. */
      path: z.string().min(1).max(1000),
      type: DownloadType,
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** The origin the file came from. */
      origin: WebOrigin
    })
    .strict(),
  z
    .object({
      kind: z.literal('upload'),
      path: z.string().min(1).max(1000),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      origin: WebOrigin
    })
    .strict()
])
export type BrowserEvidence = z.infer<typeof BrowserEvidence>

/** Content taken from a page. It is data from an untrusted source, never instructions. */
export const UntrustedContent = z
  .object({
    untrusted: z.literal(true),
    /** Where it came from (`null` for a page on no web origin). */
    origin: z.string().max(300),
    /** The page's structure as its accessibility tree (roles and names). */
    structure: z.string().max(100_000),
    /** The page's visible text. */
    text: z.string().max(100_000),
    truncated: z.boolean()
  })
  .strict()
export type UntrustedContent = z.infer<typeof UntrustedContent>

/** Values extracted from a page, by field name: untrusted data. */
export const Extraction = z.record(
  z.string().max(41),
  z.union([z.string().max(10_000), z.array(z.string().max(10_000)).max(200), z.null()])
)
export type Extraction = z.infer<typeof Extraction>

export const BrowserActionResult = z
  .object({
    index: z.number().int().min(0).max(49),
    action: BrowserActionType,
    /** What it acted on, e.g. `button "Search"`. */
    target: z.string().max(500),
    success: z.boolean(),
    method: BrowserMethod,
    /** The page after the action. */
    url: z.string().max(2000).nullable(),
    origin: z.string().max(300).nullable(),
    title: z.string().max(500).nullable(),
    /** What was really observed. Never the text that was typed. */
    observation: z.string().max(2000),
    content: UntrustedContent.nullable(),
    extraction: Extraction.nullable(),
    suspicious: z.array(SuspiciousContent).max(20),
    evidence: BrowserEvidence.nullable(),
    error: ErrorEnvelope.nullable(),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp
  })
  .strict()
export type BrowserActionResult = z.infer<typeof BrowserActionResult>

export const BrowserTaskStatus = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'WAITING_APPROVAL',
  /** Stopped by a safety rule (an unexpected origin); nothing after it ran. */
  'SAFETY_STOP'
])
export type BrowserTaskStatus = z.infer<typeof BrowserTaskStatus>

/** What is kept about an action: its type and origin, never what it typed. */
export const BrowserActionSummary = z
  .object({ type: BrowserActionType, origin: z.string().max(300).nullable() })
  .strict()

export const BrowserTask = z
  .object({
    taskId: Uuidv7,
    missionId: Uuidv7.nullable(),
    sessionId: Uuidv7,
    title: z.string().min(1).max(200),
    status: BrowserTaskStatus,
    actions: z.array(BrowserActionSummary).max(50),
    /** The origins the task may be on; any other origin stops it. */
    allowedOrigins: z.array(WebOrigin).max(20),
    results: z.array(BrowserActionResult).max(50),
    error: ErrorEnvelope.nullable(),
    /** Permission requests the task is waiting for (WAITING_APPROVAL). */
    permissionRequests: z.array(Uuidv7).max(50),
    allowCoordinateFallback: z.boolean(),
    createdAt: UtcTimestamp,
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type BrowserTask = z.infer<typeof BrowserTask>

export const BrowserTaskRequest = z
  .object({
    taskId: Uuidv7,
    title: z.string().min(1).max(200),
    /** An open session to reuse; null runs in a new temporary session, closed afterwards. */
    sessionId: Uuidv7.nullable(),
    actions: z.array(BrowserAction).min(1).max(50),
    /**
     * Origins the task may reach besides those it navigates to. Any other
     * origin, reached by a redirect, a link or a script, stops the task.
     */
    extraOrigins: z.array(WebOrigin).max(10),
    /** Screen-point clicks are refused unless the task allows them. */
    allowCoordinateFallback: z.boolean()
  })
  .strict()
export type BrowserTaskRequest = z.infer<typeof BrowserTaskRequest>

export const BrowserProfile = z.enum(['temporary', 'persistent'])
export type BrowserProfile = z.infer<typeof BrowserProfile>

export const BrowserTab = z
  .object({
    index: z.number().int().min(0),
    url: z.string().max(2000),
    title: z.string().max(500),
    active: z.boolean()
  })
  .strict()
export type BrowserTab = z.infer<typeof BrowserTab>

export const BrowserSession = z
  .object({
    sessionId: Uuidv7,
    missionId: Uuidv7.nullable(),
    profile: BrowserProfile,
    tabs: z.array(BrowserTab).max(20),
    createdAt: UtcTimestamp
  })
  .strict()
export type BrowserSession = z.infer<typeof BrowserSession>

export const BrowserRuntimeState = z.enum(['running', 'stopped', 'crashed', 'unavailable'])

export const BrowserStatus = z
  .object({
    available: z.boolean(),
    /** Why the agent cannot browse, when it cannot. */
    reason: z.string().max(500).nullable(),
    /** The browser the host found, e.g. "Microsoft Edge". */
    browser: z.string().max(100).nullable(),
    version: z.string().max(100).nullable(),
    runtime: z
      .object({
        state: BrowserRuntimeState,
        pid: z.number().int().positive().nullable(),
        restarts: z.number().int().nonnegative(),
        lastError: z.string().max(500).nullable()
      })
      .strict(),
    /** Whether the person turned on the persistent profile (off by default). */
    persistentProfile: z.boolean(),
    downloadsFolder: z.string().max(1000).nullable(),
    uploadsFolder: z.string().max(1000).nullable(),
    sessions: z.number().int().nonnegative()
  })
  .strict()
export type BrowserStatus = z.infer<typeof BrowserStatus>

// ---- Browser calls: Core → host → browser runtime --------------------------------------------

/** A page as the runtime last saw it. */
export const PageInfo = z
  .object({
    url: z.string().max(2000),
    origin: z.string().max(300),
    title: z.string().max(500),
    tab: z.number().int().min(0),
    tabs: z.number().int().min(0),
    /** Tabs a page opened by itself, closed by the runtime (a page cannot open tabs). */
    popupsClosed: z.number().int().nonnegative()
  })
  .strict()
export type PageInfo = z.infer<typeof PageInfo>

const Session = Uuidv7
const WithPage = z.object({ page: PageInfo }).strict()
/** What a control was, as the runtime found it. */
const Found = z
  .object({
    page: PageInfo,
    found: z.string().max(300),
    method: z.enum(['semantic', 'selector'])
  })
  .strict()

/** Every operation the host performs for the agent, with its input and result. */
export const BrowserOps = {
  status: { params: z.object({}).strict(), result: BrowserStatus },
  openSession: {
    params: z
      .object({ sessionId: Session, missionId: Uuidv7.nullable(), profile: BrowserProfile })
      .strict(),
    result: BrowserSession
  },
  closeSession: {
    params: z.object({ sessionId: Session }).strict(),
    result: z.object({ closed: z.boolean() }).strict()
  },
  listSessions: {
    params: z.object({}).strict(),
    result: z.object({ sessions: z.array(BrowserSession).max(50) }).strict()
  },
  page: { params: z.object({ sessionId: Session }).strict(), result: WithPage },
  navigate: {
    params: z.object({ sessionId: Session, url: WebAddress, timeoutMs: Timeout }).strict(),
    result: z.object({ page: PageInfo, status: z.number().int().nullable() }).strict()
  },
  newTab: {
    params: z
      .object({ sessionId: Session, url: WebAddress.nullable(), timeoutMs: Timeout })
      .strict(),
    result: WithPage
  },
  switchTab: {
    params: z.object({ sessionId: Session, index: z.number().int().min(0).max(20) }).strict(),
    result: WithPage
  },
  closeTab: {
    params: z
      .object({ sessionId: Session, index: z.number().int().min(0).max(20).nullable() })
      .strict(),
    result: WithPage
  },
  click: {
    params: z.object({ sessionId: Session, target: Locator, timeoutMs: Timeout }).strict(),
    result: Found
  },
  fill: {
    params: z
      .object({ sessionId: Session, target: Locator, text: Text, timeoutMs: Timeout })
      .strict(),
    /** Whether the field holds exactly the text afterwards (the text itself never comes back). */
    result: Found.extend({ matches: z.boolean(), sensitive: z.boolean() }).strict()
  },
  select: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        value: z.string().max(500),
        timeoutMs: Timeout
      })
      .strict(),
    result: Found.extend({ selected: z.array(z.string().max(500)).max(50) }).strict()
  },
  press: {
    params: z
      .object({
        sessionId: Session,
        target: Locator.nullable(),
        keys: z.array(BrowserKey).min(1).max(10),
        timeoutMs: Timeout
      })
      .strict(),
    result: WithPage
  },
  waitFor: {
    params: z
      .object({
        sessionId: Session,
        target: Locator.nullable(),
        urlContains: z.string().min(1).max(500).nullable(),
        state: z.enum(['load', 'domcontentloaded', 'networkidle']).nullable(),
        timeoutMs: Timeout
      })
      .strict(),
    result: WithPage
  },
  describe: {
    params: z.object({ sessionId: Session, target: Locator, timeoutMs: Timeout }).strict(),
    /** What kind of control the target is, to decide the permission a click needs. */
    result: Found.extend({
      kind: z.enum(['link', 'button', 'submit', 'field', 'password', 'file', 'other']),
      formAction: z.string().max(2000).nullable(),
      /** Whether the control's form has a password field (a sign-in, whatever the task calls it). */
      formHasPassword: z.boolean()
    }).strict()
  },
  read: {
    params: z
      .object({ sessionId: Session, maxChars: z.number().int().min(100).max(100_000) })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        structure: z.string().max(100_000),
        text: z.string().max(100_000),
        truncated: z.boolean()
      })
      .strict()
  },
  extract: {
    params: z
      .object({
        sessionId: Session,
        fields: z.array(ExtractField).min(1).max(30),
        timeoutMs: Timeout
      })
      .strict(),
    result: z.object({ page: PageInfo, data: Extraction }).strict()
  },
  screenshot: {
    params: z.object({ sessionId: Session, fullPage: z.boolean() }).strict(),
    result: z
      .object({
        page: PageInfo,
        file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.png$/),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  },
  snapshotHtml: {
    params: z.object({ sessionId: Session }).strict(),
    result: z
      .object({
        page: PageInfo,
        file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.html$/),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  },
  download: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        types: z.array(DownloadType).min(1).max(7),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024),
        timeoutMs: Timeout
      })
      .strict(),
    /**
     * The host keeps the file in its quarantine folder, checks its name,
     * size, origin and content type, and only then moves it to the
     * downloads folder. A file that fails a check is removed.
     */
    result: z
      .object({
        page: PageInfo,
        verified: z.boolean(),
        /** Why the file was rejected, when it was. */
        rejected: z.string().max(500).nullable(),
        fileName: z.string().max(200),
        sourceOrigin: z.string().max(300),
        evidence: BrowserEvidence.nullable()
      })
      .strict()
  },
  upload: {
    params: z
      .object({
        sessionId: Session,
        target: Locator,
        fileName: BrowserFileName,
        timeoutMs: Timeout
      })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        /** The file names the input holds afterwards. */
        attached: z.array(z.string().max(200)).max(20),
        evidence: BrowserEvidence
      })
      .strict()
  },
  resolveUpload: {
    params: z.object({ fileName: BrowserFileName }).strict(),
    result: z.object({ path: z.string().min(1).max(1000), exists: z.boolean() }).strict()
  },
  clickPoint: {
    params: z
      .object({ sessionId: Session, x: z.number().int().min(0), y: z.number().int().min(0) })
      .strict(),
    result: z
      .object({
        page: PageInfo,
        viewport: z.object({ width: z.number().int(), height: z.number().int() }).strict()
      })
      .strict()
  },
  /** Stops the operation under way in a session at once (a navigation stops loading). */
  stop: {
    params: z.object({ sessionId: Session }).strict(),
    result: z.object({ stopped: z.boolean() }).strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type BrowserOp = keyof typeof BrowserOps
export type BrowserParams<O extends BrowserOp> = z.infer<(typeof BrowserOps)[O]['params']>
export type BrowserResult<O extends BrowserOp> = z.infer<(typeof BrowserOps)[O]['result']>

export const BROWSER_OPS = Object.keys(BrowserOps) as BrowserOp[]

/** The single host operation that carries a browser call. */
export const BrowserCall = z
  .object({
    op: z.enum(BROWSER_OPS as [BrowserOp, ...BrowserOp[]]),
    params: z.unknown()
  })
  .strict()
  .superRefine((call, context) => {
    const parsed = BrowserOps[call.op].params.safeParse(call.params)
    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        message: `Invalid parameters for ${call.op}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
      })
  })
export type BrowserCall = z.infer<typeof BrowserCall>
