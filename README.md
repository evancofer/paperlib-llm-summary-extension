# paperlib-llm-summary-extension

A [Paperlib](https://github.com/Future-Scholars/paperlib) extension that summarizes papers with an LLM and writes the summary into each paper's note. You choose how much of the paper is sent, and running it again replaces its old summary without touching anything you wrote.

By default it uses [Claude Code](https://claude.com/claude-code) on your computer, with your Claude login and no API key. It also works with any OpenAI-compatible API (OpenAI, DeepSeek, OpenRouter, Gemini, Ollama, LM Studio) and with the Anthropic API, and it runs alongside the official AI summary extension.

## Use it

Select one or more papers, right-click, and choose:

| Menu item | Command | What it does |
|---|---|---|
| LLM Summary - summarize | `\llmsummary` | Summarizes the selected papers, replacing the extension's previous summary |
| LLM Summary - summarize from selection | `\llmsummary_selection` | Shows every page of one paper, so you can click the ones to send, then summarizes them |

Papers are processed two at a time, and a notification reports the result, such as `3 summarized, 1 skipped (no PDF), 1 failed: Bad API key (HTTP 401)`.

### Summarize from selection

For a paper where automatic detection goes wrong, **summarize from selection** opens a window with a thumbnail of every page. All pages start selected. Click a page to leave it out or put it back, or shift-click to change a range, then click **Summarize**. Your choice applies to that one run and overrides "Text to send".

The window shows an estimate of the selection's size as you click, and warns you if it's over Max input tokens. You can still continue, in which case the end of the selection is trimmed.

## Install locally

Requires Node 20.19 or later to build.

1. Run `npm install` and `npm run build`.
2. In Paperlib, go to **Preferences → Extensions → Install from Local** and choose this folder.
3. To use your Claude plan, install Claude Code and run `claude` once in a terminal to sign in. No other setup is needed. For any other provider, open the extension's settings and enter a provider, base URL, model and API key.

After each rebuild, click **Reload** on the extension's card. Reinstalling the same version does nothing.

## Settings

Text settings save when you press Enter or leave the field.

| Setting | Default | Notes |
|---|---|---|
| Provider | Claude Code | Base URL and model follow when you switch, unless you've changed them |
| Base URL | blank | Not used by Claude Code. Common values are listed in the setting's description. |
| Model | `claude-haiku-5-5` | Any model name your provider accepts |
| API key | blank | Not needed for Claude Code or local servers. Otherwise it's moved to your system keychain, with one key per provider. Clear the field to delete it. |
| Text to send | Main text + captions | See below |
| Number of pages | 5 | For the "First N pages" option, and for Abstract + captions when a paper has no Abstract heading |
| Remove page headers and footers | on | Preprint headers and "Downloaded from" lines always go |
| Max input tokens | 30000 | Set by hand, not read from the model, and estimated as characters ÷ 4. Lower it for models with small limits, such as local Ollama. |
| Max output tokens | 400 | The reply limit sent to the provider, which Claude Code doesn't support. Raise this if the report says summaries were cut off. |
| Prompt | a 3–5 sentence summary | |
| Language | blank | Blank lets the model decide |
| Summary position | Top | Paperlib previews only the first 10 lines of a note |
| If you edited the last summary | Keep it and add the new one | Or skip the paper |
| Existing plain-text notes | Convert to Markdown | Or keep them plain, with visible markers |
| Batch limit | 20 | Larger selections do nothing and show a message |
| Timeout (seconds) | 120 | For each request |

### Text to send

| Option | Sends |
|---|---|
| First N pages | The first N pages |
| Main text only | All text apart from reference sections and captions |
| Main text + captions | The same, with figure and table captions gathered at the end |
| Abstract + captions | The abstract and all captions |
| Whole PDF | Every page, including references |

Long text is trimmed from the end to fit Max input tokens, keeping captions for as long as possible. The result message tells you when this happens, and how large the paper was.

## How it finds the parts of a paper

A reference section is found by its title, on a line of its own: References, Reference List, Bibliography, Literature Cited, Works Cited and similar. It's removed up to the next heading of any kind, or to the end of the paper. Only that section goes, so everything around it is kept. If a heading isn't recognized, as can happen with text that's the same size as the body, the text after it goes too.

If no such title is found, all the text is sent, subject to Max input tokens, including any references. The abstract is found by its "Abstract" heading, and Abstract + captions uses the first N pages if there isn't one. Captions are gathered from the whole paper.

If the result looks wrong, use **summarize from selection** to choose the pages yourself.

Known limits:

- Scanned PDFs have no text to extract. They stop with a message and no API call, as there's no OCR.
- Text that's rotated on the page is dropped, which includes sideways tables.
- A paper with no References title, as in Nature and some physics journals, is sent with its references.
- A caption that doesn't start with something like `Figure 1.` or `Table 2:` isn't recognized as one.
- Columns are read in the order the PDF stores them, which is reading order for most generated PDFs but not all.

## How your notes are protected

Each summary sits between hidden markers holding a hash of its text:

```
## AI Summary <!-- plsum:start v=1 id=1a2b3c4d model=gpt-4o-mini date=2026-11-06 scope=main+captions pages=8 hash=0123456789ab -->

The summary.
<!-- plsum:end id=1a2b3c4d -->
```

The extension only replaces or removes a section whose markers are complete and whose hash still matches. If you edit a summary, the hash stops matching and it becomes yours. Everything else in the note is left alone, including `## AI Summary` sections from the official extension. The note is re-read just before saving, so edits made while waiting for the model are kept.

Paperlib hides these markers in Markdown notes. To remove a summary, delete it from the note by hand.

An existing plain-text note is converted to Markdown by default, with escaping so that it looks the same. That does change the note's stored text, so choose "Keep as plain text" if you edit notes outside Paperlib.

## Privacy

The page picker draws your PDF in a local window with no Node access, using a small server that only your own computer can reach and that closes with the window.

Each summary sends the chosen PDF text, the paper's title, year and publication, and your prompt to the provider you set: Anthropic for Claude Code, under your Claude account, or otherwise the base URL. Nothing is sent anywhere else. Claude Code runs with no tools, no saved session and none of your Claude settings, so text in a paper can't make it do anything except write a reply. Summaries count toward your plan's usage limits. To keep papers on your machine, use a local server such as Ollama or LM Studio.

API keys go in the system keychain and aren't logged.

## Develop

```sh
npm test            # unit tests
npm run fixtures    # downloads the test PDFs, which aren't committed
npm run build
npm run smoke       # runs dist/main.js end to end against a fake app and LLM server
```

Tests for missing PDFs are skipped. bioRxiv sometimes rate-limits the download, so try again later if it fails.

Paperlib runs extensions in a `vm` sandbox, and its release builds use an older Node than the `paperlib-api` docs suggest (Node 18 in Paperlib 3.1.12). `scripts/sandbox.cjs` recreates that sandbox. To run the smoke test on Paperlib's own runtime:

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/Paperlib.app/Contents/MacOS/Paperlib scripts/sandbox-smoke.cjs
```

`pdfjs-dist` is pinned to 4.10.38 because versions 5 and 6 need `DOMMatrix` and `Response` when imported, which this runtime doesn't have. Don't upgrade it without running this check.

## License

[GPL-3.0-or-later](LICENSE)
