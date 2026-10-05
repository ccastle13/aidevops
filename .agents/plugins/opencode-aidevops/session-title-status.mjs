// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2025-2026 Marcus Quinn

import {
  resetTerminalTitleState as defaultResetTerminalTitleState,
  setTerminalTitleStatus as defaultSetTerminalTitleStatus,
} from "./terminal-title.mjs";

function getEvent(input) {
  return input?.event || input || {};
}

function sessionIDFrom(event) {
  return event.properties?.sessionID || event.properties?.info?.sessionID || event.properties?.info?.id || "";
}

function isRootSessionInfo(info) {
  return Boolean(info) && !info.parentID;
}

const ROOT_SESSION_STATUSES = new Set(["busy", "retry", "idle"]);
const TERMINAL_ASSISTANT_FINISH_REASONS = new Set(["stop", "end_turn", "completed"]);
const MAX_TRACKED_MESSAGE_IDS = 128;

function rememberMessageID(ids, messageID) {
  if (!messageID || ids.has(messageID)) return false;
  ids.add(messageID);
  while (ids.size > MAX_TRACKED_MESSAGE_IDS) ids.delete(ids.values().next().value);
  return true;
}

function isTerminalAssistantCompletion(info) {
  if (info?.role !== "assistant" || info.summary === true || info.mode === "compaction") return false;
  if (typeof info.time?.completed !== "number") return false;
  return TERMINAL_ASSISTANT_FINISH_REASONS.has(String(info.finish || "").toLowerCase());
}

function normalizeSessionStatus(status) {
  if (status === "running") return "busy";
  return status;
}

function registerSessionInfo(info, state) {
  const id = info?.id || "";
  if (!id) return;
  if (info.parentID) state.sessionParent.set(id, info.parentID);
  else state.sessionParent.delete(id);
}

function rootOf(sessionID, state) {
  let id = sessionID;
  const seen = new Set();
  while (id && state.sessionParent.has(id)) {
    if (seen.has(id)) break;
    seen.add(id);
    id = state.sessionParent.get(id);
  }
  return id || sessionID;
}

function isInFamily(sessionID, rootID, state) {
  if (!rootID || !sessionID) return false;
  if (sessionID === rootID) return true;
  return rootOf(sessionID, state) === rootID;
}

function isInActiveFamily(sessionID, state) {
  return isInFamily(sessionID, state.activeRootSessionID, state);
}

function turnFor(rootID, state) {
  let turn = state.turns.get(rootID);
  if (!turn) {
    turn = {
      activeUserMessageID: "",
      activeUserCreatedAt: null,
      completedUserMessageID: "",
      completedAssistantMessageIDs: new Set(),
      seenUserMessageIDs: new Set(),
    };
    state.turns.set(rootID, turn);
  }
  return turn;
}

function familyHasActiveWork(rootID, state) {
  for (const [sessionID, status] of state.familyStatus.entries()) {
    if (!isInFamily(sessionID, rootID, state)) continue;
    if (status === "busy" || status === "retry") return true;
  }
  return false;
}

function activePendingPermissionCount(state) {
  let count = 0;
  for (const sessionID of state.pendingPermissionSessions.values()) {
    if (isInActiveFamily(sessionID, state)) count += 1;
  }
  return count;
}

function resolveTitleStatus(state) {
  if (activePendingPermissionCount(state) > 0) return "permission";
  const rootID = state.activeRootSessionID;
  if (!rootID) return "idle";
  let hasRetry = false;
  let hasBusy = false;
  for (const [sessionID, status] of state.familyStatus.entries()) {
    if (!isInFamily(sessionID, rootID, state)) continue;
    if (status === "retry") hasRetry = true;
    if (status === "busy") hasBusy = true;
  }
  if (hasRetry) return "retry";
  if (hasBusy) return "busy";
  return "idle";
}

function emitResolvedStatus(state, setTerminalTitleStatus) {
  const next = resolveTitleStatus(state);
  // Idempotent: session.idle/status while already 🟡/🟢 must not thrash Tabby.
  if (next === state.lastEmittedStatus) return;
  state.lastEmittedStatus = next;
  setTerminalTitleStatus(next);
}

/** Soft-focus a root without wiping sibling root status (multi-session tabs). */
function focusRoot(sessionID, state, setTerminalTitleStatus, { emit = true } = {}) {
  if (!sessionID) return;
  const rootID = rootOf(sessionID, state);
  state.activeRootSessionID = rootID;
  if (!state.familyStatus.has(rootID)) state.familyStatus.set(rootID, "idle");
  turnFor(rootID, state);
  if (emit) emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleSessionCreated(context) {
  const { info, state, setTerminalTitleStatus } = context;
  if (!info?.id) return;
  registerSessionInfo(info, state);
  if (isRootSessionInfo(info)) {
    // Do not reset sibling roots — Triage keeps many parallel root sessions.
    focusRoot(info.id, state, setTerminalTitleStatus);
    return;
  }
  if (!state.familyStatus.has(info.id)) {
    state.familyStatus.set(info.id, "idle");
  }
  // Child of some root: if it belongs to the focused root, refresh title.
  if (isInActiveFamily(info.id, state)) emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleSessionUpdated(context) {
  const { info, state, setTerminalTitleStatus } = context;
  if (!info?.id) return;
  registerSessionInfo(info, state);
  if (isRootSessionInfo(info)) {
    // Session switch / title update on a root → follow focus so 🟢/⚪ works
    // for every root session in the tab, not only the first one created.
    focusRoot(info.id, state, setTerminalTitleStatus);
    return;
  }
  if (!state.familyStatus.has(info.id)) state.familyStatus.set(info.id, "idle");
}

function handleSessionDeleted({ sessionID, state, setTerminalTitleStatus, resetTerminalTitleState }) {
  const toDelete = new Set([sessionID]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [childID, parentID] of state.sessionParent.entries()) {
      if (!toDelete.has(parentID) || toDelete.has(childID)) continue;
      toDelete.add(childID);
      grew = true;
    }
  }

  for (const id of toDelete) {
    state.familyStatus.delete(id);
    state.sessionParent.delete(id);
    state.turns.delete(id);
    for (const [requestID, owner] of [...state.pendingPermissionSessions.entries()]) {
      if (owner === id) state.pendingPermissionSessions.delete(requestID);
    }
  }

  if (toDelete.has(state.activeRootSessionID)) {
    // Prefer another known root; else clear.
    let next = "";
    for (const id of state.familyStatus.keys()) {
      if (!state.sessionParent.has(id)) {
        next = id;
        break;
      }
    }
    state.activeRootSessionID = next;
    if (!next) {
      state.lastEmittedStatus = "";
      resetTerminalTitleState();
      return;
    }
  }
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleUserMessageUpdated({ info, sessionID, state, setTerminalTitleStatus }) {
  const rootID = rootOf(sessionID, state);
  focusRoot(rootID, state, setTerminalTitleStatus, { emit: false });
  const turn = turnFor(rootID, state);
  const messageID = info.id || "";
  if (!rememberMessageID(turn.seenUserMessageIDs, messageID)) return;
  const createdAt = Number.isFinite(info.time?.created) ? info.time.created : null;
  if (
    turn.activeUserMessageID &&
    turn.activeUserCreatedAt !== null &&
    (createdAt === null || createdAt < turn.activeUserCreatedAt)
  ) {
    return;
  }
  turn.activeUserMessageID = messageID;
  turn.activeUserCreatedAt = createdAt;
  turn.completedUserMessageID = "";
  state.familyStatus.set(rootID, "busy");
  if (activePendingPermissionCount(state) > 0) return;
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleAssistantMessageUpdated({ info, sessionID, state, setTerminalTitleStatus }) {
  const rootID = rootOf(sessionID, state);
  const turn = turnFor(rootID, state);
  if (
    !isTerminalAssistantCompletion(info) ||
    activePendingPermissionCount(state) > 0 ||
    !turn.activeUserMessageID ||
    info.parentID !== turn.activeUserMessageID
  ) return;
  if (!rememberMessageID(turn.completedAssistantMessageIDs, info.id)) return;
  turn.completedUserMessageID = turn.activeUserMessageID;
  state.familyStatus.set(rootID, "idle");
  focusRoot(rootID, state, setTerminalTitleStatus, { emit: false });
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleMessageUpdated(context) {
  const { info, sessionID, state } = context;
  if (!sessionID) return;
  // Child sessions: status events drive the tab; ignore child message heuristics.
  if (state.sessionParent.has(sessionID)) return;
  // Only known roots (or the focused root) drive message heuristics. Ignore
  // unregistered ids so stray child events without session.created cannot
  // steal focus from the real root.
  const isKnownRoot = state.familyStatus.has(sessionID) && !state.sessionParent.has(sessionID);
  const isFocusedRoot = sessionID === state.activeRootSessionID;
  if (!isKnownRoot && !isFocusedRoot) return;
  if (info?.role === "user") handleUserMessageUpdated(context);
  else handleAssistantMessageUpdated(context);
}

function handleSessionStatus({ event, sessionID, state, setTerminalTitleStatus }) {
  if (!sessionID) return;
  const status = normalizeSessionStatus(event.properties?.status?.type);
  if (!ROOT_SESSION_STATUSES.has(status)) return;

  // Adopt unknown sessions as their own root so multi-session tabs work even
  // when session.created was missed (long-lived OpenCode restore).
  if (!state.familyStatus.has(sessionID) && !state.sessionParent.has(sessionID)) {
    state.familyStatus.set(sessionID, "idle");
  }

  const rootID = rootOf(sessionID, state);
  focusRoot(rootID, state, setTerminalTitleStatus, { emit: false });
  if (activePendingPermissionCount(state) > 0) {
    state.familyStatus.set(sessionID, status);
    emitResolvedStatus(state, setTerminalTitleStatus);
    return;
  }

  const turn = turnFor(rootID, state);
  if (
    sessionID === rootID &&
    status === "busy" &&
    turn.completedUserMessageID &&
    turn.completedUserMessageID === turn.activeUserMessageID
  ) return;
  if (sessionID === rootID && status !== "idle") turn.completedUserMessageID = "";
  state.familyStatus.set(sessionID, status);
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleSessionIdle({ sessionID, state, setTerminalTitleStatus }) {
  if (!sessionID) return;
  if (!state.familyStatus.has(sessionID) && !state.sessionParent.has(sessionID)) {
    state.familyStatus.set(sessionID, "idle");
  }
  const rootID = rootOf(sessionID, state);
  focusRoot(rootID, state, setTerminalTitleStatus, { emit: false });
  state.familyStatus.set(sessionID, "idle");
  if (activePendingPermissionCount(state) > 0) {
    emitResolvedStatus(state, setTerminalTitleStatus);
    return;
  }
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handlePermissionAsked({ event, sessionID, state, setTerminalTitleStatus }) {
  if (!sessionID) return;
  const requestID = event.properties?.id;
  if (!requestID) return;
  const rootID = rootOf(sessionID, state);
  focusRoot(rootID, state, setTerminalTitleStatus, { emit: false });
  const turn = turnFor(rootID, state);
  turn.completedUserMessageID = "";
  state.pendingPermissionSessions.set(requestID, sessionID);
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handlePermissionReplied({ event, sessionID, state, setTerminalTitleStatus }) {
  const requestID = event.properties?.requestID || event.properties?.permissionID;
  if (!requestID) return;
  const owner = state.pendingPermissionSessions.get(requestID);
  const wasPending = state.pendingPermissionSessions.delete(requestID);
  if (!wasPending) return;

  const focusID = sessionID || owner || state.activeRootSessionID;
  if (focusID) focusRoot(focusID, state, setTerminalTitleStatus, { emit: false });
  if (activePendingPermissionCount(state) > 0) {
    emitResolvedStatus(state, setTerminalTitleStatus);
    return;
  }

  const rootID = state.activeRootSessionID;
  if (rootID) {
    const turn = turnFor(rootID, state);
    turn.completedUserMessageID = "";
    // Permission replies historically resume work as busy even before the next
    // native status event; keep that when the focused family is otherwise idle.
    if (!familyHasActiveWork(rootID, state)) state.familyStatus.set(rootID, "busy");
  }
  emitResolvedStatus(state, setTerminalTitleStatus);
}

const EVENT_HANDLERS = new Map([
  ["session.created", handleSessionCreated],
  ["session.updated", handleSessionUpdated],
  ["session.deleted", handleSessionDeleted],
  ["message.updated", handleMessageUpdated],
  ["session.status", handleSessionStatus],
  ["session.idle", handleSessionIdle],
  ["permission.asked", handlePermissionAsked],
  ["permission.updated", handlePermissionAsked],
  ["permission.replied", handlePermissionReplied],
]);

export function createSessionTitleStatusHandler({
  isHeadless = () => false,
  isEnabled = () => process.env.AIDEVOPS_TAB_STATUS_ENABLED !== "false",
  resetTerminalTitleState = defaultResetTerminalTitleState,
  setTerminalTitleStatus = defaultSetTerminalTitleStatus,
} = {}) {
  const state = {
    activeRootSessionID: "",
    lastEmittedStatus: "",
    familyStatus: new Map(),
    sessionParent: new Map(),
    turns: new Map(),
    pendingPermissionSessions: new Map(),
  };

  return async function sessionTitleStatusHandler(input) {
    if (isHeadless() || !isEnabled()) return;

    const event = getEvent(input);
    const info = event.properties?.info;
    const sessionID = sessionIDFrom(event);
    if (!sessionID) return;

    EVENT_HANDLERS.get(event.type)?.({
      event,
      info,
      sessionID,
      state,
      resetTerminalTitleState,
      setTerminalTitleStatus,
    });
  };
}
