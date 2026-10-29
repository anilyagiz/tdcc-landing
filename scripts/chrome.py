#!/usr/bin/env python3
"""Keep the shared page chrome (logo symbol, nav, footer) identical on every page.

The canonical markup lives here. Each page marks the blocks it owns with
<!-- chrome:NAME --> ... <!-- /chrome:NAME --> comments; this script rewrites
what is between them. Pages that do not have the markers yet get them wrapped
around their existing <svg> symbol sheet, <header class="nav"> and <footer>.

    python3 scripts/chrome.py          # rewrite pages in place
    python3 scripts/chrome.py --check  # exit 1 if any page is out of date
    python3 scripts/chrome.py team.html  # only the pages named
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

NAV = [
    ("/chat.html", "Chat"),
    ("/marketplace.html", "Marketplace"),
    ("/app.html", "App"),
    ("/exact-core.html", "Exact Core"),
    ("/cask-q.html", "Research"),
    ("/team.html", "Company"),
]
EARLY = ("Get early access", "/#join")
HOST = ("List your GPU", "/marketplace.html#hosts")

# page -> (nav entry marked current, call to action)
PAGES = {
    "index.html": (None, EARLY),
    "marketplace.html": ("/marketplace.html", ("List your GPU", "#hosts")),
    "account.html": (None, HOST),
    "admin.html": (None, HOST),
    "confirm.html": (None, HOST),
    "privacy.html": (None, EARLY),
    "terms.html": (None, EARLY),
    "facts.html": (None, EARLY),
    "404.html": (None, EARLY),
    "exact-core.html": ("/exact-core.html", EARLY),
    "app.html": ("/app.html", EARLY),
    "team.html": ("/team.html", EARLY),
    "litepaper.html": ("/litepaper.html", EARLY),
    "cask-q.html": ("/cask-q.html", EARLY),
    "two-laptops-80-tps.html": ("/cask-q.html", EARLY),
    "launch.html": (None, EARLY),
    "chat.html": ("/chat.html", EARLY),
}

MARK = """<svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <symbol id="mark" viewBox="0 0 120 80">
      <g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 70 H111 A15 15 0 0 0 95 47 A33 33 0 0 0 29 47 A17 17 0 0 0 9 70 Z" />
        <g stroke-width="1.4" opacity=".85">
          <path d="M62 14 V70" />
          <path d="M62 14 C49 22 46 46 48 70" /><path d="M62 14 C75 22 78 46 76 70" />
          <path d="M62 14 C40 20 33 44 35 70" /><path d="M62 14 C84 20 91 44 89 70" />
          <path d="M38 26 Q62 31 86 26" /><path d="M31 39 Q62 45 93 39" /><path d="M29 54 Q62 60 95 54" />
        </g>
      </g>
      <g fill="currentColor">
        <rect x="59.5" y="26.5" width="5" height="5" /><rect x="45" y="39" width="5" height="5" /><rect x="74" y="39" width="5" height="5" />
        <rect x="59.5" y="42" width="5" height="5" /><rect x="33" y="52" width="4.5" height="4.5" /><rect x="86.5" y="52" width="4.5" height="4.5" />
        <rect x="59.5" y="57" width="5" height="5" /><rect x="47" y="27" width="4" height="4" /><rect x="73" y="27" width="4" height="4" />
      </g>
    </symbol>
  </svg>"""

FOOTER = """<footer>
    <div class="wrap">
      <div class="foot-grid">
        <div>
          <a class="brand" href="/" aria-label="TDCC home"><svg aria-hidden="true"><use href="#mark" /></svg><span class="brand-name">The Decentralized Compute Company</span></a>
          <p class="about">A GPU marketplace, a job network that checks its own work, and Exact Core, an AI chip whose answers anyone can re-check.</p>
        </div>
        <div>
          <h4>Product</h4>
          <ul><li><a href="/chat.html">TDCC Chat</a></li><li><a href="/account.html#billing">Balance &amp; API keys</a></li><li><a href="/marketplace.html">GPU marketplace</a></li><li><a href="/account.html">My account</a></li><li><a href="/exact-core.html">Exact Core chip</a></li><li><a href="/app.html">TDCC App</a></li><li><a href="/app.html#downloads">Desktop beta</a></li><li><a href="/#developers">Developers</a></li></ul>
        </div>
        <div>
          <h4>Company</h4>
          <ul><li><a href="/team.html">Team</a></li><li><a href="/litepaper.html">Litepaper</a></li><li><a href="/cask-q.html">Research</a></li><li><a href="/two-laptops-80-tps.html">Engineering</a></li><li><a href="/facts.html">Facts</a></li></ul>
        </div>
        <div>
          <h4>Connect</h4>
          <ul><li><a href="https://x.com/computecompany" target="_blank" rel="noreferrer">X / @computecompany</a></li><li><a href="https://www.linkedin.com/in/anilyagiz/" target="_blank" rel="noreferrer">LinkedIn</a></li><li><a href="mailto:anil@decentralizedcompute.company">Email</a></li><li><a href="https://github.com/anilyagiz/tdcc-exact-core" target="_blank" rel="noreferrer">GitHub</a></li><li><a href="/feed.xml">RSS</a></li></ul>
        </div>
      </div>
      <div class="wordmark" aria-hidden="true">decentralized compute</div>
      <div class="legal"><span>© 2026 The Decentralized Compute Company</span><span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · <a href="/facts.html">Facts</a></span></div>
    </div>
  </footer>"""


def nav(current, cta):
    cur = ' aria-current="page"'
    links = "\n".join(
        f'        <a href="{href}"{cur if href == current else ""}>{label}</a>' for href, label in NAV
    )
    return f"""<header class="nav" id="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/" aria-label="The Decentralized Compute Company — home">
        <svg aria-hidden="true"><use href="#mark" /></svg>
        <span class="brand-name">tdcc</span>
      </a>
      <nav class="nav-links" id="nav-links" aria-label="Primary navigation">
{links}
        <a class="btn solid sm nav-cta" href="{cta[1]}">{cta[0]}</a>
      </nav>
      <button class="menu-btn" id="menu-btn" type="button" aria-expanded="false" aria-controls="nav-links" aria-label="Open menu"><span></span><span></span></button>
    </div>
  </header>"""


FIND = {
    "mark": re.compile(r'<svg[^>]*>\s*<symbol id="mark".*?</svg>', re.S),
    "nav": re.compile(r'<header class="nav".*?</header>', re.S),
    "footer": re.compile(r"<footer.*?</footer>", re.S),
}


def put(html, name, block, page):
    marked = re.compile(rf"<!-- chrome:{name} -->.*?<!-- /chrome:{name} -->", re.S)
    wrapped = f"<!-- chrome:{name} -->\n  {block}\n  <!-- /chrome:{name} -->"
    if marked.search(html):
        return marked.sub(lambda _: wrapped, html, count=1)
    found = FIND[name].search(html)
    if found:
        return html[: found.start()] + wrapped + html[found.end():]
    if name == "footer" and "</main>" in html:
        i = html.index("</main>") + len("</main>")
        return html[:i] + "\n\n  " + wrapped + html[i:]
    if name == "mark" and "<body" in html:
        i = html.index(">", html.index("<body")) + 1
        return html[:i] + "\n  " + wrapped + html[i:]
    raise SystemExit(f"{page}: no place for chrome:{name}")


def render(page, html):
    current, cta = PAGES[page]
    html = put(html, "mark", MARK, page)
    html = put(html, "nav", nav(current, cta), page)
    return put(html, "footer", FOOTER, page)


def main():
    check = "--check" in sys.argv
    named = [a for a in sys.argv[1:] if not a.startswith("--")]
    stale = []
    for page in named or PAGES:
        path = ROOT / page
        html = path.read_text(encoding="utf-8")
        out = render(page, html)
        if out != html:
            stale.append(page)
            if not check:
                path.write_text(out, encoding="utf-8", newline="\n")
    if check and stale:
        print("chrome out of date: " + ", ".join(stale) + " (run python3 scripts/chrome.py)")
        sys.exit(1)
    if not check:
        print("updated: " + (", ".join(stale) or "nothing"))


if __name__ == "__main__":
    main()
