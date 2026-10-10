#!/usr/bin/env python3
"""Export the existing user manual to standalone HTML, searchable PDF and ZIP.

Run: python3 docs/manual-tools/export_user_manual.py
Requires Pandoc, Chromium, Python Playwright, and a Chinese system font.
Only writes documentation artifacts; does not build or publish the website.
"""
from __future__ import annotations

import base64
import html
import json
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
SOURCE = DOCS / "使用说明.md"
HTML = SOURCE.with_suffix(".html")
PDF = SOURCE.with_suffix(".pdf")
ZIP = DOCS / "心知网站使用说明手册.zip"

CSS = r"""
:root { --ink:#243446; --navy:#152f46; --muted:#637286; --line:#dbe3eb; --accent:#137d76; --paper:#fff; --bg:#eef2f5; }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:24px; }
body { margin:0; color:var(--ink); background:var(--bg); font:15px/1.85 'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif; }
a { color:#166d83; text-decoration:none; overflow-wrap:anywhere; }
a:hover { text-decoration:underline; }
button { font:inherit; cursor:pointer; }
.skip-link { position:fixed; top:-100px; left:12px; z-index:99; padding:8px 16px; background:white; }
.skip-link:focus { top:12px; }
.layout { max-width:1280px; margin:36px auto; display:grid; grid-template-columns:244px minmax(0,1fr); gap:26px; padding:0 22px; }
.side { position:sticky; top:24px; align-self:start; max-height:calc(100vh - 48px); overflow:auto; padding:22px 18px; border:1px solid var(--line); border-radius:12px; background:white; }
.side strong { display:block; color:var(--navy); margin-bottom:12px; font-size:17px; }
.side ol { margin:0; padding-left:23px; font-size:12.5px; }
.side li { margin:8px 0; line-height:1.55; padding-left:2px; }
.side a { color:#46596d; }
.side .actions { border-top:1px solid var(--line); margin-top:20px; padding-top:15px; }
.print-btn { width:100%; border:0; padding:9px 12px; color:white; background:var(--navy); border-radius:6px; }
.side small { display:block; color:var(--muted); margin-top:10px; line-height:1.7; }
main { min-width:0; background:var(--paper); border:1px solid var(--line); border-radius:12px; overflow:hidden; box-shadow:0 5px 24px #24344608; }
.cover { position:relative; padding:56px 52px 46px; border-bottom:1px solid var(--line); background:linear-gradient(125deg,#f4f9fa,#fff 72%); }
.cover::before { content:''; display:block; width:52px; height:5px; background:var(--accent); margin-bottom:28px; }
.cover .eyebrow { color:var(--accent); font-size:12px; font-weight:700; letter-spacing:3px; margin-bottom:16px; }
.cover h1 { color:var(--navy); font-size:32px; line-height:1.4; margin:0 0 20px; letter-spacing:.6px; }
.cover > p { font-size:17px; color:#4b6275; }
.cover ul { padding:0; list-style:none; font-size:13px; color:var(--muted); line-height:2; margin:25px 0; }
.cover blockquote { margin:30px 0 0; font-size:12px; }
.contents { padding:28px 52px; border-bottom:1px solid var(--line); }
.contents h2 { margin-top:0; }
.contents ol { columns:2; column-gap:32px; padding-left:23px; font-size:13px; }
.contents li { margin:8px 0; break-inside:avoid; line-height:1.65; }
.chapter { padding:32px 52px 38px; border-bottom:1px solid var(--line); }
h2 { color:var(--navy); font-size:24px; line-height:1.5; margin:0 0 23px; font-weight:700; }
h3 { color:#1c5365; font-size:17px; line-height:1.5; margin:26px 0 11px; }
p { margin:11px 0; }
ul,ol { padding-left:25px; }
li { margin:6px 0; }
strong { color:#1e3f51; }
blockquote { margin:18px 0; padding:12px 16px; background:#eef6f7; border-left:3px solid #6eaba7; color:#456376; }
blockquote p { margin:0; }
code { font:0.9em/1.5 'Noto Sans Mono CJK SC',monospace; background:#f1f4f7; border-radius:3px; padding:1px 4px; overflow-wrap:anywhere; }
.table-scroll { overflow-x:auto; margin:16px 0; }
table { width:100%; border-collapse:collapse; font-size:12.5px; line-height:1.7; table-layout:fixed; }
th,td { text-align:left; padding:9px 11px; border:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
th { background:#edf4f7; color:#204c62; font-weight:700; }
tbody tr:nth-child(even) { background:#fafcfd; }
td:first-child { width:26%; }
.screenshot { margin:22px 0 14px; break-inside:avoid; }
.screenshot img { display:block; max-width:100%; height:auto; margin:auto; border:1px solid var(--line); border-radius:6px; }
.screenshot.mobile img { width:270px; }
.screenshot figcaption { color:var(--muted); font-size:11.5px; line-height:1.65; margin-top:9px; }
.end-note { padding:20px 52px; color:var(--muted); font-size:12px; background:#f8fafb; }
@media (max-width:1000px) { .layout{display:block;max-width:860px;margin:18px auto;} .side{display:none;} }
@media (max-width:600px) { body{font-size:14px;} .layout{padding:0 10px;margin:10px auto;} .cover,.contents,.chapter{padding:26px 22px;} .cover h1{font-size:26px;} h2{font-size:21px;} h3{font-size:16px;} .contents ol{columns:1;} table{font-size:12px;min-width:470px;} .end-note{padding:18px 22px;} }
@page { size:A4; margin:17mm 16mm 17mm; }
@media print {
  html { scroll-behavior:auto; }
  body { background:white; font-size:10pt; line-height:1.65; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .layout { display:block; max-width:none; margin:0; padding:0; }
  .side,.skip-link,.end-note { display:none; }
  main { border:0; border-radius:0; box-shadow:none; overflow:visible; }
  .cover { min-height:255mm; padding:24mm 7mm 12mm; border:0; background:linear-gradient(145deg,#eef6f7,#fff 66%); break-after:page; }
  .cover::before { height:1.5mm; width:17mm; margin-bottom:13mm; }
  .cover h1 { font-size:31pt; max-width:148mm; margin-bottom:12mm; line-height:1.5; }
  .cover .eyebrow { font-size:10pt; margin-bottom:8mm; }
  .cover > p { font-size:16pt; }
  .cover ul { font-size:10pt; line-height:2.1; margin:14mm 0; }
  .cover blockquote { margin-top:24mm; font-size:9pt; padding:5mm; }
  .contents { padding:5mm 1mm; border:0; break-after:page; }
  .contents h2 { margin-bottom:10mm; }
  .contents ol { columns:1; font-size:11pt; line-height:1.9; padding-left:7mm; }
  .contents li { margin:4mm 0; }
  .chapter { padding:0; border:0; break-before:page; }
  .chapter h2 { font-size:17pt; margin:0 0 6mm; padding-bottom:3mm; border-bottom:1px solid #afc7d4; break-after:avoid; }
  h3 { font-size:11.5pt; margin:6mm 0 2.5mm; break-after:avoid; }
  p { margin:2.5mm 0; orphans:3; widows:3; }
  ul,ol { margin:3mm 0; padding-left:6mm; }
  li { margin:1.5mm 0; orphans:3; widows:3; }
  .table-scroll { overflow:visible; margin:4mm 0; }
  table { font-size:8.9pt; line-height:1.6; min-width:0; }
  th,td { padding:2.2mm 2.5mm; }
  thead { display:table-header-group; }
  tr { break-inside:avoid; }
  blockquote { padding:3mm 4mm; }
  .screenshot { margin:4mm 0; }
  .screenshot img { max-height:96mm; max-width:100%; width:auto; border-radius:1mm; object-fit:contain; }
  .screenshot.mobile img { width:auto; max-height:96mm; }
  .screenshot figcaption { font-size:8pt; margin-top:2mm; }
  a { color:#146279; }
}
"""


def render(markdown: str) -> str:
    return subprocess.run(
        ["pandoc", "--from=gfm", "--to=html5", "--wrap=none"],
        input=markdown,
        text=True,
        check=True,
        capture_output=True,
    ).stdout


def embed_screenshots(body: str) -> str:
    def embed(match: re.Match[str]) -> str:
        relative = match.group(1)
        path = (DOCS / relative).resolve()
        if path.parent != (DOCS / "manual-assets").resolve():
            raise ValueError(f"Unexpected manual image path: {relative}")
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f'src="data:image/png;base64,{encoded}"'

    body = re.sub(r'src="(manual-assets/[^\"]+)"', embed, body)
    # Keep the explanatory caption with the screenshot in printed output.
    def figure(match: re.Match[str]) -> str:
        image, caption = match.groups()
        mobile = " mobile" if 'alt="手机' in image else ""
        return f'<figure class="screenshot{mobile}">{image}<figcaption>{caption}</figcaption></figure>'

    body = re.sub(r'<p>(<img[^>]+>)</p>\s*<p><em>(.*?)</em></p>', figure, body, flags=re.S)
    return re.sub(r'(<table>.*?</table>)', r'<div class="table-scroll">\1</div>', body, flags=re.S)


def export() -> None:
    source = SOURCE.read_text(encoding="utf-8")
    chunks = re.split(r'\n<a id="([a-z]+)"></a>\n', source)
    assert len(chunks) == 25, "Expected 12 manual chapters"
    cover_source, contents_source = chunks[0].split("## 目录", 1)
    cover = render(cover_source)
    contents = render("## 目录" + contents_source)
    chapters = []
    nav = []
    for index in range(1, len(chunks), 2):
        anchor, text = chunks[index : index + 2]
        title = re.search(r"^## (.+)$", text, flags=re.M).group(1)
        label = html.escape(re.sub(r"^\d+\. ", "", title))
        nav.append(f'<li><a href="#{anchor}">{label}</a></li>')
        chapters.append(f'<section class="chapter" id="{anchor}" aria-label="{html.escape(title, quote=True)}">{render(text)}</section>')
    body = embed_screenshots("".join(chapters))
    template = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>心知 · 网站使用说明手册</title><meta name="description" content="learn.dryz.info 网站中文使用手册：检索、阅读、AI辅助及晨会清单。"><style>{CSS}</style></head>
<body><a class="skip-link" href="#quickstart">跳到操作说明</a><div class="layout">
<nav class="side" aria-label="手册目录"><strong>心知 · 使用手册</strong><ol>{''.join(nav)}</ol>
<div class="actions"><button class="print-btn" type="button" onclick="window.print()">打印 / 保存 PDF</button><small>手册版本 1.1 · 2026-10-10<br>网站：<a href="https://learn.dryz.info/">learn.dryz.info</a><br>截图与样式内嵌，可离线阅读。</small></div></nav>
<main><header class="cover"><div class="eyebrow">心知 / 阅读与研讨</div>{cover}</header>
<nav class="contents" aria-label="完整目录">{contents}</nav>{body}
<div class="end-note">手册版本 1.1 · 正文来源：使用说明.md · 图片来源：本地界面预览。</div></main></div></body></html>'''
    HTML.write_text(template, encoding="utf-8")
    chromium = shutil.which("chromium") or shutil.which("chromium-browser")
    if not chromium:
        raise RuntimeError("Chromium is required for PDF export")
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=chromium, headless=True, args=["--no-sandbox"])
        page = browser.new_page(locale="zh-CN", viewport={"width":1280,"height":1000})
        page.set_content(template, wait_until="load")
        page.evaluate("document.fonts.ready")
        assert page.locator(".chapter").count() == 12
        assert page.locator(".chapter img").count() == 6
        page.pdf(
            path=str(PDF),
            format="A4",
            prefer_css_page_size=True,
            print_background=True,
            display_header_footer=True,
            header_template='<div style="font-family:sans-serif;font-size:8px;width:100%;margin:0 60px;color:#657688;">心知 · 网站使用说明手册</div>',
            footer_template='<div style="font-family:sans-serif;font-size:8px;width:100%;margin:0 60px;display:flex;justify-content:space-between;color:#657688;"><span>learn.dryz.info · 2026-10-10</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
            outline=True,
            tagged=True,
        )
        browser.close()
    with zipfile.ZipFile(ZIP, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in [SOURCE, HTML, PDF] + sorted((DOCS / "manual-assets").glob("*.png")):
            archive.write(path, str(Path("心知网站使用说明手册") / path.relative_to(DOCS)))
    print(json.dumps({"files": [{"path": str(path), "bytes": path.stat().st_size} for path in (SOURCE, HTML, PDF, ZIP)]}, ensure_ascii=False))


if __name__ == "__main__":
    export()
