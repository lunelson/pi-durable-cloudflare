import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ConversationTranscript,
  type EntryLoader,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  conversationSnapshot,
  initialSessionState,
  sessionReducer,
  type SessionState,
} from "../src/client/session-state.ts";
import { parseServerEventEnvelope, formatScheduledInstruction } from "../src/protocol.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "faux",
  provider: "faux",
  model: "faux",
  usage,
  stopReason: "stop",
  timestamp: 2,
});

const event = (value: unknown) => parseServerEventEnvelope(JSON.stringify(value));

const noHistory: EntryLoader = async () => ({ items: [] });

/** A conversation view as the server sends it: entries in its window, documents keyed by kind. */
const view = (
  entries: readonly unknown[],
  docs: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({
  type: "conversation.view",
  conversationId: 1,
  view: { conversation: { id: 1 }, entries, docs, ...extra },
});

const ops = (value: readonly unknown[]) => ({
  type: "conversation.ops",
  conversationId: 1,
  ops: value,
});

const apply = (state: SessionState, ...values: unknown[]): SessionState =>
  values.reduce<SessionState>(
    (current, value) => sessionReducer(current, { type: "event", event: event(value) }),
    state,
  );

/** What the client renders: the replica merged into a transcript, as `usePiSession` does. */
const rendered = (
  state: SessionState,
  conversationId = 1,
  transcript = new ConversationTranscript(noHistory),
) =>
  conversationSnapshot(
    transcript.merge(state.views[conversationId]!),
    state.typing[conversationId],
  );

const userEntry = (id: number, content: string) => ({
  id,
  conversationId: 1,
  kind: "pi.user",
  model: [{ role: "user", content, timestamp: 1 }],
});

describe("session view reducer", () => {
  it("hydrates a late join and applies streamed view operations", () => {
    let state = apply(
      initialSessionState,
      { type: "session.snapshot", session: { conversations: [{ id: 1 }] } },
      view([userEntry(2, "Hello")], {
        "pi.live": {
          run: { taskId: 3, inputs: [3], turns: 0 },
          generation: { attempt: 1, message: assistant("Hel") },
        },
        "pi.agent": { thinkingLevel: "off", tools: [] },
        "pi.usage": { models: {}, tools: {} },
      }),
    );

    expect(rendered(state)).toMatchObject({
      entries: [{ role: "user", text: "Hello" }],
      live: { active: true, text: "Hel" },
      tools: [],
      agent: { thinkingLevel: "off", tools: [] },
      usage: { models: {}, tools: {} },
    });

    state = apply(
      state,
      ops([["a", ["docs", "pi.live", "generation", "message", "content", 0, "text"], "lo"]]),
    );
    expect(rendered(state).live).toMatchObject({ active: true, text: "Hello" });

    state = apply(
      state,
      ops([
        [
          "p",
          ["entries"],
          1,
          0,
          [{ id: 4, conversationId: 1, kind: "pi.assistant", model: [assistant("Hello")] }],
        ],
        ["d", ["docs", "pi.live", "run"]],
        ["d", ["docs", "pi.live", "generation"]],
      ]),
    );
    expect(rendered(state)).toMatchObject({
      entries: [
        { role: "user", text: "Hello" },
        { role: "assistant", text: "Hello" },
      ],
      live: null,
    });
  });

  it("keeps entries that leave the window and loads earlier history on demand", async () => {
    const pages: unknown[] = [];
    const transcript = new ConversationTranscript(async (query, limit) => {
      pages.push({ query, limit });
      return { items: [userEntry(1, "First")] as unknown as EntryRecord[] };
    });
    let state = apply(initialSessionState, view([userEntry(2, "Second")], {}, { before: 1 }));
    expect(rendered(state, 1, transcript)).toMatchObject({
      earlier: true,
      entries: [{ text: "Second" }],
    });

    // The window drops its oldest entry; the transcript keeps it.
    state = apply(
      state,
      ops([
        ["p", ["entries"], 0, 1, [userEntry(3, "Third")]],
        ["s", ["before"], 2],
      ]),
    );
    expect(rendered(state, 1, transcript).entries.map(({ text }) => text)).toEqual([
      "Second",
      "Third",
    ]);

    await transcript.loadEarlier(BACKGROUND_CONTEXT);
    expect(pages).toEqual([{ query: { maxEntryId: 1, order: "descending" }, limit: 50 }]);
    expect(rendered(state, 1, transcript)).toMatchObject({
      earlier: false,
      entries: [{ text: "First" }, { text: "Second" }, { text: "Third" }],
    });
  });

  it("shows a gap when a new view does not continue the transcript", () => {
    const transcript = new ConversationTranscript(noHistory);
    let state = apply(initialSessionState, view([userEntry(2, "Before")]));
    rendered(state, 1, transcript);
    // A reconnect after more than a window of entries: the new view starts well past the newest entry held.
    state = apply(state, view([userEntry(90, "After")], {}, { before: 89 }));
    expect(rendered(state, 1, transcript)).toMatchObject({
      entries: [{ text: "Before" }, { text: "After" }],
      gaps: [{ kind: "gap", after: 2, upTo: 90 }],
    });
  });

  it("labels scheduled deliveries rather than user messages", () => {
    const state = apply(
      initialSessionState,
      view([
        userEntry(
          2,
          formatScheduledInstruction({ id: "schedule:2", instruction: "Look outside the window" }),
        ),
        userEntry(
          3,
          formatScheduledInstruction({
            id: "schedule:3",
            instruction: "Check again tomorrow",
            recurrence: { cadence: { unit: "day", interval: 1 }, timezone: "Europe/Vienna" },
          }),
        ),
      ]),
    );

    expect(rendered(state).entries).toEqual([
      expect.objectContaining({
        role: "scheduled",
        text: "Look outside the window",
        canFork: false,
      }),
      expect.objectContaining({ role: "scheduled", text: "Check again tomorrow", canFork: false }),
    ]);
  });

  it("labels compaction and reset entries in place and strips the summary wrapper", () => {
    const state = apply(
      initialSessionState,
      view([
        userEntry(2, "Before the summary"),
        {
          id: 5,
          conversationId: 1,
          kind: "pi.compaction",
          head: 3,
          model: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nUser asked about weather.\n</summary>",
                },
              ],
              timestamp: 1,
            },
          ],
          data: { reason: "threshold" },
        },
        { id: 6, conversationId: 1, kind: "pi.reset", head: 6 },
        {
          id: 7,
          conversationId: 1,
          kind: "pi.reset",
          head: 7,
          model: [{ role: "user", content: "Continue from the handoff.", timestamp: 2 }],
        },
      ]),
    );

    // 1.5.0 views keep the history before a head marker: the marker sits where it was written.
    expect(rendered(state).entries).toEqual([
      expect.objectContaining({ role: "user", text: "Before the summary" }),
      expect.objectContaining({
        role: "compaction",
        text: "User asked about weather.",
        canFork: false,
      }),
      expect.objectContaining({ role: "reset", text: "Context reset", canFork: false }),
      expect.objectContaining({
        role: "reset",
        text: "Continue from the handoff.",
        canFork: false,
      }),
    ]);
  });

  it("omits the rendered diagnostics block from tool result text", () => {
    const diagnostics = [{ severity: "warn", code: "truncated", message: "Output truncated" }];
    const state = apply(
      initialSessionState,
      view([
        {
          id: 4,
          conversationId: 1,
          kind: "pi.tool-result",
          model: [
            {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "get_weather",
              content: [
                { type: "text", text: "Sunny" },
                { type: "text", text: "<harness>\n[warn] Output truncated\n</harness>" },
              ],
              details: { source: "cache" },
              isError: false,
              timestamp: 1,
            },
          ],
          data: { diagnostics },
        },
      ]),
    );

    expect(rendered(state).entries).toEqual([
      expect.objectContaining({
        role: "tool",
        text: "Sunny",
        diagnostics,
        toolResult: {
          callId: "call-1",
          name: "get_weather",
          isError: false,
          details: { source: "cache" },
        },
      }),
    ]);
  });

  it("keeps assistant tool calls structured instead of repeating them as transcript text", () => {
    const state = apply(
      initialSessionState,
      view([
        {
          id: 3,
          conversationId: 1,
          kind: "pi.assistant",
          model: [
            {
              ...assistant("I will check."),
              content: [
                { type: "text", text: "I will check." },
                {
                  type: "toolCall",
                  id: "call-1",
                  name: "get_weather",
                  arguments: { location: "Vienna" },
                },
              ],
            },
          ],
        },
      ]),
    );

    expect(rendered(state).entries).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "I will check.",
        toolCalls: [{ callId: "call-1", name: "get_weather", args: { location: "Vienna" } }],
      }),
    ]);
  });

  it("tracks live compactions from pi.live", () => {
    let state = apply(
      initialSessionState,
      view([], {
        "pi.live": {
          compactions: [
            { taskId: 8, trigger: "threshold", blocking: false, attempt: 1 },
            { taskId: 9, trigger: "overflow", blocking: true, attempt: 1 },
          ],
        },
      }),
    );
    expect(rendered(state).compactions).toEqual([
      { taskId: 8, reason: "threshold", blocking: false },
      { taskId: 9, reason: "overflow", blocking: true },
    ]);

    state = apply(state, ops([["d", ["docs", "pi.live", "compactions"]]]));
    expect(rendered(state).compactions).toEqual([]);
  });

  it("does not change the selected conversation for prompt acknowledgements", () => {
    let state = sessionReducer(initialSessionState, { type: "select", conversationId: 2 });
    state = apply(state, {
      type: "command.result",
      command: "prompt.submit",
      requestId: "prompt-1",
      ok: true,
      conversationId: 1,
      submissionId: 3,
    });
    expect(state.activeConversationId).toBe(2);

    state = apply(state, {
      type: "command.result",
      command: "conversation.create",
      requestId: "create-1",
      ok: true,
      conversationId: 4,
    });
    expect(state.activeConversationId).toBe(4);
  });

  it("tracks the session activity graph from snapshots and updates", () => {
    let state = apply(initialSessionState, {
      type: "session.snapshot",
      session: {
        conversations: [{ id: 1 }],
        activity: {
          tasks: {
            "4": {
              id: 4,
              kind: "pi.generation",
              conversationId: 1,
              background: false,
              abortRequested: false,
              state: { status: "running", phase: "stream" },
              conversations: [],
            },
          },
        },
      },
    });

    expect(state.activity?.tasks["4"]).toMatchObject({
      kind: "pi.generation",
      state: { status: "running", phase: "stream" },
    });

    const sleeping = {
      id: 6,
      kind: "app.deliver-scheduled-instruction",
      conversationId: 1,
      background: true,
      abortRequested: false,
      state: { status: "sleeping", phase: "wait", until: 1_800_000_000_000 },
      conversations: [],
    };
    state = apply(state, { type: "session.activity", activity: { tasks: { "6": sleeping } } });
    expect(state.activity).toEqual({ tasks: { "6": sleeping } });
    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: { "6": { ...sleeping, state: { status: "sleeping", phase: "wait" } } },
        },
      }),
    ).toThrow("Activity sleeping task state is invalid");
    expect(
      event({
        type: "session.activity",
        activity: { tasks: { "6": { ...sleeping, blocked: "missing_task" } } },
      }),
    ).toMatchObject({ activity: { tasks: { "6": { blocked: "missing_task" } } } });
    // 1.5.0 ends restart-limited tasks instead of parking them, so `restart_limit` is no longer a blocked reason.
    for (const blocked of ["restart_limit", "tired"]) {
      expect(() =>
        event({
          type: "session.activity",
          activity: { tasks: { "6": { ...sleeping, blocked } } },
        }),
      ).toThrow("Activity task blocked reason is invalid");
    }

    state = apply(state, { type: "session.activity", activity: { tasks: {} } });
    expect(state.activity).toEqual({ tasks: {} });

    expect(() =>
      event({
        type: "session.activity",
        activity: {
          tasks: {
            "4": {
              id: 5,
              kind: "pi.generation",
              conversationId: 1,
              background: false,
              abortRequested: false,
              state: { status: "running", phase: "stream" },
              conversations: [],
            },
          },
        },
      }),
    ).toThrow("Activity task key does not match its id");
  });

  it("keeps conversation owners in the session snapshot", () => {
    const state = apply(initialSessionState, {
      type: "session.snapshot",
      session: { conversations: [{ id: 1 }, { id: 7, owner: { conversationId: 1 } }] },
    });
    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
    expect(() =>
      event({
        type: "session.snapshot",
        session: { conversations: [{ id: 7, owner: { conversationId: "1" } }] },
      }),
    ).toThrow("conversation.owner.conversationId must be a positive integer");
  });

  it("adds a committed subagent conversation without replacing the session snapshot", () => {
    const state = apply(
      initialSessionState,
      { type: "session.snapshot", session: { conversations: [{ id: 1 }] } },
      { type: "conversation.created", conversation: { id: 7, owner: { conversationId: 1 } } },
    );

    expect(state.conversations).toEqual([{ id: 1 }, { id: 7, owner: { conversationId: 1 } }]);
  });

  it("rejects command results without a valid command discriminator", () => {
    expect(() =>
      event({
        type: "command.result",
        requestId: "prompt-1",
        ok: true,
        conversationId: 1,
      }),
    ).toThrow("Command result command is invalid");
  });

  it("rejects malformed views and unsafe operations", () => {
    expect(() =>
      event({ type: "conversation.view", conversationId: 1, view: { entries: [] } }),
    ).toThrow("Conversation view payload is invalid");
    expect(() => event(ops([["s", ["__proto__", "polluted"], true]]))).toThrow();
    expect(() => event(ops([["x"]]))).toThrow();
  });

  it("tracks tool progress, usage, and configuration from documents", () => {
    let state = apply(
      initialSessionState,
      view([], {
        "pi.live": {
          run: { taskId: 3, inputs: [2], turns: 1 },
          tools: [
            {
              callId: "call-1",
              name: "search",
              status: "running",
              taskId: 7,
              output: "searching",
              details: { matches: 2 },
              diagnostics: [{ severity: "info", message: "Using cached index" }],
            },
          ],
        },
        "pi.agent": { thinkingLevel: "off", tools: [] },
        "pi.usage": { models: {}, tools: {} },
      }),
    );
    state = apply(
      state,
      ops([
        ["t", ["docs", "pi.live", "tools", 0, "output"], 6],
        ["a", ["docs", "pi.live", "tools", 0, "output"], "ed"],
        ["s", ["docs", "pi.live", "tools", 0, "status"], "done"],
        [
          "s",
          ["docs", "pi.agent"],
          {
            model: { provider: "openai", modelId: "gpt-test" },
            thinkingLevel: "high",
            tools: ["search"],
          },
        ],
        [
          "s",
          ["docs", "pi.usage", "models", "openai/gpt-test"],
          {
            ...usage,
            input: 10,
            output: 5,
            totalTokens: 15,
            cost: { ...usage.cost, total: 0.0125 },
          },
        ],
      ]),
    );

    expect(rendered(state)).toMatchObject({
      tools: [
        {
          callId: "call-1",
          name: "search",
          status: "done",
          output: "inged",
          details: { matches: 2 },
          diagnostics: [{ severity: "info", message: "Using cached index" }],
        },
      ],
      agent: {
        model: { provider: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
        tools: ["search"],
      },
      usage: { models: { "openai/gpt-test": { input: 10, output: 5, totalTokens: 15 } } },
    });

    state = apply(state, ops([["d", ["docs", "pi.live", "tools"]]]));
    expect(rendered(state).tools).toEqual([]);
  });

  it("surfaces why a run ended without an answer until another run starts", () => {
    let state = apply(
      initialSessionState,
      view([], {
        "pi.live": {
          runFailure: { taskId: 9, inputs: [8], reason: "model_error", detail: "boom" },
        },
      }),
    );

    expect(rendered(state).failure).toEqual({
      taskId: 9,
      kind: "Run",
      message: "model_error: boom",
    });

    state = apply(
      state,
      ops([
        [
          "r",
          {
            conversation: { id: 1 },
            entries: [],
            docs: { "pi.live": { run: { taskId: 10, inputs: [10], turns: 0 } } },
          },
        ],
      ]),
    );
    expect(rendered(state).failure).toBeUndefined();
  });

  it("tracks queued inputs from the inbox document until it drains", () => {
    let state = apply(
      initialSessionState,
      view([], {
        "pi.live": { run: { taskId: 3, inputs: [3], turns: 0 } },
        "pi.inbox": { items: [{ id: 5, mode: "followUp", content: "And tomorrow?" }] },
      }),
    );
    expect(rendered(state).queued).toEqual([
      { submissionId: 5, mode: "followUp", text: "And tomorrow?" },
    ]);

    state = apply(state, ops([["p", ["docs", "pi.inbox", "items"], 0, 1, []]]));
    expect(rendered(state).queued).toEqual([]);
  });

  it("tracks typing presence per conversation", () => {
    let state = apply(initialSessionState, {
      type: "presence.typing",
      conversationId: 2,
      usernames: ["Anne", "John"],
    });
    expect(state.typing[2]).toEqual(["Anne", "John"]);

    state = apply(state, { type: "presence.typing", conversationId: 2, usernames: [] });
    expect(state.typing[2]).toEqual([]);
  });
});
