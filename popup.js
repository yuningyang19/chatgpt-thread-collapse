(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    keepRecentCount: 6,
    autoCollapseComplex: true,
    extremeMemoryMode: false,
    debugMode: false,
    nearbyExpandCount: 12
  };

  const FALLBACK_MESSAGES = {
    popupTitle: "ChatGPT Thread Collapse",
    popupSubtitle: "Semi-virtualize and lazily restore old assistant messages to reduce long-thread lag.",
    enableExtension: "Enable extension",
    recentKeepCount: "Keep the latest assistant messages expanded",
    collapseComplex: "Prefer collapsing code/math-heavy old messages",
    extremeMemoryMode: "Extreme memory-saving mode (do not cache full nodes)",
    debugMode: "Developer debug mode",
    sessionControls: "Current thread controls",
    loadingPageState: "Reading current page state…",
    currentSummary: "assistant messages: {0}, collapsed: {1}, near viewport: {2}{3}.",
    extremeSummarySuffix: ", extreme memory-saving mode enabled",
    notChatgptTab: "No manageable ChatGPT conversation was detected in the current tab.",
    saveStatus: "Settings saved.",
    settingsAutoSave: "Settings are saved automatically.",
    expandNearby: "Expand nearby messages",
    expandAll: "Expand all collapsed messages in this thread",
    restorePrevious: "Restore previous collapsed view",
    recollapseOld: "Re-collapse old messages in this thread",
    resetSession: "Reset current thread state",
    unableReadPageState: "Unable to read the current page state. Make sure this tab is a ChatGPT page.",
    expandAllConfirm: "Expanding all will restore every collapsed assistant message in the current thread and may reintroduce a lot of DOM, which can hurt performance briefly. Continue?",
    resetSessionConfirm: "This will clear manual expand, lock, and collapsed records for the current thread. Continue?",
    cannotExpandExtreme: "Full restore is unavailable in extreme memory-saving mode."
  };

  const elements = {
    enabled: document.getElementById("enabled"),
    keepRecentCount: document.getElementById("keepRecentCount"),
    autoCollapseComplex: document.getElementById("autoCollapseComplex"),
    extremeMemoryMode: document.getElementById("extremeMemoryMode"),
    debugMode: document.getElementById("debugMode"),
    expandNearby: document.getElementById("expandNearby"),
    expandAll: document.getElementById("expandAll"),
    restorePreviousCollapsed: document.getElementById("restorePreviousCollapsed"),
    recollapseOld: document.getElementById("recollapseOld"),
    resetSession: document.getElementById("resetSession"),
    pageStateHint: document.getElementById("pageStateHint"),
    saveStatus: document.getElementById("saveStatus"),
    popupTitle: document.querySelector(".popup-header h1"),
    popupSubtitle: document.querySelector(".popup-header p"),
    sessionTitle: document.querySelector(".panel-title")
  };

  let currentPageState = null;

  init().catch((error) => {
    console.error("[ChatGPT Thread Lite] Popup init failed", error);
    elements.pageStateHint.textContent = t("unableReadPageState");
  });

  async function init() {
    applyI18n();
    const stored = await chrome.storage.local.get(["settings"]);
    const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
    renderSettings(settings);
    bindSettings();
    bindActions();
    await refreshPageState();
  }

  function applyI18n() {
    document.title = t("popupTitle");
    if (elements.popupTitle) {
      elements.popupTitle.textContent = t("popupTitle");
    }
    if (elements.popupSubtitle) {
      elements.popupSubtitle.textContent = t("popupSubtitle");
    }
    if (elements.sessionTitle) {
      elements.sessionTitle.textContent = t("sessionControls");
    }

    setLabelText("enabled", t("enableExtension"));
    setLabelText("keepRecentCount", t("recentKeepCount"));
    setLabelText("autoCollapseComplex", t("collapseComplex"));
    setLabelText("extremeMemoryMode", t("extremeMemoryMode"));
    setLabelText("debugMode", t("debugMode"));
    setButtonText("expandNearby", t("expandNearby"));
    setButtonText("expandAll", t("expandAll"));
    setButtonText("restorePreviousCollapsed", t("restorePrevious"));
    setButtonText("recollapseOld", t("recollapseOld"));
    setButtonText("resetSession", t("resetSession"));
    elements.pageStateHint.textContent = t("loadingPageState");
    elements.saveStatus.textContent = t("settingsAutoSave");
  }

  function setLabelText(controlId, text) {
    const input = elements[controlId];
    if (!input) {
      return;
    }
    const label = input.closest("label");
    const span = label ? label.querySelector("span") : null;
    if (span) {
      span.textContent = text;
    }
  }

  function setButtonText(buttonId, text) {
    const button = elements[buttonId];
    if (button) {
      button.textContent = text;
    }
  }

  function renderSettings(settings) {
    elements.enabled.checked = Boolean(settings.enabled);
    elements.keepRecentCount.value = String(settings.keepRecentCount);
    elements.autoCollapseComplex.checked = Boolean(settings.autoCollapseComplex);
    elements.extremeMemoryMode.checked = Boolean(settings.extremeMemoryMode);
    elements.debugMode.checked = Boolean(settings.debugMode);
  }

  function bindSettings() {
    const onChange = async () => {
      const nextSettings = {
        enabled: elements.enabled.checked,
        keepRecentCount: clampNumber(elements.keepRecentCount.value, 1, 50, DEFAULT_SETTINGS.keepRecentCount),
        autoCollapseComplex: elements.autoCollapseComplex.checked,
        extremeMemoryMode: elements.extremeMemoryMode.checked,
        debugMode: elements.debugMode.checked,
        nearbyExpandCount: DEFAULT_SETTINGS.nearbyExpandCount
      };

      await chrome.storage.local.set({ settings: nextSettings });
      elements.saveStatus.textContent = t("saveStatus");
      await notifyActiveTab({ type: "settingsUpdated" });
      await refreshPageState();
    };

    elements.enabled.addEventListener("change", onChange);
    elements.keepRecentCount.addEventListener("change", onChange);
    elements.autoCollapseComplex.addEventListener("change", onChange);
    elements.extremeMemoryMode.addEventListener("change", onChange);
    elements.debugMode.addEventListener("change", onChange);
  }

  function bindActions() {
    elements.expandNearby.addEventListener("click", () => runAction("expandNearby"));
    elements.expandAll.addEventListener("click", async () => {
      if (currentPageState && currentPageState.extremeMemoryMode) {
        elements.pageStateHint.textContent = t("cannotExpandExtreme");
        return;
      }

      const proceed = window.confirm(t("expandAllConfirm"));
      if (!proceed) {
        return;
      }
      await runAction("expandAll");
    });
    elements.restorePreviousCollapsed.addEventListener("click", () => runAction("restorePreviousCollapsed"));
    elements.recollapseOld.addEventListener("click", () => runAction("recollapseOld"));
    elements.resetSession.addEventListener("click", async () => {
      const proceed = window.confirm(t("resetSessionConfirm"));
      if (!proceed) {
        return;
      }
      await runAction("resetSession");
    });
  }

  async function runAction(action) {
    const response = await notifyActiveTab({ type: action });
    if (!response || response.ok === false) {
      elements.pageStateHint.textContent = response && response.message
        ? response.message
        : t("unableReadPageState");
      return;
    }
    if (response.message) {
      elements.pageStateHint.textContent = response.message;
    }
    await refreshPageState();
  }

  async function refreshPageState() {
    const pageState = await notifyActiveTab({ type: "getPageState" });
    currentPageState = pageState && pageState.ok !== false ? pageState : null;

    if (!currentPageState) {
      elements.pageStateHint.textContent = t("notChatgptTab");
      setActionAvailability(false);
      return;
    }

    const collapsedCount = currentPageState.collapsedCount || 0;
    const assistantCount = currentPageState.assistantCount || 0;
    const nearbyCount = currentPageState.nearbyCollapsedCount || 0;
    const extremeText = currentPageState.extremeMemoryMode ? t("extremeSummarySuffix") : "";
    elements.pageStateHint.textContent = formatMessage("currentSummary", [
      assistantCount,
      collapsedCount,
      nearbyCount,
      extremeText
    ]);

    setActionAvailability(true);
    elements.expandAll.disabled = Boolean(currentPageState.extremeMemoryMode);
    elements.restorePreviousCollapsed.disabled = !Boolean(currentPageState.hasPreviousCollapsedSnapshot);
    elements.expandNearby.disabled = nearbyCount === 0 || Boolean(currentPageState.extremeMemoryMode);
  }

  function setActionAvailability(enabled) {
    [
      elements.expandNearby,
      elements.expandAll,
      elements.restorePreviousCollapsed,
      elements.recollapseOld,
      elements.resetSession
    ].forEach((button) => {
      button.disabled = !enabled;
    });
  }

  async function notifyActiveTab(message) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      return null;
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      console.warn("[ChatGPT Thread Lite] Unable to message active tab", error);
      return null;
    }
  }

  function t(key) {
    return chrome.i18n.getMessage(key) || FALLBACK_MESSAGES[key] || key;
  }

  function formatMessage(key, substitutions) {
    const resolved = chrome.i18n.getMessage(key, substitutions);
    if (resolved) {
      return resolved;
    }
    let fallback = FALLBACK_MESSAGES[key] || key;
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(new RegExp(`\\{${index}\\}`, "g"), String(value));
    });
    return fallback;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  }
})();
