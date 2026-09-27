# ADR 0010 — Browser Agent: decisions in Core, targets chosen by the host, the browser in its own process

- Status: accepted (SET 9)
- Date: 2026-09-27

## Context

SET 9 asks for a Browser Agent with isolated sessions. It must support:

- navigation, tabs, search and forms
- extraction, screenshots
- downloads and uploads

Every piece of web content is untrusted. The agent must never follow
instructions that come from a page. It needs:

- per-site permissions, and a safety response to unexpected cross-origin
  navigation
- cancellation
- crash isolation

The Permission Engine (SET 7) and the pattern of the Computer Agent (SET 8)
exist.

## Decisions

### 1. Three layers, as in SET 8

| Layer                                                              | Decides                                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Core** — `BrowserAgent` (`packages/core/src/browser/`)           | What to do, in which order, which permissions each action needs for which origin, where the task may be, what page text tries to direct the agent. Owns the task, cancel, events, storage. |
| **Host** — `BrowserHost` (`apps/desktop/src/main/browser-host.ts`) | Which browser runs, and every folder: profile, quarantine, downloads, uploads, evidence. Checks every download before keeping it. Serves only Core (`host.browser.call`).                  |
| **Browser runtime** — `services/browser-runtime`                   | Nothing. Drives the browser through `playwright-core` exactly as one validated request says.                                                                                               |

Core never sends a path. An upload names a file in the uploads folder, and
a download is kept under a name the host makes unique; nothing is ever
overwritten.

### 2. `playwright-core` with an installed browser, bundled into one file

Jupiter drives Microsoft Edge (always present on Windows 10/11), Google Chrome
or Chromium, found by the host. It downloads no browser.

The runtime and `playwright-core` are bundled into one CommonJS file
(`browser-runtime.cjs`), because the packaged app ships no `node_modules`.
They run in a separate process on Electron's own Node.js.

**Alternatives considered.**

- **An Electron `BrowserView`.** This puts web content inside Jupiter's own
  process, so a page crash or hang would reach Jupiter.
- **The full `playwright` package with its own downloaded browsers.** This
  adds hundreds of megabytes and a download step.
- **CDP by hand.** This rebuilds what Playwright already does (waiting,
  locators, downloads, uploads).

### 3. Sessions are isolated

Each task runs in a temporary browser context of its own, unless it names an
open session: no cookies, storage or cache are shared, and nothing is written
to disk.

A persistent profile is possible only when the person turns on
`browser.persistentProfile` (off by default). Even then it is Jupiter's own
profile folder, never the person's browser profile.

Contexts have no site permissions, and service workers are blocked. A page
cannot open tabs by itself: such tabs are blocked, closed and reported.

### 4. Permissions per action and per origin

Each action needs a capability for its exact origin:

| Capability             | Risk     | Used for                                                          |
| ---------------------- | -------- | ----------------------------------------------------------------- |
| `browser.navigate`     | MEDIUM   | Opening a page                                                    |
| `browser.read`         | LOW      | Reading, extracting and screenshots                               |
| `browser.interact`     | MEDIUM   | Clicking and typing                                               |
| `browser.submit_login` | MEDIUM   | Signing in                                                        |
| `browser.submit_form`  | HIGH     | Sending a message or a form                                       |
| `browser.download`     | MEDIUM   | Downloading a file                                                |
| `browser.upload`       | CRITICAL | Uploading, for the file and for the site                          |
| `payment.make`         | CRITICAL | A purchase                                                        |
| `browser.click_point`  | HIGH     | Clicking a point (opt-in and labelled); the effect is not checked |

All the missing permissions are asked for together before anything runs
(`WAITING_APPROVAL`, nothing done). Each is checked again at the moment of
use, for the origin the page is really on.

**Submissions.** A click or an Enter that would send a form counts as a
submission. A form that asks for a password is a sign-in, whatever the task
calls it.

**Single-use answers.** An _Allow once_ answer is used up by the first
action it allows. After that it covers only the rest of the same task, for
the same capability and exact target, and only when the capability is LOW or
MEDIUM risk. HIGH and CRITICAL actions need a fresh answer each time.

### 5. Origins and the safety response

A task may be only on the origins it navigates to, plus any it names. After
each action, Core compares the page's origin with that set. Any other origin
stops the task at once, whether a redirect, a link or a script took it
there. The response is:

1. status `SAFETY_STOP`, error `UNEXPECTED_ORIGIN`;
2. the page is stopped;
3. a `browser.safety_stop` event is published;
4. nothing after that action runs.

### 6. Pages are data

Page text reaches the task only as `UntrustedContent`, labelled with its
origin.

**Labelled instructions.** Text that tries to direct the agent is found and
labelled. There are seven kinds:

- override instructions
- reveal secrets
- private files
- grant permissions
- redirect the agent
- install software
- impersonate the user

Labelled text is reported and never followed.

**What cannot change.** The agent's actions come only from the approved task,
so a page cannot add actions, permissions or origins.

**Missions.** In a Mission, `browser.read_page` passes the page text to later
steps between `BEGIN/END UNTRUSTED PAGE TEXT` fences, with a note of what was
labelled.

**Secrets.** Text that looks like a credential is never typed into a page.

### 7. Downloads are checked before they are kept

A download lands in the quarantine folder. It is kept, under a new unique
name in the downloads folder, only if all of these hold:

- it came from the page's origin;
- it fits the size limit;
- its extension is one of the types the task expected;
- its content matches its type (magic bytes).

Otherwise it is removed and the action fails with `DOWNLOAD_REJECTED`. The
evidence records the size, type and SHA-256.

### 8. Cancel, deadlines and crashes

**Cancel.** Cancel aborts the task, stops the running browser operation
(`stop`, which interrupts navigation) and skips the queued actions.

**Deadlines.** Every runtime call has a deadline. A runtime that misses it is
stopped.

**Crashes.** A crash of the browser or the runtime fails the task with a
structured error. Jupiter keeps running, and the next task starts a new
runtime.

## Consequences

- The Browser Agent needs an installed Chromium-family browser. Without one,
  it is shown as _Unavailable_, with the reason.
- The package grows by the bundled runtime (a few MB), not by a browser.
- **Not in SET 9:** computer vision, CAPTCHA solving, and filling payment
  details. Purchases always need a fresh CRITICAL answer.
