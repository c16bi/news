"""Article text and picture extraction (scripts/harvest_articles.py)."""

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import harvest_articles as ha  # noqa: E402

P = ("The European Central Bank held rates steady on Thursday, citing persistent core inflation "
     "across the single currency area and a weaker outlook for industrial output.")
Q = ("Analysts had widely expected the decision, though several noted the accompanying statement "
     "struck a markedly more cautious tone than the one issued in July.")
R = ("Bond markets moved little on the news, with the ten-year Bund yield finishing the session "
     "almost exactly where it began.")

NEWS_PAGE = f"""<html><head>
<meta property="og:image" content="https://cdn.example.com/lead.jpg">
</head><body>
<nav><p>Home</p><p>World</p><p>Business</p></nav>
<header><p>Sign up for our newsletter</p></header>
<article>
  <figure><figcaption>A trader works the floor. Photograph: Getty Images</figcaption></figure>
  <p>{P}</p>
  <p>Advertisement</p>
  <p>Share this article</p>
  <p>{Q}</p>
  <script>window.ads = 1;</script>
  <p>{R}</p>
</article>
<aside><p>Related: five things to watch in markets this week and beyond</p></aside>
<footer><p>Copyright 2026 All rights reserved</p></footer>
</body></html>"""


class Text(unittest.TestCase):
    def setUp(self):
        self.text = ha.pick_text(NEWS_PAGE)

    def test_keeps_the_article(self):
        for para in (P, Q, R):
            self.assertIn(para, self.text)

    def test_drops_page_furniture(self):
        for junk in ("World", "Related", "Copyright", "Sign up"):
            self.assertNotIn(junk, self.text)

    def test_drops_ads_share_prompts_captions_and_scripts(self):
        for junk in ("Advertisement", "Share this", "Getty Images", "window.ads"):
            self.assertNotIn(junk, self.text)

    def test_keeps_paragraph_breaks(self):
        self.assertEqual(self.text.count("\n\n"), 2)

    def test_works_without_an_article_element(self):
        page = f"<html><body><div class=post><p>{P}</p><p>{Q}</p><p>{R}</p></div></body></html>"
        self.assertIn(P, ha.pick_text(page))

    def test_prefers_the_longest_article_element(self):
        stub = "Teaser rail item that is long enough to pass the filter. " * 2
        page = f"<article><p>{stub}</p></article><article><p>{P}</p><p>{Q}</p><p>{R}</p></article>"
        self.assertNotIn("Teaser rail", ha.pick_text(page))

    def test_a_consent_wall_is_not_an_article(self):
        wall = ("<article><p>We use cookies and similar technologies on this site.</p>"
                "<p>Accept all cookies to continue reading this article now.</p></article>")
        self.assertEqual(ha.pick_text(wall), "")
        self.assertEqual(ha.pick_text("<html><body></body></html>"), "")

    def test_decodes_entities(self):
        page = (f"<article><p>Rates &amp; yields &mdash; the ECB&rsquo;s &ldquo;cautious&rdquo; tone "
                f"surprised nobody at all this week.</p><p>{P}</p><p>{Q}</p></article>")
        text = ha.pick_text(page)
        self.assertIn("Rates & yields", text)
        self.assertNotIn("&amp;", text)

    def test_caps_long_articles_at_a_paragraph(self):
        para = "This is a sentence of reasonable length that stands in for real article prose. " * 12
        text = ha.pick_text("<article>" + f"<p>{para}</p>" * 12 + "</article>")
        self.assertLessEqual(len(text), ha.MAX_TEXT + 1)
        self.assertTrue(text.endswith("…"))

    def test_survives_malformed_markup(self):
        for bad in ("<html><body><article><p>unclosed", "<p>a<p>b<p>c", "", "<<<>>>", "<article>" * 50):
            ha.pick_text(bad)


class Picture(unittest.TestCase):
    def test_reads_og_image(self):
        self.assertEqual(ha.pick_image(NEWS_PAGE, "https://x.com/a"), "https://cdn.example.com/lead.jpg")

    def test_resolves_relative_and_rejects_insecure(self):
        self.assertEqual(
            ha.pick_image('<meta property="og:image" content="/img/a.jpg">', "https://news.example/story"),
            "https://news.example/img/a.jpg",
        )
        self.assertEqual(ha.pick_image('<meta property="og:image" content="http://x.com/a.jpg">', "https://x.com/"), "")


class FeedText(unittest.TestCase):
    def test_measures_text_not_markup(self):
        self.assertEqual(ha.feed_text_length({"content": "<p>Hello <b>there</b> world</p>"}), len("Hello there world"))


if __name__ == "__main__":
    unittest.main()
