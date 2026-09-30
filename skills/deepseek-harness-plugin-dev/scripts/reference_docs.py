"""Fetch/search official reference pages; cached manuals stay outside the skill.

Uses only the Python standard library. Network access is required only for refresh.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = "https://deepseek-harness.github.io/deepseek-harness/en/reference/"
CACHE = Path(tempfile.gettempdir()) / "deepseek-harness-reference-cache"


def reference_url(base: str, href: str) -> str | None:
    parts = urlsplit(urljoin(base, href))
    if parts.scheme != "https" or parts.netloc != "deepseek-harness.github.io":
        return None
    prefix = "/deepseek-harness/en/reference/"
    if not parts.path.startswith(prefix):
        return None
    path = parts.path if parts.path == prefix else parts.path.rstrip("/")
    if Path(path).suffix not in ("", ".html"):
        return None
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


class Page(HTMLParser):
    def __init__(self, url: str):
        super().__init__(convert_charrefs=True)
        self.url = url
        self.links: set[str] = set()
        self.body: list[str] = []
        self.main_depth = 0
        self.depth = 0
        self.skip = 0
        self.heading: list[str] | None = None
        self.headings: list[str] = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "a" and (link := reference_url(self.url, values.get("href", ""))):
            self.links.add(link)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.depth += 1
        if tag == "main":
            self.main_depth = self.depth
        if not self.main_depth:
            return
        if tag in {"script", "style", "button", "svg"}:
            self.skip += 1
        if self.skip:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.body.append("\n" + "#" * int(tag[1]) + " ")
            self.heading = []
        elif tag == "pre":
            self.body.append("\n```\n")
        elif tag in {"p", "li", "tr", "div", "blockquote"}:
            self.body.append("\n")
        elif tag in {"td", "th"}:
            self.body.append(" | ")
        elif tag == "br":
            self.body.append("\n")

    def handle_endtag(self, tag):
        if self.main_depth and not self.skip:
            if tag in {"h1", "h2", "h3", "h4", "h5", "h6"} and self.heading is not None:
                self.headings.append("".join(self.heading).strip().replace("\u200b", ""))
                self.heading = None
                self.body.append("\n")
            elif tag == "pre":
                self.body.append("\n```\n")
            elif tag in {"p", "li", "tr", "div", "blockquote"}:
                self.body.append("\n")
        if tag in {"script", "style", "button", "svg"} and self.skip:
            self.skip -= 1
        if tag == "main":
            self.main_depth = 0
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if self.main_depth and not self.skip:
            self.body.append(data)
            if self.heading is not None:
                self.heading.append(data)


def page_key(url: str) -> str:
    suffix = url.removeprefix(ROOT).removesuffix(".html")
    return suffix or "index"


def fetch(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "DeepSeek-Harness-Skill-Reference/1.0"})
    with urlopen(request, timeout=30) as response:
        if reference_url(url, response.url) is None:
            raise ValueError(f"Unexpected redirect: {response.url}")
        raw = response.read()
    parser = Page(url)
    parser.feed(raw.decode("utf-8"))
    body = re.sub(r"\n[ \t]*\n(?:[ \t]*\n)+", "\n\n", "".join(parser.body)).strip()
    if not parser.headings or not body:
        raise ValueError("Document body or headings missing; inspect site layout")
    return {"key": page_key(url), "url": url, "title": parser.headings[0],
            "headings": parser.headings, "text": body, "links": sorted(parser.links),
            "sha256": hashlib.sha256(raw).hexdigest(), "characters": len(body),
            "fetched_at": datetime.now(timezone.utc).isoformat()}


def refresh(cache: Path) -> int:
    cache.mkdir(parents=True, exist_ok=True)
    pending, seen, pages, failures, broken_links = {ROOT}, set(), [], [], []
    with ThreadPoolExecutor(max_workers=6) as pool:
        while pending:
            batch = sorted(pending - seen)
            pending.clear()
            if not batch:
                break
            seen.update(batch)
            futures = {pool.submit(fetch, url): url for url in batch}
            for future in as_completed(futures):
                url = futures[future]
                try:
                    page = future.result()
                    filename = hashlib.sha256(url.encode()).hexdigest()[:20] + ".txt"
                    (cache / filename).write_text(page.pop("text"), encoding="utf-8")
                    page["cache_file"] = filename
                    pending.update(set(page.pop("links")) - seen)
                    pages.append(page)
                except HTTPError as error:
                    target = broken_links if error.code == 404 and url != ROOT else failures
                    target.append({"url": url, "error": str(error)})
                except Exception as error:
                    failures.append({"url": url, "error": str(error)})
    manifest = {"root": ROOT, "fetched_at": datetime.now(timezone.utc).isoformat(),
                "pages": sorted(pages, key=lambda item: item["key"]),
                "failures": failures, "broken_links": sorted(broken_links, key=lambda item: item["url"])}
    (cache / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"cache": str(cache), "pages": len(pages), "failures": failures,
                      "broken_links": len(broken_links)}, ensure_ascii=False))
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["refresh", "list", "read", "search"])
    parser.add_argument("query", nargs="?", help="Exact page key for read; literal text for search")
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--limit", type=int, default=20, help="Maximum search hits")
    args = parser.parse_args()
    if args.command == "refresh":
        return refresh(args.cache)
    if args.command in {"read", "search"} and not args.query:
        parser.error("read and search require a query")
    try:
        manifest = json.loads((args.cache / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"Cache unavailable: {error}. Run refresh first.", file=sys.stderr)
        return 1
    if args.command == "list":
        for page in manifest["pages"]:
            print(f'{page["key"]}\t{page["title"]}\t{page["characters"]}\t{page["url"]}')
        return 1 if manifest["failures"] else 0
    hits = 0
    for page in manifest["pages"]:
        if args.command == "read" and page["key"] != args.query:
            continue
        body = (args.cache / page["cache_file"]).read_text(encoding="utf-8")
        if args.command == "read":
            print(f'{page["url"]}\nFetched: {page["fetched_at"]}\n\n{body}')
            return 0
        for number, line in enumerate(body.splitlines(), 1):
            if args.query.casefold() in line.casefold():
                print(f'{page["key"]}:{number}: {line}')
                hits += 1
                if hits >= max(1, args.limit):
                    return 0
    if not hits:
        print("No matching page or text.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
