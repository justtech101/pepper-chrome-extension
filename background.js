const JARVIS_ENDPOINT = "http://127.0.0.1:8766/browser-watch";
const CONTROL_ROOT = "http://127.0.0.1:8766/control";
const MIN_SECONDS_BETWEEN_SENDS = 5;
const FRAME_MAX_WIDTH = 640;
const FRAME_JPEG_QUALITY = 0.5;
// Deliberately a literal, not chrome.runtime.getManifest().version. A content
// script still running in an already-open tab reports the version it was built
// with, and `result.version === EXT_VERSION` is what spots it and re-injects.
// Read both sides from the manifest at runtime and they always agree, so that
// check silently stops finding anything.
//
// It does have to be bumped by hand, and on 2026-09-02 it was not: it sat at
// "1.15.0" through 1.15.1. The guard against that is the desk hashing these
// files - build_id answers `version` from here and `known` from disk, and the
// two disagreeing is how a stale extension gets caught. A test now pins this
// string to manifest.json so the drift cannot repeat quietly.
const EXT_VERSION = "1.47.8";

// v1.40.0 — Every profile gets a stable id and sends it when pairing, so the
// desk can tell two Chromes apart. Before this, `pair` was anonymous: the user's
// everyday Chrome and PEPPER's own profile both ran this extension, both sat
// on one shared command queue, and whichever polled first took the command.
// The loser's tab ids went stale with no error anywhere. The desk now holds
// for one profile and answers a second with `desk_busy`, which is handled
// below by backing off quietly instead of hammering the pair endpoint.
// v1.16.0 — close_tab so Pepper can tidy the tabs she opens, and
// reload_extension so she can load her own fixes without a chrome:// click.
// v1.15.0 — Custom listbox options (role=option) + set_file via DataTransfer +
// focus_url so an open form tab can be bound without reloading (go wiped Dub).
// v1.5.0 — Reaches inside iframes. Job application forms are almost never
// in the top document: Indeed's Easily-apply questions, and Greenhouse and
// Lever boards embedded on an employer's careers page, all live in a frame.
// v1.4.0 — Watch and control are always on. No off toggles.
let controlSession = "";
let lastSentEpoch = 0;
let polling = false;
let pairing = false;
let bridgeUp = false;
let profileId = "";
let profileLabel = "";
let deskBusy = "";

// A stable name for THIS Chrome profile.
//
// chrome.storage.local is per-profile, so a value written here is exactly what
// is needed: it survives extension reloads and browser restarts, and PEPPER's
// profile and the user's everyday profile get different ones automatically. The
// extension genuinely cannot see its own user-data-dir, so the default label
// is derived from the id and is meant to be recognisable rather than
// meaningful - `pepper_profile.ps1 -Status` prints whichever id holds the desk
// so the two can be told apart.
async function ensureProfileIdentity() {
  const stored = await chrome.storage.local.get(["profileId", "profileLabel"]);
  profileId = stored.profileId || "";
  profileLabel = stored.profileLabel || "";
  if (!profileId) {
    profileId =
      (globalThis.crypto && crypto.randomUUID && crypto.randomUUID()) ||
      `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await chrome.storage.local.set({ profileId });
  }
  if (!profileLabel) {
    profileLabel = `chrome-${profileId.replace(/[^a-z0-9]/gi, "").slice(0, 4)}`;
    await chrome.storage.local.set({ profileLabel });
  }
  return profileId;
}

function updateBadge() {
  if (controlSession && polling) {
    chrome.action.setBadgeText({ text: "P" });
    chrome.action.setBadgeBackgroundColor({ color: "#e8461a" });
    return;
  }
  if (deskBusy) {
    // Another Chrome owns the desk. Distinct from "…" (desk down) on purpose:
    // this one is fixed by disabling the extension in the other window, not by
    // starting the desk.
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#b0870a" });
    return;
  }
  chrome.action.setBadgeText({ text: "…" });
  chrome.action.setBadgeBackgroundColor({ color: "#2d89ff" });
}

async function forceAlwaysOnFlags() {
  await chrome.storage.local.set({
    watching: true,
    controlling: true,
    controlAlwaysOn: true,
  });
}

async function boot() {
  await forceAlwaysOnFlags();
  await ensureProfileIdentity();
  const result = await chrome.storage.local.get(["controlSession"]);
  controlSession = result.controlSession || "";
  updateBadge();
  await ensurePaired();
}

boot();

chrome.runtime.onInstalled.addListener(() => {
  forceAlwaysOnFlags().then(() => ensurePaired());
});

chrome.runtime.onStartup.addListener(() => {
  forceAlwaysOnFlags().then(() => ensurePaired());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  // Refuse any attempt to turn watch/control off.
  const patch = {};
  if ("watching" in changes && changes.watching.newValue !== true) {
    patch.watching = true;
  }
  if ("controlling" in changes && changes.controlling.newValue !== true) {
    patch.controlling = true;
  }
  if ("controlAlwaysOn" in changes && changes.controlAlwaysOn.newValue !== true) {
    patch.controlAlwaysOn = true;
  }
  if ("controlSession" in changes) {
    controlSession = changes.controlSession.newValue || "";
  }
  if (Object.keys(patch).length) {
    chrome.storage.local.set(patch);
  }
  updateBadge();
  if (controlSession) {
    startPoll();
  }
});

// This alarm is the only thing that revives the service worker after Chrome
// stops it, so it is the whole of the pairing story on a quiet machine.
//
// Two bugs lived here. First, 0.25 minutes is 15 s, which is below the minimum
// period Chrome honours - it was silently clamped, so the real revival gap was
// never the 15 s this claimed. Ask for a period Chrome will actually keep.
//
// Second, this ran at the top level of the service worker, and `create` with an
// existing name *replaces* that alarm and restarts its countdown. Every worker
// startup therefore pushed the next fire a full period into the future; on a
// machine where the worker starts and dies repeatedly, the alarm that is meant
// to revive it could be perpetually deferred and never fire at all. Only create
// it when it is missing.
const CONTROL_ALARM = "pepper-control";
const CONTROL_ALARM_MINUTES = 0.5;

chrome.alarms.get(CONTROL_ALARM, (existing) => {
  if (!existing) {
    chrome.alarms.create(CONTROL_ALARM, { periodInMinutes: CONTROL_ALARM_MINUTES });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONTROL_ALARM) {
    return;
  }
  ensurePaired();
});

chrome.tabs.onActivated.addListener(async () => {
  const tab = await activeTab();
  if (tab && tab.id !== undefined && !isRestrictedUrl(tab.url)) {
    ensureContentScript(tab.id);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || isRestrictedUrl(tab.url)) {
    return;
  }
  if (tab.active) {
    ensureContentScript(tabId);
    return;
  }
  // Her own work tab, which is deliberately never active so it cannot steal
  // focus. Injecting only into active tabs meant that after every navigation
  // her tab had no content script at all: `snapshot` came back with no text
  // and no url, `own_window` appeared to "fix" reading only because moving
  // her into her own window made her tab the active one there, and a whole
  // session was spent treating unreadable pages as broken sites.
  //
  // She has to be able to read the page she is standing on whether or not
  // anyone is looking at it. Fixed 2026-09-09.
  const everything = await chrome.storage.local.get(null);
  for (const key of await allPepperTabKeys()) {
    if (everything[key] === tabId) {
      ensureContentScript(tabId);
      break;
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "JARVIS_VIDEO_SNAPSHOT") {
    // Watch is always on — accept snapshots from any active tab.
    if (!sender.tab || !sender.tab.active || sender.tab.windowId === undefined) {
      return;
    }
    sendSnapshot(message.snapshot, sender.tab.windowId);
    return;
  }
  if (message?.type === "PEPPER_STATUS" || message?.type === "TECH_CONTROL_STATUS") {
    sendResponse({
      ok: true,
      watching: true,
      controlling: true,
      controlAlwaysOn: true,
      paired: Boolean(controlSession),
      profile_id: profileId,
      profile_label: profileLabel,
      desk_busy: deskBusy,
      bridgeUp,
      version: EXT_VERSION,
    });
    return;
  }
  if (
    message?.type === "PEPPER_RECONNECT"
    || message?.type === "TECH_SET_CONTROL"
  ) {
    // Ignore any request to turn control off — always re-pair.
    forceAlwaysOnFlags()
      .then(() => ensurePaired(true))
      .then((paired) =>
        sendResponse({
          ok: true,
          paired,
          controlAlwaysOn: true,
          version: EXT_VERSION,
        })
      )
      .catch((error) =>
        sendResponse({ ok: false, error: String(error.message || error) })
      );
    return true;
  }
});

async function ensurePaired(force = false) {
  if (pairing) {
    return Boolean(controlSession);
  }
  if (!force && controlSession && polling) {
    return true;
  }
  pairing = true;
  updateBadge();
  try {
    if (!profileId) {
      await ensureProfileIdentity();
    }
    const response = await fetch(`${CONTROL_ROOT}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_id: profileId,
        profile_label: profileLabel,
      }),
    });
    const data = await response.json();
    bridgeUp = true;
    if (data.error === "desk_busy") {
      // Do not retry in a tight loop. The other Chrome is healthy and polling;
      // hammering /pair would just add noise to a desk that is working fine.
      deskBusy =
        data.message ||
        `Another Chrome (${data.holder_label || "unknown"}) owns the desk.`;
      controlSession = "";
      await chrome.storage.local.set({ controlSession: "" });
      return false;
    }
    deskBusy = "";
    if (!data.ok || !data.session) {
      return false;
    }
    controlSession = data.session;
    await chrome.storage.local.set({
      watching: true,
      controlling: true,
      controlAlwaysOn: true,
      controlSession: data.session,
    });
    updateBadge();
    startPoll();
    return true;
  } catch (error) {
    bridgeUp = false;
    return false;
  } finally {
    pairing = false;
    updateBadge();
  }
}

async function startPoll() {
  if (polling || !controlSession) {
    return;
  }
  polling = true;
  updateBadge();
  while (controlSession) {
    try {
      const response = await fetch(
        `${CONTROL_ROOT}/poll?session=${encodeURIComponent(controlSession)}`
      );
      const data = await response.json();
      bridgeUp = true;
      if (maybeReload(data)) {
        return;
      }
      if (data.error === "bad_session") {
        controlSession = "";
        await chrome.storage.local.set({ controlSession: "" });
        polling = false;
        await ensurePaired(true);
        return;
      }
      if (data.command) {
        const result = await runCommand(data.command);
        await fetch(`${CONTROL_ROOT}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session: controlSession,
            id: data.command.id,
            ...result,
          }),
        });
      }
    } catch (error) {
      bridgeUp = false;
      await sleep(1200);
      try {
        const status = await fetch(`${CONTROL_ROOT}/status`);
        const body = await status.json();
        bridgeUp = true;
        if (!body.paired) {
          polling = false;
          await ensurePaired(true);
          return;
        }
      } catch (statusError) {
        // desk still down — keep looping
      }
    }
  }
  polling = false;
  updateBadge();
  await ensurePaired(true);
}

// Reload myself when the files on disk have moved ahead of what is running.
//
// `chrome.runtime.reload()` re-reads an unpacked extension from disk, so this
// is a thing the extension can do for itself. The alternative was asking the user
// to Remove and Load unpacked every time a line changed - six times in one
// afternoon, and twice Chrome silently served a cached build whose folder on
// disk read a newer number, so a round of live testing ran against code that
// was never loaded.
//
// Guarded three ways, because a reload loop would be worse than the problem:
// only on a version that is present and genuinely different, only once per
// service-worker life, and never within 30 seconds of starting up.
let reloading = false;
let knownBuild = "";
const bootedAt = Date.now();

function maybeReload(data) {
  const expected = String((data && data.expected_version) || "");
  // The desk sends `version+digest`, where the digest is a hash of the scripts
  // themselves. Comparing only the manifest number let a build ship without a
  // bump and pretend to be its predecessor - which is exactly how the first
  // version of this feature ended up installed and inert. The number before
  // the `+` is all this side can know about itself, so a bare match on that is
  // not enough: anything with a digest attached must be checked against what
  // was running when this worker started.
  if (!expected) {
    return false;
  }
  if (!knownBuild) {
    knownBuild = expected;
    return false;
  }
  if (expected === knownBuild) {
    return false;
  }
  if (reloading || Date.now() - bootedAt < 30000) {
    return false;
  }
  reloading = true;
  console.log(
    "PEPPER " + EXT_VERSION + " is behind " + expected + " on disk. Reloading."
  );
  try {
    chrome.runtime.reload();
  } catch (error) {
    reloading = false;
    return false;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

// Pepper's own tab.
//
// Every page command used to land on whatever tab the user happened to be looking
// at, so starting a job search took over the thing he was reading, mid-
// sentence. That is the difference between an assistant and an interruption.
//
// She gets her own tab instead, created in the background with `active: false`
// so it never steals focus, and she works in it while he uses the computer.
// `use_this_tab` binds her to his current tab for the times he does want her
// on the page in front of him, and `show_tab` brings hers forward when he
// wants to watch.
const WORK_TAB_KEY = "pepperWorkTabId";

// v1.46.0 - Named tabs. Until 2026-09-27 there was ONE work tab, shared by
// every caller: the scheduled Marketplace and Social Inbox passes navigated it
// back to Facebook every 10-15 minutes, so a job someone else was doing in it
// (publishing Etsy listings that morning) kept landing on Facebook. A command
// may now carry `tab: "<name>"`; each name gets its own tab. No name means
// "work", which is the old single tab under its old storage key, so every
// existing caller behaves exactly as before.
let currentTabName = "work";

function cleanTabName(value) {
  const name = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return name || "work";
}

function tabKey(name) {
  const clean = cleanTabName(name);
  return clean === "work" ? WORK_TAB_KEY : `pepperTab:${clean}`;
}

async function storedWorkTabId(name = currentTabName) {
  const key = tabKey(name);
  const row = await chrome.storage.local.get([key]);
  const value = row[key];
  return typeof value === "number" ? value : null;
}

async function setWorkTab(tabId, name = currentTabName) {
  await chrome.storage.local.set({
    [tabKey(name)]: typeof tabId === "number" ? tabId : null,
  });
}

// Every tab Pepper owns, by storage key - for the listeners below.
async function allPepperTabKeys() {
  const everything = await chrome.storage.local.get(null);
  return Object.keys(everything).filter(
    (key) => key === WORK_TAB_KEY || key.startsWith("pepperTab:"));
}

// One creation at a time per name: two commands arriving together used to each
// find no stored tab and each open their own.
const tabCreation = new Map();

async function workTab(create = true, name = currentTabName) {
  const key = tabKey(name);
  const previous = tabCreation.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => workTabUnlocked(create, name));
  tabCreation.set(key, run);
  return run;
}

async function workTabUnlocked(create, name) {
  const stored = await storedWorkTabId(name);
  if (stored !== null) {
    try {
      const tab = await chrome.tabs.get(stored);
      if (tab && tab.id !== undefined) {
        return tab;
      }
    } catch (error) {
      // He closed it. Fall through and make another rather than failing -
      // closing a tab is not a way of saying "stop working".
    }
  }
  if (!create) {
    return null;
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await setWorkTab(tab.id, name);
  return tab;
}

// If the user closes one of her tabs, forget it now rather than discovering it later.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const everything = await chrome.storage.local.get(null);
  const stale = {};
  for (const key of await allPepperTabKeys()) {
    if (everything[key] === tabId) {
      stale[key] = null;
    }
  }
  if (Object.keys(stale).length) {
    await chrome.storage.local.set(stale);
  }
});

function isRestrictedUrl(url) {
  const value = String(url || "");
  return (
    !value
    || value.startsWith("chrome://")
    || value.startsWith("chrome-extension://")
    || value.startsWith("devtools://")
    || value.startsWith("edge://")
    || value.startsWith("about:")
  );
}

async function waitTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return tab;
    }
    await sleep(200);
  }
  return chrome.tabs.get(tabId);
}

// The document the user thinks of as "the page". Job applications are almost
// never in it: Indeed's Easily-apply questions, and Greenhouse and Lever boards
// embedded on an employer's careers page, all render inside an iframe. Until
// 2026-08-25 the content script ran with `all_frames: false` and every command
// targeted this frame only, so Pepper could read the page *around* an
// application form and not one field inside it.
const TOP_FRAME = 0;
const MAX_FRAMES = 12;

async function pingContent(tabId, frameId = TOP_FRAME) {
  try {
    const result = await chrome.tabs.sendMessage(
      tabId,
      { type: "TECH_CONTROL", command: { action: "ping" } },
      { frameId }
    );
    if (!result || !result.ok) {
      return false;
    }
    // A stale content script answers a ping perfectly happily. Reloading the
    // extension swaps the service worker immediately but leaves the old script
    // running in every tab that was already open, so `ensureContentScript`
    // pinged, got a cheerful yes, and never re-injected - and a whole reload
    // silently did nothing to the tabs that mattered. Cost a live test on
    // 2026-08-26, where the new code was not under test at all and the old
    // behaviour looked like a bug in the new one.
    return result.version === EXT_VERSION;
  } catch (error) {
    return false;
  }
}

async function ensureContentScript(tabId) {
  if (await pingContent(tabId)) {
    return true;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"],
    });
  } catch (error) {
    return false;
  }
  await sleep(250);
  return pingContent(tabId);
}

// Frame discovery without a new permission: `scripting` is already granted, and
// executeScript with allFrames returns one InjectionResult per frame, each
// carrying its own frameId. Asking for `webNavigation` just to enumerate frames
// would widen the extension's permissions for something this already answers.
async function frameSummaries(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        url: location.href,
        fields: document.querySelectorAll(
          "input:not([type=hidden]):not([type=password]), select, textarea"
        ).length,
        buttons: document.querySelectorAll(
          'button, input[type=submit], [role="button"]'
        ).length,
      }),
    });
    return results
      .filter((row) => row && row.result)
      .map((row) => ({ frameId: row.frameId ?? TOP_FRAME, ...row.result }))
      .slice(0, MAX_FRAMES);
  } catch (error) {
    return [{ frameId: TOP_FRAME, url: "", fields: 0, buttons: 0 }];
  }
}

// Frames worth asking, most promising first. An ad or tracking iframe holds no
// fields and no buttons, and there are usually several of them; walking those
// before the one holding the application form is how a working click looks like
// a broken one.
async function candidateFrames(tabId) {
  const frames = await frameSummaries(tabId);
  const useful = frames.filter(
    (frame) => frame.frameId === TOP_FRAME || frame.fields > 0 || frame.buttons > 0
  );
  return useful.sort((a, b) => {
    if (a.frameId === TOP_FRAME) return -1;
    if (b.frameId === TOP_FRAME) return 1;
    return b.fields + b.buttons - (a.fields + a.buttons);
  });
}

// Whether a reply means "this frame does not hold the thing you asked for",
// as opposed to "this frame refused you". A refusal must stop the walk: if the
// top frame blocks a Submit, trying the next frame until one accepts is a way
// of shopping for a frame that will break the rule.
function missedTarget(page) {
  if (!page) return true;
  if (page.ok) return false;
  const blob = String(page.error || "") + " " + String(page.message || "");
  if (/blocked|refus|not_allowed/i.test(blob)) return false;
  return /no_field|not_found|no_button|no_match|illegal invocation/i.test(blob);
}

async function setFieldInPage(tabId, command) {
  const name = command.name || "";
  const selector = command.selector || "";
  const value = String(command.value ?? command.text ?? "");
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [name, selector, value],
      func: (fieldName, fieldSelector, fieldValue) => {
        function fire(el) {
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
        let el = null;
        if (fieldSelector) {
          el = document.querySelector(fieldSelector);
        }
        if (!el && fieldName) {
          el =
            document.getElementById(fieldName)
            || document.querySelector(`[name="${fieldName}"]`);
        }
        if (!el) {
          return { ok: false, error: "no_field" };
        }
        if (el.tagName === "SELECT") {
          const needle = String(fieldValue || "").trim().toLowerCase();
          let match = null;
          for (const opt of Array.from(el.options)) {
            const text = String(opt.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
            const val = String(opt.value || "").trim().toLowerCase();
            if (text === needle || val === needle) {
              match = opt;
              break;
            }
            if (!match && (text.includes(needle) || val.includes(needle))) {
              match = opt;
            }
          }
          if (!match) {
            return { ok: false, error: "not_found" };
          }
          el.value = match.value;
          fire(el);
          return { ok: true, action: "set", name: el.name || fieldName, value: el.value };
        }
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (type === "radio") {
          const radios = Array.from(
            document.querySelectorAll(`input[type="radio"][name="${el.name}"]`)
          );
          const needle = String(fieldValue || "").trim().toLowerCase();
          const hit =
            radios.find((r) => String(r.value || "").toLowerCase() === needle) || radios[0];
          if (!hit) {
            return { ok: false, error: "not_found" };
          }
          hit.checked = true;
          fire(hit);
          return { ok: true, action: "set", name: hit.name, value: hit.value, checked: true };
        }
        if (type === "checkbox") {
          const should = /^(1|y|yes|true|on|checked)$/i.test(String(fieldValue || "Y"));
          if (should !== Boolean(el.checked)) {
            el.click();
          }
          if (should && !el.checked) {
            el.checked = true;
            fire(el);
          }
          if (!should && el.checked) {
            el.checked = false;
            fire(el);
          }
          return {
            ok: true,
            action: "set",
            name: el.name || fieldName,
            value: el.value,
            checked: el.checked,
          };
        }
        el.focus();
        try {
          if (typeof el.select === "function") {
            el.select();
          }
          if (!document.execCommand("insertText", false, fieldValue)) {
            el.value = fieldValue;
          }
        } catch (error) {
          el.value = fieldValue;
        }
        fire(el);
        return {
          ok: true,
          action: "set",
          name: el.name || fieldName,
          value: String(el.value || "").slice(0, 120),
        };
      },
    });
    // Take the frame that actually found the field, not the first one back.
    // `injected[0]` is the top document, which on an Indeed or Greenhouse
    // application is precisely the frame the field is *not* in.
    const rows = Array.isArray(injected) ? injected : [];
    const hit = rows.find((row) => row && row.result && row.result.ok);
    if (hit) {
      return Object.assign({}, hit.result, { frameId: hit.frameId ?? TOP_FRAME });
    }
    const miss = rows.find((row) => row && row.result);
    return (miss && miss.result) || { ok: false, error: "inject_failed" };
  } catch (error) {
    return {
      ok: false,
      error: "cannot_control_this_page",
      message: String(error.message || error),
    };
  }
}

// One page, one snapshot, even when the form is three frames down. Fields and
// buttons carry the frame they came from so a later `set` or `click` can be
// aimed rather than guessed at.
async function snapshotAllFrames(tabId, command) {
  const frames = await candidateFrames(tabId);
  let merged = null;
  const fields = [];
  const buttons = [];
  const parts = [];

  for (const frame of frames) {
    let page = null;
    try {
      page = await chrome.tabs.sendMessage(
        tabId,
        { type: "TECH_CONTROL", command },
        { frameId: frame.frameId }
      );
    } catch (error) {
      continue;
    }
    if (!page || !page.ok) continue;
    if (!merged) {
      merged = Object.assign({}, page);
    }
    for (const field of page.fields || []) {
      fields.push(Object.assign({}, field, { frameId: frame.frameId }));
    }
    for (const button of page.buttons || []) {
      buttons.push(button);
    }
    if (frame.frameId !== TOP_FRAME && page.text) {
      parts.push("--- embedded form (" + (page.url || frame.url || "frame") + ") ---");
      parts.push(page.text);
    }
  }

  if (!merged) {
    return { ok: false, error: "no_content_script" };
  }
  merged.fields = fields.slice(0, 300);
  merged.buttons = buttons.slice(0, 200);
  merged.frames = frames.length;
  if (parts.length) {
    merged.text = [merged.text || ""].concat(parts).join("\n\n").slice(0, 16000);
  }
  return merged;
}

async function sendToPage(tabId, command) {
  if (!(await ensureContentScript(tabId))) {
    return {
      ok: false,
      error: "cannot_control_this_page",
      message: "Content script is not available on this tab.",
    };
  }
  try {
    if (command.action === "snapshot") {
      return await snapshotAllFrames(tabId, command);
    }

    // Top frame first: it is the common case and stays exactly as fast as it
    // was. Only when the top frame reports it could not find the target do we
    // pay for frame discovery and walk the iframes.
    let page = await chrome.tabs.sendMessage(
      tabId,
      { type: "TECH_CONTROL", command },
      { frameId: TOP_FRAME }
    );
    if (missedTarget(page)) {
      for (const frame of await candidateFrames(tabId)) {
        if (frame.frameId === TOP_FRAME) continue;
        let inner = null;
        try {
          inner = await chrome.tabs.sendMessage(
            tabId,
            { type: "TECH_CONTROL", command },
            { frameId: frame.frameId }
          );
        } catch (frameError) {
          continue;
        }
        if (!missedTarget(inner)) {
          // Say which frame answered. "I clicked Continue" and "I clicked
          // Continue inside the Greenhouse form embedded on this page" are
          // different claims, and only the second one is checkable.
          return Object.assign({}, inner, {
            frameId: frame.frameId,
            frameUrl: frame.url || "",
          });
        }
      }
    }
    if (
      command.action === "set"
      && page
      && page.ok === false
      && /illegal invocation|no_field|not_found/i.test(
        String(page.error || "") + " " + String(page.message || "")
      )
    ) {
      const fallback = await setFieldInPage(tabId, command);
      if (fallback && fallback.ok) {
        return fallback;
      }
    }
    return page || { ok: false, error: "no_content_script" };
  } catch (error) {
    if (command.action === "set") {
      const fallback = await setFieldInPage(tabId, command);
      if (fallback && fallback.ok) {
        return fallback;
      }
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await sleep(250);
      const page = await chrome.tabs.sendMessage(tabId, {
        type: "TECH_CONTROL",
        command,
      });
      return page || { ok: false, error: "no_content_script" };
    } catch (retryError) {
      return {
        ok: false,
        error: "cannot_control_this_page",
        message: String(retryError.message || retryError),
      };
    }
  }
}

async function runCommand(command) {
  const action = String(command.action || "");
  currentTabName = cleanTabName(command.tab);
  try {
    if (action === "tabs") {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        action,
        tabs: tabs.slice(0, 20).map((tab) => ({
          id: tab.id,
          title: tab.title || "",
          url: tab.url || "",
          active: Boolean(tab.active),
        })),
      };
    }
    if (action === "reload_extension") {
      // Added after finding the browser running 1.15.0 while the disk held
      // 1.16.0: two releases had been written and neither was ever live, and
      // nothing said so. Chrome re-reads an unpacked extension from disk on
      // runtime.reload(), so from here on Pepper can pick up her own fixes
      // instead of waiting on a click at chrome://extensions - a page she is
      // not allowed to touch.
      //
      // The reply has to go out first. reload() tears down this worker
      // immediately, so anything after it is never sent and the caller is
      // left unable to tell a reload from a crash.
      setTimeout(() => chrome.runtime.reload(), 400);
      return {
        ok: true,
        action,
        version: EXT_VERSION,
        message: "Reloading. Give me a few seconds, then check build_id - the version should have moved.",
      };
    }
    if (action === "close_tab") {
      // Housekeeping Pepper could not do at all before 1.16.0: she could open
      // tabs and never tidy them, so a long session left a row of duplicates
      // and the only way to clear them was the user doing it by hand.
      //
      // Two guardrails, both from things that actually went wrong:
      //
      // 1. Ids only, never "close everything". A close-all would be one bad
      //    match away from taking the window with it, and Chrome disappearing
      //    mid-task is exactly the surprise this session already suffered.
      // 2. Never take the last tab. Closing it closes the window, which ends
      //    the browser and Pepper's own control channel with it.
      const wanted = Array.isArray(command.ids)
        ? command.ids
        : (typeof command.id === "number" ? [command.id] : []);
      const ids = wanted.filter((id) => typeof id === "number");
      if (!ids.length) {
        return {
          ok: false,
          error: "no_ids",
          message: "Tell me which tab ids to close. I will not close tabs I was not given.",
        };
      }
      const open = await chrome.tabs.query({});
      const openIds = new Set(open.map((tab) => tab.id));
      const keepAtLeastOne = open.length - ids.filter((id) => openIds.has(id)).length < 1;
      if (keepAtLeastOne) {
        return {
          ok: false,
          error: "would_close_window",
          message: "That would close every tab, which closes Chrome and cuts my own connection. Leave one open.",
        };
      }
      const closed = [];
      const missing = [];
      for (const id of ids) {
        if (!openIds.has(id)) {
          missing.push(id);
          continue;
        }
        try {
          await chrome.tabs.remove(id);
          closed.push(id);
        } catch (error) {
          missing.push(id);
        }
      }
      // A dead work tab is how she ends up answering every command with
      // "cannot_control_this_page" while the page in front of the user is fine.
      const stored = await storedWorkTabId();
      if (stored !== null && closed.includes(stored)) {
        await setWorkTab(null);
      }
      return { ok: true, action, closed, missing };
    }
    if (action === "frames") {
      // The diagnostic for "she cannot see the form". Before 1.5.0 the only
      // symptom of an application living in an iframe was a page read that
      // came back describing the furniture around it.
      const tab = await workTab();
      if (!tab || tab.id === undefined || isRestrictedUrl(tab.url)) {
        return { ok: false, error: "cannot_control_this_page" };
      }
      return { ok: true, action, frames: await frameSummaries(tab.id) };
    }
    if (action === "new_tab") {
      // Background, always. A tab that jumps to the front is the behaviour
      // this whole change exists to stop.
      const tab = await chrome.tabs.create({
        url: command.url || "https://www.google.com/",
        active: false,
      });
      await setWorkTab(tab.id);
      await waitTabComplete(tab.id);
      await ensureContentScript(tab.id);
      return { ok: true, action, url: tab.url || command.url, title: tab.title || "" };
    }
    if (action === "use_this_tab") {
      // For when he does want her on the page in front of him.
      const his = await activeTab();
      if (!his || his.id === undefined) {
        return { ok: false, error: "no_tab" };
      }
      // Without this guard, a chrome:// or about: page in front of the user sent
      // ensureContentScript after a tab that can never host a content script,
      // and the command was collected and then never answered - 95 s of
      // silence reported as `extension_no_result`. Every other handler that
      // touches a tab already checks this; `focus_url` and `frames` are the
      // pattern. 2026-09-11: this cost a session's worth of browser work that
      // looked like a dead bridge while snapshot was answering in 0 s.
      if (isRestrictedUrl(his.url)) {
        return {
          ok: false,
          error: "restricted",
          message: "That tab is a browser page I cannot drive. Switch to a normal web page and ask again.",
        };
      }
      await setWorkTab(his.id);
      // Same honesty rule as focus_url: a bind that cannot be read is not a
      // success, and saying so here is what turns an unexplained empty
      // snapshot into an actionable "reload the tab".
      const mine = await ensureContentScript(his.id);
      if (!mine) {
        return {
          ok: false,
          error: "content_script_unavailable",
          bound: true,
          url: his.url || "",
          title: his.title || "",
          message: "Bound to that tab, but it has no content script so it cannot be read. Reload the tab and try again.",
        };
      }
      return { ok: true, action, url: his.url || "", title: his.title || "" };
    }
    if (action === "build_id") {
      // Answered by the *background*, so it reports what the service worker is
      // actually running - which the content script cannot, because it is
      // injected fresh from disk on every use and therefore always looks
      // current. Hours went into confusing those two on 2026-08-26.
      return { ok: true, action, version: EXT_VERSION, known: knownBuild };
    }
    if (action === "screenshot") {
      const mine = await workTab();
      if (!mine || mine.id === undefined) {
        return { ok: false, error: "no_tab" };
      }
      // Refuse unless her tab is the visible one in its own window.
      // `captureVisibleTab` photographs whatever is active in the window it is
      // given - so on a backgrounded work tab it would quietly hand back a
      // picture of whatever the user happens to be reading. That is the wrong
      // page and somebody else's business.
      if (!mine.active) {
        return {
          ok: false,
          error: "tab_not_visible",
          message:
            "My tab is in the background, and a screenshot there would "
            + "photograph whatever you are looking at instead. Say `work in a "
            + "window` and I will move to my own window, where I can be "
            + "photographed without touching yours.",
        };
      }
      // Chrome does not composite a fully occluded window, and refuses the
      // capture with "image readback failed". Her window opens behind the user's
      // by design, so that is the normal case rather than the exception.
      //
      // So: try as-is, and only if that fails raise her window, capture, and
      // put his back. Brief and visible, which is the honest trade - the
      // alternative is the `debugger` permission, which captures occluded tabs
      // but attaches a "Chrome is being debugged" banner to the browser for as
      // long as it is held.
      const shoot = async () =>
        chrome.tabs.captureVisibleTab(mine.windowId, { format: "png" });
      let image = "";
      let raised = false;
      try {
        image = await shoot();
      } catch (first) {
        const previous = await chrome.windows.getLastFocused({});
        try {
          await chrome.windows.update(mine.windowId, { focused: true });
          await sleep(220);
          image = await shoot();
          raised = true;
        } catch (second) {
          return {
            ok: false,
            error: "capture_failed",
            message: String(second.message || second),
          };
        } finally {
          if (previous && previous.id !== undefined && previous.id !== mine.windowId) {
            try {
              await chrome.windows.update(previous.id, { focused: true });
            } catch (restore) {
              // His window went away mid-capture. Nothing to put back.
            }
          }
        }
      }
      return {
        ok: true,
        action,
        image: await shrinkShot(image),
        raised,
        url: mine.url || "",
        title: mine.title || "",
      };
    }
    if (action === "own_window") {
      // Her own window, unfocused. This is what makes a screenshot possible
      // without stealing focus: her tab is the *active* tab of that window, so
      // it can be photographed, while the user's window keeps the foreground.
      const mine = await workTab();
      if (!mine || mine.id === undefined) {
        return { ok: false, error: "no_tab" };
      }
      const made = await chrome.windows.create({
        tabId: mine.id,
        focused: false,
        width: 1280,
        height: 900,
      });
      await setWorkTab(mine.id);
      return {
        ok: true,
        action,
        windowId: made && made.id,
        url: mine.url || "",
      };
    }
    if (action === "show_tab") {
      const mine = await workTab(currentTabName !== "work");
      if (!mine || mine.id === undefined) {
        return { ok: false, error: "no_tab", message: "I do not have a tab open yet." };
      }
      if (currentTabName !== "work") {
        // A named tab (the watchers' "watch" tab) must be RENDERED - Facebook
        // draws no inbox in a hidden tab - without ever taking the user's window.
        // So it lives alone in one window of its own, made once and reused,
        // and is activated there without focusing it. Never a new window per
        // call: that is what slowed the PC on 2026-09-09.
        let here = mine;
        const siblings = await chrome.tabs.query({ windowId: mine.windowId });
        if (siblings.length > 1) {
          const made = await chrome.windows.create({
            tabId: mine.id, focused: false, width: 1280, height: 900,
          });
          here = (made && made.tabs && made.tabs[0]) || mine;
        } else {
          await chrome.tabs.update(mine.id, { active: true });
        }
        return {
          ok: true, action, tab: currentTabName, background: true,
          url: here.url || "", title: here.title || "",
        };
      }
      await chrome.tabs.update(mine.id, { active: true });
      if (mine.windowId !== undefined) {
        await chrome.windows.update(mine.windowId, { focused: true });
      }
      return { ok: true, action, url: mine.url || "", title: mine.title || "" };
    }
    // Bind Pepper to an already-open tab whose URL contains the needle.
    // Never changes the URL — that was the Buffer partner form wipe.
    if (action === "focus_url") {
      const needle = String(command.url || command.text || "").trim().toLowerCase();
      if (!needle) {
        return { ok: false, error: "no_url", message: "focus_url needs a URL fragment to match." };
      }
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find((tab) => String(tab.url || "").toLowerCase().includes(needle));
      if (!hit || hit.id === undefined) {
        return {
          ok: false,
          error: "not_found",
          message: `No open tab matches ${needle}.`,
        };
      }
      if (isRestrictedUrl(hit.url)) {
        return { ok: false, error: "restricted", message: "That tab is a browser page I cannot drive." };
      }
      await setWorkTab(hit.id);
      const bring = command.activate !== false;
      if (bring) {
        await chrome.tabs.update(hit.id, { active: true });
        if (hit.windowId !== undefined) {
          await chrome.windows.update(hit.windowId, { focused: true });
        }
      }
      // The return value used to be discarded, and that is how binding
      // "succeeded" against a tab that could not be read: focus_url answered
      // ok:true with the URL and title taken from Chrome's tab record - not
      // from the page - and every snapshot after it came back empty with no
      // explanation. 2026-09-11: four tabs bound cleanly and read 0 chars
      // each, which looked like four broken sites instead of one missing
      // content script. The tab stays bound either way; the caller just has
      // to be told the page is not readable yet.
      const ready = await ensureContentScript(hit.id);
      if (!ready) {
        return {
          ok: false,
          error: "content_script_unavailable",
          bound: true,
          url: hit.url || "",
          title: hit.title || "",
          message: "Bound to that tab, but it has no content script so it cannot be read. Reload the tab and try again.",
        };
      }
      return {
        ok: true,
        action,
        url: hit.url || "",
        title: hit.title || "",
        tabId: hit.id,
      };
    }
    const tab = await workTab();
    if (!tab || tab.id === undefined) {
      return { ok: false, error: "no_tab", message: "I could not open a tab to work in." };
    }
    if (action === "real_click") {
      // A REAL mouse click (v1.47.0, 2026-09-27). Some buttons ignore the
      // synthetic events "click" dispatches: Facebook's Marketplace editor
      // took Pepper's text and her "Next" clicks, but its final "Update"
      // never fired, so every listing edit silently saved nothing. the user chose
      // to accept the cost: chrome.debugger shows Chrome's "started debugging
      // this browser" bar while attached. It is attached for ONE click and
      // detached in `finally`, every time.
      //
      // v1.47.1, same day - the first version located the button BEFORE
      // attaching, and the click still did not save. Cause: attaching
      // chrome.debugger pops that infobar, which docks above the page and
      // pushes the whole viewport down - a real resize, same as the
      // "controlled by automated software" bar. Coordinates measured before
      // attach are stale by the bar's height once it lands. Now: attach
      // FIRST, wait for the bar to settle, THEN locate (getBoundingClientRect
      // runs fresh, after the resize), THEN click. Top frame only:
      // coordinates from inside an iframe are relative to that frame and
      // would land somewhere else.
      const target = { tabId: tab.id };
      await chrome.debugger.attach(target, "1.3");
      try {
        // The bar's slide-in is a CSS transition; give it real time to finish
        // and the page's resize handler to run before trusting a rect.
        await sleep(400);
        const where = await sendToPage(tab.id, Object.assign({}, command, { action: "locate" }));
        if (!where || !where.ok) {
          return where || { ok: false, error: "not_found" };
        }
        if ((where.frameId !== undefined && where.frameId !== TOP_FRAME) || where.top === false) {
          return {
            ok: false,
            error: "iframe_target",
            message: "That button is inside an embedded frame; real_click only works on the main page.",
            label: where.label,
          };
        }
        const x = Math.round(where.x);
        const y = Math.round(where.y);
        let debugShot = "";
        if (command.debug_shot) {
          // One-off diagnostic (2026-09-27): confirm what the page actually
          // looks like, through the CDP session itself, at the exact instant
          // before the press - not a separate captureVisibleTab call, which
          // cannot see what changed while the debugger bar is up.
          try {
            const pic = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", { format: "png" });
            debugShot = pic && pic.data ? `data:image/png;base64,${pic.data}` : "";
          } catch (error) {
            debugShot = "";
          }
        }
        const mouse = (type, extra = {}) => chrome.debugger.sendCommand(
          target, "Input.dispatchMouseEvent",
          Object.assign({ type, x, y, button: "left", clickCount: 1 }, extra));
        await mouse("mouseMoved", { button: "none", clickCount: 0 });
        await sleep(30);
        await mouse("mousePressed", { buttons: 1 });
        await sleep(30);
        await mouse("mouseReleased", { buttons: 0 });
        return {
          ok: true, action, label: where.label, x, y, debugShot,
          hitIsTarget: where.hitIsTarget, hitTag: where.hitTag, hitLabel: where.hitLabel,
        };
      } finally {
        try {
          await chrome.debugger.detach(target);
        } catch (error) {
          // Already detached (tab closed or navigated away) - nothing to undo.
        }
      }
    }
    if (action === "real_type") {
      // REAL keyboard input (v1.47.4, 2026-09-28) through chrome.debugger:
      // Input.insertText for each line and a real Enter key between lines.
      // Google Sites' text boxes showed pasted/scripted text in the DOM and
      // then threw it away ("Click to edit text" again), the same way
      // Facebook's listing form kept its own copy. Browser-level input is the
      // only thing those editors record. Tab-scoped - never OS-level keys.
      //
      // Optional `selector`/`text`: real-click that target first to put the
      // caret there (same locate + guard as real_click). Otherwise it types
      // at the current caret. `value` is what gets typed.
      const target = { tabId: tab.id };
      const value = String(command.value || "");
      if (!value) {
        return { ok: false, error: "missing_text", message: "real_type needs a value." };
      }
      await chrome.debugger.attach(target, "1.3");
      try {
        await sleep(400);
        if (command.selector || command.text) {
          const where = await sendToPage(tab.id, Object.assign({}, command, { action: "locate" }));
          if (!where || !where.ok) {
            return where || { ok: false, error: "not_found" };
          }
          const x = Math.round(where.x);
          const y = Math.round(where.y);
          const mouse = (type, extra = {}) => chrome.debugger.sendCommand(
            target, "Input.dispatchMouseEvent",
            Object.assign({ type, x, y, button: "left", clickCount: 1 }, extra));
          await mouse("mouseMoved", { button: "none", clickCount: 0 });
          await mouse("mousePressed", { buttons: 1 });
          await sleep(30);
          await mouse("mouseReleased", { buttons: 0 });
          // 900 ms, not 300: on Google Sites the editor mounts on click, and
          // the first line typed at 300 ms went nowhere while the rest landed.
          await sleep(900);
        }
        const key = (type, extra = {}) => chrome.debugger.sendCommand(
          target, "Input.dispatchKeyEvent", Object.assign({ type }, extra));
        const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        if (command.replace) {
          // v1.47.5: clear what is there first - a real Ctrl+A then Backspace.
          // Typing at the caret otherwise lands INSIDE existing text: the
          // first test turned "Your page title" into "Your TEST123page title".
          const selA = { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 };
          await key("rawKeyDown", selA);
          await key("keyUp", selA);
          await sleep(60);
          const back = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
          await key("rawKeyDown", back);
          await key("keyUp", back);
          await sleep(80);
        }
        const lines = value.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          if (i > 0) {
            await key("rawKeyDown", enter);
            await key("char", Object.assign({ text: "\r" }, enter));
            await key("keyUp", enter);
            await sleep(40);
          }
          if (lines[i]) {
            // v1.47.7: one real key per character, not Input.insertText.
            // Google Sites kept the Enter presses across a reload but dropped
            // every insertText run - its editor records keystrokes, and a
            // bulk insert with no keydown never marked the box as changed.
            // `bulk: true` keeps the old fast path for editors that are fine
            // with it.
            if (command.bulk) {
              await chrome.debugger.sendCommand(target, "Input.insertText", { text: lines[i] });
            } else {
              for (const ch of lines[i]) {
                await key("keyDown", { text: ch, unmodifiedText: ch, key: ch });
                await key("keyUp", { key: ch });
              }
            }
            await sleep(40);
          }
        }
        if (command.commit) {
          // Leave the box the way a person does (Escape), so the editor
          // commits the edit instead of holding it as an open draft.
          const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
          await sleep(200);
          await key("rawKeyDown", esc);
          await key("keyUp", esc);
        }
        return { ok: true, action, lines: lines.length, chars: value.length };
      } finally {
        try {
          await chrome.debugger.detach(target);
        } catch (error) {
          // Already detached - nothing to undo.
        }
      }
    }
    if (action === "real_scroll") {
      // A real mouse-wheel scroll (v1.47.2, 2026-09-27). Twitch's panel
      // editor keeps its content in a div with its own overflow, and
      // window.scrollBy (the plain "scroll" action) moves the OUTER document
      // only - it did nothing there, same shape of problem as real_click:
      // Update needed the browser's own click, this needs the browser's own
      // wheel. Center-of-viewport by default; pass x/y to scroll a specific
      // panel. dy > 0 scrolls down, matching a real wheel.
      const target = { tabId: tab.id };
      const dy = Number(command.dy) || 600;
      const x = Number.isFinite(command.x) ? Math.round(command.x) : 640;
      const y = Number.isFinite(command.y) ? Math.round(command.y) : 400;
      await chrome.debugger.attach(target, "1.3");
      try {
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
          type: "mouseWheel", x, y, deltaX: 0, deltaY: dy,
        });
        return { ok: true, action, x, y, dy };
      } finally {
        try {
          await chrome.debugger.detach(target);
        } catch (error) {
          // Already detached - nothing to undo.
        }
      }
    }
    if (action === "navigate") {
      await chrome.tabs.update(tab.id, { url: command.url });
      await waitTabComplete(tab.id);
      await ensureContentScript(tab.id);
      return { ok: true, action, url: command.url };
    }
    if (action === "back") {
      await chrome.tabs.goBack(tab.id);
      await waitTabComplete(tab.id);
      await ensureContentScript(tab.id);
      return { ok: true, action };
    }
    if (action === "forward") {
      await chrome.tabs.goForward(tab.id);
      await waitTabComplete(tab.id);
      await ensureContentScript(tab.id);
      return { ok: true, action };
    }
    if (action === "reload") {
      await chrome.tabs.reload(tab.id);
      await waitTabComplete(tab.id);
      await ensureContentScript(tab.id);
      return { ok: true, action };
    }
    if (isRestrictedUrl(tab.url)) {
      return {
        ok: false,
        error: "cannot_control_this_page",
        message: "Chrome will not let me control that page (chrome:// and the store are blocked).",
      };
    }
    return await sendToPage(tab.id, command);
  } catch (error) {
    return {
      ok: false,
      error: "cannot_control_this_page",
      message: String(error.message || error),
    };
  }
}

// A screenshot is for reading a page, so it keeps far more detail than a watch
// frame - but not full size. A raw PNG of a 1280-wide window is megabytes of
// base64, which is what silently overran the desk's request cap and turned a
// working capture into a 20-second timeout blaming the extension.
async function shrinkShot(dataUrl, maxWidth = 1400, quality = 0.8) {
  try {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const reader = new FileReader();
    return await new Promise((resolve, reject) => {
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    // Better a big image than none.
    return dataUrl;
  }
}

async function downscaleFrame(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const scale = Math.min(1, FRAME_MAX_WIDTH / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, width, height);

  const outBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: FRAME_JPEG_QUALITY,
  });
  const buffer = await outBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

async function sendSnapshot(snapshot, windowId) {
  const now = Date.now() / 1000;
  if (now - lastSentEpoch < MIN_SECONDS_BETWEEN_SENDS) {
    return;
  }
  lastSentEpoch = now;

  let frame = "";
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 70,
    });
    frame = await downscaleFrame(dataUrl);
  } catch (error) {
    // Tab not visible/focused or capture rate-limited.
  }

  try {
    await fetch(JARVIS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, frame }),
    });
  } catch (error) {
    // Bridge not up.
  }
}
