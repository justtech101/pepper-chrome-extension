# PEPPER: a Chrome extension that lets a local AI assistant drive your browser

PEPPER is the browser half of **Pepper**, a desktop AI assistant. The extension pairs with a small "desk" server running on your own PC. It takes commands from that server, carries them out in the page, and reports back: read this page, fill that field, click Next, upload this file. It works in its own background tab, so it never takes over the page you are reading.

It is built for real-world sites that resist automation: React and Lexical editors, forms inside iframes, menus built from plain `div`s, and buttons that ignore synthetic clicks. Almost every function carries a comment explaining the site bug it was written to get past.

> **The desk server is not part of this repo.** PEPPER is the client; it only does something when a program on your machine answers on `127.0.0.1:8766` using the protocol below.

## How it works

```
desk (your PC, 127.0.0.1:8766)  <--HTTP-->  background.js (service worker)  <--messages-->  content.js (every frame)
```

1. **Pairing:** `POST /control/pair` with a stable per-profile id, which returns a session. If a second Chrome profile tries to pair, it gets `desk_busy` and backs off, so two browsers never share one command queue.
2. **Polling:** `GET /control/poll?session=…` returns at most one command at a time. The answer goes back to `POST /control/result`.
3. **Watching:** the top frame reports what video is playing (title, time, ad or not) plus a small JPEG frame to `POST /browser-watch`, at most every 5 seconds.
4. **Staying current:** if the desk reports a newer build on disk, the extension reloads itself, with guards against a reload loop.

## Commands

| Area | Actions |
|---|---|
| Tabs | `new_tab`, `navigate`, `back`, `forward`, `reload`, `tabs`, `close_tab` (ids only; never the last tab), `use_this_tab`, `focus_url`, `show_tab`, `own_window` |
| Reading | `snapshot` (text, buttons, links and fields across all frames), `query` (CSS selector to properties), `describe` (redacted HTML of one element), `debug_form`, `frames`, `list_clickable`, `media`, `wait_ready`, `screenshot` (its own tab only) |
| Acting | `click`, `menu_click`, `set`, `type`, `set_file`, `press`, `scroll`, `drag` (allow-listed sites only), `download_media` |
| Real input | `real_click`, `real_type` and `real_scroll` attach `chrome.debugger` for a single action and detach in `finally`, for editors that only accept trusted input |
| Upkeep | `ping`, `build_id`, `reload_extension` |

A command can carry `tab: "<name>"`, which gives each job its own named tab, so scheduled jobs don't navigate each other's pages away.

## Safety limits built into the extension

These checks run in the page, as a second wall behind whatever the desk enforces:

- **No money:** clicks whose label starts with pay, checkout, donate, transfer, withdraw, wire or venmo are refused. So are phrases such as "Place order", "Buy now" and "Confirm payment".
- **No secrets:** it will not type into, attach to, or press keys in password, card, CVV, SSN, routing or account-number fields. Their values are redacted from every read.
- **No `eval`:** `query` returns a fixed set of properties for a selector. There is deliberately no arbitrary-JavaScript action, because the browser is signed into mail and payment sites.
- **Google Voice:** sending is always blocked on `voice.google.com`. Google forbids automated messaging there.
- **Screenshots:** it only photographs its own tab, never the page you have in front of you.

## Warning: read this before installing

This extension asks for `<all_urls>`, `scripting`, `tabs` and `debugger`. Any program on your PC that answers on `127.0.0.1:8766` can read and act on every site you are signed into, within the limits above. Only install it if you run, and trust, the desk server it pairs with. Chrome shows a "started debugging this browser" bar while a `real_*` action runs; that is expected.

## Install (unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this folder.
3. Start your desk server on `127.0.0.1:8766`. The badge turns into **P** once it pairs, and shows **…** while the desk is down or **!** if another Chrome profile holds the desk.

`EXT_VERSION` appears as a literal in both `background.js` and `content.js`, and has to match `manifest.json`. That's deliberate: it is how a stale content script left in an open tab gets spotted and re-injected.
