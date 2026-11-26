"""Offline Playwright regression for the six list title surfaces."""
import json
import os
from pathlib import Path
import re
import unittest

from playwright.sync_api import expect, sync_playwright

ROOT = Path(os.environ.get("XINZHI_LONG_TITLE_ROOT", Path(__file__).resolve().parents[1]))
WIDTHS = (390, 430, 768, 1280)
THEMES = ("light", "dark")
CJK = "心血管临床研究结果与循证医学分析" * 5
ENGLISH = ("Prospective cardiovascular research on clinical outcomes and patient care " * 4)[:260].rstrip()
TOKEN = ("Pneumonia-associated-cardiomyopathy-" + "W" * 90)[:90]
EXAMPLE_DOI = "10.1016/j.jacc.2026.01.0123456789abcdefghij"
ESCAPED = '<b>字面标题</b> &amp; "不是标记" ' + CJK
ESCAPED_EN = '<b>Literal title</b> &amp; "not markup"'
FIXTURES = {
    "T1": (CJK, "Cardiac evidence"),
    "T2": ("循证研究", ENGLISH),
    "T2-original": ("", ENGLISH),
    "T1-original": ("", CJK),
    "T3-token": (TOKEN, TOKEN),
    "T3-doi": (EXAMPLE_DOI, EXAMPLE_DOI),
    "T4": (ESCAPED, ESCAPED_EN),
    "T5": ("", "Clinical study"),
    "T6": ("房颤", "Atrial fibrillation"),
}
CARD_BADGES = ("#房颤/电生理", "#结构性心脏病", "#穿戴/远程监测")

# row selector, displayed title selector, English subtitle selector (when rendered)
SURFACES = {
    "S1": ("#weeklyAuto .weekly-row", ".weekly-row-title .title-open", None),
    "S2": (".deep-reading-item[data-deep-reading]", ".deep-reading-item-title", None),
    "S3": (".article-card", ".article-title .title-open", ".article-title-en"),
    "S4": (".compact-row", ".compact-title", ".article-title-en"),
    "S5": (".huddle-item", "h4", ".huddle-original-title"),
    "S6": ("[data-citation-export] > div", "label", None),
}


def source(path):
    return (ROOT / path).read_text(encoding="utf-8")


def declarations(path, pattern):
    match = re.search(pattern, source(path), re.S)
    if not match:
        raise AssertionError(f"Production declaration missing: {path}: {pattern}")
    return match[0]


def renderers():
    functions = {
        "src/app/09-weekly.js": ("weeklyRow", "dailyReadingGroups", "dailyReadingItem", "renderDailyDeepRead"),
        "src/app/05-list.js": ("renderArticleCard", "renderCompactRow"),
        "src/app/07-shortlist.js": ("openHuddleModal",),
        "src/app/01-state-helpers.js": ("cardSideActionsHtml", "cardTakeaway", "paperTopicTags"),
        "src/app/09y-topic-match.js": ("topicBadgeHtml",),
    }
    return "\n".join([
        declarations("src/app/01-state-helpers.js", r"  const esc = .*?\n  }\[c\]\)\);"),
        *(declarations(path, rf"  function {name}\([^\n]*\) \{{.*?\n  }}")
          for path, names in functions.items() for name in names),
    ])


def shell():
    index = source("index.html")
    weekly = index[index.index('      <section id="weeklySection"'):]
    weekly = weekly[:weekly.index("</section>") + len("</section>")].replace('data-pane="board" hidden', 'data-pane="board"')
    modal = index[index.index('  <div class="modal-backdrop" id="huddleModalBackdrop"'):].split("\n  <!--", 1)[0]
    return f"""<!doctype html><html lang="zh-CN" data-style="a"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"></head><body>
<div class="app-container"><main class="main-content">{weekly}
<div id="cards" class="articles-stream" hidden></div>
<div id="compact" class="articles-compact-list" hidden></div></main></div>{modal}</body></html>"""


def setup(page, theme):
    assets = {"/": ("text/html; charset=utf-8", shell()), "/style.css": ("text/css; charset=utf-8", source("style.css"))}

    def route_request(route):
        url = route.request.url
        if url.startswith("http://fixture.test/api/"):
            route.fulfill(json={"ok": True})
        elif url.removeprefix("http://fixture.test") in assets:
            mime, body = assets[url.removeprefix("http://fixture.test")]
            route.fulfill(content_type=mime, body=body)
        else:
            route.abort()

    page.route("**/*", route_request)
    page.goto("http://fixture.test/")
    page.add_script_tag(content=source("citation-export.js"))
    page.add_script_tag(content="""
      (() => {
        const $ = selector => document.querySelector(selector);
        const state = {huddle:[], huddleCompare:[], search:''};
        const DEFERRED = false, AI_AVAIL = false, RADAR_LOAD = {state:'idle'};
        const foldSearch = v => String(v || '').toLowerCase(), exactDoi = () => false, selectedTags = () => [];
        const quicklookOf = p => ({one_line:p.takeaway}), publicationStatusHtml = () => '',
          designBadgeHtml = () => '', journalMetricBadge = () => '', doiStatusBlock = () => '',
          getPublisherClass = () => 'pub-other', cardJournalName = p => p.journal,
          dateLabel = p => p.date, officialArticleUrl = () => '#source', huddleStarSvg = () => '☆',
          pdfDownloadLink = () => '<span class="ft-status ft-compact"><button class="btn-sm" type="button">获取全文</button></span>';
        const beijingToday = () => '2026-01-02', contentDate = s => s;
        const huddlePaper = id => papers.find(p => p.id === id), huddlePapers = () => papers,
          selectedComparePapers = () => [], studyKey = p => p.doi, compareBoxHtml = () => '',
          buildCitations = () => '', copyToClipboard = () => {}, pushOverlay = () => {}, compareCheck = () => {};
        const deepReadingHistoryLimit = 12;
        let activeDeepReadingId = '', huddleLastFocus, papers;
""" + renderers() + """
        window.setFixtureSearch = value => { state.search = value; };
        window.renderFixture = (surface, fixture) => {
          papers = fixture.map(([id,titleZh,title,tags]) => ({id, pmcid:id, weeklyPick:1, titleZh, title, tags,
            journal:'Clinical Research Journal', date:beijingToday(), doi:'10.9999/test-' + id,
            takeaway:title === 'Atrial fibrillation' ? '简短要点' : title,
            topic:title === 'Atrial fibrillation' ? '房颤' : title,
            scope:'public-fulltext-body', humanReviewed:false, publishedOn:beijingToday()}));
          const weekly = $('#weeklySection'), layout = weekly.closest('.app-container');
          weekly.hidden = !['S1','S2'].includes(surface);
          weekly.dataset.pane = surface === 'S2' ? 'reading' : 'board';
          layout.classList.toggle('full-width-layout', !weekly.hidden);
          layout.classList.toggle('weekly-layout', !weekly.hidden);
          $('#weeklyAuto').innerHTML = '<ul class="weekly-list">' + papers.map(p => weeklyRow(p,p.date,p.id)).join('') + '</ul>';
          window.DEEP_READINGS = {items:papers.concat(papers.map(p => ({...p, pmcid:'history-'+p.pmcid, publishedOn:'2026-01-01'})))};
          renderDailyDeepRead();
          if (surface === 'S2') $('#dailyDeepRead details').open = true;
          $('#cards').hidden = surface !== 'S3';
          $('#cards').innerHTML = papers.map(renderArticleCard).join('');
          $('#compact').hidden = surface !== 'S4';
          $('#compact').innerHTML = papers.map(renderCompactRow).join('');
          document.body.classList.remove('dialog-open');
          $('#huddleModalBackdrop').classList.remove('open');
          if (['S5','S6'].includes(surface)) {
            state.huddle = papers.map(p => p.id);
            openHuddleModal();
            const panel = $('[data-citation-export]');
            panel.open = surface === 'S6';
          }
        };
      })();
""")
    page.locator("html").evaluate("(e,theme) => e.dataset.theme = theme", theme)


def cases(surface):
    return {**FIXTURES, "T3-badges": (CJK, TOKEN)} if surface == "S3" else FIXTURES


def mount(page, surface, fixtures=None):
    if fixtures is None:
        fixtures = cases(surface)
    page.evaluate("([surface,fixtures]) => window.renderFixture(surface,fixtures)", [
        surface, [[key, zh, en, CARD_BADGES if key == "T3-badges" else []] for key, (zh, en) in fixtures.items()],
    ])
    rows = page.locator(SURFACES[surface][0])
    expect(rows).to_have_count(len(fixtures) * (2 if surface == "S2" else 1))
    expect(rows.first).to_be_visible()
    return rows


MEASURE = """(row, sel) => {
  const rect = e => {
    const {x,y,right,bottom,width,height} = e.getBoundingClientRect();
    return {x,y,right,bottom,width,height};
  };
  const metrics = e => e && {
    ...rect(e), sw:e.scrollWidth, cw:e.clientWidth, sh:e.scrollHeight, ch:e.clientHeight,
    text:e.textContent, title:e.closest('[title]')?.getAttribute('title') ?? null,
    clamp:getComputedStyle(e).webkitLineClamp, display:getComputedStyle(e).display,
    wrap:getComputedStyle(e).overflowWrap, white:getComputedStyle(e).whiteSpace
  };
  const title = row.querySelector(sel[0]), subtitle = sel[1] && row.querySelector(sel[1]);
  const clip = row.closest('.modal-body,.weekly-deep-read');
  const controls = [...row.querySelectorAll('.card-side-actions button,.card-side-actions a,.weekly-deep-badge,.huddle-item > button')]
    .map(e => ({...metrics(e), label:e.className}));
  const aux = row.querySelector('.weekly-row-line,.deep-reading-topic,.article-gist');
  return {row:metrics(row), clip:metrics(clip), title:metrics(title), subtitle:metrics(subtitle), controls, aux:metrics(aux),
    doc:[document.documentElement.scrollWidth,document.documentElement.clientWidth],
    badges:[...row.querySelectorAll('.topic-badge')].map(metrics),
    panel:metrics(row.closest('[data-citation-export]'))};
}"""


def measures(rows, surface):
    return [row.evaluate(MEASURE, SURFACES[surface][1:]) for row in rows.all()]


def capture(page, out, width, theme, surface):
    tokens = ("T3-badges", "T3-token") if surface == "S3" else ("T3-token",)
    order = ("T1", *tokens, "T2", "T6")
    row = mount(page, surface, {key: cases(surface)[key] for key in order})
    if surface in ("S5", "S6"):
        page.locator("#huddleModalBody").evaluate("e => e.scrollTop = 0")
    else:
        row.first.scroll_into_view_if_needed()
    page.screenshot(path=str(out / f"{width}-{theme}-{surface}.png"), animations="disabled")


def run_metrics(out):
    with sync_playwright() as pw, launch(pw) as browser:
        result = {}
        for width in WIDTHS:
            for theme in THEMES:
                page = browser.new_page(viewport={"width":width, "height":844 if width < 600 else 800}, reduced_motion="reduce")
                try:
                    setup(page, theme)
                    for surface in SURFACES:
                        result[f"{width}/{theme}/{surface}"] = measures(mount(page, surface), surface)
                        if width in (390, 1280):
                            capture(page, out, width, theme, surface)
                finally:
                    page.close()
    (out / "metrics.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")


def launch(pw):
    return pw.chromium.launch(headless=True, executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
                              args=["--no-sandbox"])

# Restore only the pre-change layout declarations; focus outlines do not affect geometry.
BEFORE_LONG_TITLE_CSS = """
.weekly-row-title .weekly-deep-badge { min-height: auto; }
.deep-reading-item[data-deep-reading]:not([title]) .deep-reading-item-title { -webkit-line-clamp: 2; }
.huddle-item-content h4, [data-citation-export], .weekly-row-line,
.article-card.has-side-actions .title-open, .article-card.has-side-actions .article-title-en.is-hit {
  overflow-wrap: inherit;
}
"""

FOCUS = """(e, rowSelector) => {
  const row = e.closest(rowSelector), outer = row.closest('.weekly-deep-read,.modal-body');
  const r = row.getBoundingClientRect(), b = e.getBoundingClientRect(), s = getComputedStyle(e);
  const clip = outer && getComputedStyle(outer).overflowY !== 'visible' ? outer.getBoundingClientRect() : null;
  const p = Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
  return {visible:e.matches(':focus-visible') && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0,
          ring:[b.left-p,b.top-p,b.right+p,b.bottom+p],
          bounds:[Math.max(r.left, clip?.left ?? 0, 0), Math.max(r.top, clip?.top ?? 0, 0),
                  Math.min(r.right, clip?.right ?? innerWidth, innerWidth),
                  Math.min(r.bottom, clip?.bottom ?? innerHeight, innerHeight)]};
}"""


def combined_title(zh, en):
    return f"{zh}\n{en}" if zh and zh != en else en


class LongTitleChecks:
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.addClassCleanup(cls.pw.stop)
        cls.browser = launch(cls.pw)
        cls.addClassCleanup(cls.browser.close)

    def page(self, width, theme):
        page = self.browser.new_page(viewport={"width": width, "height": 844 if width < 600 else 800},
                                     reduced_motion="reduce")
        setup(page, theme)
        return page

    def assert_inside(self, item, box):
        self.assertGreaterEqual(item["x"], box["x"] - 1)
        self.assertLessEqual(item["right"], box["right"] + 1)
        self.assertGreaterEqual(item["y"], box["y"] - 1)
        self.assertLessEqual(item["bottom"], box["bottom"] + 1)

    def assert_focus_ring(self, target, row_selector):
        # Establish keyboard modality before moving focus to the exact fixture.
        target.page.keyboard.press("Tab")
        target.evaluate("e => e.scrollIntoView({block:'center', inline:'nearest'})")
        target.focus()
        expect(target).to_be_focused()
        m = target.evaluate(FOCUS, row_selector)
        self.assertTrue(m["visible"], m)
        left, top, right, bottom = m["ring"]
        l, t, r, b = m["bounds"]
        self.assertTrue(left >= l-1 and top >= t-1 and right <= r+1 and bottom <= b+1, m)

    def test_extreme_geometry_titles_and_controls(self):
        for width in WIDTHS:
            for theme in THEMES:
                with self.page(width, theme) as page:
                    for surface, (row_sel, title_sel, _) in SURFACES.items():
                        rows = mount(page, surface)
                        actual = measures(rows, surface)
                        fixtures = cases(surface)
                        ids = list(fixtures) * (2 if surface == "S2" else 1)
                        for i, (key, row, m) in enumerate(zip(ids, rows.all(), actual)):
                            with self.subTest(width=width, theme=theme, surface=surface, case=key, row=i):
                                self.assert_geometry(width, surface, m)
                                zh, en = fixtures[key]
                                target = row if surface == "S2" else row.locator(title_sel)
                                if surface in ("S1", "S2", "S3", "S4"):
                                    if surface == "S2":
                                        expect(target).to_have_accessible_name(re.compile(re.escape(zh or en)))
                                    else:
                                        expect(target).to_have_accessible_name(zh or en)
                                elif surface == "S5":
                                    target = row.get_by_role("checkbox")
                                else:
                                    target = row.get_by_role("checkbox", name=f"{i + 1}. {en}")
                                # S5/S6 titles are not focusable. Their native checkboxes may draw
                                # into the modal's padding, but must not be clipped by the modal.
                                self.assert_focus_ring(target, "#huddleModalBody" if surface in ("S5", "S6") else row_sel)
                                self.assert_native_titles(surface, key, m, zh, en)
                                if key == "T3-badges":
                                    self.assertEqual([b["text"] for b in m["badges"]], list(CARD_BADGES))
                                    for badge in m["badges"]:
                                        self.assert_inside(badge, m["row"])
                                        self.assertGreater(badge["height"], 0)
                                        self.assertLessEqual(badge["sw"], badge["cw"] + 1)
                        if surface == "S6":
                            with self.subTest(width=width, theme=theme, surface=surface, case="export actions"):
                                self.assert_export_actions(page)

    def assert_geometry(self, width, surface, m):
        title, row, subtitle = m["title"], m["row"], m["subtitle"]
        self.assertLessEqual(m["doc"][0], width + 1)
        self.assert_inside(title, row)
        self.assertLessEqual(title["sw"], title["cw"] + 1)
        if surface in ("S1", "S2", "S3", "S4"):
            self.assertEqual(title["clamp"], "2")
        if subtitle and subtitle["display"] != "none":
            self.assert_inside(subtitle, row)
            if surface in ("S3", "S4"):
                self.assertEqual(subtitle["clamp"], "2")
        if m["clip"]:
            self.assertLessEqual(m["clip"]["sw"], m["clip"]["cw"] + 1)
        if m["panel"]:
            self.assertLessEqual(m["panel"]["sw"], m["panel"]["cw"] + 1)
        if surface == "S1":
            self.assertLessEqual(m["aux"]["sw"], m["aux"]["cw"] + 1)
        if surface == "S2":
            self.assertGreaterEqual(row["width"], 32)
            self.assertGreaterEqual(row["height"], 32)
        expected_actions = {"S1": 4, "S2": 0, "S3": 3, "S4": 3, "S5": 1, "S6": 0}
        self.assertEqual(len(m["controls"]), expected_actions[surface])
        for control in m["controls"]:
            self.assert_inside(control, row)
            self.assertGreaterEqual(control["width"], 32, control)
            self.assertGreaterEqual(control["height"], 32, control)
            self.assertLessEqual(control["sw"], control["cw"] + 1, control)
            self.assertLessEqual(control["sh"], control["ch"] + 1, control)
            if surface in ("S1", "S3", "S4"):
                overlap_width = min(title["right"], control["right"]) - max(title["x"], control["x"])
                overlap_height = min(title["bottom"], control["bottom"]) - max(title["y"], control["y"])
                self.assertFalse(overlap_width > 1 and overlap_height > 1, {"title": title, "control": control})

    def assert_native_titles(self, surface, key, m, zh, en):
        title, subtitle = m["title"], m["subtitle"]
        clipped = title["sh"] > title["ch"] + 1
        if surface in ("S1", "S2", "S3", "S4"):
            self.assertIn(zh or en, title["text"])
            if surface in ("S1", "S4"):
                self.assertEqual(title["title"], combined_title(zh, en))
            elif surface == "S2" and (key not in ("T5", "T6") or clipped):
                self.assertEqual(title["title"], combined_title(zh, en))
            if surface == "S2" and key == "T4":  # This fixture must genuinely overflow two lines at all widths.
                self.assertTrue(clipped)
        else:
            self.assertFalse(clipped)
        if subtitle and subtitle["display"] != "none":
            if surface in ("S3", "S4"):
                self.assertEqual(subtitle["title"], en)
                if key == "T2":
                    self.assertLessEqual(subtitle["sw"], subtitle["cw"] + 1)
            if subtitle["sh"] > subtitle["ch"] + 1 or subtitle["sw"] > subtitle["cw"] + 1:
                self.assertEqual(subtitle["title"], en)

    def assert_export_actions(self, page):
        panel = page.locator("[data-citation-export]")
        expect(panel.get_by_role("combobox")).to_be_visible()
        actions = panel.locator(":scope > button")
        expect(actions).to_have_count(2)
        for action in actions.all():
            expect(action).to_be_visible()
            a, p = action.bounding_box(), panel.bounding_box()
            self.assertGreaterEqual(a["width"], 32)
            self.assertGreaterEqual(a["height"], 32)
            self.assertGreaterEqual(a["x"], p["x"] - 1)
            self.assertLessEqual(a["x"] + a["width"], p["x"] + p["width"] + 1)

    def test_short_title_position_and_size_unchanged(self):
        def geometry(row, surface):
            m = row.evaluate(MEASURE, SURFACES[surface][1:])
            t, r = m["title"], m["row"]
            return (t["width"], t["height"], t["x"] - r["x"], t["y"] - r["y"]), t

        for width in WIDTHS:
            for theme in THEMES:
                with self.page(width, theme) as page:
                    page.evaluate("() => document.fonts.ready.then(() => true)")
                    for surface in SURFACES:
                        with self.subTest(width=width, theme=theme, surface=surface):
                            row = mount(page, surface).nth(list(FIXTURES).index("T6"))
                            before = page.add_style_tag(content=BEFORE_LONG_TITLE_CSS)
                            baseline, _ = geometry(row, surface)
                            before.evaluate("e => e.remove()")
                            actual, title = geometry(row, surface)
                            for field, value, expected in zip(("width", "height", "x", "y"), actual, baseline):
                                self.assertAlmostEqual(value, expected, delta=1, msg=field)
                            self.assertLessEqual(title["sh"], title["ch"] + 1)

    def test_no_new_short_title_attributes(self):
        with self.page(390, "light") as page:
            for surface in SURFACES:
                with self.subTest(surface=surface):
                    m = measures(mount(page, surface, {"T6": FIXTURES["T6"]}), surface)[0]
                    self.assertEqual(m["title"]["title"], {
                        "S1": combined_title(*FIXTURES["T6"]), "S4": combined_title(*FIXTURES["T6"]),
                    }.get(surface))

    def test_compact_title_tooltip_deduplicates_and_falls_back(self):
        with self.page(390, "light") as page:
            cases = {
                "translated": ("房颤", "Atrial fibrillation", "房颤\nAtrial fibrillation"),
                "identical": ("Clinical study", "Clinical study", "Clinical study"),
            "no-zh": ("", "Clinical study", "Clinical study"),
            }
            for case, (zh, en, expected) in cases.items():
                with self.subTest(case=case):
                    button = mount(page, "S4", {case: (zh, en)}).get_by_role("button", name=zh or en, exact=True)
                    expect(button).to_have_attribute("title", expected)

    def test_markup_stays_escaped_and_title_round_trips(self):
        zh, en = FIXTURES["T4"]
        with self.page(1280, "light") as page:
            for surface, (_, title_sel, sub_sel) in SURFACES.items():
                with self.subTest(surface=surface):
                    rows = mount(page, surface, {"T4": (zh, en)})
                    for row in rows.all():
                        title = row.locator(title_sel)
                        expect(title).to_have_text(f"1. {en}" if surface == "S6" else f"1. {zh}" if surface == "S5" else zh)
                        expect(row.locator("b")).to_have_count(0)
                        if surface in ("S1", "S2", "S4"):
                            owner = row if surface == "S2" else title
                            expect(owner).to_have_attribute("title", combined_title(zh, en))
                        if sub_sel and surface in ("S3", "S4"):
                            expect(row.locator(sub_sel)).to_have_attribute("title", en)

    def test_empty_chinese_title_falls_back_to_english(self):
        with self.page(390, "dark") as page:
            for surface, (_, title_sel, _) in SURFACES.items():
                with self.subTest(surface=surface):
                    _, en = FIXTURES["T5"]
                    rows = mount(page, surface, {"T5": ("", en)})
                    for row in rows.all():
                        expect(row.locator(title_sel)).to_have_text(f"1. {en}" if surface in ("S5", "S6") else en)
                        expect(row.locator(".article-title-en,.huddle-original-title")).to_have_count(0)
                        if surface == "S2":
                            self.assertIsNone(row.get_attribute("title"))

    def test_mobile_rules_do_not_leak_when_viewport_grows(self):
        with self.page(390, "light") as page:
            for surface in ("S1", "S2", "S3", "S4"):
                with self.subTest(surface=surface):
                    page.set_viewport_size({"width": 390, "height": 844})
                    rows = mount(page, surface, {"T2": FIXTURES["T2"]})
                    expected_display = "none"
                    if surface in ("S3", "S4"):
                        expect(rows.first.locator(".article-title-en")).to_have_css("display", expected_display)
                    elif surface == "S1":
                        expect(rows.first.locator(".weekly-deep-badge")).to_have_css("display", "flex")
                    else:
                        expect(rows.first).to_have_css("padding-top", "12px")
                    page.set_viewport_size({"width": 1280, "height": 800})
                    if surface in ("S3", "S4"):
                        expect(rows.first.locator(".article-title-en")).not_to_have_css("display", expected_display)
                    elif surface == "S1":
                        expect(rows.first.locator(".weekly-deep-badge")).to_have_css("display", "inline-flex")
                    else:
                        expect(rows.first).to_have_css("padding-top", "10px")

    def test_matching_english_subtitle_wraps_instead_of_clipping_token(self):
        for width in (768, 1280):
            with self.subTest(width=width), self.page(width, "light") as page:
                page.evaluate("window.setFixtureSearch('Pneumonia')")
                rows = mount(page, "S3", {"T3-token": ("最长题名", TOKEN)})
                expect(rows.first.locator(".article-title-en.is-hit")).to_be_visible()
                m = measures(rows, "S3")[0]
                self.assertLessEqual(m["subtitle"]["sw"], m["subtitle"]["cw"] + 1)
                self.assertGreater(m["subtitle"]["height"], 20)


if __name__ == "__main__":
    if evidence := os.environ.get("XINZHI_LONG_TITLE_EVIDENCE"):
        run_metrics(Path(evidence))
    else:
        class LongTitleTest(LongTitleChecks, unittest.TestCase):
            pass

        unittest.main(verbosity=2)
