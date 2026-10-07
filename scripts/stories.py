"""
stories.py - notice when different outlets are reporting the same story.

When something big happens, the BBC, the Guardian and the NYT all run it, and
a merged feed shows it three times in a row. This finds those groups so the
front end can collapse them into one row with the other outlets underneath.

The approach is deliberately plain - TF-IDF over the headline and the opening
of the text, compared by cosine similarity - because the cost of a mistake is
lopsided. A missed group costs a duplicate row, which is what the feed already
looks like today. A wrong group hides a different story under someone else's
headline, which is worse than no grouping at all. So everything here leans
towards not merging:

  - only different outlets are grouped; one outlet's follow-up pieces stay as
    separate rows, since they are usually different angles, not repeats
  - each outlet appears at most once in a group
  - members must be published within WINDOW of each other
  - an item joins a group by its similarity to the group as a whole (the
    centroid), never to one member, so A~B and B~C cannot chain A to C
  - it must also share a name with the group - a person, company, place or
    product - unless the wording is near-identical (STRONG)
  - THRESHOLD was tuned on the live feed by reading every group it produced

The name rule exists because of one real pair. The Verge's "Google's
power-hungry data centers crave nuclear energy" and the NYT's "Energy firms
try to squeeze more power out of old nuclear plants" scored 0.44 - higher than
several genuine matches - because they share a topic. What they do not share
is anyone or anything named, and every correct group in the live feed did.

Pure standard library; imported by build_river.py and by the tests.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from urllib.parse import urlsplit

# Tuned on the live feed by reading every group each candidate produced. See
# tests/test_stories.py for the cases that pin it.
THRESHOLD = 0.32

# Above this, wording alone is enough - two outlets rewriting one wire story
# ("Average five-year mortgage rate hits 6%...") may name nobody at all.
STRONG = 0.6

# Stories older than this apart are follow-ups, not the same report.
WINDOW = 48 * 3600

# The opening of the text carries the who/what/where a headline abbreviates.
LEAD_CHARS = 320

# Headlines are written to be distinctive; body text much less so.
TITLE_WEIGHT = 2.0

WORD_RE = re.compile(r"[^\W\d_][\w'’-]*", re.UNICODE)

STOPWORDS = frozenset(
    """
    a about above after again against all almost also am among an and any are
    around as at back be because been before being below between both but by
    can could did do does doing down during each even ever every few for from
    further get gets getting go goes going got had has have having he her here
    hers him his how i if in into is it its itself just last later least less
    like made make makes many may me might more most much must my near never
    next no nor not now of off on once one only or other our out over own per
    put said same say says see seen she should since so some still such take
    takes than that the their them then there these they this those though
    three through to too two under until up upon us very was we were what when
    where whether which while who whom whose why will with within without would
    yet you your yours
    new news live latest update updates breaking report reports reported video
    watch analysis opinion explained explainer podcast newsletter week weeks
    day days year years today tonight yesterday time first big top want wants
    way ways look looks know need needs help show shows according amid across
    """.split()
)


def domain_of(url: str) -> str:
    host = urlsplit(url or "").netloc.lower()
    return host[4:] if host.startswith("www.") else host


def tokens(text: str) -> list[str]:
    out = []
    for raw in WORD_RE.findall((text or "").lower()):
        word = raw.replace("’", "'").strip("'-")
        if word.endswith("'s"):
            word = word[:-2]
        # Light plural folding: enough to match "rate"/"rates", not a stemmer.
        if len(word) > 4 and word.endswith("s") and not word.endswith("ss"):
            word = word[:-1]
        if len(word) < 3 or word in STOPWORDS:
            continue
        out.append(word)
    return out


CAP_WORD_RE = re.compile(r"[^\W\d_][\w'’-]*", re.UNICODE)
SENTENCE_END_RE = re.compile(r"[.!?:–—|]\s*$")


def _fold(word: str) -> str:
    folded = tokens(word)
    return folded[0] if folded else ""


def _is_title_case(title: str) -> bool:
    """Headline Style Capitalises Every Word, which says nothing about names."""
    words = [w for w in CAP_WORD_RE.findall(title) if len(w) > 3]
    if len(words) < 3:
        return False
    return sum(1 for w in words if w[0].isupper()) / len(words) > 0.6


def names(item: dict) -> set[str]:
    """Words that are probably names: people, companies, places, products.

    A capital letter only means something mid-sentence, so the first word of
    each sentence is skipped, and a Title Case headline is ignored entirely in
    favour of the sentence-case text under it. Mixed-case and all-caps words
    (SpaceX, ChatGPT, MotoGP, EU, BT) count wherever they appear: nothing
    capitalises those by accident.
    """
    found: set[str] = set()
    title = item.get("title") or ""
    lead = (item.get("text") or "")[:LEAD_CHARS]
    sources = [lead] if _is_title_case(title) else [title, lead]
    for text in sources:
        for match in CAP_WORD_RE.finditer(text):
            word = match.group(0)
            inner = word[1:]
            distinctive = any(c.isupper() for c in inner)
            at_start = match.start() == 0 or bool(SENTENCE_END_RE.search(text[: match.start()]))
            if word[0].isupper() and (distinctive or not at_start):
                folded = _fold(word)
                if folded:
                    found.add(folded)
    # Acronyms anywhere, including inside a Title Case headline.
    for word in CAP_WORD_RE.findall(title):
        if len(word) >= 2 and any(c.isupper() for c in word[1:]):
            folded = _fold(word) or word.lower()
            found.add(folded)
    return found


def _vector(item: dict, idf: dict[str, float]) -> dict[str, float]:
    weights: Counter = Counter()
    for word in tokens(item.get("title", "")):
        weights[word] += TITLE_WEIGHT
    for word in tokens((item.get("text") or "")[:LEAD_CHARS]):
        weights[word] += 1.0
    vec = {w: tf * idf.get(w, 0.0) for w, tf in weights.items()}
    norm = math.sqrt(sum(v * v for v in vec.values()))
    return {w: v / norm for w, v in vec.items()} if norm else {}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(w, 0.0) for w, v in a.items())


def cluster(items: list[dict], threshold: float = THRESHOLD) -> list[list[str]]:
    """Groups of URLs reporting the same story, each newest first.

    `items` need `url`, `title` and `date`; `text` is used when present. Only
    groups of two or more are returned.
    """
    docs = [it for it in items if it.get("url") and it.get("title")]
    if not docs:
        return []

    df: Counter = Counter()
    for it in docs:
        df.update(set(tokens(it["title"]) + tokens((it.get("text") or "")[:LEAD_CHARS])))
    n = len(docs)
    # A word in more than a fifth of everything identifies nothing - but only
    # once there is enough of everything to say so; in a handful of articles
    # every shared word is "common". The smoothing keeps a word in all of a
    # small set from weighing exactly zero.
    common = max(5, 0.2 * n)
    idf = {w: math.log((1 + n) / (1 + c)) + 1 for w, c in df.items() if c <= common}

    vectors = {it["url"]: _vector(it, idf) for it in docs}
    groups: list[dict] = []

    for it in sorted(docs, key=lambda x: (-x.get("date", 0), x["url"])):
        vec = vectors[it["url"]]
        if not vec:
            continue
        dom = domain_of(it["url"])
        own_names = names(it)
        best, best_sim = None, threshold
        for g in groups:
            if dom in g["domains"]:
                continue
            if g["newest"] - it.get("date", 0) > WINDOW:
                continue
            sim = _cosine(vec, g["centroid"])
            if sim < best_sim:
                continue
            if sim < STRONG and not (own_names & g["names"]):
                continue
            best, best_sim = g, sim

        if best is None:
            groups.append(
                {
                    "urls": [it["url"]],
                    "domains": {dom},
                    "names": set(own_names),
                    "newest": it.get("date", 0),
                    "sum": dict(vec),
                    "centroid": dict(vec),
                }
            )
            continue

        best["urls"].append(it["url"])
        best["domains"].add(dom)
        best["names"] |= own_names
        for w, v in vec.items():
            best["sum"][w] = best["sum"].get(w, 0.0) + v
        norm = math.sqrt(sum(v * v for v in best["sum"].values()))
        best["centroid"] = {w: v / norm for w, v in best["sum"].items()} if norm else {}

    return [g["urls"] for g in groups if len(g["urls"]) > 1]
