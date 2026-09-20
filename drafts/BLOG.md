---
title: "What I learned counting AI co-authored commits across 26,000 of my own"
published: false
tags: github, ai, opensource, git
canonical_url:
---

I use Claude Code every day, but if you asked me how much of my code I actually
write with it, all I had was a feeling. The data was sitting right there in git
the whole time:

```console
$ git log --format='%b' | grep -c 'Co-Authored-By: Claude'
960
```

960 out of 1,107 commits in that repo. Across everything I've touched:
**10,253 of 26,242 commits — 39%.**

I built [a small tool](https://github.com/yosh1/cocommit) to render that as an
SVG card for a GitHub profile. The tool is the boring part. What I found while
building it is what I actually want to write about.

---

## 1. GitHub has an undocumented `co-authored-by:` search qualifier

The commit search API accepts this:

```console
$ gh api '/search/commits?q=author:USER+co-authored-by:noreply@anthropic.com&per_page=1' \
    --jq '.total_count'
```

It works. It is also documented nowhere — it does not appear in [GitHub's
commit search docs](https://docs.github.com/en/search-github/searching-commits).

Since "it seems to work" is not evidence, I ran a control (counts move as I
commit, so these are one snapshot rather than fixed values):

| Query (all with `author:USER`) | `total_count` |
|---|---|
| `co-authored-by:noreply@anthropic.com` | 10,253 |
| `co-authored-by:copilot@github.com` | 29 |
| `zzznotaqualifier:noreply@anthropic.com` | **0** |
| no qualifier | 26,242 |

An invented qualifier returns zero. Change the value and the count changes.
The parser recognizes it.

But undocumented means it can vanish without notice, and **the dangerous
failure mode isn't returning zero.** If GitHub stops parsing the qualifier, it
falls back to treating the whole thing as free text, which matches *everything*
— and you'd proudly render "100% AI co-authored."

So the check is on both sides:

```js
// Co-authored commits are a strict subset of all commits. A count equal to
// the total means the qualifier didn't filter at all.
const unusable = (n) => n === 0 || n >= total;
```

## 2. Searching by display name silently counts the wrong people

This is the one that surprised me, and it's the bug I shipped first.

My initial implementation searched `co-authored-by:claude` — the agent's name.
Reasonable-looking, and it returns a plausible number. Then I added Cursor and
got this:

```console
$ gh api '/search/commits?q=co-authored-by:cursor+is:public' --jq '.total_count'
10033042
```

Ten million felt too round. I looked at what was actually matching:

```console
$ gh api '/search/commits?q=co-authored-by:cursor+is:public&per_page=5' \
    --jq '.items[].commit.message' | grep -i co-authored
Co-authored-by: Cursor <cursoragent@cursor.com>
```

The real trailer uses an address. Searching the *name* matches any co-author
who happens to share it. And when I checked my own supposedly-correct Claude
numbers:

```
name form : 10,262
email form: 10,255
```

Seven commits of drift. Looking at what those matched, they carried a second
trailer naming a human collaborator — a teammate, counted as an AI, because a
name is not an identity. Every agent is now keyed on the address in its
trailer.

This matters more than it sounds, because some tools put *variable* text in the
display name:

```
Co-authored-by: aider (anthropic/claude-sonnet-5) <aider@aider.chat>
Co-authored-by: aider (ollama/gemma4:e4b-mlx)    <aider@aider.chat>
```

Aider appends whichever model it used. The name is unstable; the address isn't.

I read the trailers off real public commits rather than trusting vendor docs.
Here's what nine agents actually write, with the public commit count each one
has as of today:

| Agent | Trailer address | Public commits |
|---|---|---|
| Claude | `noreply@anthropic.com` | 89,025,757 |
| Cursor | `cursoragent@cursor.com` | 8,374,584 |
| Copilot | `copilot@github.com` | 4,046,637 |
| Codex | `codex@openai.com`, `noreply@openai.com` | 1,812,065 |
| Devin | `devin-ai-integration[bot]@users.noreply.github.com` | 588,010 |
| Gemini | `gemini-code-assist@google.com` + bot address | 290,638 |
| Jules | `google-labs-jules[bot]@users.noreply.github.com` | 233,948 |
| Aider | `aider@aider.chat` | 133,041 |
| Amp | `amp@ampcode.com` | 104,075 |

One tool I expected to find had no dedicated trailer at all — searching for it
returned only human contributors. Worth checking before you assume.

## 3. What GitHub's image proxy (camo) actually allows

Every image in a README is rewritten through `camo.githubusercontent.com`.
People repeat a lot of folklore about what survives that trip, so I read the
response headers:

```
content-security-policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'
```

That single line settles it:

| | |
|---|---|
| JavaScript | **blocked** (`default-src 'none'`) |
| Web fonts | **blocked** — system font stacks or nothing |
| External images | **blocked** (`img-src data:` only) |
| CSS animation | **allowed** (`style-src 'unsafe-inline'`) |

Animation works, which is fun — until it doesn't. My first version grew the
bars from zero:

```xml
<rect height="0"><animate attributeName="height" to="28"/></rect>
```

Rasterize that locally and **the bars disappear.** Anything that ignores SMIL
sees `height="0"`. Static renderers, social preview generators, and thumbnail
pipelines all land there.

The fix is to make the resting state the truth and let animation only supply a
starting point:

```xml
<rect height="28"><animate attributeName="height" from="0" to="28"/></rect>
```

Now it animates where animation runs and looks finished everywhere else. There
is a test for it, because I will absolutely make this mistake again:

```js
test('animated rendering still declares the finished geometry', () => {
  const svg = renderCard(sample, { animate: true });
  assert.doesNotMatch(svg, /height="0"/);
});
```

## 4. Why this can't be a hosted service

I started out planning a github-readme-stats-style URL that returns an SVG.
Then I compared the two numbers I could offer:

| Scope | AI-written | Total | Share |
|---|---|---|---|
| including private | 10,253 | 26,242 | **39%** |
| public only | 126 | 5,688 | **2%** |

Work code lives in private repos. A public-only number isn't a smaller version
of the truth, it's a different number — 2% instead of 39%.

And commit search only sees repositories the token owner can reach. Other
people's *public* commits are searchable, but their private ones never are. So
a hosted service can only ever offer the 2% number, no matter how many tokens
it pools.

Running in the user's own CI solves it completely: their token, their private
repos, their number. No server, no one else's PAT to hold.

The API shape helps too — I only ever read `total_count`, never enumerate
commits. (Which is lucky, since search caps enumeration at 1,000 results while
`total_count` stays accurate well past it.) Repository names, commit messages
and diffs are never read.

---

## The part that stuck with me

Twelve months of history, charted:

October 2025: 42 commits. September 2026: 2,022. **A 48x increase**, with the
most recent months running above 80%.

I knew my workflow had changed. I didn't know it had changed *that* much, and I
couldn't have told you so with a number before this. That turned out to be
worth more than the card itself.

The tool is MIT licensed and has zero dependencies:

```console
$ GITHUB_TOKEN=ghp_... npx github:yosh1/cocommit --user your-login
```

https://github.com/yosh1/cocommit

If your agent isn't in the table, `git log --format='%b' | grep -i co-authored`
will show you what it writes — send me the trailer and I'll add it.
