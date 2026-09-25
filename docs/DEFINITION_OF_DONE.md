# Definition of done

A SET is complete only when **all** of the following are true (Master Prompt,
Appendix B), with evidence recorded in `docs/sets/SET-NN-*.md`:

1. Requested behaviour is implemented in real code.
2. No visible control falsely claims unavailable behaviour.
3. Schemas and trust boundaries are validated.
4. Relevant permissions and identity rules are enforced.
5. Errors, timeouts, cancellation, restart and failure recovery are tested.
6. Data migrations and backward compatibility are handled.
7. Unit and integration tests pass.
8. Required manual/E2E tests pass with evidence.
9. Security and privacy implications are documented.
10. User-facing Thai and English states are coherent.
11. Build and package remain healthy (`npm run verify`, CI green).
12. Known limitations are explicit.

Every acceptance test of the SET is listed with PASS or FAIL. If any is FAIL,
the SET is not complete: fix it, or document the real blocker, and do not start
the next SET. A passing SET is tagged `jupiter-set-NN-<name>`.

The SET report also contains: scope completed, files added/changed,
architecture decisions, database migrations, security implications, commands
actually run, automated test counts, manual tests, known limitations, how to
run it, and evidence/artifact paths.
