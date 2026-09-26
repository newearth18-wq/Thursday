# Plugins — Coming later (SET 15)

**Status: not implemented.** Jupiter has no plugin engine yet. Nothing in this
folder is loaded or executed, and the desktop shell shows **Plugins** as
_Coming later_.

SET 15 adds the Plugin Manager, manifest validation and the isolated plugin
runtime (`services/plugin-runtime`). Third-party plugin code will never run in
the Electron main process or the renderer.

The `demo-tools` plugin of the earlier Thursday Browser prototype lives with
that prototype in [`legacy/thursday-browser/plugins`](../legacy/thursday-browser/plugins);
it is not a Jupiter plugin.
