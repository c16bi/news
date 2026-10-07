"""Story grouping (scripts/stories.py).

The cases in data/story_cases.json are real articles from the live feed, with
the opening text the clustering actually sees. They pin the decisions that
were checked by reading every group the tuned settings produced.
"""

import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import stories  # noqa: E402

CASES = json.loads((HERE / "data" / "story_cases.json").read_text(encoding="utf-8"))

# Unrelated stories so the inverse document frequencies look like a real feed
# rather than a corpus of three articles that all share every word.
FILLER = [
    ("https://example-a.com/1", "Royal Mail to cut up to 2,500 head office jobs"),
    ("https://example-b.com/2", "Why are France's students protesting?"),
    ("https://example-c.com/3", "Turkey's Erdogan captures city his party never won"),
    ("https://example-d.com/4", "Pogacar misses European Championships with poor form"),
    ("https://example-e.com/5", "Apple AirPods Pro discounted in autumn sale"),
    ("https://example-f.com/6", "Brazil's presidential race heads to a runoff"),
    ("https://example-g.com/7", "Knicks open training camp with new rotation questions"),
    ("https://example-h.com/8", "Yankees beat Rays in Game 2 of division series"),
    ("https://example-i.com/9", "Bank of England holds rates as inflation eases"),
    ("https://example-j.com/10", "OpenAI releases new model for software agents"),
]


def corpus(*keys):
    items = [dict(a) for k in keys for a in CASES[k]]
    newest = max(a["date"] for a in items)
    for i, (url, title) in enumerate(FILLER):
        items.append({"url": url, "title": title, "date": newest - 3600 * (i + 1), "text": ""})
    return items


def groups_of(items):
    return [set(g) for g in stories.cluster(items)]


class Grouping(unittest.TestCase):
    def assertGrouped(self, key):
        urls = {a["url"] for a in CASES[key]}
        found = groups_of(corpus(*CASES))
        self.assertIn(urls, found, f"{key}: expected one group of {len(urls)}")

    def test_same_story_from_two_outlets(self):
        self.assertGrouped("russell")

    def test_three_outlets_one_group(self):
        self.assertGrouped("paramount")

    def test_near_identical_wording_with_no_names(self):
        # "Average five-year mortgage rate hits 6%..." names nobody; wording
        # this close is enough on its own.
        self.assertGrouped("mortgage")

    def test_shared_topic_is_not_the_same_story(self):
        # Google's data centres and old nuclear plants: same subject, scored
        # higher than several true matches, but no shared name. Must stay apart.
        nuclear = {a["url"] for a in CASES["nuclear"]}
        for group in groups_of(corpus(*CASES)):
            self.assertFalse(nuclear <= group, "the nuclear pair was grouped")

    def test_filler_is_never_grouped(self):
        filler = {u for u, _ in FILLER}
        for group in groups_of(corpus(*CASES)):
            self.assertFalse(group & filler, f"unrelated story pulled into {group}")


class Rules(unittest.TestCase):
    def item(self, url, title, date, text=""):
        return {"url": url, "title": title, "date": date, "text": text}

    def test_one_outlet_is_never_grouped_with_itself(self):
        title = "Verstappen takes first pole of 2026 ahead of Hamilton in Malaysia"
        items = [
            self.item("https://www.bbc.co.uk/sport/a", title, 1000),
            self.item("https://www.bbc.co.uk/sport/b", title, 900),
        ]
        self.assertEqual(stories.cluster(items, threshold=0.1), [])

    def test_each_outlet_appears_once_per_group(self):
        title = "Verstappen takes first pole of 2026 ahead of Hamilton in Malaysia"
        items = [
            self.item("https://www.bbc.co.uk/a", title, 1000),
            self.item("https://www.autosport.com/a", title, 990),
            self.item("https://www.autosport.com/b", title, 980),
        ]
        groups = stories.cluster(items, threshold=0.1)
        self.assertEqual(len(groups), 1)
        domains = [stories.domain_of(u) for u in groups[0]]
        self.assertEqual(len(domains), len(set(domains)))

    def test_far_apart_in_time_is_a_follow_up_not_a_repeat(self):
        title = "Verstappen takes first pole of 2026 ahead of Hamilton in Malaysia"
        items = [
            self.item("https://www.bbc.co.uk/a", title, 10 * 86400),
            self.item("https://www.autosport.com/a", title, 10 * 86400 - stories.WINDOW - 60),
        ]
        self.assertEqual(stories.cluster(items, threshold=0.1), [])

    def test_groups_are_newest_first(self):
        title = "Verstappen takes first pole of 2026 ahead of Hamilton in Malaysia"
        items = [
            self.item("https://www.autosport.com/a", title, 900),
            self.item("https://www.bbc.co.uk/a", title, 1000),
        ]
        groups = stories.cluster(items, threshold=0.1)
        self.assertEqual(groups[0][0], "https://www.bbc.co.uk/a")

    def test_empty_and_untitled_input(self):
        self.assertEqual(stories.cluster([]), [])
        self.assertEqual(stories.cluster([{"url": "https://a.com/x", "title": "", "date": 1}]), [])


class Names(unittest.TestCase):
    def test_sentence_case_headline(self):
        names = stories.names({"title": "Customer data at Asos may be compromised after app access"})
        self.assertIn("asos", names)

    def test_first_word_of_a_sentence_is_not_a_name(self):
        # Capitalised only because it starts the headline.
        names = stories.names({"title": "Customer data at Asos may be compromised"})
        self.assertNotIn("customer", names)

    def test_title_case_headline_is_ignored_for_names(self):
        # Every word capitalised says nothing about which ones are names.
        names = stories.names({"title": "Energy Firms Try to Squeeze More Power Out of Old Nuclear Plants"})
        self.assertNotIn("energy", names)
        self.assertNotIn("nuclear", names)

    def test_mixed_case_words_count_anywhere(self):
        names = stories.names({"title": "SpaceX Eyes $40 Billion Deal to Buy Nvidia Chips"})
        self.assertIn("spacex", names)


if __name__ == "__main__":
    unittest.main()
