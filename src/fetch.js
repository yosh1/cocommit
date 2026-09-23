/**
 * Data collection via the GitHub Search Commits API.
 *
 * Why this API and not the local session logs every other tool reads:
 * `Co-authored-by:` trailers live in git history, so the number is verifiable
 * by anyone with `git log` and survives a change of machine.
 *
 * Two constraints shape everything here, both measured rather than assumed:
 *   - `total_count` stays accurate past 1000 results, but `items` is capped at
 *     1000. So we only ever read counts, never enumerate commits.
 *   - Search is rate limited to 30 requests/minute, an order of magnitude
 *     below the 5000/hour core limit. Every query is spent deliberately.
 */

const API = 'https://api.github.com';

/**
 * Ways to identify an AI co-author, keyed by agent name.
 *
 * `co-authored-by:` is a real qualifier but is absent from GitHub's search
 * documentation, so it could stop working without notice. Each agent therefore
 * carries a full-text `fallback` that matches the trailer as literal text.
 * Both forms were measured to return identical counts (10,203) in 2026-09.
 */
/**
 * Every agent is matched by the email address in its trailer, never by its
 * display name. A name matches any co-author who happens to share it — a
 * search for `co-authored-by:claude` also returns commits whose only real
 * match is an unrelated human on the same commit — while the address is the
 * agent's own identity.
 *
 * Addresses below were read from real public commits rather than from
 * vendor documentation. Where a tool writes more than one address, the
 * alternates are OR'd together; GitHub's search accepts the OR of qualifiers
 * in parentheses.
 */
export const AGENTS = {
  claude: {
    label: 'Claude',
    query: 'co-authored-by:noreply@anthropic.com',
    fallback: '"Co-Authored-By: Claude"',
  },
  copilot: {
    label: 'Copilot',
    query: 'co-authored-by:copilot@github.com',
    fallback: '"Co-authored-by: Copilot"',
  },
  cursor: {
    label: 'Cursor',
    query: 'co-authored-by:cursoragent@cursor.com',
    fallback: '"Co-authored-by: Cursor"',
  },
  codex: {
    label: 'Codex',
    // The CLI has shipped both addresses over time.
    query: '(co-authored-by:codex@openai.com OR co-authored-by:noreply@openai.com)',
    fallback: '"Co-authored-by: codex"',
  },
  devin: {
    label: 'Devin',
    query: 'co-authored-by:devin-ai-integration[bot]@users.noreply.github.com',
    fallback: '"Co-Authored-By: Devin AI"',
  },
  aider: {
    label: 'Aider',
    // Aider appends the model it used, so the display name varies per commit
    // while the address stays put — exactly why addresses are the key here.
    query: 'co-authored-by:aider@aider.chat',
    fallback: '"Co-authored-by: aider"',
  },
  amp: {
    label: 'Amp',
    query: 'co-authored-by:amp@ampcode.com',
    fallback: '"Co-authored-by: Amp"',
  },
  jules: {
    label: 'Jules',
    query: 'co-authored-by:google-labs-jules[bot]@users.noreply.github.com',
    fallback: '"Co-authored-by: google-labs-jules"',
  },
  gemini: {
    label: 'Gemini',
    query: '(co-authored-by:gemini-code-assist@google.com OR co-authored-by:gemini-code-assist[bot]@users.noreply.github.com)',
    fallback: '"Co-authored-by: gemini-code-assist"',
  },
};

class RateLimiter {
  /** Search allows 30/min; 28 leaves room for the caller's own probing. */
  constructor(perMinute = 28) {
    this.interval = 60000 / perMinute;
    this.last = 0;
  }

  async take() {
    const wait = this.last + this.interval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }
}

export class GitHubClient {
  constructor({ token, fetchImpl = globalThis.fetch, log = () => {} }) {
    if (!token) throw new Error('A GitHub token is required: Search API requests are rejected unauthenticated for private repositories.');
    this.token = token;
    this.fetch = fetchImpl;
    this.log = log;
    this.limiter = new RateLimiter();
    this.queries = 0;
  }

  async search(q) {
    await this.limiter.take();
    // per_page=1 because only total_count is ever read; asking for more
    // results would cost bandwidth for data we deliberately discard.
    const url = `${API}/search/commits?q=${encodeURIComponent(q)}&per_page=1`;

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cocommit',
        },
      });
      this.queries++;

      if (res.ok) return (await res.json()).total_count;

      // Secondary rate limits answer 403/429 with a hint of how long to wait.
      if (res.status === 403 || res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        const waitMs = retryAfter
          ? retryAfter * 1000
          : reset
            ? Math.max(0, reset * 1000 - Date.now()) + 1000
            : 2000 * 2 ** attempt;
        this.log(`rate limited, waiting ${Math.ceil(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 90000)));
        continue;
      }

      const body = await res.text().catch(() => '');
      throw new Error(`GitHub search failed (${res.status}): ${body.slice(0, 200)}`);
    }
    throw new Error('GitHub search failed: still rate limited after 4 attempts.');
  }
}

/** Inclusive last day of `YYYY-MM`, correct across leap years. */
export function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** The `count` months ending with (and including) `end`, oldest first. */
export function monthRange(end, count) {
  const [y, m] = end.split('-').map(Number);
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return months;
}

/**
 * Collect the totals and the monthly series for one user.
 *
 * The headline totals cover the same months as the chart, not all of history.
 * An all-time denominator counts every commit written before the agent
 * existed, so a history that is now mostly co-authored reads far lower than
 * the bars beside it — measured on one real account, 39% against 70% for the
 * same twelve months.
 *
 * Merge commits are excluded from every count. They carry no trailer of their
 * own, and a merged pull request's work is already counted in the commits it
 * brought in, so including them only adds a second, never-co-authored copy.
 *
 * Costs 2 + 2*months queries. At 28/min the default 12 months takes ~56s,
 * which is why this is built to run in scheduled CI rather than per request.
 */
export async function collect({ client, user, agent = 'claude', months = 12, visibility = 'all', now = new Date() }) {
  const { query, fallback, label } = AGENTS[agent] ?? AGENTS.claude;
  const scope = visibility === 'public' ? ' is:public' : '';
  const base = `author:${user} merge:false${scope}`;

  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const span = monthRange(end, months);
  const since = `${span[0]}-01`;
  const until = monthEnd(span[span.length - 1]);
  const period = `${base} author-date:${since}..${until}`;

  const total = await client.search(period);

  // Decide once whether the undocumented qualifier still works, then reuse
  // that choice for every later query so the series stays self-consistent.
  // A qualifier GitHub no longer parses is treated as free text, which
  // silently matches nothing rather than erroring — hence the zero check.
  let agentQuery = query;
  let coauthored = await client.search(`${period} ${query}`);

  // Co-authored commits are a strict subset of all commits, so a count equal
  // to the total means the qualifier did not filter at all — GitHub matched
  // the whole query as free text. Zero is the other tell.
  //
  // Equality is the important case: an ignored qualifier returns exactly the
  // unfiltered total, which would otherwise be published as a proud 100%.
  const unusable = (n) => n === 0 || n >= total;
  if (unusable(coauthored) && total > 0) {
    const viaFallback = await client.search(`${period} ${fallback}`);
    if (viaFallback > 0 && viaFallback < total) {
      client.log(`'${query}' did not filter as expected; using full-text trailer match`);
      agentQuery = fallback;
      coauthored = viaFallback;
    } else if (coauthored > total) {
      throw new Error(
        `Search returned ${coauthored} co-authored commits but only ${total} commits in total. ` +
        'GitHub may have changed how it parses the co-authored-by qualifier.',
      );
    }
  }

  const series = [];
  for (const month of span) {
    const range = `author-date:${month}-01..${monthEnd(month)}`;
    const monthTotal = await client.search(`${base} ${range}`);
    // Skip the second query when the month is empty: the co-authored count
    // cannot exceed the total, so it is necessarily zero.
    const monthCo = monthTotal === 0 ? 0 : await client.search(`${base} ${agentQuery} ${range}`);
    // Clamp rather than throw: one odd month should not discard a whole card,
    // and a bar can never exceed its own track.
    series.push({ month, total: monthTotal, coauthored: Math.min(monthCo, monthTotal) });
  }

  return {
    user,
    agent,
    agentLabel: label,
    visibility,
    since,
    until,
    generatedAt: now.toISOString(),
    total,
    coauthored,
    share: total > 0 ? coauthored / total : 0,
    series,
  };
}
