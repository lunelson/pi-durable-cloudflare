import { assertValidOp, type Op } from "@earendil-works/chord/delta";
import type {
  BlockedReason,
  ConversationView,
  Cursor,
  EntryRecord,
  InboxState,
  TaskGraph,
  TaskGraphNode,
  TaskGraphState,
} from "@earendil-works/pi-durable";

export const ROOT_CONVERSATION_ID = 1;
export const MAX_PROMPT_CHARACTERS = 100_000;
export const MAX_REQUEST_ID_CHARACTERS = 256;
/** Most entries one `conversation.entries` request may load. */
export const MAX_ENTRY_PAGE_SIZE = 100;
// JSON may escape each prompt code unit as six characters.
export const MAX_CLIENT_FRAME_CHARACTERS =
  MAX_PROMPT_CHARACTERS * 6 + MAX_REQUEST_ID_CHARACTERS + 1024;
const SCHEDULED_INSTRUCTION_PREFIX = "Scheduled instruction due now: ";
const RECURRENCE_NOTE_PREFIX = "\n\nThis instruction recurs.";

/** Input submitted when a scheduled instruction is due. Self-contained; no system-prompt support needed. */
export function formatScheduledInstruction(scheduled: {
  readonly id: string;
  readonly instruction: string;
  readonly recurrence?: {
    readonly cadence: {
      readonly unit: "minute" | "hour" | "day" | "week" | "month";
      readonly interval: number;
    };
    readonly timezone: string;
  };
}): string {
  const text = `${SCHEDULED_INSTRUCTION_PREFIX}${scheduled.instruction}`;
  if (scheduled.recurrence === undefined) return text;
  const { interval, unit } = scheduled.recurrence.cadence;
  const cadence = `${interval} ${unit}${interval === 1 ? "" : "s"}`;
  return `${text}${RECURRENCE_NOTE_PREFIX} It repeats every ${cadence} in ${scheduled.recurrence.timezone}. After carrying it out, call schedule with this instruction and sourceScheduleId ${JSON.stringify(scheduled.id)}. Omit delaySeconds, at, and recurrence because the next UTC deadline and recurrence policy are derived from the source.`;
}

/** The instruction text of a scheduled delivery input, or `undefined` for ordinary input. */
export function parseScheduledInstruction(content: string): string | undefined {
  if (!content.startsWith(SCHEDULED_INSTRUCTION_PREFIX)) return undefined;
  const text = content.slice(SCHEDULED_INSTRUCTION_PREFIX.length);
  const note = text.lastIndexOf(RECURRENCE_NOTE_PREFIX);
  return note === -1 ? text : text.slice(0, note);
}

/** Display text of queued user input content: a string or text/image parts. */
function userInputText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
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

/** A user input waiting in a conversation's inbox for the current turn to finish. */
export interface QueuedInput {
  readonly submissionId: number;
  readonly mode: "steer" | "followUp";
  readonly text: string;
}

/** Queued user inputs of a conversation's `pi.inbox` document; passive writes are not user messages. */
export function queuedInputs(inbox: Readonly<InboxState> | undefined): QueuedInput[] {
  const items: QueuedInput[] = [];
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    items.push({ submissionId: item.id, mode: item.mode, text: userInputText(item.content) });
  }
  return items;
}

export type ConnectionStatus = "connecting" | "connected" | "failed";

export interface ConversationSummary {
  readonly id: number;
  readonly parent?: {
    readonly conversationId: number;
    readonly at: number;
  };
  /** Set for conversations created by a tool call, such as a search subagent. */
  readonly owner?: {
    readonly conversationId: number;
  };
}

export type ClientCommand =
  | {
      readonly type: "presence.typing";
      readonly conversationId: number;
      readonly typing: boolean;
    }
  | {
      readonly type: "conversation.open";
      readonly requestId: string;
      readonly conversationId: number;
    }
  | {
      readonly type: "conversation.create";
      readonly requestId: string;
    }
  | {
      readonly type: "conversation.fork";
      readonly requestId: string;
      readonly conversationId: number;
      readonly entryId: number;
    }
  | {
      readonly type: "prompt.submit";
      readonly requestId: string;
      readonly conversationId: number;
      readonly content: string;
    }
  | {
      /** Load a page of a conversation's history, for entries outside the view's window. */
      readonly type: "conversation.entries";
      readonly requestId: string;
      readonly conversationId: number;
      readonly query: EntryPageQuery;
      readonly limit: number;
    };

/** Inclusive entry ID bounds and order of a history page, as `Conversation.entries()` takes them. */
export interface EntryPageQuery {
  readonly minEntryId?: number;
  readonly maxEntryId?: number;
  readonly order?: "ascending" | "descending";
}
export type ClientCommandType = Exclude<ClientCommand["type"], "presence.typing">;

export type CommandResult =
  | {
      readonly type: "command.result";
      readonly command: ClientCommandType;
      readonly requestId: string;
      readonly ok: true;
      readonly conversationId?: number;
      readonly submissionId?: number;
    }
  | {
      readonly type: "command.result";
      readonly command: ClientCommandType;
      readonly requestId: string;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export type ServerEvent =
  | {
      readonly type: "session.snapshot";
      readonly session: {
        readonly conversations: readonly ConversationSummary[];
        readonly activity?: TaskGraph;
      };
    }
  | {
      readonly type: "conversation.created";
      readonly conversation: ConversationSummary;
    }
  | {
      readonly type: "session.activity";
      readonly activity: TaskGraph;
    }
  | {
      /** The first value of a conversation watch: a window over the transcript and the conversation's documents. */
      readonly type: "conversation.view";
      readonly conversationId: number;
      readonly view: ConversationView;
    }
  | {
      /** Operations that turn the previous view of the conversation into the next one. */
      readonly type: "conversation.ops";
      readonly conversationId: number;
      readonly ops: readonly Op[];
    }
  | {
      /** A page of history answering a `conversation.entries` command. */
      readonly type: "conversation.entries";
      readonly requestId: string;
      readonly conversationId: number;
      readonly entries: readonly EntryRecord[];
      readonly next?: Cursor;
    }
  | {
      readonly type: "presence.typing";
      readonly conversationId: number;
      readonly usernames: readonly string[];
    }
  | CommandResult
  | {
      readonly type: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export class InvalidClientCommand extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRequestId = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_CHARACTERS) {
    throw new InvalidClientCommand(
      `requestId must be a non-empty string of at most ${MAX_REQUEST_ID_CHARACTERS} characters`,
    );
  }
  return value;
};

const requireId = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidClientCommand(`${name} must be a positive integer`);
  }
  return value;
};

const optionalId = (value: unknown, name: string): number | undefined =>
  value === undefined ? undefined : requireId(value, name);

const commandTypes = new Set<ClientCommandType>([
  "conversation.open",
  "conversation.create",
  "conversation.fork",
  "prompt.submit",
  "conversation.entries",
]);

const requireCommandType = (value: unknown): ClientCommandType => {
  if (typeof value !== "string" || !commandTypes.has(value as ClientCommandType)) {
    throw new Error("Command result command is invalid");
  }
  return value as ClientCommandType;
};

const requireError = (value: unknown): { readonly code: string; readonly message: string } => {
  if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") {
    throw new Error("Server error payload is invalid");
  }
  return { code: value.code, message: value.message };
};

const TASK_OUTCOMES = new Set(["completed", "failed", "aborted", "orphaned", "faulted"]);
const BLOCKED_REASONS = new Set<BlockedReason>([
  "missing_task",
  "task_too_old",
  "migration_failed",
]);

const optionalBlockedReason = (value: unknown): BlockedReason | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !BLOCKED_REASONS.has(value as BlockedReason)) {
    throw new Error("Activity task blocked reason is invalid");
  }
  return value as BlockedReason;
};

const taskGraphState = (value: unknown): TaskGraphState => {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error("Activity task state is invalid");
  }
  if (value.status === "pending" || value.status === "running") {
    if (typeof value.phase !== "string") throw new Error("Activity task phase is invalid");
    return { status: value.status, phase: value.phase };
  }
  if (value.status === "sleeping") {
    if (typeof value.phase !== "string" || !Number.isFinite(value.until)) {
      throw new Error("Activity sleeping task state is invalid");
    }
    return { status: value.status, phase: value.phase, until: value.until as number };
  }
  if (value.status === "waiting") {
    if (
      typeof value.phase !== "string" ||
      !Array.isArray(value.on) ||
      (value.policy !== "failFast" && value.policy !== "allSettled")
    ) {
      throw new Error("Activity waiting task state is invalid");
    }
    return {
      status: value.status,
      phase: value.phase,
      on: value.on.map((id) => requireId(id, "activity.task.state.on")) as unknown as Extract<
        TaskGraphState,
        { status: "waiting" }
      >["on"],
      policy: value.policy,
    };
  }
  if (value.status === "completing") {
    if (typeof value.outcome !== "string" || !TASK_OUTCOMES.has(value.outcome)) {
      throw new Error("Activity completing task outcome is invalid");
    }
    return {
      status: value.status,
      outcome: value.outcome as Extract<TaskGraphState, { status: "completing" }>["outcome"],
    };
  }
  throw new Error("Activity task status is invalid");
};

const parseTaskGraph = (value: unknown): TaskGraph => {
  if (!isRecord(value) || !isRecord(value.tasks)) throw new Error("Activity graph is invalid");
  const tasks: Record<string, TaskGraphNode> = {};
  for (const [key, candidate] of Object.entries(value.tasks)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.kind !== "string" ||
      typeof candidate.background !== "boolean" ||
      typeof candidate.abortRequested !== "boolean" ||
      !Array.isArray(candidate.conversations)
    ) {
      throw new Error("Activity task is invalid");
    }
    const id = requireId(candidate.id, "activity.task.id");
    if (key !== String(id)) throw new Error("Activity task key does not match its id");
    const owner = optionalId(candidate.owner, "activity.task.owner");
    const blocked = optionalBlockedReason(candidate.blocked);
    tasks[key] = {
      id: id as TaskGraphNode["id"],
      kind: candidate.kind,
      conversationId: requireId(
        candidate.conversationId,
        "activity.task.conversationId",
      ) as TaskGraphNode["conversationId"],
      ...(owner === undefined ? {} : { owner: owner as NonNullable<TaskGraphNode["owner"]> }),
      background: candidate.background,
      abortRequested: candidate.abortRequested,
      state: taskGraphState(candidate.state),
      ...(blocked === undefined ? {} : { blocked }),
      conversations: candidate.conversations.map((conversationId) =>
        requireId(conversationId, "activity.task.conversations"),
      ) as unknown as TaskGraphNode["conversations"],
    };
  }
  return { tasks };
};

const parseConversationSummary = (value: unknown): ConversationSummary => {
  if (!isRecord(value)) throw new Error("Conversation summary is invalid");
  const summary: { -readonly [K in keyof ConversationSummary]: ConversationSummary[K] } = {
    id: requireId(value.id, "conversation.id"),
  };
  if (value.parent !== undefined) {
    if (!isRecord(value.parent)) throw new Error("Conversation parent is invalid");
    summary.parent = {
      conversationId: requireId(value.parent.conversationId, "conversation.parent.conversationId"),
      at: requireId(value.parent.at, "conversation.parent.at"),
    };
  }
  if (value.owner !== undefined) {
    if (!isRecord(value.owner)) throw new Error("Conversation owner is invalid");
    summary.owner = {
      conversationId: requireId(value.owner.conversationId, "conversation.owner.conversationId"),
    };
  }
  return summary;
};

export function parseClientCommand(message: string): ClientCommand {
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch (error) {
    throw new InvalidClientCommand("Message must contain valid JSON", { cause: error });
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InvalidClientCommand("Message must be a command object");
  }

  if (value.type === "presence.typing") {
    if (typeof value.typing !== "boolean") {
      throw new InvalidClientCommand("typing must be a boolean");
    }
    return {
      type: value.type,
      conversationId: requireId(value.conversationId, "conversationId"),
      typing: value.typing,
    };
  }

  const requestId = requireRequestId(value.requestId);
  switch (value.type) {
    case "conversation.open":
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
      };
    case "conversation.create":
      return { type: value.type, requestId };
    case "conversation.fork":
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
        entryId: requireId(value.entryId, "entryId"),
      };
    case "prompt.submit": {
      if (typeof value.content !== "string" || value.content.trim().length === 0) {
        throw new InvalidClientCommand("content must contain text");
      }
      if (value.content.length > MAX_PROMPT_CHARACTERS) {
        throw new InvalidClientCommand(`content cannot exceed ${MAX_PROMPT_CHARACTERS} characters`);
      }
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
        content: value.content,
      };
    }
    case "conversation.entries": {
      if (!isRecord(value.query)) throw new InvalidClientCommand("query must be an object");
      const { minEntryId, maxEntryId, order } = value.query;
      if (order !== undefined && order !== "ascending" && order !== "descending") {
        throw new InvalidClientCommand("query.order must be ascending or descending");
      }
      const limit = requireId(value.limit, "limit");
      if (limit > MAX_ENTRY_PAGE_SIZE) {
        throw new InvalidClientCommand(`limit cannot exceed ${MAX_ENTRY_PAGE_SIZE}`);
      }
      const min = optionalId(minEntryId, "query.minEntryId");
      const max = optionalId(maxEntryId, "query.maxEntryId");
      return {
        type: value.type,
        requestId,
        conversationId: requireId(value.conversationId, "conversationId"),
        query: {
          ...(min === undefined ? {} : { minEntryId: min }),
          ...(max === undefined ? {} : { maxEntryId: max }),
          ...(order === undefined ? {} : { order }),
        },
        limit,
      };
    }
    default:
      throw new InvalidClientCommand(`Unknown command type: ${value.type}`);
  }
}

const isEntryRecord = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.kind === "string" &&
  Number.isSafeInteger(value.id) &&
  Number.isSafeInteger(value.conversationId);

/** Checks the view's shape; the documents' and entries' payloads remain owned by pi-durable's typed state. */
const parseConversationView = (value: unknown): ConversationView => {
  if (
    !isRecord(value) ||
    !isRecord(value.conversation) ||
    !Array.isArray(value.entries) ||
    !value.entries.every(isEntryRecord) ||
    !isRecord(value.docs) ||
    !Object.values(value.docs).every(isRecord) ||
    (value.before !== undefined && !Number.isSafeInteger(value.before))
  ) {
    throw new Error("Conversation view payload is invalid");
  }
  return value as unknown as ConversationView;
};

/** Validate the application envelope. View and entry payloads remain owned by pi-durable's typed state. */
export function parseServerEventEnvelope(message: string): ServerEvent {
  const value: unknown = JSON.parse(message);
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Server message is not an event object");
  }

  switch (value.type) {
    case "session.snapshot": {
      if (!isRecord(value.session) || !Array.isArray(value.session.conversations)) {
        throw new Error("Session snapshot payload is invalid");
      }
      const conversations = value.session.conversations.map(parseConversationSummary);
      return {
        type: value.type,
        session: {
          conversations,
          ...(value.session.activity === undefined
            ? {}
            : { activity: parseTaskGraph(value.session.activity) }),
        },
      };
    }
    case "conversation.created":
      return { type: value.type, conversation: parseConversationSummary(value.conversation) };
    case "session.activity":
      return { type: value.type, activity: parseTaskGraph(value.activity) };
    case "conversation.view": {
      const conversationId = requireId(value.conversationId, "conversationId");
      return { type: value.type, conversationId, view: parseConversationView(value.view) };
    }
    case "conversation.ops": {
      const conversationId = requireId(value.conversationId, "conversationId");
      if (!Array.isArray(value.ops)) throw new Error("Conversation ops payload is invalid");
      // Ops are applied as paths into the view, so each must be well formed and free of prototype segments.
      for (const op of value.ops) assertValidOp(op);
      return { type: value.type, conversationId, ops: value.ops as readonly Op[] };
    }
    case "conversation.entries": {
      const requestId = requireRequestId(value.requestId);
      const conversationId = requireId(value.conversationId, "conversationId");
      if (!Array.isArray(value.entries) || !value.entries.every(isEntryRecord)) {
        throw new Error("Conversation entries payload is invalid");
      }
      if (value.next !== undefined && !isRecord(value.next)) {
        throw new Error("Conversation entries cursor is invalid");
      }
      return {
        type: value.type,
        requestId,
        conversationId,
        entries: value.entries as unknown as readonly EntryRecord[],
        ...(value.next === undefined ? {} : { next: value.next as Cursor }),
      };
    }
    case "presence.typing": {
      const conversationId = requireId(value.conversationId, "conversationId");
      if (
        !Array.isArray(value.usernames) ||
        !value.usernames.every((username) => typeof username === "string")
      ) {
        throw new Error("Typing presence payload is invalid");
      }
      return { type: value.type, conversationId, usernames: value.usernames };
    }
    case "command.result": {
      const requestId = requireRequestId(value.requestId);
      const command = requireCommandType(value.command);
      if (value.ok === true) {
        const conversationId = optionalId(value.conversationId, "conversationId");
        const submissionId = optionalId(value.submissionId, "submissionId");
        return {
          type: value.type,
          command,
          requestId,
          ok: true,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(submissionId === undefined ? {} : { submissionId }),
        };
      }
      if (value.ok === false) {
        return {
          type: value.type,
          command,
          requestId,
          ok: false,
          error: requireError(value.error),
        };
      }
      throw new Error("Command result payload is invalid");
    }
    case "error":
      return { type: value.type, error: requireError(value.error) };
    default:
      throw new Error(`Unknown server event: ${value.type}`);
  }
}
