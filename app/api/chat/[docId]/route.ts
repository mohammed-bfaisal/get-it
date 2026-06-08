/**
 * Chat with the document.
 *
 *   GET    /api/chat/[docId]                         → list of chats (full)
 *   POST   /api/chat/[docId] { action:"create", title? }
 *                                                    → new empty chat
 *   POST   /api/chat/[docId] { action:"send", chatId, message }
 *                                                    → user message + assistant reply
 *   DELETE /api/chat/[docId]?chatId=...              → remove a chat
 *
 * After every assistant turn we schedule a knowledge-graph evaluation pass
 * (fire-and-forget) so the user's mastery scores update as soon as the
 * model has finished writing.
 */

import { NextResponse } from "next/server";
import { runJsonInThread, CodexError } from "@/lib/codex";
import { getDoc } from "@/lib/store";
import {
  loadWorkContext,
  saveWorkContext,
  newId,
  type ChatMessage,
} from "@/lib/work-context";
import { chatReplySchema, type ChatReplyResult } from "@/lib/schemas-kg";
import { loadKG } from "@/lib/kg";

export const runtime = "nodejs";
export const maxDuration = 180;

const SYSTEM = `You are Get It.'s study companion for one specific document.

You answer the student's questions about the document accurately and
concisely. You teach with care:

  • If the student is missing a prerequisite, give a 1-line bridge before
    answering.
  • Use plain language; introduce technical terms only when the source did.
  • When the source contradicts a common misconception, name the
    misconception explicitly.
  • Cite page numbers from the document when you reference specific facts.
  • Encourage the student to explain things back to you when their question
    suggests confusion.

LANGUAGE: reply in the same language as the student's most recent message.
If unsure, default to the document's language.

KEEP IT TIGHT: 2–8 short paragraphs is usually plenty. No filler. No
repeating the question.`;

function docContext(docId: string): string {
  const doc = getDoc(docId);
  if (!doc) return "";
  const kg = loadKG(docId);
  const kgPart = kg && kg.status === "ready"
    ? `\nKEY CONCEPTS (knowledge graph):\n${kg.nodes
        .map((n) => `- ${n.label}: ${n.summary}`)
        .join("\n")}\n`
    : "";
  // Full document text — no excerpt cap. Upload caps the document at
  // MAX_PDF_PAGES, and the conversation runs on a persistent Codex thread, so
  // this whole block is sent ONCE on the first turn and reused (cached) for
  // every later turn rather than re-sent each message.
  const fullText = doc.extracted.pages
    .map((p) => `[page ${p.pageIndex + 1}]\n${p.text}`)
    .join("\n\n");
  return `DOCUMENT: ${doc.filename}\n${kgPart}\nDOCUMENT TEXT:\n${fullText}`;
}

function renderHistory(messages: ChatMessage[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "STUDENT" : "ASSISTANT"}: ${m.content}`)
    .join("\n\n");
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const wc = loadWorkContext(docId);
  return NextResponse.json({ chats: wc.chats });
}

type Body =
  | { action: "create"; title?: string }
  | { action: "send"; chatId: string; message: string };

export async function POST(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const body = (await req.json()) as Body;
  const wc = loadWorkContext(docId);

  if (body.action === "create") {
    const now = Date.now();
    const chat = {
      id: newId(),
      title: (body.title ?? "New chat").slice(0, 80),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    wc.chats.unshift(chat);
    saveWorkContext(wc);
    return NextResponse.json({ chat });
  }

  if (body.action === "send") {
    const chat = wc.chats.find((c) => c.id === body.chatId);
    if (!chat) return NextResponse.json({ error: "chat not found" }, { status: 404 });
    const message = body.message?.trim();
    if (!message) return NextResponse.json({ error: "empty message" }, { status: 400 });

    const userMsg: ChatMessage = { role: "user", content: message, ts: Date.now() };
    chat.messages.push(userMsg);
    chat.updatedAt = userMsg.ts;
    // First user message becomes the chat title if not already set.
    if (chat.title === "New chat" && chat.messages.length === 1) {
      chat.title = message.slice(0, 60);
    }
    saveWorkContext(wc);

    // The new turn the student just typed — all that needs to go over the
    // wire when resuming an existing Codex thread.
    const turnInput = `STUDENT: ${message}\n\n--- ASSISTANT REPLY ---\nReply now as ASSISTANT. Output JSON.`;

    let reply: ChatReplyResult | null = null;
    let codexThreadId: string | null = chat.codexThreadId ?? null;

    // Resume the conversation's native Codex thread when we have one: the
    // document + prior turns already live in that thread, so we send only the
    // new message (guaranteed prefix-cache hit, a fraction of the tokens).
    if (chat.codexThreadId) {
      try {
        const { data, threadId } = await runJsonInThread<ChatReplyResult>({
          outputSchema: chatReplySchema,
          opts: { reasoning: "low" },
          resume: { threadId: chat.codexThreadId, input: turnInput },
        });
        reply = data;
        codexThreadId = threadId ?? chat.codexThreadId;
      } catch (e) {
        // Rate-limit / auth / binary: let the health banner take over.
        if (e instanceof CodexError && e.kind !== "generic") throw e;
        // Generic failure (e.g. the session expired / was evicted from
        // ~/.codex/sessions, or OpenRouter reported that it is stateless):
        // fall through and rebuild with full local context so the answer never
        // silently degrades.
        reply = null;
      }
    }

    // No thread yet (first turn) or the resume failed: open a fresh thread and
    // seed it with the full context — system prompt + whole document + the
    // conversation so far. Stable prefix first, the latest turn last.
    if (!reply) {
      const fullInput = `${SYSTEM}\n\n${docContext(docId)}\n\n--- CONVERSATION SO FAR ---\n${renderHistory(
        chat.messages,
      )}\n\n--- ASSISTANT REPLY ---\nReply now as ASSISTANT. Output JSON.`;
      const { data, threadId } = await runJsonInThread<ChatReplyResult>({
        outputSchema: chatReplySchema,
        opts: { reasoning: "low" },
        start: { input: fullInput },
      });
      reply = data;
      codexThreadId = threadId;
    }

    const reloaded = loadWorkContext(docId);
    const liveChat = reloaded.chats.find((c) => c.id === chat.id);
    if (!liveChat) return NextResponse.json({ error: "chat vanished" }, { status: 500 });
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: reply.reply,
      ts: Date.now(),
    };
    liveChat.messages.push(assistantMsg);
    liveChat.updatedAt = assistantMsg.ts;
    if (codexThreadId) liveChat.codexThreadId = codexThreadId;
    saveWorkContext(reloaded);

    // NB: the knowledge-graph evaluation is intentionally NOT scheduled here.
    // The client triggers a single pass when the student leaves the Chat tab
    // (see viewer-client), so a multi-message, multi-thread chat session costs
    // exactly one evaluation instead of one per reply.

    return NextResponse.json({
      chat: liveChat,
      reply: assistantMsg,
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  const { docId } = await ctx.params;
  if (!getDoc(docId)) {
    return NextResponse.json({ error: "doc not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const chatId = url.searchParams.get("chatId");
  if (!chatId) return NextResponse.json({ error: "chatId required" }, { status: 400 });
  const wc = loadWorkContext(docId);
  wc.chats = wc.chats.filter((c) => c.id !== chatId);
  saveWorkContext(wc);
  return NextResponse.json({ ok: true });
}
