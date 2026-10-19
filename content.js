(() => {
  // PEPPER content script — always-on watch + control for the Pepper desk.
  // Version kept in sync with manifest.json.
  // A literal on purpose - see the note on EXT_VERSION in background.js.
  const EXT_VERSION = "1.47.8";
  // Custom dropdowns (Dub, Radix, Headless UI) render choices as role=option,
  // not <option>. Missing that selector is why "click TikTok" failed on Buffer's
  // partner form while the word was visible in the page text.
  // role=radio/checkbox/switch/tab are the same story as role=option below:
  // component libraries build them out of plain divs, so a real <input> is
  // never in the DOM. Missing role=radio is why "No, it's not made for kids"
  // could not be clicked on YouTube's upload form - a required field, so the
  // upload could not proceed at all.
  const CLICKABLE_SEL =
    'a, button, [role="button"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listitem"], input, option, label, textarea, summary, [onclick]';
  const SNAPSHOT_CLICKABLE_SEL =
    'a, button, [role="button"], [role="option"], [role="menuitem"], [role="menuitemradio"], input[type=submit], input[type=button]';
  // Matches SET_FILE_MAX_BYTES in jarvis_browser_control.py. All three
  // limits - this one, that one, and the desk's HTTP body cap - are one
  // constraint; raising any alone just moves where the rejection happens.
  // 8 MB could not hold a single 1080x1920 clip, which made video posting
  // impossible.
  const FILE_MAX_BYTES = 48 * 1024 * 1024;
  // Set on click; scopes the next set/type to the link block the user opened.
  let focusedBlockRoot = null;
  // The last field actually written to. This is the anchor that tells one
  // identically-labelled control from another.
  //
  // 2026-09-09, on a client's Facebook Page: nine attempts to click the composer's
  // "Next" all landed on Facebook's notifications dropdown, because that
  // dropdown contains BOTH a role="textbox" and an element labelled "Next".
  // Every container-based selector - including :has() - matched it first, and
  // `querySelector` returns match one with no way to say "not that one".
  //
  // Scoping harder could never have worked: the two subtrees are structurally
  // identical. What separates them is the caption, which only the composer
  // holds. So the honest discriminator is DOM distance from the field we just
  // typed into - the composer's Next shares a close ancestor with the caption
  // box; the notifications Next shares only <body>.
  let lastWrittenEl = null;
  const POLL_INTERVAL_MS = 4000;
  // Narrowed 2026-08-25. Send, post, publish and submit moved under the user's
  // standing grant, which lives in a file on the desk and cannot be read from
  // a content script - so the desk is the authority on those and refuses
  // before a command ever reaches this page.
  //
  // What stays here is the set that never lifts no matter who asks, kept as a
  // second wall for the case the desk is wrong: money, and Google Voice, whose
  // prohibition on automated sending is Google's rather than the user's.
  const BLOCKED_FIRST = /^(pay|checkout|donate|transfer|withdraw|wire|venmo)$/i;
  const BLOCKED_PHRASE = /^(buy now|place order|check out|submit payment|complete purchase|confirm purchase|confirm payment|confirm order|pay now)$/i;
  const VOICE_SEND = /^(send|send now|send message|send text|send mail|send email)$/i;
  const PASSWORD_FIELD = /password|passwd|card.?number|cc.?num|cvc|cvv|csc|ssn|social.?security|routing|account.?number|iban/i;
  const EDIT_HOSTS = ["linktr.ee", "linktree.com", "payhip.com", "whop.com"];
  const AD_TEXT_PATTERN = /taking an ad break|ad break|\bad\s+\d+\s*\/\s*\d+\b|sponsored break|advertisement/i;

  function findActiveVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    const playing = videos.filter((video) => video.readyState >= 2 && video.videoWidth > 0);
    if (!playing.length) {
      return null;
    }
    playing.sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return bRect.width * bRect.height - aRect.width * bRect.height;
    });
    return playing[0];
  }

  function detectLikelyAd() {
    const text = document.body ? document.body.innerText : "";
    return AD_TEXT_PATTERN.test(text.slice(0, 4000));
  }

  function collectSnapshot() {
    const video = findActiveVideo();
    if (!video) {
      return null;
    }
    return {
      title: document.title || "",
      url: location.href,
      site: location.hostname,
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: video.paused,
      isAd: detectLikelyAd(),
    };
  }

  function tick() {
    const snapshot = collectSnapshot();
    if (!snapshot) {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "JARVIS_VIDEO_SNAPSHOT", snapshot }, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // Extension context can be invalidated mid-page-life.
    }
  }

  function clickBlocked(label) {
    const text = String(label || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return false;
    }
    if (BLOCKED_PHRASE.test(text)) {
      return true;
    }
    if (
      /(^|\.)voice\.google\.com$/i.test(location.hostname)
      && VOICE_SEND.test(text)
    ) {
      // Google's own prohibition on automated messaging, not a vault
      // preference. Tested on 2026-08-15 with the user's explicit override and it
      // still held - the consequence lands on his number and his account.
      return true;
    }
    return BLOCKED_FIRST.test(text.split(" ")[0] || "");
  }

  function visible(el) {
    if (!el) {
      return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function svgLabel(el) {
    // Icon-only controls put their name on the icon, not on the thing you
    // click: Instagram's "New post" is an anchor whose only text is an <svg
    // aria-label>, and MediaSilo's toolbar is the same shape. Without this
    // the label reads as empty and the control is invisible to click.
    if (!el || typeof el.querySelector !== "function") {
      return "";
    }
    const labelled = el.querySelector("svg[aria-label]");
    if (labelled) {
      return normalize(labelled.getAttribute("aria-label"));
    }
    const title = el.querySelector("svg title");
    return title ? normalize(title.textContent) : "";
  }

  function labelOf(el) {
    if (!el) {
      return "";
    }
    if (el.tagName === "OPTION") {
      return normalize(el.textContent);
    }
    if (el.tagName === "INPUT" && /^(radio|checkbox)$/i.test(el.type || "")) {
      if (el.id) {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) {
          return normalize(lab.innerText || lab.textContent);
        }
      }
      const parentLab = el.closest("label");
      if (parentLab) {
        return normalize(parentLab.innerText || parentLab.textContent);
      }
      return normalize(el.value);
    }
    return normalize(
      el.getAttribute("aria-label")
      || el.getAttribute("title")
      || el.innerText
      || el.value
      || el.getAttribute("name")
      || svgLabel(el)
      || ""
    );
  }

  function wordBoundaryMatch(label, needle) {
    if (!label.includes(needle)) {
      return false;
    }
    const index = label.indexOf(needle);
    const before = index === 0 ? " " : label[index - 1];
    const after = index + needle.length >= label.length ? " " : label[index + needle.length];
    return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
  }

  function isListChoice(el) {
    if (!el) {
      return false;
    }
    if (el.tagName === "OPTION") {
      return true;
    }
    const role = (el.getAttribute("role") || "").toLowerCase();
    return (
      role === "option"
      || role === "menuitem"
      || role === "menuitemradio"
      || role === "menuitemcheckbox"
    );
  }

  // Depth of the lowest ancestor shared by `el` and `anchor`. Deeper means the
  // two are more closely related. Returns null when they share nothing.
  //
  // Counting HOPS instead of depth looks equivalent and is not: on the
  // Facebook page both Next controls sit exactly two hops below their shared
  // ancestor, so hops ties and the tie-break falls straight back to the
  // notifications panel. Depth separates them, because the composer's shared
  // ancestor is the composer itself while the notifications panel's is <body>.
  function sharedAncestorDepth(el, anchor) {
    if (!el || !anchor) {
      return null;
    }
    let node = el;
    while (node) {
      if (node.contains(anchor)) {
        let depth = 0;
        let up = node;
        while (up && up.parentElement) {
          depth += 1;
          up = up.parentElement;
        }
        return depth;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Of several elements matching one selector, the one nearest the field we
  // just typed into. See the note on `lastWrittenEl`.
  function nearestToWritten(nodes) {
    let best = null;
    let bestDepth = -1;
    for (const el of nodes) {
      const depth = sharedAncestorDepth(el, lastWrittenEl);
      if (depth !== null && depth > bestDepth) {
        best = el;
        bestDepth = depth;
      }
    }
    return best;
  }

  function findClickable(text, selector, exact, nth) {
    if (selector) {
      const hits = Array.from(document.querySelectorAll(selector)).filter(
        (el) => visible(el) || isListChoice(el)
      );
      if (!hits.length) {
        // Keep the old behaviour for selectors that match only hidden nodes;
        // some callers deliberately target those.
        return document.querySelector(selector) || null;
      }
      if (hits.length === 1) {
        return hits[0];
      }
      // Ambiguous. Prefer the match that sits closest to the field we just
      // wrote - on the Facebook composer that is the caption box, which the
      // notifications dropdown does not contain.
      return nearestToWritten(hits) || hits[0];
    }
    const needle = normalize(text).toLowerCase();
    if (!needle) {
      return null;
    }
    // A modal covers the page behind it, so a label that appears both inside
    // and outside the dialog must resolve to the one inside. Instagram's reel
    // composer has eleven "Share" controls and the first in document order is
    // a feed post's share icon - clicking that instead of the dialog's Share
    // is the same first-match-wins bug that made every Dub save hit card one.
    // Falls back to the whole page only when the dialog has no match.
    // Pick the BIGGEST visible dialog, not the last one in document order.
    //
    // `.pop()` assumed the composer is last in the DOM. On a Facebook Page the
    // feed below it is full of `[role="dialog"]` elements, so the last one is
    // a feed widget and a scoped search inside it finds nothing - which is how
    // "Next" stayed unclickable while sitting in plain view, and then, once a
    // document-wide fallback was added, how a *different* "Next" got clicked
    // and the staged post was thrown away.
    //
    // A real modal covers the screen; feed dialogs are small. Area is the
    // honest discriminator. This also still picks the composer on Instagram,
    // where dialog scoping was introduced for the eleven "Share" controls.
    const modal = Array.from(
      document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
    )
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, area: rect.width * rect.height };
      })
      .sort((a, b) => a.area - b.area)
      .map((row) => row.el)
      .pop();
    let nodes = document.querySelectorAll(CLICKABLE_SEL);
    if (modal) {
      const inside = modal.querySelectorAll(CLICKABLE_SEL);
      if (inside.length) {
        nodes = inside;
      }
    }
    // **Pick the Nth match when the first one is the wrong one.**
    // Added 2026-09-14 for Linktree, where the sidebar carries a nav link
    // called "Archive" and every per-link menu carries an action ALSO called
    // "Archive". First-match-wins meant the nav always won: the click looked
    // successful, the page navigated to an empty archive view, and nothing was
    // ever archived. Four different routes failed the same way.
    //
    // `nth` is 1-based and counts only exact label matches, in document order,
    // so "the second Archive" is a stable thing to ask for. Deliberately dumb:
    // no scoring, no guessing which one the caller meant.
    if (nth) {
      const all = [];
      for (const el of nodes) {
        if (!visible(el) && !isListChoice(el)) continue;
        const label = labelOf(el).toLowerCase();
        if (label && label === needle) {
          all.push(el);
        }
      }
      return all[Number(nth) - 1] || null;
    }

    let exactSoft = null;
    let optionFallback = null;
    let softFallback = null;
    for (const el of nodes) {
      if (el.tagName === "INPUT") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "password", "file"].includes(type)) {
          continue;
        }
      }
      // Open listboxes often park options off-screen or with zero box until
      // measured; requiring visible() made "TikTok" unfindable on Dub.
      if (!visible(el) && !isListChoice(el)) {
        continue;
      }
      const label = labelOf(el).toLowerCase();
      if (!label) {
        continue;
      }
      if (label === needle) {
        if (
          isListChoice(el)
          || el.tagName === "INPUT"
          || el.tagName === "BUTTON"
          || el.getAttribute("role") === "button"
        ) {
          return el;
        }
        if (!exactSoft) {
          exactSoft = el;
        }
        continue;
      }
      if (exact) {
        continue;
      }
      if (isListChoice(el) && label.includes(needle) && !optionFallback) {
        optionFallback = el;
      }
      // Short needles like "Link" must not match "Linktree admin". Exact mode
      // is always strict; otherwise require a word boundary or a close label.
      const allowSoft = needle.length > 4 || wordBoundaryMatch(label, needle);
      if (
        !softFallback
        && allowSoft
        && label.includes(needle)
        && !(needle.length <= 12 && label.length > needle.length + 24)
      ) {
        softFallback = el;
      }
    }
    const found = exact
      ? (exactSoft || optionFallback || null)
      : (exactSoft || optionFallback || softFallback);
    if (found) {
      return found;
    }
    return findByBareText(needle, modal);
  }

  // Last resort: a control that is not a button by any markup Pepper can see.
  //
  // Facebook's "Next" in the reel composer is a plain <div> carrying a React
  // listener - no <button>, no role="button", no onclick attribute - so it
  // matches nothing in CLICKABLE_SEL. On 2026-09-09 she could read the word
  // "Next" in the page and still reported "I could not find Next on this
  // page", which is the most confusing failure she has: the thing is plainly
  // there.
  //
  // So: find the smallest element whose own text IS the label, then walk up to
  // something plausibly clickable. Deliberately narrow - exact text only, and
  // preferring the innermost node - because a loose version of this would
  // start clicking paragraphs.
  function findByBareText(needle, modal) {
    if (!needle) {
      return null;
    }
    // Try the dialog first, then the whole page.
    //
    // The modal is chosen with `.pop()` on every visible [role="dialog"], i.e.
    // the LAST one in document order. On a Facebook Page the feed below the
    // composer is full of dialogs, so that pick can easily be a feed element
    // rather than the composer - and then a search scoped to it finds nothing
    // while the control sits in plain view. Searching the document afterwards
    // costs one extra pass and only happens when the scoped search failed.
    return bareTextIn(needle, modal) || bareTextIn(needle, document.body);
  }

  function bareTextIn(needle, root) {
    if (!root || typeof root.querySelectorAll !== "function") {
      return null;
    }
    let best = null;
    for (const el of root.querySelectorAll("div, span, a, li")) {
      if (!visible(el)) {
        continue;
      }
      if (normalize(el.textContent).toLowerCase() !== needle) {
        continue;
      }
      // Innermost wins: the dialog itself also "contains" the word.
      if (!best || best.contains(el)) {
        best = el;
      }
    }
    if (!best) {
      return null;
    }
    let node = best;
    for (let up = 0; up < 4 && node; up += 1) {
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (
        node.tagName === "BUTTON"
        || node.tagName === "A"
        || role === "button"
        || node.hasAttribute("tabindex")
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function findBlockRoot(el) {
    let node = el;
    while (node && node !== document.body) {
      if (node.querySelector('input[name="url"], input[name="title"], textarea[name="url"]')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function findBlockByText(text) {
    const needle = normalize(text).toLowerCase();
    if (!needle) {
      return null;
    }
    const inputs = document.querySelectorAll('input[name="url"], input[name="title"]');
    for (const input of inputs) {
      let node = input.parentElement;
      for (let depth = 0; depth < 14 && node; depth += 1) {
        const blob = normalize(node.innerText || node.textContent || "").toLowerCase();
        if (blob.includes(needle)) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findByNameOrId(name) {
    const key = normalize(name);
    if (!key) {
      return null;
    }
    const byId = document.getElementById(key);
    if (byId) {
      return byId;
    }
    const named = Array.from(document.querySelectorAll(`[name="${CSS.escape(key)}"]`));
    if (!named.length) {
      return null;
    }
    const visibleNamed = named.filter(visible);
    return visibleNamed[0] || named[0];
  }

  function findField(selector, name, scopeRoot) {
    const root = scopeRoot || focusedBlockRoot;
    if (selector) {
      if (root) {
        const scoped = root.querySelector(selector);
        if (scoped) {
          return scoped;
        }
      }
      return document.querySelector(selector);
    }
    if (name && root) {
      const scopedNamed = Array.from(root.querySelectorAll(`[name="${CSS.escape(name)}"]`)).filter(visible);
      if (scopedNamed.length) {
        return scopedNamed[0];
      }
    }
    if (name) {
      return findByNameOrId(name);
    }
    const active = document.activeElement;
    if (active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) {
      return active;
    }
    // `[contenteditable=true]` missed the plain `<div contenteditable>` form and
    // the `plaintext-only` variant. Rich editors - YouTube Studio's channel
    // description, Grok's prompt box, Meta's composer caption - are all
    // contenteditable rather than <textarea>, so a narrow match here reads as
    // "the field does not exist".
    const query =
      "input:not([type=hidden]):not([type=password]), textarea, [contenteditable]:not([contenteditable='false'])";
    if (root) {
      const scoped = root.querySelector(query);
      if (scoped) {
        return scoped;
      }
    }
    return document.querySelector(query);
  }

  function fieldBlocked(el) {
    if (!el) {
      return true;
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    const name = `${el.getAttribute("name") || ""} ${el.id || ""} ${auto} ${type}`;
    if (type === "password") {
      return true;
    }
    if (/^(current-password|new-password|cc-number|cc-csc|cc-exp)$/.test(auto)) {
      return true;
    }
    return PASSWORD_FIELD.test(name);
  }

  function editHostAllowed(href) {
    try {
      const host = new URL(href).hostname.toLowerCase();
      return EDIT_HOSTS.some((h) => host === h || host.endsWith("." + h));
    } catch (error) {
      return false;
    }
  }

  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function pointerEvent(type, el, point, extra) {
    const init = Object.assign(
      {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
        buttons: 1,
      },
      extra || {}
    );
    el.dispatchEvent(new MouseEvent(type, init));
    try {
      el.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), init));
    } catch (error) {
      // older Chrome
    }
  }

  async function dragElement(from, to) {
    const start = centreOf(from);
    const end = centreOf(to);
    from.scrollIntoView({ block: "center" });
    pointerEvent("mousedown", from, start);
    const steps = 12;
    for (let i = 1; i <= steps; i += 1) {
      const point = {
        x: start.x + ((end.x - start.x) * i) / steps,
        y: start.y + ((end.y - start.y) * i) / steps,
      };
      pointerEvent("mousemove", document.elementFromPoint(point.x, point.y) || to, point);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    pointerEvent("mouseup", to, end, { buttons: 0 });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  function fireChange(el, text) {
    // Fire what a real edit fires, not the minimum.
    //
    // A plain Event("input") carries no inputType and no data. Frameworks that
    // inspect those - Google's Closure jsaction contract among them - can
    // ignore it entirely, which leaves the DOM showing the new value while the
    // framework's own model still holds the old one. That is what saved a stale date
    // back to a Google Careers profile on 2026-09-09 after the
    // field read the new one.
    //
    // beforeinput first, then a real InputEvent, then change. Falls back to the
    // plain events where InputEvent is unavailable.
    const value = typeof text === "string" ? text : String(el.value || "");
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: value,
        })
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: value,
        })
      );
    } catch (error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fireBlur(el) {
    try {
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    } catch (error) {
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }

  function clickElement(el) {
    if (el.tagName === "OPTION") {
      const sel = el.closest("select");
      if (sel) {
        sel.value = el.value;
        fireChange(sel);
        return;
      }
    }
    // ARIA listbox / menu items: prefer a real pointer sequence so Radix and
    // Headless UI register the choice the same way a human click would.
    if (isListChoice(el) && el.tagName !== "OPTION") {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      try {
        el.focus();
      } catch (error) {
        // not focusable
      }
      realClick(el);
      if (el.getAttribute("aria-selected") !== "true") {
        try {
          el.setAttribute("aria-selected", "true");
        } catch (error) {
          // read-only
        }
      }
      return;
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "radio") {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.focus();
        el.checked = true;
        fireChange(el);
        return;
      }
      if (type === "checkbox") {
        el.scrollIntoView({ block: "center", inline: "center" });
        el.focus();
        // Never set checked and then click — that toggles it back off.
        if (!el.checked) {
          el.click();
        }
        if (!el.checked) {
          el.checked = true;
          fireChange(el);
        }
        return;
      }
    }
    el.scrollIntoView({ block: "center", inline: "center" });
    el.focus();
    realClick(el);
  }

  // `el.click()` fires one synthetic `click` and nothing else - no pointerdown,
  // no mousedown. Plenty of the modern web never sees it: Indeed's job cards
  // open their detail pane off a pointer sequence, so a bare .click() reported
  // success and did absolutely nothing, over and over.
  //
  // The drag code learned this in August ("a bare mousedown/mouseup does
  // nothing to dnd-kit") and clicking never got the same treatment.
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };
    const sequence = [
      ["pointerover", "pointer"],
      ["pointerenter", "pointer"],
      ["mouseover", "mouse"],
      ["pointerdown", "pointer"],
      ["mousedown", "mouse"],
      ["pointerup", "pointer"],
      ["mouseup", "mouse"],
      ["click", "mouse"],
    ];
    for (const [type, family] of sequence) {
      let event;
      try {
        if (family === "pointer" && window.PointerEvent) {
          event = new PointerEvent(type, Object.assign({ pointerId: 1, isPrimary: true }, base));
        } else if (family === "pointer") {
          continue; // no PointerEvent support; the mouse pair carries it
        } else {
          event = new MouseEvent(type, type === "mouseup" || type === "click"
            ? Object.assign({}, base, { buttons: 0 })
            : base);
        }
      } catch (error) {
        continue;
      }
      el.dispatchEvent(event);
    }
  }

  // Enough of the page to notice that a click did something, and cheap enough
  // to take twice on every click. Not a diff - just a fingerprint.
  function pageSignature() {
    const body = document.body;
    return [
      location.href,
      document.title,
      body ? body.innerText.length : 0,
      document.querySelectorAll('a, button, [role="button"], input, textarea, select').length,
    ].join("|");
  }

  async function typeInto(el, text, opts = {}) {
    el.focus();
    lastWrittenEl = el;
    el.scrollIntoView({ block: "center", inline: "center" });
    if (el.isContentEditable) {
      // Writing innerText straight in updates what you see and nothing else.
      // Rich editors (Draft.js on TikTok, Lexical on Meta) keep the real value
      // in their own state and only update it from input events, so a direct
      // write leaves the page showing new text while the editor still holds
      // the old one - and the old one is what posts. TikTok's character
      // counter is the tell: it stays on the previous length.
      //
      // Selecting the existing content and going through execCommand makes the
      // browser emit a genuine beforeinput/input pair, which those editors
      // handle like a paste.
      const wanted = String(text);
      const before = el.innerText || "";

      const selectAll = () => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      };

      // Did the text actually land? Compare against the last non-empty line,
      // because that is the part every failing path dropped.
      const holds = (value) => {
        const seen = (el.innerText || "").replace(/\s+/g, "");
        const lines = value.split("\n").filter((line) => line.trim());
        const tail = (lines.length ? lines[lines.length - 1] : value).replace(/\s+/g, "");
        return seen.length > 0 && (!tail || seen.indexOf(tail) >= 0);
      };

      try {
        selectAll();
        if (wanted.indexOf("\n") >= 0 || opts.html) {
          // Multi-line goes in as a paste: newlines cannot ride inside
          // insertText, and insertParagraph made TikTok replace the whole
          // upload form with "Something went wrong". A paste lands at the
          // editor's own caret and ignores the DOM selection, so the field
          // has to be emptied first.
          document.execCommand("delete");
          const transfer = new DataTransfer();
          transfer.setData("text/plain", wanted);
          // v1.47.3 (2026-09-28): `html` pastes formatted content too -
          // headings, bold, lists - for rich editors that keep formatting
          // on paste (Google Sites). Plain text stays the fallback.
          if (opts.html) {
            transfer.setData("text/html", String(opts.html));
          }
          el.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          );
        } else {
          document.execCommand("insertText", false, wanted);
        }
      } catch (error) {
        // Fall through to the checks below rather than trusting a throw.
      }

      // Trust the field, never the return value. dispatchEvent only reports
      // whether preventDefault was called, which says nothing about whether
      // the text arrived - and the delete above has already emptied the
      // field, so a quiet failure leaves it BLANK. YouTube's description box
      // came back empty exactly this way, after the caption had been cleared.
      // Give the editor a moment before judging it.
      //
      // Lexical (Facebook) and Draft.js commit their state asynchronously, so
      // reading the field straight after the write sees the OLD content, the
      // check below decides the write failed, and the fallback appends a
      // SECOND copy. On 2026-09-09 that put the same caption into a client's
      // post three times over, and the run reported ok:true each time.
      //
      // A short synchronous settle is not available here, so re-check a few
      // times against a wall-clock budget instead. This is cheap when the
      // write landed - the first re-read passes and it stops.
      let settled = holds(wanted);
      if (!settled) {
        // Yield, do not spin. A busy-wait blocks the single JS thread, so the
        // editor cannot commit while it runs and the check below is then
        // guaranteed to fail - which is exactly how the caption ended up in a
        // client's post twice on 2026-09-09.
        for (let tries = 0; tries < 12 && !settled; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          settled = holds(wanted);
        }
      }

      if (!settled) {
        try {
          selectAll();
          document.execCommand("insertText", false, wanted);
        } catch (error) {
          // Editors that reject multi-line insertText land on the guard below.
        }
      }

      // Duplication guard. If the text is now present more than once, the
      // write landed twice - either the editor replayed it or the fallback
      // above fired on a stale read. Clear and put it in exactly once. An
      // extra copy is not a cosmetic problem: it is what would have gone out
      // on the client's page.
      // Let any asynchronous replay land before counting copies.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const once = String(wanted).replace(/\s+/g, " ").trim();
      if (once.length > 24) {
        const seen = (el.innerText || "").replace(/\s+/g, " ");
        let count = 0;
        let at = seen.indexOf(once);
        while (at >= 0) {
          count += 1;
          at = seen.indexOf(once, at + once.length);
        }
        if (count > 1) {
          try {
            selectAll();
            document.execCommand("delete");
            document.execCommand("insertText", false, wanted);
          } catch (error) {
            // Leave it to the emptiness guard below rather than throw.
          }
        }
      }

      if (!(el.innerText || "").trim()) {
        // Last resort. A direct write does not update a framework's own
        // state, so this can still post stale text - but an empty field is a
        // certain failure and this is at worst an uncertain one, and it never
        // leaves the page worse than it was found.
        try {
          el.innerText = wanted;
        } catch (error) {
          if (before) {
            el.innerText = before;
          }
        }
      }
      fireChange(el, wanted);
      return;
    }
    if (el.tagName === "SELECT") {
      setSelectValue(el, text);
      return;
    }
    // Opt-in browser-made edit (v1.46.1, 2026-09-27): `type` with trusted:true
    // selects the text and runs execCommand("insertText"), so Chrome itself
    // fires genuine (isTrusted) beforeinput/input events and no synthetic ones
    // follow. For forms that ignore scripted input. Built while chasing
    // Facebook's listing editor - which turned out NOT to need it: that form
    // takes the text fine and it is its final "Update" button that ignores
    // synthetic clicks. Kept opt-in only; the setter path stays the default.
    if (opts.trusted && typeof el.select === "function") {
      let done = false;
      try {
        el.select();
        done = document.execCommand("insertText", false, text)
          && String(el.value) === String(text);
      } catch (error) {
        done = false;
      }
      if (done) {
        fireBlur(el);
        return;
      }
      // Fall through to the setter path rather than leaving it half-typed.
    }
    // Native value setter FIRST, not as a fallback.
    //
    // React keeps its own copy of an input's value and skips its onChange when
    // the DOM value already matches what it recorded. `execCommand` updates the
    // DOM and returns true, so the old code treated it as success and never ran
    // the setter below - the field read back correctly and React submitted its
    // OWN, unchanged value.
    //
    // That is exactly what happened on Google Careers on 2026-09-09: a job's
    // start year was set, read back correctly, submitted - and the saved
    // profile still held the old year. A field that reads back right has not
    // necessarily been *accepted*.
    //
    // Assigning through the prototype's setter resets React's tracker, so the
    // input event below is seen as a real change. This is the standard fix and
    // it is harmless on plain inputs, which is why it is now the primary path.
    let wrote = false;
    try {
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, text);
        wrote = String(el.value) === String(text);
      }
    } catch (error) {
      wrote = false;
    }
    if (!wrote) {
      // Older or unusual controls that do not expose the prototype setter.
      try {
        if (typeof el.select === "function") {
          el.select();
        }
        wrote = document.execCommand("insertText", false, text);
      } catch (error) {
        wrote = false;
      }
    }
    if (!wrote) {
      try {
        el.value = text;
      } catch (error) {
        // Nothing further to try; fireChange still reports what is there.
      }
    }
    fireChange(el, text);
    fireBlur(el);
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  function setSelectValue(sel, wanted) {
    const needle = normalize(wanted).toLowerCase();
    let match = null;
    for (const opt of Array.from(sel.options)) {
      const text = normalize(opt.textContent).toLowerCase();
      const value = normalize(opt.value).toLowerCase();
      if (text === needle || value === needle) {
        match = opt;
        break;
      }
      if (!match && (text.includes(needle) || value.includes(needle))) {
        match = opt;
      }
    }
    if (!match) {
      return false;
    }
    sel.value = match.value;
    fireChange(sel);
    return true;
  }

  function truthy(value) {
    return /^(1|y|yes|true|on|checked)$/i.test(normalize(value));
  }

  async function setField(command) {
    const wanted = String(command.value ?? command.text ?? "");
    const name = command.name || "";
    const selector = command.selector || "";
    const scopeRoot = command.scope
      ? findBlockByText(command.scope)
      : focusedBlockRoot;

    // Radios: pick the input in the named group whose value matches.
    if (name) {
      const radios = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
      );
      if (radios.length) {
        const needle = normalize(wanted).toLowerCase();
        const hit =
          radios.find((el) => normalize(el.value).toLowerCase() === needle)
          || radios.find((el) => labelOf(el).toLowerCase() === needle)
          || (truthy(wanted) ? radios.find((el) => /^(y|yes|1|true)$/i.test(el.value)) : null);
        if (!hit) {
          return {
            ok: false,
            error: "not_found",
            message: `No radio ${name}=${wanted}`,
          };
        }
        clickElement(hit);
        return {
          ok: true,
          action: "set",
          name,
          value: hit.value,
          checked: hit.checked,
        };
      }
    }

    const el = findField(selector, name, scopeRoot);
    if (!el) {
      const scopeHint = command.scope ? ` in "${command.scope}"` : "";
      return {
        ok: false,
        error: "no_field",
        message: `Could not find field ${selector || name || "target"}${scopeHint}.`,
      };
    }
    if (fieldBlocked(el)) {
      return {
        ok: false,
        error: "blocked_field",
        message: "I will not type into a password or payment field.",
      };
    }

    const type = (el.getAttribute("type") || el.tagName).toLowerCase();
    if (type === "checkbox") {
      const shouldCheck = truthy(wanted) || wanted === "" || wanted === el.value;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      if (shouldCheck && !el.checked) {
        el.click();
      }
      if (!shouldCheck && el.checked) {
        el.click();
      }
      if (shouldCheck && !el.checked) {
        el.checked = true;
        fireChange(el);
      }
      if (!shouldCheck && el.checked) {
        el.checked = false;
        fireChange(el);
      }
      return {
        ok: true,
        action: "set",
        name: el.name || name,
        value: el.value,
        checked: el.checked,
      };
    }

    if (el.tagName === "SELECT") {
      if (!setSelectValue(el, wanted)) {
        return {
          ok: false,
          error: "not_found",
          message: `No option ${wanted} in ${el.name || el.id || "select"}.`,
        };
      }
      return {
        ok: true,
        action: "set",
        name: el.name || name,
        value: el.value,
      };
    }

    await typeInto(el, wanted);
    return {
      ok: true,
      action: "set",
      name: el.name || name,
      value: String(el.value || "").slice(0, 120),
    };
  }

  function pageSnapshot() {
    const text = document.body ? document.body.innerText : "";
    const buttons = Array.from(document.querySelectorAll(SNAPSHOT_CLICKABLE_SEL))
      .filter((el) => visible(el) || isListChoice(el))
      // 40 was a ceiling Indeed hit on every page: the search chrome alone
      // spends it, and the control that actually does the thing sits past the
      // cut. Being unable to see a button is indistinguishable from the button
      // not existing, and it sent us looking for bugs that were not there.
      .slice(0, 120)
      .map((el) => labelOf(el))
      .filter(Boolean);
    const fields = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        return type !== "hidden" && type !== "password";
      })
      .slice(0, 150)
      .map((el) => {
        const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        const entry = {
          tag: el.tagName.toLowerCase(),
          type,
          name: el.getAttribute("name") || "",
          id: el.id || "",
          value: el.tagName === "SELECT" ? el.value : String(el.value || "").slice(0, 160),
          label: labelOf(el).slice(0, 80),
        };
        if (el.tagName === "SELECT") {
          entry.options = Array.from(el.options)
            .slice(0, 50)
            .map((opt) => normalize(opt.textContent))
            .filter(Boolean);
        }
        if (type === "radio" || type === "checkbox") {
          entry.checked = Boolean(el.checked);
        }
        if (type === "file") {
          entry.files = el.files ? el.files.length : 0;
        }
        return entry;
      });
    // Labels alone cannot be acted on later. A results page lists fifteen jobs
    // and the only way to reopen one is its href, so anchors come back with
    // both - otherwise "apply to number 2" has a number and nothing to open.
    const links = Array.from(document.querySelectorAll("a[href]"))
      .filter(visible)
      .slice(0, 150)
      .map((el) => ({ text: labelOf(el).slice(0, 120), href: el.href || "" }))
      .filter((row) => row.text && row.href.startsWith("http"));
    return {
      ok: true,
      action: "snapshot",
      version: EXT_VERSION,
      title: document.title || "",
      url: location.href,
      text: text.slice(0, 8000),
      // Chat threads put the newest messages at the bottom, past the head cap.
      text_tail: text.length > 8000 ? text.slice(-8000) : "",
      selection: window.getSelection ? window.getSelection().toString() : "",
      buttons,
      links,
      fields,
    };
  }

  function setFileInput(command) {
    const scopeRoot = command.scope ? findBlockByText(command.scope) : focusedBlockRoot;
    const name = command.name || "";
    const selector = command.selector || "";
    const filename = String(command.filename || "upload.bin");
    const mime = String(command.mime || "application/octet-stream");
    const b64 = String(command.content_base64 || "");
    if (!b64) {
      return {
        ok: false,
        error: "no_content",
        message: "set_file needs content_base64 from the desk (path is never read in the page).",
      };
    }
    let bytes;
    try {
      const binary = atob(b64);
      if (binary.length > FILE_MAX_BYTES) {
        return {
          ok: false,
          error: "too_large",
          message: `File is ${binary.length} bytes; max is ${FILE_MAX_BYTES}.`,
        };
      }
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
    } catch (error) {
      return { ok: false, error: "bad_base64", message: "content_base64 could not be decoded." };
    }
    let el = findField(selector, name, scopeRoot);
    if (el && (el.getAttribute("type") || "").toLowerCase() !== "file") {
      el = null;
    }
    if (!el) {
      const files = Array.from(document.querySelectorAll('input[type="file"]'));
      el = files[0] || null;
    }
    if (!el) {
      return {
        ok: false,
        error: "no_file_input",
        message: "No file input on this page. Use a hosted URL when the site has no <input type=file>.",
      };
    }
    if (fieldBlocked(el)) {
      return {
        ok: false,
        error: "blocked_field",
        message: "I will not attach a file to a password or payment field.",
      };
    }
    try {
      const file = new File([bytes], filename, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      fireChange(el);
    } catch (error) {
      return {
        ok: false,
        error: "set_file_failed",
        message: String((error && error.message) || error || "could not set files"),
      };
    }
    return {
      ok: true,
      action: "set_file",
      name: el.name || name || "file",
      filename,
      bytes: bytes.length,
      files: el.files ? el.files.length : 0,
    };
  }

  async function handleControl(command) {
    const action = String(command.action || "");
    if (action === "ping") {
      return { ok: true, action: "ping", version: EXT_VERSION, url: location.href };
    }
    if (action === "describe") {
      // Show the actual markup, instead of guessing at it.
      //
      // Added 2026-09-09 after two wrong diagnoses in a row on Google Careers:
      // a date that would not save and a resume upload with no visible file
      // input. Both were guessed at from `debug_form`, which lists fields it
      // recognises and is silent about everything it does not - custom month
      // pickers, save buttons built from divs, upload controls that mount
      // their input only on click. Guessing at markup nobody can see is how a
      // session gets spent.
      //
      // Values are redacted: this returns HTML, and HTML on a signed-in page
      // can carry things that must never leave it.
      // Through findClickable, not a bare querySelector, so that describe and
      // click resolve to the SAME element. A proof step that inspects one node
      // while the click lands on another proves nothing at all.
      const target = findClickable(
        command.text || "", command.selector || "", false
      );
      if (!target) {
        return {
          ok: false,
          error: "not_found",
          message: "Nothing matched " + (command.selector || command.text || "that") + ".",
        };
      }
      let node = target;
      const up = Math.max(0, Math.min(6, Number(command.up) || 0));
      for (let i = 0; i < up && node.parentElement; i += 1) {
        node = node.parentElement;
      }
      const clone = node.cloneNode(true);
      clone.querySelectorAll("input, textarea").forEach((field) => {
        const type = (field.getAttribute("type") || "").toLowerCase();
        const name = field.getAttribute("name") || "";
        if (type === "password" || PASSWORD_FIELD.test(name)) {
          field.setAttribute("value", "[redacted]");
        }
      });
      clone.querySelectorAll("script, style, svg").forEach((junk) => junk.remove());
      const limit = Math.max(400, Math.min(20000, Number(command.limit) || 6000));
      const html = String(clone.outerHTML || "").replace(/\s+/g, " ");
      return {
        ok: true,
        action: "describe",
        tag: node.tagName,
        truncated: html.length > limit,
        html: html.slice(0, limit),
      };
    }
    if (action === "debug_form") {
      // contenteditable is listed too. Leaving it out is why debug_form reported
      // every field on YouTube Studio's channel page *except* the description,
      // which reads as "the field is not there" when it is simply a div.
      const fields = Array.from(
        document.querySelectorAll(
          "input, select, textarea, [contenteditable]:not([contenteditable='false'])"
        )
      ).map((el) => {
        const editable = el.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
        const type = editable
          ? "contenteditable"
          : (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
        const entry = {
          tag: el.tagName.toLowerCase(),
          type,
          name: el.getAttribute("name") || el.getAttribute("aria-label") || "",
          id: el.id || "",
          value: String((editable ? el.innerText : el.value) || "").slice(0, 200),
          required: Boolean(el.required),
          maxLength: el.maxLength > 0 ? el.maxLength : null,
          minLength: el.minLength > 0 ? el.minLength : null,
          pattern: el.getAttribute("pattern") || "",
          autocomplete: el.getAttribute("autocomplete") || "",
          disabled: Boolean(el.disabled),
          readOnly: Boolean(el.readOnly),
          visible: visible(el),
          className: String(el.className || "").slice(0, 80),
        };
        if (type === "radio" || type === "checkbox") {
          entry.checked = Boolean(el.checked);
        }
        if (el.tagName === "SELECT") {
          entry.options = Array.from(el.options).map((opt) => ({
            text: normalize(opt.textContent),
            value: opt.value,
            selected: Boolean(opt.selected),
          }));
        }
        return entry;
      });
      const forms = Array.from(document.forms).map((form) => ({
        name: form.getAttribute("name") || "",
        id: form.id || "",
        method: form.method || "",
        action: form.action || "",
        fieldCount: form.elements.length,
      }));
      const errorNodes = Array.from(
        document.querySelectorAll(".error, .errors, .alert, .validation, [class*='error'], [id*='error']")
      )
        .slice(0, 20)
        .map((el) => normalize(el.innerText || el.textContent).slice(0, 300))
        .filter(Boolean);
      return {
        ok: true,
        action: "debug_form",
        version: EXT_VERSION,
        title: document.title || "",
        url: location.href,
        forms,
        fields,
        errors: errorNodes,
        bodyError: (() => {
          const text = document.body ? document.body.innerText : "";
          const idx = text.toLowerCase().indexOf("error");
          return idx >= 0 ? text.slice(idx, idx + 400) : "";
        })(),
      };
    }
    if (action === "snapshot") {
      const snap = pageSnapshot();
      snap.focusedBlock = focusedBlockRoot
        ? normalize(focusedBlockRoot.innerText || "").slice(0, 120)
        : "";
      return snap;
    }
    if (action === "wait_ready") {
      const minButtons = Number(command.minButtons) || 1;
      const minFields = Number(command.minFields) || 0;
      const maxMs = Number(command.timeoutMs) || 40000;
      const start = Date.now();
      let last = pageSnapshot();
      while (Date.now() - start < maxMs) {
        last = pageSnapshot();
        const buttons = last.buttons || [];
        const fields = last.fields || [];
        if (buttons.length >= minButtons || fields.length >= minFields) {
          return Object.assign({ ok: true, action: "wait_ready", ready: true }, last);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return Object.assign({ ok: true, action: "wait_ready", ready: false }, last);
    }
    if (action === "set") {
      return await setField(command);
    }
    if (action === "set_file") {
      return setFileInput(command);
    }
    if (action === "media") {
      // Pepper could not see a <video> or read an <img> src at all, so a
      // generated video sat on screen with no way to name it, let alone save
      // it. Report only - saving is a separate, deliberate action.
      // Not `kind`: the command envelope already uses that key.
      const want = String(command.media_kind || "").toLowerCase();
      const nodes = [];
      if (want !== "image") {
        document.querySelectorAll("video").forEach((el) => nodes.push(["video", el]));
      }
      if (want !== "video") {
        document.querySelectorAll("img").forEach((el) => nodes.push(["image", el]));
      }
      const min = Number(command.min_width) || 0;
      // The index must be PER KIND, because download_media indexes into
      // querySelectorAll('video') or ('img') separately. A combined index here
      // meant "media says image 1" and "download_media takes image 1" pointed
      // at different pictures - which downloaded a 300x300 avatar instead of
      // the generated still.
      const seen = { video: 0, image: 0 };
      const items = nodes
        .map(([kind, el]) => ({
          index: seen[kind]++,
          kind,
          src: el.currentSrc || el.src || "",
          width: el.videoWidth || el.naturalWidth || el.clientWidth || 0,
          height: el.videoHeight || el.naturalHeight || el.clientHeight || 0,
        }))
        .filter((item) => item.src && item.width >= min)
        // Not 40: a test pins that number out of this file, guarding an old
        // button-cap bug. The media list is short anyway.
        .slice(0, 60);
      return { ok: true, action, count: items.length, media: items };
    }
    if (action === "download_media") {
      // Fetch in the page so the request carries the page's own cookies - a
      // generated asset behind a signed URL is not fetchable from the desk -
      // then hand it to Chrome as a normal download. The bytes never cross the
      // extension channel, which is what makes a 3 MB video practical here.
      const want = String(command.media_kind || "video").toLowerCase();
      const wanted = want === "image" ? "img" : "video";
      const list = Array.from(document.querySelectorAll(wanted)).filter(
        (el) => el.currentSrc || el.src
      );
      const index = Number.isInteger(command.index) ? command.index : list.length - 1;
      const el = list[index];
      if (!el) {
        return {
          ok: false,
          error: "no_media",
          message: `No ${wanted} at index ${index}; the page has ${list.length}.`,
        };
      }
      const src = el.currentSrc || el.src;
      // Streaming mode. Fetching into a blob first means holding the whole
      // file in page memory - fine for a 3 MB clip, wrong for a 277 MB master.
      // Handing the URL straight to Chrome lets it stream to disk, and a
      // presigned link already carries its own auth and content-disposition.
      if (command.direct) {
        const link = document.createElement("a");
        link.href = src;
        if (command.filename) link.download = String(command.filename);
        document.body.appendChild(link);
        link.click();
        setTimeout(() => link.remove(), 4000);
        return {
          ok: true,
          action,
          kind: wanted,
          index,
          mode: "direct",
          message:
            "Handed to Chrome as a streaming download - no size limit, but the filename may come from the server, and progress shows in Chrome's download bar.",
        };
      }
      try {
        const response = await fetch(src, { credentials: "include" });
        if (!response.ok) {
          return { ok: false, error: "fetch_failed", status: response.status };
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = String(command.filename || "pepper-download");
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
          URL.revokeObjectURL(url);
          link.remove();
        }, 4000);
        return {
          ok: true,
          action,
          kind: wanted,
          index,
          bytes: blob.size,
          type: blob.type,
          filename: link.download,
          message:
            "Chrome may ask to allow multiple downloads the first time. If nothing lands, check the address bar.",
        };
      } catch (error) {
        return { ok: false, error: "download_failed", message: String(error.message || error) };
      }
    }
    if (action === "locate") {
      // For real_click (v1.47.0): find the target exactly as "click" would,
      // apply the SAME send/pay/post guard, and report where it sits on screen.
      // The background then presses a real mouse there via chrome.debugger.
      const el = findClickable(command.text, command.selector, Boolean(command.exact), command.nth);
      if (!el) {
        return {
          ok: false,
          error: "not_found",
          message: `I could not find ${command.text || command.selector || "that"} on this page.`,
        };
      }
      const label = labelOf(el);
      if (clickBlocked(label)) {
        return {
          ok: false,
          error: "blocked_click",
          message: "I stopped. That looks like send, pay, or post. I will not click it.",
          label,
        };
      }
      el.scrollIntoView({ block: "center", inline: "center" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Diagnostic (2026-09-27): what is ACTUALLY at that point. A real
      // click on the wrong element - a transparent overlay, a sibling that
      // grew to cover it - would look identical to "the click did nothing".
      const hit = document.elementFromPoint(cx, cy);
      return {
        ok: true,
        action: "locate",
        label,
        top: window === window.top,
        x: cx,
        y: cy,
        width: rect.width,
        height: rect.height,
        hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))),
        hitTag: hit ? hit.tagName : "",
        hitLabel: hit ? labelOf(hit) : "",
      };
    }
    if (action === "click") {
      const el = findClickable(command.text, command.selector, Boolean(command.exact), command.nth);
      if (!el) {
        return {
          ok: false,
          error: "not_found",
          message: `I could not find ${command.text || command.selector || "that"} on this page.`,
        };
      }
      focusedBlockRoot = findBlockRoot(el) || focusedBlockRoot;
      const label = labelOf(el);
      if (clickBlocked(label)) {
        return {
          ok: false,
          error: "blocked_click",
          message: "I stopped. That looks like send, pay, or post. I will not click it.",
          label,
        };
      }
      // "I found a button and called click on it" is not the same claim as
      // "the page did something", and reporting the first as the second is how
      // a run looks fine while going nowhere. Take a fingerprint either side.
      const before = pageSignature();
      clickElement(el);
      // Poll rather than sleep once. A single 350 ms check was long enough for
      // a widget and far too short for a page transition: clicking Continue on
      // Indeed's application moved to the next step and still reported
      // "nothing changed", because the new document had not landed yet. A
      // false "nothing happened" is its own harm - it sends you hunting a bug
      // that is not there, which is the mirror of the problem this was added
      // to solve.
      let changed = false;
      for (let waited = 0; waited < 1600; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (pageSignature() !== before) {
          changed = true;
          break;
        }
      }
      return { ok: true, action: "click", label, checked: el.checked, changed };
    }
    if (action === "type") {
      const scopeRoot = command.scope ? findBlockByText(command.scope) : focusedBlockRoot;
      const el = findField(command.selector, command.name, scopeRoot);
      if (!el) {
        return {
          ok: false,
          error: "no_field",
          message: "Click a text field first, then tell me what to type.",
        };
      }
      if (fieldBlocked(el)) {
        return {
          ok: false,
          error: "blocked_field",
          message: "I will not type into a password or payment field.",
        };
      }
      const trusted = Boolean(command.trusted);
      await typeInto(el, String(command.text || ""), { trusted, html: command.html || "" });
      return { ok: true, action: "type", trusted, value: String(el.value || "").slice(0, 120) };
    }
    if (action === "query") {
      // **Read any part of the DOM by selector, with values intact.**
      //
      // Added 2026-09-15 to close four gaps that were all the same gap. On one
      // day: `list_clickable` could not see a modal's buttons that `describe`
      // could, so a client's posts went unscheduled against a wall that was not
      // there; `debug_form` truncates every value at ~200 characters, so a live
      // product description could not be read back before overwriting it; and
      // there was no way to enumerate links at all, so finding a job
      // application URL was done by web search instead of by reading the page.
      //
      // **Deliberately NOT an `eval` action, which is what was first asked for.**
      // This extension drives a browser signed into Gmail, PayPal, Payhip,
      // TikTok and a client's Buffer. Arbitrary page-context JavaScript there
      // can read session tokens and mail bodies, and the instruction to run it
      // can arrive from anywhere upstream. A selector plus a fixed set of
      // returned properties does every job the four gaps actually needed, and
      // cannot be talked into exfiltrating a cookie. `describe` already carries
      // the same reasoning for HTML: values on a signed-in page can carry
      // things that must never leave it.
      const selector = String(command.selector || "").trim();
      if (!selector) {
        return { ok: false, error: "missing_selector",
                 message: "Tell me what to query, like a CSS selector." };
      }
      let found;
      try {
        found = document.querySelectorAll(selector);
      } catch (error) {
        return { ok: false, error: "bad_selector",
                 message: String(error && error.message || error).slice(0, 200) };
      }
      const limit = Math.max(1, Math.min(500, Number(command.limit) || 100));
      const cap = Math.max(40, Math.min(8000, Number(command.value_limit) || 2000));
      const rows = [];
      let index = 0;
      for (const el of found) {
        if (rows.length >= limit) break;
        index += 1;
        if (command.visible_only && !visible(el)) continue;
        const name = el.getAttribute ? (el.getAttribute("name") || "") : "";
        const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
        const row = {
          nth: index,
          tag: el.tagName,
          text: normalize(el.innerText || el.textContent || "").slice(0, 300),
          visible: visible(el),
        };
        const id = el.getAttribute && el.getAttribute("id");
        if (id) row.id = String(id).slice(0, 120);
        if (name) row.name = String(name).slice(0, 120);
        if (type) row.type = type;
        const cls = el.getAttribute && el.getAttribute("class");
        if (cls) row.className = String(cls).slice(0, 160);
        if (el.href) row.href = String(el.href).slice(0, 600);
        if (el.getAttribute && el.getAttribute("aria-label")) {
          row.ariaLabel = String(el.getAttribute("aria-label")).slice(0, 160);
        }
        if (typeof el.checked === "boolean") row.checked = el.checked;
        if (typeof el.disabled === "boolean") row.disabled = el.disabled;

        // The value, in full up to the cap - this is the whole point, since
        // `debug_form` cuts at ~200 and that is what made a safe restore
        // impossible. Secrets never come back, whatever the selector asked for.
        let value = null;
        if (el.isContentEditable) value = el.innerText || "";
        else if (typeof el.value === "string") value = el.value;
        if (value !== null) {
          if (type === "password" || PASSWORD_FIELD.test(name) ||
              PASSWORD_FIELD.test(String(el.getAttribute && el.getAttribute("autocomplete") || ""))) {
            row.value = "[redacted]";
            row.redacted = true;
          } else {
            row.value = String(value).slice(0, cap);
            row.value_truncated = String(value).length > cap;
            row.value_length = String(value).length;
          }
        }
        rows.push(row);
      }
      return {
        ok: true,
        action: "query",
        selector: selector,
        matched: found.length,
        returned: rows.length,
        truncated: found.length > rows.length,
        items: rows,
      };
    }
    if (action === "list_clickable") {
      // **Show the indices `findClickable` actually uses.**
      //
      // `nth` was unusable because the only way to count rows was the snapshot,
      // which enumerates SNAPSHOT_CLICKABLE_SEL - a much narrower set than the
      // CLICKABLE_SEL that findClickable walks. "The 16th More options" meant
      // two different elements depending on who counted, so an archive aimed at
      // one row reported success and did nothing.
      //
      // This counts the same way the clicker does, and carries the surrounding
      // row text so identical labels can still be told apart - six Linktree
      // placeholders all read "Check out my digital product", and position is
      // the only thing that distinguishes them.
      const want = normalize(command.text || "").toLowerCase();
      const items = [];
      let index = 0;
      for (const el of document.querySelectorAll(CLICKABLE_SEL)) {
        if (!visible(el) && !isListChoice(el)) continue;
        const label = labelOf(el);
        if (!label) continue;
        // Count EXACTLY as findClickable's `nth` does: when a label is given it
        // counts only the elements carrying that label, so the number returned
        // here is the number that can be handed straight back as `nth`. Getting
        // this off by even one aims a destructive click at the wrong row.
        if (want && label.toLowerCase() !== want) continue;
        index += 1;
        let context = "";
        let node = el.parentElement;
        for (let up = 0; up < 5 && node; up += 1) {
          const text = normalize(node.innerText || "");
          if (text.length > context.length) context = text;
          if (context.length > 60) break;
          node = node.parentElement;
        }
        items.push({ nth: index, label: label.slice(0, 60),
                     context: context.slice(0, 90) });
      }
      return { ok: true, action, count: items.length, items: items.slice(0, 60) };
    }

    if (action === "menu_click") {
      // **Open a menu and click inside it, without letting go.**
      //
      // Added 2026-09-14. Every desk command is a separate message, and a
      // dropdown closes the moment focus leaves it - so "click More options"
      // then "click Archive" could never work: by the time the second command
      // arrived the menu was gone, and the only Archive left in the DOM was
      // Linktree's sidebar nav link. Four routes failed that way, each looking
      // like a successful click that did nothing.
      //
      // Doing both halves in one page-context call is the whole point. The
      // menu never loses focus because nothing happens in between.
      // Scope the trigger by hand. `findClickable` has no root parameter, and
      // "More options" appears once per row - eighteen times on Linktree - so
      // without scoping the first row always wins.
      // Find the trigger by walking UP from each candidate until an ancestor
      // contains the row's own text.
      //
      // `findBlockByText` cannot do this on Linktree - its rows are not the
      // block shape that function looks for, so every scoped call came back
      // empty. Positional `nth` is no better: the snapshot counts over
      // SNAPSHOT_CLICKABLE_SEL and `findClickable` counts over the much wider
      // CLICKABLE_SEL, so "the 16th More options" means two different elements
      // depending on who is counting - which is why one archive reported
      // success and archived nothing.
      //
      // The row that contains the title IS the row, so ask that directly.
      const scopeText = normalize(command.scope || "").toLowerCase();
      let trigger = null;
      if (scopeText) {
        const want = normalize(command.text || "").toLowerCase();
        for (const el of document.querySelectorAll(CLICKABLE_SEL)) {
          if (!visible(el)) continue;
          if (labelOf(el).toLowerCase() !== want) continue;
          // Climb a bounded number of levels - far enough to clear the row,
          // never so far it reaches a container holding every link.
          let node = el.parentElement;
          for (let up = 0; up < 6 && node; up += 1) {
            const text = normalize(node.innerText || "").toLowerCase();
            if (text.includes(scopeText)) { trigger = el; break; }
            node = node.parentElement;
          }
          if (trigger) break;
        }
      }
      // **A scoped request that cannot find its scope must FAIL, not guess.**
      // 2026-09-14: the first version fell back to an unscoped search when the
      // scope lookup came up empty. "More options" appears once per row, so the
      // fallback opened row one's menu and archived "What Should I Automate
      // First?" - the user's free lead magnet - while the command said
      // `scope: "My Website"`. It reported ok:true. Archive being reversible is
      // the only reason that cost nothing.
      //
      // Asking for a specific row and silently acting on a different one is
      // worse than doing nothing, so there is no fallback when scope is given.
      if (!trigger && command.scope) {
        return { ok: false, error: "scope_not_found",
                 message: `Could not find "${command.text}" inside `
                          + `"${command.scope}". Refusing to act on a `
                          + `different row.` };
      }
      if (!trigger) {
        trigger = findClickable(command.text, command.selector,
                                Boolean(command.exact), command.nth);
      }
      if (!trigger) {
        return { ok: false, error: "not_found",
                 message: `No menu trigger ${command.text || command.selector}.` };
      }
      // **Record what was VISIBLE, not what existed.** A dropdown is usually
      // already in the DOM and merely hidden, so a set built from
      // querySelectorAll marks the menu item as pre-existing and the "did this
      // appear because of my click" test fails. It then falls through to the
      // nav link that shares the label, reports ok:true, and does nothing -
      // which is exactly what happened twice on Linktree's Archive.
      const before = new Set(
        Array.from(document.querySelectorAll(CLICKABLE_SEL)).filter(visible)
      );
      clickElement(trigger);
      await new Promise((resolve) => setTimeout(resolve, Number(command.wait) || 700));

      const wanted = normalize(command.item || "").toLowerCase();
      if (!wanted) {
        return { ok: true, action, opened: true,
                 message: "Menu opened; no item asked for." };
      }
      // Prefer something that appeared BECAUSE of the click. A portal-rendered
      // menu item is new to the DOM; the nav link that shares its label is not.
      const fresh = [];
      const stale = [];
      for (const el of document.querySelectorAll(CLICKABLE_SEL)) {
        if (!visible(el)) continue;
        if (labelOf(el).toLowerCase() !== wanted) continue;
        (before.has(el) ? stale : fresh).push(el);
      }
      const pick = fresh[0] || stale[stale.length - 1] || null;
      if (!pick) {
        return { ok: false, error: "no_item",
                 message: `Menu opened but no item called ${command.item}.` };
      }
      const label = labelOf(pick);
      if (clickBlocked(label)) {
        return { ok: false, error: "blocked_click",
                 message: "I stopped. That looks like send, pay, or post.",
                 label };
      }
      const sig = pageSignature();
      clickElement(pick);
      let moved = false;
      for (let waited = 0; waited < 1600; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (pageSignature() !== sig) { moved = true; break; }
      }
      return { ok: true, action, item: label, fromMenu: Boolean(fresh.length),
               changed: moved };
    }

    if (action === "drag") {
      if (!editHostAllowed(location.href)) {
        return { ok: false, error: "blocked_host", message: "Drag is not enabled on this site." };
      }
      const from = findClickable(command.from || command.source || "", command.fromSelector);
      const to = findClickable(command.to || command.target || "", command.toSelector);
      if (!from) {
        return { ok: false, error: "not_found", message: "I could not find what to drag." };
      }
      if (!to) {
        return { ok: false, error: "not_found", message: "I could not find where to drop it." };
      }
      if (clickBlocked(labelOf(from)) || clickBlocked(labelOf(to))) {
        return {
          ok: false,
          error: "blocked_click",
          message: "That target looks like send, pay, or post.",
        };
      }
      await dragElement(from, to);
      return {
        ok: true,
        message: "Dragged " + labelOf(from) + " onto " + labelOf(to) + ".",
      };
    }
    if (action === "press" || action === "press_key") {
      // Press a key on the focused element, in-page.
      //
      // 2026-09-13: the original three-line version dispatched only keydown
      // and keyup, with `key` and nothing else. That is not enough for a modern
      // interface. React reads `keyCode`/`which`, many editors listen for
      // `keypress` rather than keydown, and an event without `composed` never
      // leaves a shadow root - so Grok Imagine's composer ignored it and there
      // was no way to submit a prompt at all. Its send control is an unlabelled
      // icon, so clicking was not an option either.
      //
      // In-page dispatch, never OS-level: the standing rule is drive pages
      // in-page and never SendKeys or AppActivate, and this keeps it.
      const named = {
        enter: { key: "Enter", code: "Enter", keyCode: 13 },
        escape: { key: "Escape", code: "Escape", keyCode: 27 },
        tab: { key: "Tab", code: "Tab", keyCode: 9 },
        arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
        arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      };
      const wanted = String(command.key || "enter").toLowerCase();
      const spec = named[wanted];
      if (!spec) {
        return {
          ok: false,
          error: "unknown_key",
          message: "I can press " + Object.keys(named).join(", ") + ".",
        };
      }
      let target = null;
      if (command.selector || command.name) {
        target = findField(command.selector, command.name, null);
      }
      if (!target) {
        target = document.activeElement;
      }
      if (!target || target === document.body) {
        return {
          ok: false,
          error: "no_field",
          message: "Nothing is focused. Click or type into a field first.",
        };
      }
      if (fieldBlocked(target)) {
        return {
          ok: false,
          error: "blocked_field",
          message: "I will not press keys in a password or payment field.",
        };
      }
      const readOf = (el) => String(el.value || el.textContent || "").slice(0, 80);
      const before = readOf(target);
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: Boolean(command.shift),
        ctrlKey: Boolean(command.ctrl),
        metaKey: Boolean(command.meta),
        which: spec.keyCode,
        ...spec,
      };
      try {
        target.focus();
      } catch (error) {
        // Some custom elements refuse focus; the events still dispatch.
      }
      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keypress", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return {
        ok: true,
        action,
        key: spec.key,
        on: String(target.tagName || "?").toLowerCase(),
        // A submitted box usually empties. Reporting it lets the caller tell
        // "the key did something" from "the key went nowhere".
        changed: before !== readOf(target),
      };
    }
    if (action === "scroll") {
      window.scrollBy({ top: Number(command.dy) || 700, left: 0, behavior: "smooth" });
      return { ok: true, action: "scroll" };
    }
    return { ok: false, error: "unknown_action" };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "TECH_CONTROL") {
      return;
    }
    Promise.resolve(handleControl(message.command || {}))
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  });

  // Control has to reach every frame - that is the whole point of 1.5.0, since
  // application forms live in iframes. Watch must not. It reports what the user is
  // looking at, and that is the top document: with all_frames on, every ad
  // iframe and every embedded player would start posting a video snapshot every
  // four seconds, on a 7.6 GB machine, and an advert is not what he is
  // watching. The message listener above is registered in all frames; only the
  // poll is confined to the top one.
  if (window.top === window) {
    setInterval(tick, POLL_INTERVAL_MS);
    tick();
  }
})();
