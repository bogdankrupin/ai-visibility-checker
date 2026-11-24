# AI Visibility Checker

A Chrome extension that shows whether AI chats cite the page you're looking at.

Open any article and click **Check this page**. The extension writes 5 prompts people would plausibly use to find this page and shows a matrix: for which prompts and in which engines (Claude, ChatGPT, AI Mode, AI Overview, Gemini, Perplexity) the page shows up, and where it doesn't.

No servers and no command line. Your API keys stay in your browser.

---

## Install (2 minutes)

1. **Download the extension.** Go to this repo's [Releases](../../releases/latest) and download `ai-visibility-checker.zip`.
2. **Unzip it** into a folder you'll keep (for example `Documents/ai-visibility-checker`). Chrome loads the extension from that folder.
3. **Open** `chrome://extensions` in Chrome.
4. **Turn on Developer mode** with the toggle in the top right corner.
5. **Click Load unpacked** and select the unzipped folder.
6. **Pin the icon** using the puzzle icon in the Chrome toolbar.

## First run

1. Click the extension icon. A side panel opens on the right.
2. Paste two keys:
   - **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/settings/keys)
   - **SE Ranking API key** for the Data API from your SE Ranking account ([how to get it](https://seranking.com/api/data/getting-started#authentication))
3. Click **Save and test keys**. Both lines should turn green.
4. Open an article and click **Check this page**. A check takes 20–40 seconds.

## Reading the results

| Icon | Meaning |
|---|---|
| ✓ | The page is cited |
| ◐ | Claude found the page through search but didn't cite it in the answer |
| ≈ | Another page from the same site is cited |
| – | Not found |
| ! | The check failed (hover to see why) |

Click a prompt in the table to see details: a snippet of the answer, which sources were cited instead of you, and which real prompt it matched.

Below the table, **Real prompts where this page is already cited** lists data from the SE Ranking database for each engine.

### How each engine is checked

- **Claude** is a live check. Each prompt runs in Claude with web search right now.
- **ChatGPT, AI Mode, AI Overview, Gemini and Perplexity** are checked against the SE Ranking AI Search database. The extension pulls real prompts whose AI answers already cite this URL, and Claude decides whether a generated prompt has the same intent. This is not a live run of the prompt in ChatGPT. It is a synchronous approximation with no queue.

## Cost

- **SE Ranking:** 200 Data API credits for every prompt the database returns. The default is up to 10 prompts per engine, so up to 10,000 credits per check. If the page isn't cited anywhere, no credits are spent. You can change the limit in Settings → Advanced.
- **Anthropic:** 7 Claude calls per check, 5 of them with web search.
- **Cache:** results are saved for 7 days. Reopening the same page shows the saved result at no cost. **Check again** runs a fresh check.

## Updating

When a new version is out, download the new zip from [Releases](../../releases/latest), replace the folder contents and click ⟳ on the extension card in `chrome://extensions`. Your keys and cache are kept.

## Privacy

API keys are stored in your browser's `chrome.storage.local`. Page content and keys are sent only to `api.anthropic.com` and `api.seranking.com`. There are no other servers.

## For developers

```
extension/
  manifest.json           Manifest V3, side panel
  background.js           opens the panel when the icon is clicked
  sidepanel.html/css/js   UI, settings, cache
  lib/analyze.js          pipeline: prompt generation, SE Ranking, live Claude check, intent matching
.github/workflows/release.yml   on changes to extension/ in main, builds the zip and publishes a release
```

To ship a new version, bump `version` in `extension/manifest.json`. The GitHub Action creates the release with the new zip.
