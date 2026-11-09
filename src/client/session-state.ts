import type { JsonValue } from "@earendil-works/chord";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { AssistantMessage, Message, NestedToolCalls } from "@earendil-works/pi-ai";
import type {
  AgentState,
  CompactionReason,
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
  ToolDiagnostic,
  TaskGraph,
  TranscriptItem,
  TranscriptView,
  UsageState,
} from "@earendil-works/pi-durable";
import { CompactionEntry, ResetEntry, ToolResultEntry } from "@earendil-works/pi-durable";
import {
  ROOT_CONVERSATION_ID,
  parseScheduledInstruction,
  queuedInputs,
  type ConnectionStatus,
  type ConversationSummary,
  type QueuedInput,
  type ServerEvent,
} from "../protocol.ts";

export interface TranscriptToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface TranscriptToolResult {
  readonly callId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly details?: unknown;
  readonly nestedCalls?: NestedToolCalls;
}

export interface TranscriptEntry {
  readonly id: number;
  readonly conversationId: number;
  readonly kind: string;
  readonly role:
    | "user"
    | "assistant"
    | "system"
    | "tool"
    | "scheduled"
    | "compaction"
    | "reset"
    | "event";
  readonly text: string;
  readonly timestamp?: number;
  readonly canFork: boolean;
  readonly diagnostics?: readonly ToolDiagnostic[];
  readonly toolCalls?: readonly TranscriptToolCall[];
  readonly toolResult?: TranscriptToolResult;
}

/** Entries strictly between `after` and `upTo` that the client has not loaded. */
export type TranscriptGap = Extract<TranscriptItem, { readonly kind: "gap" }>;

export interface LiveConversation {
  readonly active: boolean;
  readonly text: string;
  readonly retry?: {
    readonly at: number;
    readonly error: string;
  };
}

export interface ToolProgress {
  readonly callId: string;
  readonly name: string;
  readonly status: "pending" | "running" | "done";
  readonly output?: string;
  readonly details?: JsonValue;
  readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface LiveCompaction {
  readonly taskId: number;
  readonly reason: CompactionReason;
  readonly blocking: boolean;
}

/** What the client renders of one conversation, derived from its view and the history it loaded. */
export interface ConversationSnapshot {
  readonly id: number;
  readonly entries: readonly TranscriptEntry[];
  /** Whether history before the first entry is not loaded yet. */
  readonly earlier: boolean;
  /** Ranges of history between loaded entries, after a reconnect missed more than the view's window. */
  readonly gaps: readonly TranscriptGap[];
  readonly partial?: AssistantMessage;
  readonly live: LiveConversation | null;
  readonly tools: readonly ToolProgress[];
  readonly compactions: readonly LiveCompaction[];
  /** Inputs submitted during a running turn, waiting to be placed after it. */
  readonly queued: readonly QueuedInput[];
  readonly typing: readonly string[];
  readonly agent?: Readonly<AgentState>;
  readonly usage?: Readonly<UsageState>;
  /** Why the newest run or compaction ended without a result, until a later one starts. */
  readonly failure?: {
    readonly taskId: number;
    readonly kind: string;
    readonly message: string;
  };
}

export interface SessionState {
  readonly status: ConnectionStatus;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId?: number;
  /** Replicas of the conversation views the server sent: the first value, then its operations. */
  readonly views: Readonly<Record<number, ConversationView>>;
  readonly typing: Readonly<Record<number, readonly string[]>>;
  readonly activity?: TaskGraph;
  readonly error?: string;
}

export type SessionAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "select"; readonly conversationId: number }
  | { readonly type: "event"; readonly event: ServerEvent }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "clear-error" };

export const initialSessionState: SessionState = {
  status: "connecting",
  conversations: [],
  views: {},
  typing: {},
};

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "connection":
      return { ...state, status: action.status };
    case "select":
      return { ...state, activeConversationId: action.conversationId, error: undefined };
    case "error":
      return { ...state, error: action.message };
    case "clear-error":
      return { ...state, error: undefined };
    case "event":
      return reduceServerEvent(state, action.event);
  }
}

function reduceServerEvent(state: SessionState, event: ServerEvent): SessionState {
  switch (event.type) {
    case "session.snapshot": {
      const conversations = event.session.conversations;
      const selectedStillExists = conversations.some(({ id }) => id === state.activeConversationId);
      const activeConversationId = selectedStillExists
        ? state.activeConversationId
        : (conversations.find(({ id }) => id === ROOT_CONVERSATION_ID)?.id ?? conversations[0]?.id);
      return {
        ...state,
        conversations,
        activeConversationId,
        ...(event.session.activity === undefined ? {} : { activity: event.session.activity }),
      };
    }
    case "conversation.created": {
      const conversations = [
        ...state.conversations.filter(({ id }) => id !== event.conversation.id),
        event.conversation,
      ].sort((left, right) => left.id - right.id);
      return { ...state, conversations };
    }
    case "session.activity":
      return { ...state, activity: event.activity };
    case "conversation.view":
      return { ...state, views: { ...state.views, [event.conversationId]: event.view } };
    case "conversation.ops": {
      const before = state.views[event.conversationId];
      // Ops follow their view on one socket; without it, only a replacement can be applied.
      if (before === undefined && event.ops[0]?.[0] !== "r") return state;
      const view = applyImmutable<ConversationView>(before, event.ops);
      return { ...state, views: { ...state.views, [event.conversationId]: view } };
    }
    case "conversation.entries":
      // Pages answer the client's transcript loader directly.
      return state;
    case "presence.typing":
      return { ...state, typing: { ...state.typing, [event.conversationId]: event.usernames } };
    case "command.result":
      if (!event.ok) return { ...state, error: event.error.message };
      return event.conversationId === undefined ||
        (event.command !== "conversation.create" && event.command !== "conversation.fork")
        ? state
        : { ...state, activeConversationId: event.conversationId, error: undefined };
    case "error":
      return { ...state, error: event.error.message };
  }
}

/** Render state of a conversation from its transcript view, the view's documents, and who is typing in it. */
export function conversationSnapshot(
  view: TranscriptView,
  typing: readonly string[] = [],
): ConversationSnapshot {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  const usage = view.docs["pi.usage"] as UsageState | undefined;
  const partial = live.generation?.message as AssistantMessage | undefined;
  const entries: TranscriptEntry[] = [];
  const gaps: TranscriptGap[] = [];
  let earlier = false;
  for (const item of view.items) {
    if (item.kind === "entry") entries.push(transcriptEntry(item.entry));
    else if (item.kind === "gap") gaps.push(item);
    else earlier = true;
  }
  const failure =
    live.runFailure !== undefined
      ? {
          taskId: live.runFailure.taskId,
          kind: "Run",
          message:
            live.runFailure.detail === undefined
              ? live.runFailure.reason
              : `${live.runFailure.reason}: ${live.runFailure.detail}`,
        }
      : live.compactionFailure !== undefined
        ? {
            taskId: live.compactionFailure.taskId,
            kind: "Compaction",
            message: live.compactionFailure.error,
          }
        : undefined;
  return {
    id: view.conversation.id,
    entries,
    earlier,
    gaps,
    live: liveConversation(live.run !== undefined, partial, live.generation?.retry),
    tools: (live.tools ?? []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      ...(tool.output === undefined ? {} : { output: tool.output }),
      ...(tool.details === undefined ? {} : { details: tool.details }),
      ...(tool.diagnostics === undefined ? {} : { diagnostics: tool.diagnostics }),
    })),
    compactions: (live.compactions ?? []).map(({ taskId, trigger, blocking }) => ({
      taskId,
      reason: trigger,
      blocking,
    })),
    queued: queuedInputs(inbox),
    typing,
    ...(agent === undefined ? {} : { agent }),
    ...(usage === undefined ? {} : { usage }),
    ...(partial === undefined ? {} : { partial }),
    ...(failure === undefined ? {} : { failure }),
  };
}

function liveConversation(
  active: boolean,
  partial: AssistantMessage | undefined,
  retry: LiveConversation["retry"],
): LiveConversation | null {
  if (!active && partial === undefined && retry === undefined) return null;
  return {
    active,
    text: partial === undefined ? "" : assistantText(partial.content),
    ...(retry === undefined ? {} : { retry }),
  };
}

function transcriptEntry(entry: EntryRecord): TranscriptEntry {
  const first = entry.model?.[0];
  const base = {
    id: entry.id,
    conversationId: entry.conversationId,
    kind: entry.kind,
    ...(first === undefined ? {} : { timestamp: first.timestamp }),
    canFork: false,
  };
  if (CompactionEntry.is(entry)) {
    const text = first === undefined ? "" : messageText(first);
    return { ...base, role: "compaction", text: compactionSummary(text) };
  }
  if (ResetEntry.is(entry)) {
    const text = first === undefined ? "" : messageText(first);
    return { ...base, role: "reset", text: text || "Context reset" };
  }
  if (ToolResultEntry.is(entry) && first?.role === "toolResult") {
    const diagnostics = toolResultDiagnostics(entry.data);
    return {
      ...base,
      role: "tool",
      text: toolResultText(first.content, diagnostics.length > 0),
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
      toolResult: {
        callId: first.toolCallId,
        name: first.toolName,
        isError: first.isError,
        ...(first.details === undefined ? {} : { details: first.details }),
        ...(first.nestedCalls === undefined ? {} : { nestedCalls: first.nestedCalls }),
      },
    };
  }
  const rawText =
    entry.model?.map(messageText).filter(Boolean).join("\n\n") ||
    (first?.role === "assistant"
      ? ""
      : entry.data === undefined
        ? entry.kind
        : JSON.stringify(entry.data));
  const scheduled = first?.role === "user" ? parseScheduledInstruction(rawText) : undefined;
  const role = scheduled === undefined ? messageRole(first) : "scheduled";
  const text = scheduled ?? rawText;
  const toolCalls =
    first?.role === "assistant"
      ? first.content.flatMap((part) =>
          part.type === "toolCall"
            ? [{ callId: part.id, name: part.name, args: part.arguments }]
            : [],
        )
      : [];
  return {
    ...base,
    role,
    text,
    canFork: role === "user" || role === "assistant",
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
  };
}

/** Compaction entries wrap the summary in the Harness's fixed `<summary>` framing. */
function compactionSummary(text: string): string {
  const match = /<summary>\n([\s\S]*)\n<\/summary>$/.exec(text);
  return match?.[1] ?? text;
}

/** Tool result content ends with a rendered `<harness>` block whenever the entry carries diagnostics. */
function toolResultText(content: readonly unknown[], hasDiagnostics: boolean): string {
  const parts = hasDiagnostics ? content.slice(0, -1) : content;
  return contentText(parts);
}

function toolResultDiagnostics(data: EntryRecord["data"]): readonly ToolDiagnostic[] {
  if (!isRecord(data) || !Array.isArray(data.diagnostics)) return [];
  return data.diagnostics.filter(isToolDiagnostic);
}

const DIAGNOSTIC_SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warn", "error"]);

function isToolDiagnostic(value: unknown): value is ToolDiagnostic {
  return (
    isRecord(value) &&
    DIAGNOSTIC_SEVERITIES.has(value.severity) &&
    typeof value.message === "string" &&
    (value.code === undefined || typeof value.code === "string")
  );
}

function messageRole(message: Message | undefined): TranscriptEntry["role"] {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "system":
      return message.role;
    case "toolResult":
      return "tool";
    default:
      return "event";
  }
}

function messageText(message: Message): string {
  switch (message.role) {
    case "system": {
      const content = contentText(message.content);
      const sections = Object.values(message.sections ?? {}).filter(
        (value): value is string => typeof value === "string",
      );
      return [content, ...sections].filter(Boolean).join("\n\n");
    }
    case "user":
      return contentText(message.content);
    case "assistant":
      return assistantText(message.content) || message.errorMessage || "";
    case "toolResult":
      return contentText(message.content);
  }
}

function contentText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "image") return "[Image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function assistantText(content: readonly unknown[]): string {
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part.type === "text" && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
