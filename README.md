# ChatGPT Thread Collapse

A local Chrome extension for long ChatGPT threads. It semi-virtualizes older assistant messages so the page keeps fewer heavy DOM nodes in memory, which helps reduce lag without breaking the ability to restore content later.

## What it does

- Keeps the newest assistant messages expanded and folds older ones into lightweight placeholders
- Restores a folded message only when you click expand
- Preserves the original ChatGPT page as much as possible, including code blocks, equations, copy buttons, and normal scrolling
- Adds thread-level controls for expand all, collapse all, nearby expand, restore previous collapsed view, and reset thread state
- Stores settings and per-thread state locally in `chrome.storage.local`

## Why it helps

ChatGPT threads become slow mostly because many assistant messages stay in the DOM at once. This extension removes old assistant message nodes from layout flow and replaces them with compact placeholders, so the browser has less work to do.

That gives you:

- Lower layout and paint cost on long conversations
- Less DOM pressure during scrolling
- Manual control over which messages stay expanded
- A safer fallback than pure CSS collapsing, because the heavy nodes are actually detached

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

Choose a license before publishing. If you want a permissive default, MIT is the simplest option.
