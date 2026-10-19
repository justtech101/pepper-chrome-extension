const watchPill = document.getElementById("watchPill");
const controlPill = document.getElementById("controlPill");
const reconnect = document.getElementById("reconnect");
const status = document.getElementById("status");

function setPill(el, live, label) {
  el.textContent = label;
  el.className = "pill " + (live ? "live" : "wait");
}

async function render() {
  const response = await chrome.runtime.sendMessage({ type: "PEPPER_STATUS" });
  const paired = Boolean(response && response.paired);
  const bridge = Boolean(response && response.bridgeUp);
  setPill(watchPill, true, "Watch always on");
  setPill(
    controlPill,
    paired,
    paired ? "Control paired" : bridge ? "Control reconnecting…" : "Desk offline"
  );
  if (response && response.error) {
    status.textContent = response.error;
    return;
  }
  if (paired) {
    status.textContent =
      "v1.5.0 — Watch and control stay on. Reads and fills forms inside iframes. Still cannot send, pay, post, or submit a job application.";
    return;
  }
  if (bridge) {
    status.textContent =
      "Pepper desk is up. Pairing… If this sticks, tap Reconnect or Reload the PEPPER extension.";
    return;
  }
  status.textContent =
    "Start the Pepper desk on this PC (bridge 127.0.0.1:8766). PEPPER will pair by itself.";
}

reconnect.addEventListener("click", async () => {
  reconnect.disabled = true;
  status.textContent = "Reconnecting…";
  await chrome.runtime.sendMessage({ type: "PEPPER_RECONNECT" });
  await new Promise((resolve) => setTimeout(resolve, 400));
  reconnect.disabled = false;
  await render();
});

render();
setInterval(render, 2000);
