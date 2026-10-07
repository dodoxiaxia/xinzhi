#!/usr/bin/env python3
"""Read-only offline browser checks against an explicitly supplied full public package.

Requires Python Playwright and system Chromium. No build, deployment or model calls.
The v14.2.3 baseline is expected to fail nav visibility and modal slash isolation.
"""
import argparse
import asyncio
import functools
import json
import shutil
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright

PUBLIC_FILES = {"index.html", "public.js", "style.css", "icon.svg", "_headers", "_worker.js"}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def check(args, origin):
    results = []
    requests = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            executable_path=args.chromium, headless=True, args=["--no-sandbox"]
        )
        try:
            for width, height in [(320, 740), (390, 844)]:
                context = await browser.new_context(
                    viewport={"width": width, "height": height}, reduced_motion="reduce"
                )

                async def guard(route):
                    request = route.request
                    requests.append({"method": request.method, "local": request.url.startswith(origin)})
                    if request.url.startswith(origin) and request.method in {"GET", "HEAD"}:
                        await route.continue_()
                    else:
                        await route.abort()

                await context.route("**/*", guard)
                page = await context.new_page()
                await page.goto(origin)
                await page.wait_for_selector(".article-card")
                nav = await page.evaluate("""() => {
                    const container = document.querySelector('.header-nav').getBoundingClientRect();
                    return [...document.querySelectorAll('.nav-tab-btn')].map(element => {
                        const rect = element.getBoundingClientRect();
                        return {label: element.textContent.trim(), left: rect.left, right: rect.right,
                            visible: rect.width > 0 && rect.left >= Math.max(0, container.left) - 1
                                && rect.right <= Math.min(innerWidth, container.right) + 1};
                    });
                }""")
                results.append({"viewport": [width, height], "check": "four_nav_entries_visible",
                                "pass": len(nav) == 4 and all(item["visible"] for item in nav), "nav": nav})
                if args.evidence_dir:
                    await page.screenshot(path=str(args.evidence_dir / f"{width}-navigation.png"))

                await page.goto(origin + "?mode=candidates&reading=abstract")
                await page.wait_for_selector(".article-card")
                trigger = page.locator(".article-card .title-open").nth(1)
                await trigger.scroll_into_view_if_needed()
                await trigger.focus()
                before = await page.evaluate("""() => ({scrollY,
                    reading: document.querySelector('#readingSelect').value, url: location.href,
                    paperId: document.activeElement.dataset.paperId})""")
                await trigger.click()
                await page.wait_for_timeout(400)
                await page.keyboard.press("Escape")
                after = await page.evaluate("""() => ({scrollY,
                    reading: document.querySelector('#readingSelect').value, url: location.href,
                    paperId: document.activeElement.dataset.paperId,
                    closed: !document.querySelector('#readerDrawer').classList.contains('open')})""")
                restored = after["closed"] and all(before[key] == after[key] for key in before)
                results.append({"viewport": [width, height], "check": "escape_restores_card_and_filters",
                                "pass": restored, "before": before, "after": after})

                await trigger.click()
                await page.wait_for_timeout(100)
                await page.keyboard.press("/")
                focus = await page.evaluate("""() => ({id: document.activeElement.id,
                    inside: document.querySelector('#readerDrawer').contains(document.activeElement),
                    open: document.querySelector('#readerDrawer').classList.contains('open')})""")
                results.append({"viewport": [width, height], "check": "slash_keeps_modal_focus",
                                "pass": focus["open"] and focus["inside"], "focus": focus})
                if args.evidence_dir:
                    await page.screenshot(path=str(args.evidence_dir / f"{width}-modal-slash.png"))
                await context.close()
        finally:
            await browser.close()
    results.append({"check": "no_mutation_requests", "pass": all(
        request["method"] in {"GET", "HEAD"} for request in requests)})
    return {"scope": "LOCAL OFFLINE; complete static public package; no successful API mocks",
            "results": results, "pass": all(result["pass"] for result in results)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--public-dir", type=Path, required=True)
    parser.add_argument("--chromium", default=shutil.which("chromium"))
    parser.add_argument("--evidence-dir", type=Path)
    args = parser.parse_args()
    if not args.chromium:
        parser.error("Supply --chromium: no system Chromium found")
    args.public_dir = args.public_dir.resolve()
    if not args.public_dir.is_dir():
        parser.error("--public-dir must be a directory")
    if {item.name for item in args.public_dir.iterdir()} != PUBLIC_FILES:
        parser.error("--public-dir must contain exactly the six approved public files")
    if not all((args.public_dir / name).is_file() for name in PUBLIC_FILES):
        parser.error("Every public package entry must be a regular file")
    if args.evidence_dir:
        args.evidence_dir = args.evidence_dir.resolve()
        if args.evidence_dir == args.public_dir or args.public_dir in args.evidence_dir.parents:
            parser.error("Evidence must be outside the public package")
        args.evidence_dir.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(
        QuietHandler, directory=str(args.public_dir)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = asyncio.run(check(args, f"http://127.0.0.1:{server.server_port}/"))
        output = json.dumps(result, ensure_ascii=False, indent=2)
        print(output)
        if args.evidence_dir:
            (args.evidence_dir / "checks.json").write_text(output + "\n", encoding="utf-8")
        return 0 if result["pass"] else 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
