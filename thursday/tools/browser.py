"""Driving a real browser, for the web that a plain fetch cannot reach.

`fetch_url` gets you a page's text. It cannot log in, click, fill a form or
wait for something rendered by JavaScript - which is most of what people
actually need done on the web.

Every action here goes through the same confirmation gate as the shell,
because a browser signed into your accounts can spend money and send messages.
The session is kept between calls so a login survives into the next step, and
it runs headful by default so you can watch what it does.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Literal

from . import ImageResult, ToolContext, ToolError, tool

log = logging.getLogger(__name__)

MAX_TEXT = 8000


class Session:
    """One long-lived browser, shared across tool calls."""

    def __init__(self, headless: bool = False, executable: str = "") -> None:
        self.headless = headless
        # An explicit binary, for a system Chrome or a Playwright install that
        # does not match the installed package's expected build.
        self.executable = executable or os.environ.get("THURSDAY_BROWSER_BINARY", "")
        self._playwright: Any = None
        self._browser: Any = None
        self._page: Any = None

    async def page(self) -> Any:
        if self._page is not None:
            return self._page
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise ToolError(
                "browsing needs Playwright: pip install 'thursday[browser]' "
                "&& playwright install chromium"
            ) from exc

        self._playwright = await async_playwright().start()
        options: dict[str, Any] = {"headless": self.headless}
        if self.executable:
            options["executable_path"] = self.executable
        try:
            self._browser = await self._playwright.chromium.launch(**options)
        except Exception as exc:
            await self.close()
            raise ToolError(
                f"could not start a browser: {exc}. Try: playwright install chromium"
            ) from exc
        self._page = await self._browser.new_page()
        return self._page

    async def close(self) -> None:
        for closer in (self._browser, self._playwright):
            if closer is None:
                continue
            try:
                await (closer.close() if hasattr(closer, "close") else closer.stop())
            except Exception:  # pragma: no cover - already gone
                pass
        self._playwright = self._browser = self._page = None

    @property
    def open(self) -> bool:
        return self._page is not None


def _session(ctx: ToolContext | None) -> Session:
    if ctx is None:
        raise ToolError("no context available")
    session = ctx.state.get("browser")
    if session is None:
        headless = not bool(getattr(ctx.settings, "browser_visible", True))
        session = Session(headless=headless)
        ctx.state["browser"] = session
    return session


class Rehearsing(ToolError):
    """Not an error so much as an answer: this is what would have happened."""


async def _approve(ctx: ToolContext, what: str, detail: str) -> None:
    """Ask before acting - or, in dry-run, say what would have been done.

    Raised rather than returned so every caller stops here. A browser action
    that carried on and only *reported* that it would not have acted would be
    the one thing dry-run must never do.
    """
    if ctx and ctx.state.get("dry_run"):
        raise Rehearsing(
            f"would {what.lower()}: {detail}. Nothing was done - the user has "
            "asked to see what you would do first."
        )
    if not await ctx.request_confirmation(what, detail):
        raise ToolError("the user declined that")


@tool(dangerous=True)
async def browse(url: str, ctx: ToolContext = None) -> dict[str, Any]:
    """Open a page in a real browser and read it.

    Unlike fetch_url this runs JavaScript and keeps cookies, so it works on
    pages that need a session. Asks before opening anything.

    Args:
        url: The full URL, including https://.
    """
    if not url.lower().startswith(("http://", "https://")):
        raise ToolError("url must start with http:// or https://")
    await _approve(ctx, "Open a browser page", url)

    page = await _session(ctx).page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        text = await page.inner_text("body")
    except Exception as exc:
        raise ToolError(f"could not open {url}: {exc}") from exc

    return {
        "url": page.url,
        "title": await page.title(),
        "text": text[:MAX_TEXT] + ("\n…(truncated)" if len(text) > MAX_TEXT else ""),
    }


@tool(dangerous=True)
async def browser_act(
    action: Literal["click", "type", "press", "wait"],
    selector: str = "",
    text: str = "",
    ctx: ToolContext = None,
) -> str:
    """Interact with the page that is already open.

    Args:
        action: click a thing, type into it, press a key, or wait for it.
        selector: A CSS selector, or text= for a link or button by its words.
        text: What to type, or which key to press.
    """
    session = _session(ctx)
    if not session.open:
        raise ToolError("no page is open; use browse first")

    await _approve(ctx, f"Browser: {action}", f"{selector} {text}".strip())
    page = await session.page()
    try:
        if action == "click":
            await page.click(selector, timeout=15000)
        elif action == "type":
            await page.fill(selector, text, timeout=15000)
        elif action == "press":
            await page.press(selector or "body", text or "Enter", timeout=15000)
        elif action == "wait":
            await page.wait_for_selector(selector, timeout=30000)
    except Exception as exc:
        raise ToolError(f"{action} failed: {exc}") from exc
    return f"{action} done on {selector or 'the page'}"


@tool(dangerous=True)
async def browser_screenshot(ctx: ToolContext = None) -> ImageResult:
    """Look at the page that is currently open."""
    session = _session(ctx)
    if not session.open:
        raise ToolError("no page is open; use browse first")

    await _approve(ctx, "Screenshot the browser page", "the page you are on")
    page = await session.page()
    import base64

    raw = await page.screenshot(type="jpeg", quality=80, full_page=False)
    return ImageResult(
        text=f"The page at {page.url}:",
        images=[("image/jpeg", base64.standard_b64encode(raw).decode("ascii"))],
    )


@tool
async def close_browser(ctx: ToolContext = None) -> str:
    """Close the browser and forget its session."""
    session = ctx.state.get("browser") if ctx else None
    if session is None or not session.open:
        return "no browser is open"
    await session.close()
    return "browser closed"
