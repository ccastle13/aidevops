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

function isInActiveFamily(sessionID, state) {
  if (!state.activeRootSessionID || !sessionID) return false;
  if (sessionID === state.activeRootSessionID) return true;
  return rootOf(sessionID, state) === state.activeRootSessionID;
}

function familyHasActiveWork(state) {
  for (const status of state.familyStatus.values()) {
    if (status === "busy" || status === "retry") return true;
  }
  return false;
}

function resolveTitleStatus(state) {
  if (state.pendingPermissionIDs.size > 0) return "permission";
  let hasRetry = false;
  let hasBusy = false;
  for (const status of state.familyStatus.values()) {
    if (status === "retry") hasRetry = true;
    if (status === "busy") hasBusy = true;
  }
  if (hasRetry) return "retry";
  if (hasBusy) return "busy";
  return "idle";
}

function emitResolvedStatus(state, setTerminalTitleStatus) {
  setTerminalTitleStatus(resolveTitleStatus(state));
}

function activateRootSession({ sessionID, state, resetState, setTerminalTitleStatus }) {
  state.activeRootSessionID = sessionID;
  resetState();
  state.familyStatus.set(sessionID, "idle");
  setTerminalTitleStatus("idle");
}

function handleSessionCreated(context) {
  const { info, state } = context;
  if (!info?.id) return;
  registerSessionInfo(info, state);
  if (isRootSessionInfo(info)) {
    activateRootSession(context);
    return;
  }
  if (isInActiveFamily(info.id, state) && !state.familyStatus.has(info.id)) {
    state.familyStatus.set(info.id, "idle");
  }
}

function handleSessionUpdated(context) {
  const { info, state } = context;
  if (!info?.id) return;
  registerSessionInfo(info, state);
  if (state.activeRootSessionID || !isRootSessionInfo(info)) {
    if (isInActiveFamily(info.id, state) && !state.familyStatus.has(info.id)) {
      state.familyStatus.set(info.id, "idle");
    }
    return;
  }
  activateRootSession(context);
}

function handleSessionDeleted({ sessionID, state, resetState, setTerminalTitleStatus }) {
  if (sessionID === state.activeRootSessionID) {
    state.activeRootSessionID = "";
    resetState();
    return;
  }
  if (!state.activeRootSessionID) return;

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

  let removed = false;
  for (const id of toDelete) {
    if (state.familyStatus.delete(id)) removed = true;
    if (state.sessionParent.delete(id)) removed = true;
  }
  if (removed) emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleUserMessageUpdated({ info, state, setTerminalTitleStatus }) {
  const messageID = info.id || "";
  if (!rememberMessageID(state.seenUserMessageIDs, messageID)) return;
  const createdAt = Number.isFinite(info.time?.created) ? info.time.created : null;
  if (
    state.activeUserMessageID &&
    state.activeUserCreatedAt !== null &&
    (createdAt === null || createdAt < state.activeUserCreatedAt)
  ) {
    return;
  }
  state.activeUserMessageID = messageID;
  state.activeUserCreatedAt = createdAt;
  state.completedUserMessageID = "";
  if (state.activeRootSessionID) state.familyStatus.set(state.activeRootSessionID, "busy");
  // Keep 🟡 while permissions are outstanding; family busy is retained for the
  // reply path without re-emitting permission on every user-message update.
  if (state.pendingPermissionIDs.size > 0) return;
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleAssistantMessageUpdated({ info, state, setTerminalTitleStatus }) {
  if (
    !isTerminalAssistantCompletion(info) ||
    state.pendingPermissionIDs.size > 0 ||
    !state.activeUserMessageID ||
    info.parentID !== state.activeUserMessageID
  ) return;
  if (!rememberMessageID(state.completedAssistantMessageIDs, info.id)) return;
  state.completedUserMessageID = state.activeUserMessageID;
  if (state.activeRootSessionID) state.familyStatus.set(state.activeRootSessionID, "idle");
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleMessageUpdated(context) {
  const { info, sessionID, state } = context;
  // Root-turn message heuristics stay root-only; child activity is driven by
  // session.status so multi-session work still paints ⚪ while children run.
  if (sessionID !== state.activeRootSessionID) return;
  if (info?.role === "user") handleUserMessageUpdated(context);
  else handleAssistantMessageUpdated(context);
}

function handleSessionStatus({ event, sessionID, state, setTerminalTitleStatus }) {
  if (!isInActiveFamily(sessionID, state) || state.pendingPermissionIDs.size > 0) return;
  const status = normalizeSessionStatus(event.properties?.status?.type);
  if (!ROOT_SESSION_STATUSES.has(status)) return;
  if (
    sessionID === state.activeRootSessionID &&
    status === "busy" &&
    state.completedUserMessageID &&
    state.completedUserMessageID === state.activeUserMessageID
  ) return;
  if (sessionID === state.activeRootSessionID && status !== "idle") state.completedUserMessageID = "";
  state.familyStatus.set(sessionID, status);
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handleSessionIdle({ sessionID, state, setTerminalTitleStatus }) {
  if (!isInActiveFamily(sessionID, state) || state.pendingPermissionIDs.size > 0) return;
  state.familyStatus.set(sessionID, "idle");
  emitResolvedStatus(state, setTerminalTitleStatus);
}

function handlePermissionAsked({ event, sessionID, state, setTerminalTitleStatus }) {
  if (!isInActiveFamily(sessionID, state)) return;
  const requestID = event.properties?.id;
  if (!requestID) return;
  state.completedUserMessageID = "";
  state.pendingPermissionIDs.add(requestID);
  setTerminalTitleStatus("permission");
}

function handlePermissionReplied({ event, sessionID, state, setTerminalTitleStatus }) {
  if (!isInActiveFamily(sessionID, state)) return;
  const requestID = event.properties?.requestID || event.properties?.permissionID;
  const wasPending = state.pendingPermissionIDs.delete(requestID);
  if (!wasPending || state.pendingPermissionIDs.size > 0) return;
  state.completedUserMessageID = "";
  // Permission replies historically resume work as busy even before the next
  // native status event; keep that when the family is otherwise idle.
  if (!familyHasActiveWork(state) && state.activeRootSessionID) {
    state.familyStatus.set(state.activeRootSessionID, "busy");
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
    activeUserMessageID: "",
    activeUserCreatedAt: null,
    completedUserMessageID: "",
    completedAssistantMessageIDs: new Set(),
    pendingPermissionIDs: new Set(),
    seenUserMessageIDs: new Set(),
    familyStatus: new Map(),
    sessionParent: new Map(),
  };

  const resetState = () => {
    state.activeUserMessageID = "";
    state.activeUserCreatedAt = null;
    state.completedUserMessageID = "";
    state.completedAssistantMessageIDs.clear();
    state.pendingPermissionIDs.clear();
    state.seenUserMessageIDs.clear();
    state.familyStatus.clear();
    state.sessionParent.clear();
    resetTerminalTitleState();
  };

  return async function sessionTitleStatusHandler(input) {
    if (isHeadless() || !isEnabled()) return;

    const event = getEvent(input);
    const info = event.properties?.info;
    const sessionID = sessionIDFrom(event);
    if (!sessionID) return;

    EVENT_HANDLERS.get(event.type)?.({ event, info, sessionID, state, resetState, setTerminalTitleStatus });
  };
}
