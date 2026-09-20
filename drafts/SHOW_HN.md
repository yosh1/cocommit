# Show HN submission

Not part of the package — this is the draft copy for posting.

---

## Title

```
Show HN: Cocommit – Count the commits you and an AI agent wrote together
```

(72 chars. HN's limit is 80.)

## URL

```
https://github.com/yosh1/cocommit
```

## First comment

Every tool I found in this space reads local session logs (`~/.claude/**/*.jsonl`)
and reports tokens or session counts — how much you talked to an agent. I wanted
the opposite: what actually landed in the repo. That's already in git, as
`Co-authored-by:` trailers, and anyone can verify it with `git log`.

Three things I learned building it that might be more interesting than the tool:

1. GitHub's commit search has an undocumented `co-authored-by:` qualifier. It
works, and I confirmed it's really parsed rather than being treated as free text
(an invented qualifier returns 0; changing the value changes the count). But
undocumented means it can break, and the bad failure mode isn't returning zero —
if GitHub stops parsing it, the query degrades to a full-text match that hits
everything, and you'd render "100% AI-written". So the check is `n === 0 || n >= total`,
with a full-text fallback.

2. Matching agents by display name is subtly wrong. I shipped that first. Searching
`co-authored-by:claude` returned 7 more commits than the address form, and those
extras were commits carrying a human colleague's trailer — a name is not an
identity. It matters more for tools like Aider, which writes
`aider (anthropic/claude-sonnet-5) <aider@aider.chat>`: the display name changes
per model, the address doesn't. All nine agents are keyed on the address, read off
real public commits rather than vendor docs.

3. It can't be a hosted service, which I only realized after comparing my own
numbers: 39% including private repos, 2% public-only. Work lives in private repos,
and commit search only sees what the token owner can reach — so a hosted version
could only ever serve the 2% number. Running in your own CI with your own token
is the only way to get the real one. Nice side effect: no one has to hand a PAT
to a stranger.

It only ever reads `total_count` and never enumerates commits, so repo names,
messages and diffs are never touched. Zero dependencies, MIT.

`GITHUB_TOKEN=... npx github:yosh1/cocommit --user you`

---

## Notes for posting

- Best window: weekdays 8-10am ET (21:00-23:00 JST). Avoid weekends.
- Reply to every technical comment quickly for the first 2 hours; early engagement
  is most of what decides whether it climbs.
- Likely objections, worth having answers ready for:
  - "Trailers measure nothing — the agent may have written one line." True, and
    it's stated in the README's caveats. It measures how you worked, not
    contribution size.
  - "Why not parse local git logs?" Because that only covers repos cloned on this
    machine; search covers everything the account touched.
  - "Undocumented API will break." Yes — hence the fallback and the detection on
    both failure modes.
  - "This encourages vanity metrics." Fair. The honest answer is that the 12-month
    trend told me something I didn't know about my own workflow.
