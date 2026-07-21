# ChatGPT Thread Collapse

A very long ChatGPT web conversation can become noticeably sluggish, so this project started as an idea for a Chrome extension that folds long threads into a lighter view.

This project was built in a vibe coding style using Codex.

It is a local Chrome extension for long ChatGPT threads. The extension semi-virtualizes older assistant messages so fewer heavy nodes actively participate in layout and painting, which helps reduce lag without breaking ChatGPT's own message tree.

## What it does

- Collapses older assistant messages into lightweight placeholders while keeping recent replies expanded
- Restores any folded message on demand
- Keeps code blocks, equations, copy buttons, and normal scrolling intact as much as possible
- Adds thread-level controls for expand all, collapse all, nearby expand, restore previous collapsed view, and reset thread state
- Stores settings and per-thread state locally in `chrome.storage.local`

## Why it helps

Long ChatGPT threads slow down because too many assistant messages stay active in layout and painting. This extension keeps the original React message nodes mounted for compatibility, hides their heavy rendering, and places compact placeholders in the layout instead.

That means:

- Less DOM pressure while scrolling
- Lower layout and paint cost on long conversations
- Manual control over what stays expanded
- A compatibility-first approach that avoids replacing React-managed message nodes

## Install

1. Open Chrome and go to `chrome://extensions/`
2. Turn on Developer mode
3. Click `Load unpacked`
4. Select the `chatgpt-thread-lite-extension` folder
5. Open `https://chatgpt.com/` or `https://chat.openai.com/`

## How to use

After the extension loads, it will start scanning assistant messages in the current conversation.

You can control it in two places:

- In the page header, where `Expand all` and `Collapse all` are injected
- In the popup, where you can change settings and manage the current thread

Per-message controls are also injected near assistant messages:

- `Expand`
- `Collapse`
- `Lock`

## Settings

The popup lets you:

- Enable or disable the extension
- Change how many recent assistant messages stay expanded
- Prefer collapsing code-heavy or formula-heavy old messages
- Turn on extreme memory-saving mode
- Expand nearby collapsed messages
- Expand all collapsed messages in the current thread
- Restore the previous collapsed view
- Re-collapse old messages
- Reset the current thread state

## Internationalization

This project already includes a minimal i18n setup:

- Chinese is the default locale
- English resources are prefilled under `_locales/en`
- UI strings are routed through `chrome.i18n.getMessage`

If you want to add more languages later, copy `_locales/en/messages.json` into a new locale folder and fill in the translations.

## Project structure

```text
chatgpt-thread-lite-extension/
├── manifest.json
├── content.js
├── content.css
├── popup.html
├── popup.js
├── popup.css
├── _locales/
│   ├── zh_CN/messages.json
│   └── en/messages.json
└── README.md
```

## Notes for maintainers

- All ChatGPT selector logic is centralized in `content.js` under `SELECTORS`
- If ChatGPT changes its DOM, update message detection before touching UI code
- Extreme memory-saving mode disables full restore for messages that were never cached
- The extension avoids auto-expanding the latest assistant reply so streaming output is not disturbed

## Development

There is no bundler and no external CDN dependency. Edit the files directly and reload the unpacked extension in Chrome.

If GitHub CLI login fails with `error connecting to github.com`, it usually means the terminal network path is blocked or not using the same proxy/VPN settings as the browser. In that case, fix terminal connectivity first, then run:

```bash
gh auth login
gh auth status
```

## License

This repository is distributed under the MIT License. See [LICENSE](./LICENSE) for the full text.
