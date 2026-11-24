# AI Visibility Checker

A Chrome extension that shows how AI search sees the site you're on. Data comes from the SE Ranking AI Search database.

Open any website, click **Check this site**, and see:

- **This page in AI answers.** Whether ChatGPT, Gemini, Perplexity, Google AI Mode and AI Overviews cite the exact page you're on.
- **The site in AI answers.** How many prompts per engine link to the site (cited) and name its brand (mentioned).
- **An insight.** For example, "Cited 6x more than named": AI uses the site as a source but rarely names the brand.
- **Competitors.** The site's top 3 organic competitors and how often each engine cites them.
- **Top prompt per engine.** The most visible prompt that cites the site.

No sign-up and no API keys. The data is a monthly snapshot of SE Ranking's prompt sample, not a live run of every possible question.

---

## Install (2 minutes)

1. Download `ai-visibility-checker.zip` from the latest [release](../../releases/latest).
2. Unzip it into a folder you'll keep, for example `Documents/ai-visibility-checker`.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the unzipped folder.
6. Pin the extension using the puzzle icon in the toolbar.

Then open any website, click the extension icon and click **Check this site**. Pick the market (US, UK, DE and others) in the top right corner.

### Limits

Each person can check 5 new sites per day. Sites someone has already checked this month open instantly and don't count. If you see "Today's check limit is reached", try again tomorrow.

---

## For the maintainer

The extension talks to a small backend on Cloudflare Workers. The backend holds the SE Ranking API key, caches every site for 30 days and enforces the limits. A GitHub Action deploys the backend and publishes the extension zip with the backend address built in.

### One-time setup (all in the browser)

1. **Cloudflare account.** Sign in at dash.cloudflare.com and open **Workers & Pages** once, so Cloudflare creates your `workers.dev` subdomain.
2. **Cloudflare API token.** My Profile > API Tokens > Create Token > template **Edit Cloudflare Workers**. Make sure it includes **Workers KV Storage: Edit**.
3. **Cloudflare account ID.** It's on the right side of the Workers & Pages overview page.
4. **Repository secrets.** In this repo: Settings > Secrets and variables > Actions > New repository secret. Add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `SERANKING_API_KEY` (SE Ranking Data API key)
5. **Run the workflow.** Actions > Deploy backend and release extension > Run workflow.

The workflow creates the cache, deploys the backend, stores the SE Ranking key there, checks that it responds and publishes a release.

### Releasing a new version

Bump `version` in `extension/manifest.json` and push. The workflow redeploys and publishes the new zip.

### Cost and limits

| Request | SE Ranking credits |
|---|---|
| New site (first check this month) | up to about 5,200 |
| New page on a site already checked | usually 0, 200 per engine where the page is cited |
| Anything already in cache | 0 |

Settings live in `worker/wrangler.toml`:

- `DAILY_CREDIT_BUDGET` caps credits spent per day across all users (default 60,000).
- `DOMAINS_PER_CLIENT_PER_DAY` caps new sites per person per day (default 5).
- `PAGES_PER_CLIENT_PER_DAY` caps new pages per person per day (default 100).

### How the card is built

| Block | SE Ranking Data API call |
|---|---|
| This page, per engine | `ai-search/prompts-by-target`, scope `url`, limit 1 |
| Cited, per engine | `ai-search/prompts-by-target`, scope `base_domain`, limit 1 (uses `total`) |
| Mentioned, per engine | `ai-search/discover-brand`, then `ai-search/prompts-by-brand`, limit 1 |
| Competitors | `domain/competitors` (top 3 after filtering generic sites), then cited per engine |
| Top prompt per engine | the prompt returned by the cited calls |

```
extension/   Chrome extension (Manifest V3 side panel)
worker/      Cloudflare Worker backend
.github/workflows/deploy.yml   deploy backend + publish release
```
