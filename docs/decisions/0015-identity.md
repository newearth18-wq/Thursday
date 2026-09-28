# ADR 0015 — Identity: Windows Hello as the strong factor, local Face Identity with an honest liveness check, opt-in protection that never replaces a permission

- Status: accepted (SET 14)
- Date: 2026-09-28

## Context

SET 14 asks for an Identity Engine that recognises the owner and protects
sensitive actions:

- levels `UNKNOWN`, `RECOGNIZED`, `VERIFIED` and `STRONG_VERIFIED`
- Windows Hello (with its PIN), and optional Face and Voice Identity
- enrollment with consent, a preview, several angles or liveness inputs, a
  protected template and no raw images or audio kept; Disable, Re-enroll and
  Delete for each method
- templates encrypted with OS-backed protection; no biometrics, templates or
  scores in logs
- assurance that expires after a timeout and on lock, logoff or another
  security event
- a liveness interface with its limitations stated honestly
- rate limiting and safe recovery
- recognition never grants a capability: the Permission Engine still decides

The risks are specific. A face match is spoofable (a photo, a video, a
mask), so face alone must never unlock the most dangerous actions. A
template that leaks is a biometric that cannot be changed. A check that
says "verified" when it only saw a photo is a simulated success, which the
Global Contract forbids. Turning protection on by default would change the
behaviour of every earlier SET (Missions, notes, memory, files) at once.

The camera and its gate, the image store (SET 13), the microphone gate and
the voice pipeline (SET 12), the host vault (`host.vault.seal`, SET 11), the
Permission Engine (SET 7) and the document-runtime process model (SET 10)
exist.

## Decision

1. **Windows Hello is the only strong factor.** The host asks Windows'
   `UserConsentVerifier` through Windows PowerShell 5.1 (a fixed script,
   `-EncodedCommand`, the message on standard input) and learns only the
   outcome (verified, cancelled, not configured, unavailable, failed).
   Windows handles the face, fingerprint or PIN; Jupiter never sees them.
   Only Windows Hello gives `STRONG_VERIFIED`. On other systems it is
   _Unavailable_ and says why.
2. **Face Identity runs on this computer, in its own process.** The
   identity runtime (`services/identity-runtime`) runs face-api 1.7.15 on
   TensorFlow.js with the WebAssembly backend (SSD MobileNet v1, 68
   landmarks, a ResNet-34 descriptor of 128 numbers), with a memory limit,
   one validated call at a time. The host decodes the PNG, scales it to at
   most 640 pixels and sends raw pixels; no image reaches the runtime from
   anywhere but the host. Face can reach `VERIFIED` at most.
3. **Frames come only from the camera.** Enrollment and verification take
   frame ids from a running camera session (SET 13); an uploaded image is
   refused (`FRAME_NOT_FROM_CAMERA`). The frames are dropped from the image
   store as soon as they are used.
4. **The liveness check is labelled Experimental and says what it cannot
   catch.** It checks one face per frame (at least 3), the same person
   throughout, that consecutive frames differ (a still image does not), and
   that the face changed size by at least 20% (the person moved closer or
   back — the challenge). A match with liveness passed is `VERIFIED`;
   without it only `RECOGNIZED`. Enrollment needs liveness to pass. The
   limitation ("a video of you or a good mask can pass it") is always shown.
5. **Voice Identity is Experimental and `RECOGNIZED` at most.** Twelve MFCC
   means per phrase (three disclosed phrases to enroll, one to check),
   computed in Core from 16 kHz PCM held in memory for the session only;
   cosine similarity of at least 0.85 matches. It is not a speaker
   verification model and never verifies.
6. **Templates are sealed by the operating system.** Face descriptors and
   voice features are sealed through `host.vault.seal` (DPAPI on Windows,
   the keyring on Linux) before they reach the database; without secure
   storage nothing is enrolled (`VAULT_UNAVAILABLE`). Deleting a method
   removes its row, then a WAL checkpoint and `secure_delete` erase the old
   pages.
7. **Assurance lives in memory with a timer.** It ends after
   `identity.timeoutMinutes` (1–60, default 10), at once when Electron's
   `powerMonitor` reports lock, suspend or shutdown (dispatched as
   `identity.security-event`, host actor only), when the person ends it,
   and when its method is turned off or deleted. A restart starts at
   `UNKNOWN`.
8. **Protection is opt-in and one more condition in the Permission
   Engine.** Off by default, so earlier SETs behave as before. When on,
   `PermissionEngine.check` asks the identity gate before any grant:
   CRITICAL needs `STRONG_VERIFIED` (so face alone never suffices), and a
   fixed list (`notes.read`, `notes.write`, `memory.read`, `memory.delete`,
   `email.send`, `browser.submit_login`, `browser.submit_form`,
   `files.write`) needs `VERIFIED`. A shortfall is `IDENTITY_REQUIRED`,
   audited as refused, with a next step. A sufficient level only lets the
   normal permission check run. The camera and the microphone are never
   gated (identity itself needs them). Turning protection on or off, and
   changing identity data while it is on, need `VERIFIED`.
9. **Rate limiting survives a restart.** Five failures in a row lock a
   method for 5 minutes, doubling up to 60 minutes; the counts are kept in
   the database. Recovery is Windows Hello, waiting, or (on a computer
   without Windows Hello) removing Jupiter's data folder.
10. **No score, template or image in any event or log.** Persistent events
    (`identity.verification`, `identity.enrollment`,
    `identity.protection_changed`) carry the method, the outcome and the
    level; `identity.assurance_changed` is transient.

## Alternatives considered

- **Windows Hello face APIs for Face Identity.** Windows does not let an
  application enroll or match its own faces; Hello is used as what it is,
  the strong factor.
- **A cloud face or voice service.** Sends biometrics off the computer;
  refused.
- **Face in the renderer (face-api in Chromium).** The renderer must not
  hold templates or decide; a separate process keeps the engine's memory
  and crashes away from the interface and Core.
- **Protection on by default.** Would silently change every earlier SET and
  lock out people on computers without Windows Hello.
- **Letting face reach `STRONG_VERIFIED` with liveness.** The liveness
  check is not presentation-attack detection; claiming otherwise would be
  dishonest.

## Consequences

- On Windows with Hello set up, critical actions can be protected strongly;
  elsewhere they cannot be performed while protection is on, and the
  interface says so.
- The identity runtime adds about 14 MB of models and WebAssembly (plus its bundle) to the
  package; it loads the models on first use.
- A Mission's identity checkpoint step stays _Unavailable_: protected steps
  check identity when they run instead.
