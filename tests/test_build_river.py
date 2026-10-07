"""The river build (scripts/build_river.py)."""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import build_river  # noqa: E402

DAY = 86400
BUILT = 1_790_000_000  # 2026-09-21 13:46 UTC


def feed(fid, title, items, *, query=False, hidden=False, tags=("news",)):
    return {
        "id": fid,
        "title": title,
        "displayTitle": title,
        "url": "",
        "feedLink": "https://" + fid + ".example/",
        "isQuery": query,
        "isEmpty": not items,
        "isHidden": hidden,
        "itemCount": len(items),
        "tags": list(tags),
        "items": items,
    }


def item(url, title, date, **extra):
    base = {
        "title": title,
        "url": url,
        "date": date,
        "author": "",
        "guid": 1,
        "unread": True,
        "content": "",
        "contentLength": 0,
        "flags": "",
        "enclosureUrl": "",
        "enclosureMime": "",
        "commentsUrl": "",
    }
    base.update(extra)
    return base


class RiverCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.docs = Path(self.tmp.name) / "docs"
        (self.docs / "feeds").mkdir(parents=True)
        (self.docs / "build_time.txt").write_text(str(BUILT))
        self.cache = Path(self.tmp.name) / "images.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, data):
        (self.docs / "feeds" / (name + ".json")).write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )

    def build(self):
        return build_river.build(self.docs, now=BUILT, image_cache=self.cache)

    def day(self, name):
        return json.loads((self.docs / "river" / (name + ".json")).read_text(encoding="utf-8"))

    def everything(self, index):
        return [a for d in index["days"] for a in self.day(d["day"])]


class Merging(RiverCase):
    def test_topic_feeds_archives_and_hidden_feeds_are_left_out(self):
        story = item("https://a.example/1", "A story", BUILT - 100)
        self.write("src", feed("src", "Source", [story]))
        self.write("topic", feed("topic", "Sport", [item("https://a.example/only-in-topic", "Topic", BUILT)], query=True))
        self.write("src_archive", feed("src", "Source", [item("https://a.example/archived", "Old", BUILT - 5)]))
        self.write("hid", feed("hid", "Hidden", [item("https://h.example/1", "Hidden", BUILT)], hidden=True))
        urls = [a["url"] for a in self.everything(self.build())]
        self.assertEqual(urls, ["https://a.example/1"])

    def test_one_story_in_two_feeds_appears_once(self):
        story = item("https://a.example/1", "Shared", BUILT - 100)
        self.write("one", feed("one", "One", [story]))
        self.write("two", feed("two", "Two", [dict(story, guid=99)]))
        self.assertEqual(len(self.everything(self.build())), 1)

    def test_days_are_utc_and_newest_first(self):
        self.write(
            "src",
            feed(
                "src",
                "Source",
                [
                    item("https://a.example/old", "Old", BUILT - 2 * DAY),
                    item("https://a.example/new", "New", BUILT - 60),
                    item("https://a.example/newer", "Newer", BUILT - 30),
                ],
            ),
        )
        index = self.build()
        self.assertEqual([d["day"] for d in index["days"]], ["2026-09-21", "2026-09-19"])
        self.assertEqual([a["title"] for a in self.day("2026-09-21")], ["Newer", "New"])
        self.assertEqual(index["days"][0]["n"], 2)

    def test_index_carries_feed_names_and_tags(self):
        self.write("src", feed("src", "BBC Business", [item("https://a.example/1", "x", BUILT)], tags=("bbc", "finance")))
        index = self.build()
        self.assertEqual(index["feeds"]["src"]["title"], "BBC Business")
        self.assertEqual(index["feeds"]["src"]["tags"], ["bbc", "finance"])

    def test_a_publisher_clock_in_the_future_does_not_pin_a_story_to_the_top(self):
        self.write("src", feed("src", "S", [item("https://a.example/1", "Future", BUILT + 5 * DAY)]))
        self.assertEqual(self.everything(self.build())[0]["date"], BUILT)


class Stability(RiverCase):
    """The point of the river: unchanged days must be byte-identical."""

    def stories(self, guid_base):
        return [
            item(f"https://a.example/{i}", f"Story {i}", BUILT - i * 3 * 3600, guid=guid_base + i)
            for i in range(40)
        ]

    def test_renumbered_guids_change_nothing(self):
        # newsboat's cache is rebuilt every run, so every item gets a new guid.
        self.write("src", feed("src", "S", self.stories(100)))
        first = self.build()
        self.write("src", feed("src", "S", self.stories(9000)))
        second = self.build()
        self.assertEqual(first["days"], second["days"])

    def test_a_new_story_changes_only_its_own_day(self):
        self.write("src", feed("src", "S", self.stories(100)))
        before = {d["day"]: d["v"] for d in self.build()["days"]}
        self.write("src", feed("src", "S", [item("https://a.example/fresh", "Fresh", BUILT)] + self.stories(5000)))
        after = {d["day"]: d["v"] for d in self.build()["days"]}
        changed = [day for day in after if before.get(day) != after[day]]
        self.assertEqual(changed, ["2026-09-21"])

    def test_unchanged_files_are_not_rewritten(self):
        self.write("src", feed("src", "S", self.stories(100)))
        self.build()
        path = self.docs / "river" / "2026-09-19.json"
        old = time.time() - 1000
        os.utime(path, (old, old))
        self.build()
        self.assertEqual(int(path.stat().st_mtime), int(old))

    def test_days_that_leave_the_feed_are_deleted(self):
        self.write("src", feed("src", "S", [item("https://a.example/old", "Old", BUILT - 3 * DAY)]))
        self.build()
        self.assertTrue((self.docs / "river" / "2026-09-18.json").exists())
        self.write("src", feed("src", "S", [item("https://a.example/new", "New", BUILT)]))
        self.build()
        self.assertFalse((self.docs / "river" / "2026-09-18.json").exists())


class Pictures(RiverCase):
    def picture(self, **extra):
        self.write("src", feed("src", "S", [item("https://a.example/1", "x", BUILT, **extra)]))
        return self.everything(self.build())[0].get("image", "")

    def test_harvested_picture_wins_over_the_enclosure(self):
        self.assertEqual(
            self.picture(lbImage="https://cdn.example/og.jpg", enclosureUrl="https://cdn.example/rss.jpg"),
            "https://cdn.example/og.jpg",
        )

    def test_enclosure_used_when_it_is_an_image(self):
        self.assertEqual(self.picture(enclosureUrl="https://cdn.example/p.jpg?w=700"), "https://cdn.example/p.jpg?w=700")
        self.assertEqual(self.picture(enclosureUrl="https://cdn.example/p", enclosureMime="image/jpeg"), "https://cdn.example/p")
        self.assertEqual(self.picture(enclosureUrl="https://cdn.example/episode.mp3"), "")

    def test_double_escaped_urls_are_repaired(self):
        # 57 live picture URLs arrived as &amp;amp; and never loaded.
        self.assertEqual(
            self.picture(enclosureUrl="https://cdn.example/p.jpg?quality=90&amp;amp;w=1200"),
            "https://cdn.example/p.jpg?quality=90&w=1200",
        )

    def test_insecure_and_inline_pictures_are_dropped(self):
        self.assertEqual(self.picture(enclosureUrl="http://cdn.example/p.jpg"), "")
        self.assertEqual(self.picture(lbImage="data:image/png;base64,AAAA"), "")
        self.assertEqual(self.picture(lbImage="javascript:alert(1)"), "")

    def test_a_rotating_cdn_host_keeps_the_url_the_reader_has(self):
        # Autosport serves the same picture from cdn-6 one hour and cdn-8 the next.
        first = self.picture(enclosureUrl="https://cdn-6.motorsport.com/images/a/s6/pic.jpg")
        second = self.picture(enclosureUrl="https://cdn-8.motorsport.com/images/a/s6/pic.jpg")
        self.assertEqual(second, first)

    def test_a_different_picture_replaces_the_old_one(self):
        self.picture(enclosureUrl="https://cdn.example/one.jpg")
        self.assertEqual(self.picture(enclosureUrl="https://cdn.example/two.jpg"), "https://cdn.example/two.jpg")


class TextAndSafety(RiverCase):
    def only(self, **extra):
        self.write("src", feed("src", "S", [item("https://a.example/1", extra.pop("title", "x"), BUILT, **extra)]))
        stories = self.everything(self.build())
        return stories[0] if stories else None

    def test_feed_html_becomes_plain_paragraphs(self):
        story = self.only(content="<p>First <b>bold</b> para.</p><script>evil()</script><p>Second &amp; last.</p>")
        self.assertEqual(story["text"], "First bold para.\n\nSecond & last.")

    def test_harvested_body_wins_when_it_is_longer(self):
        story = self.only(content="<p>Short summary.</p>", lbText="A much longer harvested body.\n\nWith two paragraphs.")
        self.assertTrue(story["text"].startswith("A much longer"))

    def test_the_feeds_own_copy_wins_when_it_is_longer(self):
        own = "<p>" + "Full article text. " * 60 + "</p>"
        story = self.only(content=own, lbText="A short harvested scrap.")
        self.assertTrue(story["text"].startswith("Full article text."))

    def test_very_long_text_is_capped_at_a_paragraph(self):
        paras = "".join("<p>" + "word " * 200 + "</p>" for _ in range(30))
        story = self.only(content=paras)
        self.assertLessEqual(len(story["text"]), build_river.MAX_TEXT + 1)
        self.assertTrue(story["text"].endswith("…"))

    def test_markup_in_titles_is_flattened(self):
        self.assertEqual(self.only(title="Rates &amp; <i>yields</i>")["title"], "Rates & yields")

    def test_a_script_link_never_reaches_the_page(self):
        self.write("src", feed("src", "S", [item("javascript:alert(1)", "Bad", BUILT), item("https://a.example/ok", "Ok", BUILT)]))
        urls = [a["url"] for a in self.everything(self.build())]
        self.assertEqual(urls, ["https://a.example/ok"])

    def test_volatile_fields_are_not_published(self):
        story = self.only(guid=123, unread=False, flags="N")
        for field in ("guid", "unread", "flags", "contentLength", "enclosureUrl", "commentsUrl"):
            self.assertNotIn(field, story)


class Groups(RiverCase):
    def test_story_groups_are_written_and_hashed(self):
        title = "Verstappen takes first 2026 pole ahead of Hamilton in Malaysia"
        filler = [item(f"https://f{i}.example/x", f"Unrelated filler headline number {i}", BUILT - 9000 - i) for i in range(12)]
        self.write("bbc", feed("bbc", "BBC F1", [item("https://www.bbc.co.uk/sport/f1/1", title, BUILT - 60)] + filler))
        self.write("as", feed("as", "Autosport", [item("https://www.autosport.com/f1/1", title, BUILT - 600)]))
        index = self.build()
        groups = json.loads((self.docs / "river" / "clusters.json").read_text())
        self.assertEqual(index["clusters"]["n"], 1)
        self.assertEqual(set(groups[0]), {"https://www.bbc.co.uk/sport/f1/1", "https://www.autosport.com/f1/1"})


if __name__ == "__main__":
    unittest.main()
