import { z } from 'zod'
import { ErrorEnvelope } from './errors'
import { UtcTimestamp, Uuidv7 } from './primitives'

/**
 * The Windows Computer Agent (SET 8).
 *
 * The agent acts on real applications through Windows UI Automation, in
 * this order of preference: semantic controls (found by automation id, name
 * or control type), the application's own keyboard accelerators, and — only
 * when a task explicitly allows it — a coordinate click inside the target
 * window, which is labelled as such and audited.
 *
 * Which applications can be opened, which folder files are saved to and
 * where evidence is kept are decided by the host, never by a request. Every
 * action returns what was really observed; an action whose effect cannot be
 * verified is a failure, never a success.
 */

/** Applications the agent may open. The host maps each to its executable. */
export const ComputerAppId = z.enum(['notepad', 'explorer'])
export type ComputerAppId = z.infer<typeof ComputerAppId>

export const COMPUTER_ACTION_TYPES = [
  'OPEN_APP',
  'CLOSE_APP',
  'FOCUS_WINDOW',
  'MANAGE_WINDOW',
  'LIST_WINDOWS',
  'WAIT_FOR_WINDOW',
  'READ_UI_TREE',
  'CLICK_ELEMENT',
  'TYPE_TEXT',
  'PRESS_KEYS',
  'SCROLL',
  'SELECT_ELEMENT',
  'SCREENSHOT',
  'SAVE_FILE',
  'CLICK_POINT'
] as const
export const ComputerActionType = z.enum(COMPUTER_ACTION_TYPES)
export type ComputerActionType = z.infer<typeof ComputerActionType>

/** UI Automation control types the agent can look for. */
export const UiControlType = z.enum([
  'Button',
  'Calendar',
  'CheckBox',
  'ComboBox',
  'Custom',
  'DataGrid',
  'DataItem',
  'Document',
  'Edit',
  'Group',
  'Header',
  'HeaderItem',
  'Hyperlink',
  'Image',
  'List',
  'ListItem',
  'Menu',
  'MenuBar',
  'MenuItem',
  'Pane',
  'ProgressBar',
  'RadioButton',
  'ScrollBar',
  'Separator',
  'Slider',
  'Spinner',
  'SplitButton',
  'StatusBar',
  'Tab',
  'TabItem',
  'Table',
  'Text',
  'Thumb',
  'TitleBar',
  'ToolBar',
  'ToolTip',
  'Tree',
  'TreeItem',
  'Window'
])
export type UiControlType = z.infer<typeof UiControlType>

/** A window of an application the agent may use, re-found on every action. */
export const WindowRef = z
  .object({
    app: ComputerAppId,
    titleContains: z.string().min(1).max(200).optional()
  })
  .strict()
export type WindowRef = z.infer<typeof WindowRef>

/** How to find a control: by what it is, never by where it is on the screen. */
export const ElementQuery = z
  .object({
    automationId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    controlType: UiControlType.optional(),
    className: z.string().min(1).max(200).optional(),
    /** Which match, when several match (0 = first). */
    index: z.number().int().min(0).max(50).optional()
  })
  .strict()
  .refine(
    (query) =>
      query.automationId !== undefined ||
      query.name !== undefined ||
      query.controlType !== undefined ||
      query.className !== undefined,
    { message: 'Name at least one of automationId, name, controlType or className' }
  )
export type ElementQuery = z.infer<typeof ElementQuery>

const KEY =
  '(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right|Space)'
/** A key or chord, e.g. `Ctrl+S`, `Shift+Tab`, `F5`. */
export const KeyChord = z
  .string()
  .regex(
    new RegExp(`^(?:Ctrl\\+)?(?:Shift\\+)?(?:Alt\\+)?${KEY}$`),
    'Expected a key such as Ctrl+S'
  )
export type KeyChord = z.infer<typeof KeyChord>

/** A file name in the folder the host chose for saving (never a path). */
export const SaveFileName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}\.txt$/,
    'Expected a plain .txt file name such as "hello.txt"'
  )
  .refine((name) => !name.includes('..'), 'A file name cannot contain ".."')

const Text = z.string().max(10_000)

export const ComputerAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('OPEN_APP'), app: ComputerAppId }).strict(),
  z.object({ type: z.literal('CLOSE_APP'), window: WindowRef }).strict(),
  z.object({ type: z.literal('FOCUS_WINDOW'), window: WindowRef }).strict(),
  z
    .object({
      type: z.literal('MANAGE_WINDOW'),
      window: WindowRef,
      operation: z.enum(['minimize', 'maximize', 'restore', 'move', 'resize']),
      x: z.number().int().min(-10_000).max(10_000).optional(),
      y: z.number().int().min(-10_000).max(10_000).optional(),
      width: z.number().int().min(100).max(10_000).optional(),
      height: z.number().int().min(100).max(10_000).optional()
    })
    .strict(),
  z.object({ type: z.literal('LIST_WINDOWS') }).strict(),
  z
    .object({
      type: z.literal('WAIT_FOR_WINDOW'),
      window: WindowRef,
      timeoutMs: z.number().int().min(100).max(60_000)
    })
    .strict(),
  z
    .object({
      type: z.literal('READ_UI_TREE'),
      window: WindowRef,
      depth: z.number().int().min(1).max(8),
      maxNodes: z.number().int().min(1).max(500)
    })
    .strict(),
  z.object({ type: z.literal('CLICK_ELEMENT'), window: WindowRef, element: ElementQuery }).strict(),
  z
    .object({ type: z.literal('TYPE_TEXT'), window: WindowRef, element: ElementQuery, text: Text })
    .strict(),
  z
    .object({
      type: z.literal('PRESS_KEYS'),
      window: WindowRef,
      keys: z.array(KeyChord).min(1).max(10)
    })
    .strict(),
  z
    .object({
      type: z.literal('SCROLL'),
      window: WindowRef,
      element: ElementQuery,
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int().min(1).max(20)
    })
    .strict(),
  z
    .object({ type: z.literal('SELECT_ELEMENT'), window: WindowRef, element: ElementQuery })
    .strict(),
  z.object({ type: z.literal('SCREENSHOT'), window: WindowRef.nullable() }).strict(),
  z
    .object({
      type: z.literal('SAVE_FILE'),
      window: WindowRef,
      fileName: SaveFileName,
      /** The content the saved file must have; by default, the editor's text before saving. */
      expectedText: Text.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('CLICK_POINT'),
      window: WindowRef,
      /** Relative to the window's top-left corner, and inside the window. */
      x: z.number().int().min(0).max(10_000),
      y: z.number().int().min(0).max(10_000),
      /** Why no semantic control could be used. */
      reason: z.string().min(1).max(300)
    })
    .strict()
])
export type ComputerAction = z.infer<typeof ComputerAction>

/** How an action reached the application. */
export const InteractionMethod = z.enum(['semantic', 'keyboard', 'coordinate', 'system', 'none'])
export type InteractionMethod = z.infer<typeof InteractionMethod>

export const ComputerEvidence = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('screenshot'),
      /** A file name in the host's evidence folder. */
      file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.png$/),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      bytes: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      path: z.string().min(1).max(1000),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/)
    })
    .strict()
])
export type ComputerEvidence = z.infer<typeof ComputerEvidence>

export const ComputerActionResult = z
  .object({
    index: z.number().int().min(0).max(49),
    action: ComputerActionType,
    /** What it acted on, e.g. `notepad › Document "Text editor"`. */
    target: z.string().max(500),
    success: z.boolean(),
    method: InteractionMethod,
    /** What was really observed afterwards. Never the text that was typed. */
    observation: z.string().max(2000),
    evidence: ComputerEvidence.nullable(),
    error: ErrorEnvelope.nullable(),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp
  })
  .strict()
export type ComputerActionResult = z.infer<typeof ComputerActionResult>

export const ComputerTaskStatus = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'WAITING_APPROVAL'
])
export type ComputerTaskStatus = z.infer<typeof ComputerTaskStatus>

/** What is kept about an action: its type and application, never the text it types. */
export const ComputerActionSummary = z
  .object({ type: ComputerActionType, app: ComputerAppId.nullable() })
  .strict()

export const ComputerTask = z
  .object({
    taskId: Uuidv7,
    missionId: Uuidv7.nullable(),
    title: z.string().min(1).max(200),
    status: ComputerTaskStatus,
    actions: z.array(ComputerActionSummary).max(50),
    results: z.array(ComputerActionResult).max(50),
    error: ErrorEnvelope.nullable(),
    /** Permission requests the task is waiting for (WAITING_APPROVAL). */
    permissionRequests: z.array(Uuidv7).max(50),
    allowCoordinateFallback: z.boolean(),
    createdAt: UtcTimestamp,
    completedAt: UtcTimestamp.nullable()
  })
  .strict()
export type ComputerTask = z.infer<typeof ComputerTask>

export const ComputerTaskRequest = z
  .object({
    taskId: Uuidv7,
    title: z.string().min(1).max(200),
    actions: z.array(ComputerAction).min(1).max(50),
    /** Coordinate clicks are refused unless the task allows them. */
    allowCoordinateFallback: z.boolean()
  })
  .strict()
export type ComputerTaskRequest = z.infer<typeof ComputerTaskRequest>

export const ComputerRuntimeState = z.enum(['running', 'stopped', 'crashed', 'unavailable'])

export const ComputerStatus = z
  .object({
    available: z.boolean(),
    platform: z.string().max(40),
    /** Why the agent cannot act, when it cannot. */
    reason: z.string().max(500).nullable(),
    runtime: z
      .object({
        state: ComputerRuntimeState,
        pid: z.number().int().positive().nullable(),
        restarts: z.number().int().nonnegative(),
        lastError: z.string().max(500).nullable()
      })
      .strict(),
    screen: z
      .object({ width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .nullable(),
    /** The folder the host saves files to. */
    saveFolder: z.string().max(1000).nullable(),
    apps: z.array(ComputerAppId)
  })
  .strict()
export type ComputerStatus = z.infer<typeof ComputerStatus>

// ---- Automation calls: Core → host → UI Automation runtime ---------------------------------

export const Bounds = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int()
  })
  .strict()
export type Bounds = z.infer<typeof Bounds>

export const WindowInfo = z
  .object({
    handle: z.number().int().positive(),
    processId: z.number().int().positive(),
    processName: z.string().max(200),
    title: z.string().max(500),
    bounds: Bounds,
    active: z.boolean(),
    minimized: z.boolean()
  })
  .strict()
export type WindowInfo = z.infer<typeof WindowInfo>

export const ElementInfo = z
  .object({
    automationId: z.string().max(200),
    name: z.string().max(500),
    controlType: z.string().max(60),
    className: z.string().max(200),
    bounds: Bounds,
    enabled: z.boolean(),
    patterns: z.array(z.string().max(40)).max(30)
  })
  .strict()
export type ElementInfo = z.infer<typeof ElementInfo>

export const UiNode = z
  .object({
    depth: z.number().int().min(0).max(8),
    controlType: z.string().max(60),
    name: z.string().max(500),
    automationId: z.string().max(200),
    className: z.string().max(200),
    enabled: z.boolean()
  })
  .strict()
export type UiNode = z.infer<typeof UiNode>

const Handle = z.number().int().positive()
const Element = z.object({ element: ElementInfo }).strict()

/** Every operation the host performs for the agent, with its input and result. */
export const AutomationOps = {
  status: { params: z.object({}).strict(), result: ComputerStatus },
  listWindows: {
    params: z.object({}).strict(),
    result: z.object({ windows: z.array(WindowInfo).max(200) }).strict()
  },
  launch: {
    params: z.object({ app: ComputerAppId }).strict(),
    result: z.object({ processId: z.number().int().positive() }).strict()
  },
  windowOp: {
    params: z
      .object({
        handle: Handle,
        operation: z.enum(['focus', 'close', 'minimize', 'maximize', 'restore', 'move', 'resize']),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional()
      })
      .strict(),
    result: z.object({ window: WindowInfo.nullable() }).strict()
  },
  findElement: {
    params: z.object({ handle: Handle, query: ElementQuery }).strict(),
    result: Element
  },
  invoke: { params: z.object({ handle: Handle, query: ElementQuery }).strict(), result: Element },
  setValue: {
    params: z.object({ handle: Handle, query: ElementQuery, text: Text }).strict(),
    result: Element
  },
  typeText: {
    params: z.object({ handle: Handle, query: ElementQuery, text: Text }).strict(),
    result: Element
  },
  sendKeys: {
    params: z.object({ handle: Handle, keys: z.array(KeyChord).min(1).max(10) }).strict(),
    result: z.object({ window: WindowInfo }).strict()
  },
  readText: {
    params: z.object({ handle: Handle, query: ElementQuery }).strict(),
    result: z.object({ text: z.string().max(200_000) }).strict()
  },
  readTree: {
    params: z
      .object({
        handle: Handle,
        depth: z.number().int().min(1).max(8),
        maxNodes: z.number().int().min(1).max(500)
      })
      .strict(),
    result: z.object({ nodes: z.array(UiNode).max(500), truncated: z.boolean() }).strict()
  },
  scroll: {
    params: z
      .object({
        handle: Handle,
        query: ElementQuery,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(20)
      })
      .strict(),
    result: Element
  },
  select: { params: z.object({ handle: Handle, query: ElementQuery }).strict(), result: Element },
  screenshot: {
    params: z.object({ handle: Handle.nullable() }).strict(),
    result: z
      .object({
        file: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.png$/),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  },
  clickPoint: {
    params: z
      .object({ handle: Handle, x: z.number().int().min(0), y: z.number().int().min(0) })
      .strict(),
    result: z.object({ screenX: z.number().int(), screenY: z.number().int() }).strict()
  },
  resolveSavePath: {
    params: z.object({ fileName: SaveFileName }).strict(),
    result: z.object({ path: z.string().min(1).max(1000), exists: z.boolean() }).strict()
  },
  verifyFile: {
    params: z.object({ fileName: SaveFileName, expected: z.string().max(200_000) }).strict(),
    result: z
      .object({
        path: z.string().min(1).max(1000),
        exists: z.boolean(),
        bytes: z.number().int().nonnegative(),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
        matches: z.boolean()
      })
      .strict()
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>

export type AutomationOp = keyof typeof AutomationOps
export type AutomationParams<O extends AutomationOp> = z.infer<(typeof AutomationOps)[O]['params']>
export type AutomationResult<O extends AutomationOp> = z.infer<(typeof AutomationOps)[O]['result']>

export const AUTOMATION_OPS = Object.keys(AutomationOps) as AutomationOp[]

/** The single host operation that carries an automation call. */
export const AutomationCall = z
  .object({
    op: z.enum(AUTOMATION_OPS as [AutomationOp, ...AutomationOp[]]),
    params: z.unknown()
  })
  .strict()
  .superRefine((call, context) => {
    const parsed = AutomationOps[call.op].params.safeParse(call.params)
    if (!parsed.success)
      context.addIssue({
        code: 'custom',
        message: `Invalid parameters for ${call.op}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`
      })
  })
export type AutomationCall = z.infer<typeof AutomationCall>
