(function () {
  "use strict";

  const EXTENSION_PREFIX = "cgpt-lite";
  const STORAGE_KEYS = {
    settings: "settings",
    sessionStates: "sessionStates"
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    keepRecentCount: 6,
    keepLatestOnly: true,
    autoCollapseComplex: true,
    extremeMemoryMode: false,
    debugMode: false,
    nearbyExpandCount: 12
  };

  const DEFAULT_SESSION_STATE = {
    lockedExpanded: {},
    manualExpanded: {},
    collapsed: {},
    lastBulkCollapsedSnapshot: []
  };

  const FALLBACK_MESSAGES = {
    assistantMessage: "Assistant message",
    expand: "Expand",
    collapse: "Collapse",
    collapsedMessage: "Message collapsed",
    lock: "Lock",
    locked: "Locked",
    permanentExpand: "Always keep this message expanded",
    restoreDefaultFold: "Restore default fold",
    collapsedHint: "Old message lightened",
    complexCollapsed: "Complex content lightened",
    clickToRestore: "Click to restore",
    noFullNodeCached: "No full node cached",
    expandAllHeader: "Expand all",
    collapseAllHeader: "Collapse all",
    expandAllPerfHint: "Expanding all may briefly affect performance.",
    extremeMemoryDisabledExpandAll: "Full restore is unavailable in extreme memory-saving mode.",
    extremeMemoryDisabledExpandNearby: "Nearby restore is unavailable in extreme memory-saving mode.",
    noCollapsedMessages: "There are no collapsed messages in the current thread.",
    noNearbyCollapsedMessages: "No collapsed messages were found near the current viewport.",
    sessionResetDone: "Current thread state has been reset.",
    noPreviousCollapsedView: "There is no previous collapsed view to restore.",
    restoredPreviousCollapsedView: "Restored the previous collapsed view.",
    recollapsedOldMessages: "Re-applied the current collapse strategy to old messages.",
    collapseAllToast: "Collapsed {0} messages.",
    expandNearbyToast: "Restored {0} messages near the viewport.",
    expandAllToast: "Restored {0} messages. You can revert with the previous collapsed view.",
    currentSummary: "assistant messages: {0}, collapsed: {1}, near viewport: {2}{3}.",
    extremeSummarySuffix: ", extreme memory-saving mode enabled",
    unableReadPageState: "Unable to read the current page state.",
    noChatgptConversation: "No manageable ChatGPT conversation was detected in the current tab.",
    restorePreviousCollapsed: "Restore previous collapsed view",
    settingsSaved: "Settings saved.",
    settingsAutoSave: "Settings are saved automatically.",
    expandNearby: "Expand nearby messages",
    expandAll: "Expand all collapsed messages in this thread",
    recollapseOld: "Re-collapse old messages in this thread",
    resetSession: "Reset current thread state"
  };

  function t(key, substitutions = []) {
    const localized = chrome.i18n.getMessage(key, substitutions);
    if (localized) {
      return localized;
    }
    let fallback = FALLBACK_MESSAGES[key] || key;
    substitutions.forEach((value, index) => {
      fallback = fallback.replace(new RegExp(`\\{${index}\\}`, "g"), String(value));
    });
    return fallback;
  }

  /*
   * All page-structure selectors stay here.
   * Keep them shallow and resilient; avoid deep utility classes.
   * Primary selectors target current ChatGPT conversation turns.
   * Fallback selectors cover older chat.openai.com layouts or future markup shifts.
   */
  const SELECTORS = {
    roots: {
      main: [
        "main",
        "[role='main']"
      ],
      conversation: [
        "main",
        "[data-testid='conversation-panel']",
        "[data-testid='conversation-panel-content']",
        ".overflow-y-auto"
      ]
    },
    header: {
      anchors: [
        "main header",
        "header",
        "[data-testid='conversation-header']",
        "[class*='sticky'][class*='top']"
      ]
    },
    messages: {
      turnCandidates: [
        "[data-message-author-role='assistant']",
        "[data-message-author-role='user']",
        "[data-message-id]",
        "article[data-testid^='conversation-turn-']",
        "[data-testid^='conversation-turn-']",
        "article",
        "[role='article']"
      ],
      assistantHints: [
        "[data-message-author-role='assistant']",
        "[data-testid*='assistant']",
        "[aria-label*='Assistant']",
        "[alt='ChatGPT']"
      ],
      userHints: [
        "[data-message-author-role='user']",
        "[data-testid*='user']",
        "[aria-label*='You']"
      ],
      contentHints: [
        ".markdown",
        "[data-message-id]",
        "pre",
        "code",
        "table",
        "p"
      ],
      toolbarAnchors: [
        "[data-message-author-role]",
        "h5",
        "header",
        ".markdown",
        "[class*='markdown']"
      ]
    },
    complexContent: {
      code: ["pre", "code"],
      math: ["mjx-container", ".katex", "[data-testid*='math']"],
      table: ["table"],
      list: ["ul", "ol"],
      quote: ["blockquote"]
    }
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    sessionKey: "",
    sessionState: cloneSessionState(DEFAULT_SESSION_STATE),
    messageRecords: new Map(),
    collapsedCache: new Map(),
    placeholderMap: new Map(),
    observer: null,
    observedRoot: null,
    scanTimer: null,
    scrollEndTimer: null,
    isScrolling: false,
    scanInProgress: false,
    pendingScan: false,
    debugCounter: 0,
    lastUrl: location.href,
    latestToastTimer: 0
  };

  bootstrap().catch((error) => {
    console.error("[ChatGPT Thread Lite] bootstrap failed", error);
  });

  async function bootstrap() {
    await loadPersistentState();
    bindRuntimeEvents();
    scheduleScan("bootstrap");
  }

  async function loadPersistentState() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.sessionStates]);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.settings] || {}) };
    state.sessionKey = getSessionKey();
    state.sessionState = getStoredSessionState(stored[STORAGE_KEYS.sessionStates], state.sessionKey);
  }

  function bindRuntimeEvents() {
    startObserver();

    window.addEventListener("scroll", () => {
      state.isScrolling = true;
      state.pendingScan = true;
      clearTimeout(state.scrollEndTimer);
      state.scrollEndTimer = window.setTimeout(() => {
        state.isScrolling = false;
        if (state.pendingScan) {
          state.pendingScan = false;
          scheduleScan("scroll settled");
        }
      }, 450);
    }, { passive: true, capture: true });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      if (changes[STORAGE_KEYS.settings]) {
        state.settings = {
          ...DEFAULT_SETTINGS,
          ...(changes[STORAGE_KEYS.settings].newValue || {})
        };
        scheduleScan("settings changed");
      }

      if (changes[STORAGE_KEYS.sessionStates]) {
        const nextStates = changes[STORAGE_KEYS.sessionStates].newValue || {};
        state.sessionState = getStoredSessionState(nextStates, state.sessionKey);
        scheduleScan("session state changed");
      }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleRuntimeMessage(message)
        .then(sendResponse)
        .catch((error) => {
          console.warn("[ChatGPT Thread Lite] message failed", error);
          sendResponse({ ok: false, message: "扩展操作失败。" });
        });
      return true;
    });

    window.addEventListener("beforeunload", () => {
      disconnectObserver();
      clearTimeout(state.scanTimer);
      clearTimeout(state.scrollEndTimer);
    });

    setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        handleUrlChange().catch((error) => {
          console.warn("[ChatGPT Thread Lite] failed to reload session state", error);
        });
      }
    }, 1000);
  }

  async function handleUrlChange() {
    state.sessionKey = getSessionKey();
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessionStates]);
    state.sessionState = getStoredSessionState(stored[STORAGE_KEYS.sessionStates], state.sessionKey);
    state.messageRecords.clear();
    state.collapsedCache.clear();
    state.placeholderMap.clear();
    scheduleScan("url changed");
  }

  function startObserver() {
    disconnectObserver();
    const root = findConversationRoot() || document.body;
    if (!root) {
      return;
    }

    state.observedRoot = root;
    state.observer = new MutationObserver((mutations) => {
      if (!state.settings.enabled || state.scanInProgress) {
        return;
      }

      const relevant = mutations.some((mutation) => {
        if (isExtensionNode(mutation.target)) {
          return false;
        }
        if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          return true;
        }
        if (mutation.type === "characterData") {
          return true;
        }
        return mutation.type === "attributes";
      });

      if (relevant) {
        state.pendingScan = true;
        if (state.isScrolling) {
          return;
        }
        scheduleScan("mutation");
      }
    });

    state.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: false
    });
  }

  function disconnectObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    state.observedRoot = null;
  }

  function scheduleScan(reason) {
    clearTimeout(state.scanTimer);
    state.pendingScan = true;
    if (state.isScrolling) {
      return;
    }
    state.scanTimer = window.setTimeout(() => {
      scanAndApply(reason).catch((error) => {
        console.warn("[ChatGPT Thread Lite] scan failed", error);
      });
    }, 320);
  }

  async function scanAndApply(reason) {
    if (state.scanInProgress || state.isScrolling) {
      state.pendingScan = true;
      return;
    }

    if (!state.settings.enabled) {
      restoreAllCollapsedNodesSilently();
      debugLog("scan skipped, disabled");
      return;
    }

    state.scanInProgress = true;
    state.pendingScan = false;
    disconnectObserver();
    try {
      const messages = collectAssistantMessages();
      applyGlobalHeaderControls(messages);
      applyToolbarControls(messages);
      applyVirtualization(messages);
      cleanupStaleCaches(messages);
      debugLog(`scan ${reason}`, {
        assistantCount: messages.length,
        collapsedCount: getCollapsedIds().length
      });
    } finally {
      state.scanInProgress = false;
      startObserver();
    }
  }

  function collectAssistantMessages() {
    const root = findConversationRoot();
    if (!root) {
      return [];
    }

    const candidates = uniqueElements(queryCandidates(root, SELECTORS.messages.turnCandidates));
    const assistantMessages = new Map();

    candidates.forEach((node, index) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (!looksLikeMessageTurn(node)) {
        return;
      }

      const role = detectMessageRole(node);
      if (role !== "assistant") {
        return;
      }

      const record = getOrCreateMessageRecord(node, index);
      if (!record) {
        return;
      }

      assistantMessages.set(record.id, record);
    });

    const records = Array.from(assistantMessages.values()).sort(compareMessageOrder);
    records.forEach((record, index) => {
      record.order = index;
      if (record.node && record.node.dataset) {
        record.node.dataset[`${camelCase(EXTENSION_PREFIX)}MessageId`] = record.id;
      }
    });

    return records;
  }

  function compareMessageOrder(left, right) {
    if (left.node === right.node) {
      return 0;
    }
    if (!left.node || !right.node || !left.node.isConnected || !right.node.isConnected) {
      return left.index - right.index;
    }
    const position = left.node.compareDocumentPosition(right.node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return left.index - right.index;
  }

  function findConversationRoot() {
    for (const selector of SELECTORS.roots.conversation) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    for (const selector of SELECTORS.roots.main) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement) {
        return node;
      }
    }
    return null;
  }

  function looksLikeMessageTurn(node) {
    if (!node.isConnected) {
      return false;
    }
    if (isExtensionNode(node)) {
      return false;
    }
    const text = getNodeText(node);
    if (!text) {
      return false;
    }
    const hasMessageMarker = node.matches("[data-message-author-role], [data-message-id], [data-testid^='conversation-turn-'], article, [role='article']");
    if (!hasMessageMarker) {
      return false;
    }
    const hasHint = SELECTORS.messages.contentHints.some((selector) => node.querySelector(selector));
    return hasHint || text.length > 20;
  }

  function detectMessageRole(node) {
    const explicitRole = node.getAttribute("data-message-author-role");
    if (explicitRole === "assistant" || explicitRole === "user") {
      return explicitRole;
    }

    if (queryCandidates(node, SELECTORS.messages.userHints).length > 0) {
      return "user";
    }

    if (queryCandidates(node, SELECTORS.messages.assistantHints).length > 0) {
      return "assistant";
    }

    const testId = node.getAttribute("data-testid") || "";
    if (/assistant/i.test(testId)) {
      return "assistant";
    }
    if (/user/i.test(testId)) {
      return "user";
    }

    return "unknown";
  }

  function getOrCreateMessageRecord(node, fallbackIndex) {
    const messageNode = resolveMessageContainer(node);
    const summary = createTextSummary(messageNode);
    if (!summary) {
      return null;
    }

    const id = buildMessageId(messageNode, summary, fallbackIndex);
    const existing = state.messageRecords.get(id) || {};
    const record = {
      id,
      node: messageNode,
      summary,
      index: fallbackIndex,
      order: existing.order || fallbackIndex,
      complex: detectComplexity(messageNode),
      hasToolbar: existing.hasToolbar || false,
      collapsed: state.sessionState.collapsed[id] === true,
      locked: state.sessionState.lockedExpanded[id] === true,
      manuallyExpanded: state.sessionState.manualExpanded[id] === true
    };
    state.messageRecords.set(id, record);
    return record;
  }

  function resolveMessageContainer(node) {
    const container = node.closest(
      "article[data-testid^='conversation-turn-'], [data-testid^='conversation-turn-'], article, [role='article']"
    );
    return container instanceof HTMLElement ? container : node;
  }

  function buildMessageId(node, summary, fallbackIndex) {
    const explicitId =
      node.getAttribute("data-message-id") ||
      node.getAttribute("data-id") ||
      node.getAttribute("id") ||
      node.getAttribute("data-testid");

    if (explicitId) {
      return sanitizeId(`msg-${explicitId}`);
    }

    const rolePart = detectMessageRole(node);
    const summaryHash = simpleHash(summary.slice(0, 300));
    const pathIndex = getSiblingPath(node);
    return sanitizeId(`${state.sessionKey}-${rolePart}-${fallbackIndex}-${pathIndex}-${summaryHash}`);
  }

  function applyToolbarControls(messages) {
    messages.forEach((record) => {
      if (!record.node || !record.node.isConnected) {
        return;
      }
      if (record.node.dataset[`${camelCase(EXTENSION_PREFIX)}Placeholder`] === "true") {
        return;
      }
      injectToolbar(record);
    });
  }

  function applyGlobalHeaderControls(messages) {
    const anchor = findGlobalHeaderAnchor();
    if (!anchor) {
      return;
    }

    let container = anchor.querySelector(`.${EXTENSION_PREFIX}-global-controls`);
    if (!container) {
      container = document.createElement("div");
      container.className = `${EXTENSION_PREFIX}-global-controls`;

      const expandAllBtn = createButton(t("expandAllHeader"), "primary", "global-expand-all", () => {
        expandAllCollapsedMessages().catch(handleSoftError);
      });

      const collapseAllBtn = createButton(t("collapseAllHeader"), "default", "global-collapse-all", () => {
        collapseAllMessages().catch(handleSoftError);
      });

      container.append(expandAllBtn, collapseAllBtn);
      anchor.appendChild(container);
    }

    const expandAllBtn = container.querySelector("[data-action='global-expand-all']");
    const collapseAllBtn = container.querySelector("[data-action='global-collapse-all']");
    const collapsedCount = getCollapsedIds().length;
    const assistantCount = messages.length;

    if (expandAllBtn) {
      expandAllBtn.disabled = state.settings.extremeMemoryMode || collapsedCount === 0;
      expandAllBtn.title = state.settings.extremeMemoryMode
        ? t("extremeMemoryDisabledExpandAll")
        : t("expandAll");
    }

    if (collapseAllBtn) {
      collapseAllBtn.disabled = assistantCount <= 1;
      collapseAllBtn.title = t("collapseAllHeader");
    }
  }

  function findGlobalHeaderAnchor() {
    for (const selector of SELECTORS.header.anchors) {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement) || !node.isConnected) {
        continue;
      }

      if (node.querySelector("h1, h2, nav, button")) {
        return node;
      }
    }
    return null;
  }

  function injectToolbar(record) {
    const existing = record.node.querySelector(`.${EXTENSION_PREFIX}-toolbar`);
    if (existing) {
      syncToolbarState(record, existing);
      return;
    }

    const anchor = findToolbarAnchor(record.node);
    if (!anchor || !anchor.parentNode) {
      return;
    }

    const toolbar = document.createElement("div");
    toolbar.className = `${EXTENSION_PREFIX}-toolbar`;
    toolbar.dataset.messageId = record.id;

    const collapseBtn = createButton(t("collapse"), "default", "collapse", () => {
      collapseMessage(record.id, { manual: true }).catch(handleSoftError);
    });

    const expandBtn = createButton(t("expand"), "primary", "expand", () => {
      expandMessage(record.id, { manual: true, persist: true }).catch(handleSoftError);
    });

    const lockBtn = createButton(t("lock"), "default", "lock", () => {
      toggleLock(record.id).catch(handleSoftError);
    });

    toolbar.append(collapseBtn, expandBtn, lockBtn);
    anchor.parentNode.insertBefore(toolbar, anchor);
    syncToolbarState(record, toolbar);
  }

  function syncToolbarState(record, toolbar) {
    const collapsed = isCollapsed(record.id);
    const lockBtn = toolbar.querySelector("[data-action='lock']");
    const collapseBtn = toolbar.querySelector("[data-action='collapse']");
    const expandBtn = toolbar.querySelector("[data-action='expand']");

    if (lockBtn) {
      lockBtn.classList.toggle("is-active", Boolean(record.locked));
      lockBtn.textContent = record.locked ? t("locked") : t("lock");
    }
    if (collapseBtn) {
      collapseBtn.disabled = collapsed;
    }
    if (expandBtn) {
      expandBtn.disabled = !collapsed;
    }
  }

  function applyVirtualization(messages) {
    const keepRecentCount = Math.max(1, Number(state.settings.keepRecentCount) || DEFAULT_SETTINGS.keepRecentCount);
    const lastExpandableIndex = Math.max(0, messages.length - 1);

    messages.forEach((record, index) => {
      record.collapsed = isCollapsed(record.id);
      record.locked = state.sessionState.lockedExpanded[record.id] === true;
      record.manuallyExpanded = state.sessionState.manualExpanded[record.id] === true;

      const isLatest = index === lastExpandableIndex;
      const keepBecauseRecent = state.settings.keepLatestOnly
        ? isLatest
        : index >= messages.length - keepRecentCount;
      const keepBecauseManual = record.locked || record.manuallyExpanded;
      const shouldPreferCollapse = state.settings.autoCollapseComplex
        ? (record.complex || !keepBecauseRecent)
        : !keepBecauseRecent;
      const shouldCollapse = !isLatest && !keepBecauseManual && shouldPreferCollapse;

      if (shouldCollapse) {
        if (!record.collapsed) {
          collapseMessageSync(record.id, { manual: false });
        } else if (record.node && record.node.isConnected) {
          collapseMessageSync(record.id, { manual: false });
        }
      } else if (record.collapsed) {
        expandMessageSync(record.id, { manual: false, persist: false });
      } else {
        syncToolbarState(record, record.node.querySelector(`.${EXTENSION_PREFIX}-toolbar`) || null);
      }
    });
  }

  async function collapseMessage(messageId, options) {
    collapseMessageSync(messageId, options);
    await persistSessionState();
  }

  function collapseMessageSync(messageId, options) {
    const record = state.messageRecords.get(messageId);
    if (!record || !record.node || !record.node.isConnected) {
      return;
    }

    const conversationRoot = findConversationRoot();
    if (conversationRoot && (record.node === conversationRoot || record.node.contains(conversationRoot))) {
      debugLog("skip unsafe message container", { messageId });
      return;
    }

    if (isCollapsed(messageId)) {
      hideCollapsedSource(record.node);
      return;
    }

    if (state.sessionState.lockedExpanded[messageId]) {
      return;
    }

    const summary = record.summary || createTextSummary(record.node);
    const placeholder = createPlaceholder(record, summary);
    const originalNode = record.node;
    const previousAriaHidden = originalNode.getAttribute("aria-hidden");
    const previousDisplay = originalNode.style.getPropertyValue("display");
    const previousDisplayPriority = originalNode.style.getPropertyPriority("display");

    if (!state.settings.extremeMemoryMode) {
      state.collapsedCache.set(messageId, {
        node: originalNode,
        summary,
        previousAriaHidden,
        previousDisplay,
        previousDisplayPriority,
        collapsedAt: Date.now()
      });
    } else {
      state.collapsedCache.delete(messageId);
    }

    try {
      hideCollapsedSource(originalNode);
      originalNode.parentNode.insertBefore(placeholder, originalNode);
      state.placeholderMap.set(messageId, placeholder);
      state.sessionState.collapsed[messageId] = true;
      delete state.sessionState.manualExpanded[messageId];
      record.summary = summary;
      record.collapsed = true;
      syncPlaceholderState(record, placeholder);
    } catch (error) {
      restoreCollapsedSource(originalNode, {
        previousAriaHidden,
        previousDisplay,
        previousDisplayPriority
      });
      placeholder.remove();
      handleSoftError(error);
    }

    if (options && options.manual) {
      showToast(t("collapsedMessage"));
    }
  }

  async function expandMessage(messageId, options) {
    const ok = expandMessageSync(messageId, options);
    if (ok) {
      await persistSessionState();
    }
  }

  function expandMessageSync(messageId, options) {
    const placeholder = state.placeholderMap.get(messageId);
    if (!placeholder || !placeholder.isConnected) {
      return false;
    }

    const cached = state.collapsedCache.get(messageId);
    if (!cached || !cached.node) {
      if (state.settings.extremeMemoryMode) {
        showToast(t("noFullNodeCached"));
      } else {
        showToast(t("noFullNodeCached"));
      }
      return false;
    }

    try {
      placeholder.remove();
      restoreCollapsedSource(cached.node, cached);
      state.placeholderMap.delete(messageId);
      delete state.sessionState.collapsed[messageId];
      if (options && options.persist) {
        state.sessionState.manualExpanded[messageId] = true;
      }
      const record = state.messageRecords.get(messageId);
      if (record) {
        record.node = cached.node;
        record.collapsed = false;
        record.manuallyExpanded = state.sessionState.manualExpanded[messageId] === true;
        record.locked = state.sessionState.lockedExpanded[messageId] === true;
        injectToolbar(record);
        const toolbar = cached.node.querySelector(`.${EXTENSION_PREFIX}-toolbar`);
        if (toolbar) {
          syncToolbarState(record, toolbar);
        }
      }
      return true;
    } catch (error) {
      handleSoftError(error);
      return false;
    }
  }

  function createPlaceholder(record, summary) {
    const placeholder = document.createElement("section");
    placeholder.className = `${EXTENSION_PREFIX}-placeholder`;
    placeholder.dataset.messageId = record.id;
    placeholder.dataset[`${camelCase(EXTENSION_PREFIX)}Placeholder`] = "true";

    const summaryNode = document.createElement("div");
    summaryNode.className = `${EXTENSION_PREFIX}-placeholder-summary`;
    summaryNode.textContent = summary || "";

    const actions = document.createElement("div");
    actions.className = `${EXTENSION_PREFIX}-placeholder-actions`;

    const expandBtn = createButton(t("expand"), "primary", "expand", () => {
      expandMessage(record.id, { manual: true, persist: true }).catch(handleSoftError);
    });
    expandBtn.disabled = state.settings.extremeMemoryMode;

    const restoreBtn = createButton(t("restoreDefaultFold"), "default", "restore", () => {
      delete state.sessionState.manualExpanded[record.id];
      persistSessionState().catch(handleSoftError);
      showToast(t("restoreDefaultFold"));
    });

    const lockBtn = createButton(record.locked ? t("locked") : t("permanentExpand"), "default", "lock", () => {
      toggleLock(record.id).catch(handleSoftError);
    });
    lockBtn.classList.toggle("is-active", Boolean(record.locked));

    actions.append(expandBtn, lockBtn, restoreBtn);
    placeholder.append(summaryNode, actions);
    return placeholder;
  }

  function hideCollapsedSource(node) {
    if (!node || !(node instanceof HTMLElement)) {
      return;
    }
    node.classList.add(`${EXTENSION_PREFIX}-source-collapsed`);
    node.style.setProperty("display", "none", "important");
    node.setAttribute("aria-hidden", "true");
  }

  function restoreCollapsedSource(node, cached) {
    if (!node || !(node instanceof HTMLElement)) {
      return;
    }
    node.classList.remove(`${EXTENSION_PREFIX}-source-collapsed`);
    if (cached && cached.previousDisplay) {
      node.style.setProperty("display", cached.previousDisplay, cached.previousDisplayPriority || "");
    } else {
      node.style.removeProperty("display");
    }
    if (!cached || cached.previousAriaHidden === null || cached.previousAriaHidden === undefined) {
      node.removeAttribute("aria-hidden");
    } else {
      node.setAttribute("aria-hidden", cached.previousAriaHidden);
    }
  }

  function syncPlaceholderState(record, placeholder) {
    if (!placeholder) {
      return;
    }
    const buttons = placeholder.querySelectorAll(`.${EXTENSION_PREFIX}-btn`);
    buttons.forEach((button) => {
      const action = button.dataset.action;
      if (action === "expand") {
        button.disabled = state.settings.extremeMemoryMode;
      }
      if (action === "lock") {
        button.classList.toggle("is-active", Boolean(record.locked));
        button.textContent = record.locked ? t("locked") : t("permanentExpand");
      }
    });
  }

  async function toggleLock(messageId) {
    if (state.sessionState.lockedExpanded[messageId]) {
      delete state.sessionState.lockedExpanded[messageId];
    } else {
      state.sessionState.lockedExpanded[messageId] = true;
      delete state.sessionState.collapsed[messageId];
      delete state.sessionState.manualExpanded[messageId];
      expandMessageSync(messageId, { manual: true, persist: false });
    }

    const record = state.messageRecords.get(messageId);
    if (record) {
      record.locked = state.sessionState.lockedExpanded[messageId] === true;
    }

    await persistSessionState();
    scheduleScan("lock toggled");
  }

  async function persistSessionState() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.sessionStates]);
    const allStates = stored[STORAGE_KEYS.sessionStates] || {};
    allStates[state.sessionKey] = cloneSessionState(state.sessionState);
    await chrome.storage.local.set({ [STORAGE_KEYS.sessionStates]: allStates });
  }

  function getStoredSessionState(allStates, sessionKey) {
    const raw = allStates && allStates[sessionKey];
    return cloneSessionState({ ...DEFAULT_SESSION_STATE, ...(raw || {}) });
  }

  function cloneSessionState(sessionState) {
    return {
      lockedExpanded: { ...(sessionState.lockedExpanded || {}) },
      manualExpanded: { ...(sessionState.manualExpanded || {}) },
      collapsed: { ...(sessionState.collapsed || {}) },
      lastBulkCollapsedSnapshot: Array.isArray(sessionState.lastBulkCollapsedSnapshot)
        ? [...sessionState.lastBulkCollapsedSnapshot]
        : []
    };
  }

  async function handleRuntimeMessage(message) {
    switch (message && message.type) {
      case "settingsUpdated":
        scheduleScan("popup settings update");
        return { ok: true };
      case "getPageState":
        return getPageState();
      case "expandNearby":
        return expandNearbyMessages();
      case "expandAll":
        return expandAllCollapsedMessages();
      case "restorePreviousCollapsed":
        return restorePreviousCollapsedSnapshot();
      case "recollapseOld":
        return recollapseOldMessages();
      case "resetSession":
        return resetCurrentSessionState();
      default:
        return { ok: false, message: t("unableReadPageState") };
    }
  }

  function getPageState() {
    const messages = collectAssistantMessages();
    const collapsedIds = getCollapsedIds();
    const nearbyCollapsedIds = getCollapsedIdsNearViewport(state.settings.nearbyExpandCount);

    return {
      ok: true,
      sessionKey: state.sessionKey,
      assistantCount: messages.length,
      collapsedCount: collapsedIds.length,
      nearbyCollapsedCount: nearbyCollapsedIds.length,
      extremeMemoryMode: Boolean(state.settings.extremeMemoryMode),
      hasPreviousCollapsedSnapshot: Array.isArray(state.sessionState.lastBulkCollapsedSnapshot)
        && state.sessionState.lastBulkCollapsedSnapshot.length > 0
    };
  }

  async function expandNearbyMessages() {
    if (state.settings.extremeMemoryMode) {
      return { ok: false, message: t("extremeMemoryDisabledExpandNearby") };
    }

    const ids = getCollapsedIdsNearViewport(state.settings.nearbyExpandCount);
    if (!ids.length) {
      return { ok: true, message: t("noNearbyCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = getCollapsedIds();
    let restored = 0;
    ids.forEach((id) => {
      if (expandMessageSync(id, { manual: true, persist: true })) {
        restored += 1;
      }
    });
    await persistSessionState();
    scheduleScan("expand nearby");
    return { ok: true, message: t("expandNearbyToast", [restored]) };
  }

  async function expandAllCollapsedMessages() {
    if (state.settings.extremeMemoryMode) {
      return { ok: false, message: t("extremeMemoryDisabledExpandAll") };
    }

    const ids = getCollapsedIds();
    if (!ids.length) {
      return { ok: true, message: t("noCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = [...ids];
    let restored = 0;
    ids.forEach((id) => {
      if (expandMessageSync(id, { manual: true, persist: true })) {
        restored += 1;
      }
    });
    await persistSessionState();
    scheduleScan("expand all");
    return { ok: true, message: t("expandAllToast", [restored]) };
  }

  async function restorePreviousCollapsedSnapshot() {
    const ids = Array.isArray(state.sessionState.lastBulkCollapsedSnapshot)
      ? [...state.sessionState.lastBulkCollapsedSnapshot]
      : [];
    if (!ids.length) {
      return { ok: true, message: t("noPreviousCollapsedView") };
    }

    ids.forEach((id) => {
      const record = state.messageRecords.get(id);
      if (record && !state.sessionState.lockedExpanded[id]) {
        collapseMessageSync(id, { manual: false });
      }
    });
    await persistSessionState();
    scheduleScan("restore previous collapsed");
    return { ok: true, message: t("restoredPreviousCollapsedView") };
  }

  async function recollapseOldMessages() {
    const messages = collectAssistantMessages();
    applyVirtualization(messages);
    await persistSessionState();
    scheduleScan("recollapse old");
    return { ok: true, message: t("recollapsedOldMessages") };
  }

  async function collapseAllMessages() {
    const messages = collectAssistantMessages();
    if (!messages.length) {
      return { ok: true, message: t("noCollapsedMessages") };
    }

    state.sessionState.lastBulkCollapsedSnapshot = getCollapsedIds();
    let collapsed = 0;

    messages.forEach((record, index) => {
      const isLatest = index === messages.length - 1;
      if (isLatest || state.sessionState.lockedExpanded[record.id]) {
        return;
      }
      if (!isCollapsed(record.id)) {
        collapseMessageSync(record.id, { manual: false });
        if (isCollapsed(record.id)) {
          collapsed += 1;
        }
      }
    });

    await persistSessionState();
    scheduleScan("collapse all");
    showToast(t("collapseAllToast", [collapsed]));
    return { ok: true, message: t("collapseAllToast", [collapsed]) };
  }

  async function resetCurrentSessionState() {
    restoreAllCollapsedNodesSilently();
    state.sessionState = cloneSessionState(DEFAULT_SESSION_STATE);
    await persistSessionState();
    scheduleScan("reset session");
    return { ok: true, message: t("sessionResetDone") };
  }

  function restoreAllCollapsedNodesSilently() {
    const ids = Array.from(state.placeholderMap.keys());
    ids.forEach((id) => {
      expandMessageSync(id, { manual: false, persist: false });
    });
  }

  function getCollapsedIds() {
    return Array.from(state.placeholderMap.keys()).filter((id) => {
      const placeholder = state.placeholderMap.get(id);
      return placeholder && placeholder.isConnected;
    });
  }

  function getCollapsedIdsNearViewport(nearbyCount) {
    const placeholders = Array.from(state.placeholderMap.entries())
      .map(([id, node]) => ({ id, node }))
      .filter((item) => item.node && item.node.isConnected);

    if (!placeholders.length) {
      return [];
    }

    const viewportCenter = window.scrollY + (window.innerHeight / 2);
    const sorted = placeholders
      .map((item) => {
        const rect = item.node.getBoundingClientRect();
        const absoluteTop = rect.top + window.scrollY;
        return {
          id: item.id,
          distance: Math.abs(absoluteTop - viewportCenter)
        };
      })
      .sort((a, b) => a.distance - b.distance);

    return sorted.slice(0, Math.max(1, nearbyCount || DEFAULT_SETTINGS.nearbyExpandCount)).map((item) => item.id);
  }

  function cleanupStaleCaches(messages) {
    const knownIds = new Set(messages.map((message) => message.id));
    Array.from(state.collapsedCache.keys()).forEach((id) => {
      if (!knownIds.has(id) && !state.placeholderMap.has(id)) {
        state.collapsedCache.delete(id);
      }
    });
    Array.from(state.placeholderMap.keys()).forEach((id) => {
      const placeholder = state.placeholderMap.get(id);
      if (!placeholder || !placeholder.isConnected) {
        state.placeholderMap.delete(id);
      }
    });
  }

  function createTextSummary(node) {
    const rawText = getNodeText(node)
      .replace(/\s+/g, " ")
      .trim();
    if (!rawText) {
      return "";
    }
    const limited = rawText.slice(0, 180);
    return limited.length < rawText.length ? `${limited}…` : limited;
  }

  function detectComplexity(node) {
    const counts = {
      code: countMatches(node, SELECTORS.complexContent.code),
      math: countMatches(node, SELECTORS.complexContent.math),
      table: countMatches(node, SELECTORS.complexContent.table),
      list: countMatches(node, SELECTORS.complexContent.list),
      quote: countMatches(node, SELECTORS.complexContent.quote)
    };
    const textLength = getNodeText(node).length;
    return counts.code > 0 || counts.math > 0 || counts.table > 0 || counts.list >= 6 || counts.quote >= 3 || textLength > 3200;
  }

  function isExtensionNode(node) {
    const element = node instanceof Element ? node : node && node.parentElement;
    if (!element) {
      return false;
    }
    return Boolean(element.closest(
      `.${EXTENSION_PREFIX}-placeholder, .${EXTENSION_PREFIX}-toolbar, .${EXTENSION_PREFIX}-global-controls, .${EXTENSION_PREFIX}-toast`
    ));
  }

  function queryCandidates(root, selectors) {
    const matches = [];
    selectors.forEach((selector) => {
      try {
        matches.push(...root.querySelectorAll(selector));
      } catch (error) {
        handleSoftError(error);
      }
    });
    return matches;
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function findToolbarAnchor(node) {
    for (const selector of SELECTORS.messages.toolbarAnchors) {
      const candidate = node.querySelector(selector);
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }
    return node.firstElementChild instanceof HTMLElement ? node.firstElementChild : node;
  }

  function createButton(label, variant, action, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${EXTENSION_PREFIX}-btn`;
    button.dataset.variant = variant === "primary" ? "primary" : variant === "danger" ? "danger" : "default";
    button.textContent = label;
    button.dataset.action = action;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function getNodeText(node) {
    return (node.innerText || node.textContent || "").trim();
  }

  function countMatches(root, selectors) {
    return selectors.reduce((count, selector) => {
      try {
        return count + root.querySelectorAll(selector).length;
      } catch (error) {
        handleSoftError(error);
        return count;
      }
    }, 0);
  }

  function getSiblingPath(node) {
    const parts = [];
    let current = node;
    while (current && current.parentElement && current !== document.body) {
      const index = Array.from(current.parentElement.children).indexOf(current);
      parts.push(index);
      current = current.parentElement;
    }
    return parts.reverse().join("-");
  }

  function getSessionKey() {
    const conversationId = extractConversationIdFromUrl(location.href);
    return conversationId ? `session:${conversationId}` : `session:path:${location.pathname}`;
  }

  function extractConversationIdFromUrl(url) {
    const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
    return match ? match[1] : "";
  }

  function sanitizeId(value) {
    return String(value).replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 220);
  }

  function simpleHash(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  }

  function camelCase(value) {
    return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  }

  function isCollapsed(messageId) {
    const placeholder = state.placeholderMap.get(messageId);
    return Boolean(placeholder && placeholder.isConnected);
  }

  function showToast(message) {
    const previous = document.querySelector(`.${EXTENSION_PREFIX}-toast`);
    if (previous) {
      previous.remove();
    }

    const toast = document.createElement("div");
    toast.className = `${EXTENSION_PREFIX}-toast`;
    toast.textContent = message;
    document.body.appendChild(toast);
    clearTimeout(state.latestToastTimer);
    state.latestToastTimer = window.setTimeout(() => {
      toast.remove();
    }, 2200);
  }

  function debugLog(label, payload) {
    if (!state.settings.debugMode) {
      return;
    }
    state.debugCounter += 1;
    console.debug(`[ChatGPT Thread Lite ${state.debugCounter}] ${label}`, payload || "");
  }

  function handleSoftError(error) {
    if (state.settings.debugMode) {
      console.warn("[ChatGPT Thread Lite] soft error", error);
    }
  }
})();
