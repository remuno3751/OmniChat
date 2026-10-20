import { randomUUID } from "node:crypto";
import { api, connectWs, requireAuth } from "../client.mjs";
import { defaultAsk } from "../prompt.mjs";
import { CliError, UsageError, oneOf, readAll, truncate } from "../util.mjs";
import { fetchGroups, resolveModel } from "./models.mjs";
import { fetchSync, findProject, resolveConversation } from "./sync.mjs";


async function readMessage(ctx, pos) {
  const parts = [];
  let usedStdin = false;
  for (const p of pos) {
    if (p === "-") {
      if (!usedStdin) parts.push((await readAll(ctx.io.stdin)).replace(/\s+$/, ""));
      usedStdin = true;
    } else parts.push(p);
  }
  if (parts.length === 0) {
    if (ctx.io.stdinIsTTY) throw new UsageError('usage: omnichat chat "<message>"  (or pipe the message on stdin / use "-")');
    parts.push((await readAll(ctx.io.stdin)).replace(/\s+$/, ""));
  }
  const msg = parts.join("\n\n");
  if (!msg.trim()) throw new UsageError("the message is empty");
  return msg;
}

function summarizeArgs(args) {
  let s;
  try { s = typeof args === "string" ? args : JSON.stringify(args); } catch { s = String(args); }
  return truncate(s ?? "", 80);
}

export async function chatCommand(ctx, pos) {
  const f = ctx.flags;
  if (f.conv && f.new) throw new UsageError("--conv and --new are mutually exclusive");
  oneOf(f.effort, ["low", "medium", "high", "max"], "effort");
  oneOf(f.search, ["off", "auto", "always"], "search");
  oneOf(f.approve, ["once", "always", "deny"], "approve");
  const message = await readMessage(ctx, pos);
  requireAuth(ctx);
  ctx.secrets.add(ctx.token);

  const needSync = !!(f.conv || f.project || !f.model);
  const sync = needSync ? await fetchSync(ctx) : null;

  // Conversation
  let existing = null;
  if (f.conv) existing = resolveConversation(sync, f.conv);
  const convId = existing ? existing.id : randomUUID();

  // Project
  let project = null;
  if (f.project) {
    project = findProject(sync, f.project);
    if (!project) {
      if (!f.createProject) {
        const names = sync.projects.map((p) => `  ${p.name}`).join("\n") || "  (none)";
        throw new CliError(`project "${f.project}" not found; pass --create-project to create it. Existing projects:\n${names}`);
      }
      project = await api(ctx, "PUT", `/projects/${randomUUID()}`, { body: { name: f.project } });
      ctx.info(`created project "${project.name}"`);
    }
  }

  // Model target
  let target = null;
  if (f.model) {
    target = resolveModel(f.model, await fetchGroups(ctx));
  } else if (existing?.providerId && existing?.model) {
    target = { providerId: existing.providerId, model: existing.model };
  } else if (project?.defaultProviderId && project?.defaultModel) {
    target = { providerId: project.defaultProviderId, model: project.defaultModel };
  } else {
    const p = sync.providers[0];
    if (!p) throw new CliError("no provider configured: add one in the OmniChat app, then use `omnichat models`");
    target = { providerId: p.id, model: p.model };
    ctx.debug(`no --model: using first provider ${p.name}/${p.model}`);
  }

  // Create / update the conversation
  const body = {};
  if (!existing || f.model) {
    body.providerId = target.providerId;
    body.model = target.model;
  }
  if (project) body.projectId = project.id;
  if (f.system != null) body.systemPrompt = f.system;
  if (f.search) body.searchMode = f.search;
  if (!existing || Object.keys(body).length > 0) {
    await api(ctx, "PUT", `/conversations/${convId}`, { body });
  }

  const conn = await connectWs(ctx);
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const result = await stream(ctx, conn, {
    frame: {
      type: "send",
      conversationId: convId,
      content: message,
      userMessageId,
      assistantMessageId,
      ...(f.effort ? { effort: f.effort } : {}),
    },
    assistantMessageId,
  });
  await conn.close();
  return finish(ctx, result, convId);
}

function stream(ctx, conn, { frame, assistantMessageId }) {
  const f = ctx.flags;
  const live = !f.json;
  const idleMs = (f.idleTimeout ?? 300) * 1000;
  const interactive = !f.approve && ctx.io.stdinIsTTY && ctx.io.stderrIsTTY;
  let printed = "";
  let reasoningStarted = false;
  let interrupted = false;
  let finished = false;
  let idle;
  let stopTimer;
  const seenTool = new Set();
  let approvalChain = Promise.resolve();

  return new Promise((resolve) => {
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(idle);
      clearTimeout(stopTimer);
      offSigint();
      resolve({ ...r, interrupted, printed });
    };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        done({ status: "timeout", error: `no data from the server for ${idleMs / 1000}s (use --idle-timeout to wait longer)` });
      }, idleMs);
    };
    const offSigint = ctx.io.onSigint(() => {
      if (interrupted) return done({ status: "stopped" });
      interrupted = true;
      try { conn.send({ type: "stop", messageId: assistantMessageId }); } catch { /* socket gone */ }
      ctx.info("interrupted: asking the server to stop (press Ctrl+C again to exit immediately)");
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => done({ status: "stopped" }), 3000);
    });

    const writeText = (t) => {
      printed += t;
      if (live) ctx.out(t);
    };

    const handleApproval = async (fr) => {
      let decision = f.approve ?? "deny";
      const perms = (fr.permissions ?? []).join(",");
      const what = `${fr.tool}(${summarizeArgs(fr.arguments)})${perms ? ` [${perms}]` : ""}`;
      if (interactive) {
        const ask = ctx.io.ask ?? ((q) => defaultAsk(q, ctx.io));
        const ans = (await ask(`Allow tool ${what}? [y]es once / [a]lways / [N]o: `)).trim().toLowerCase();
        if (ans === "\u0003") {
          decision = "deny";
          ctx.io.interrupt?.();
        } else if (ans === "y" || ans === "yes") decision = "once";
        else if (ans === "a" || ans === "always") decision = "always";
        else decision = "deny";
      } else if (!f.approve) {
        ctx.info(`tool ${what} needs approval: denied (non-interactive; use --approve once|always)`);
      } else {
        ctx.info(`tool ${what}: approval ${decision} (--approve)`);
      }
      if (!finished) conn.send({ type: "tool_approval_reply", approvalId: fr.approvalId, decision });
    };

    const onFrame = (fr) => {
      resetIdle();
      switch (fr.type) {
        case "delta": {
          if (fr.messageId !== assistantMessageId) return;
          if (fr.kind === "reasoning") {
            if (f.thinking) {
              if (!reasoningStarted) { ctx.err(ctx.style.dim("[thinking]")); reasoningStarted = true; }
              ctx.errRaw(ctx.style.dim(fr.text));
            }
          } else {
            if (reasoningStarted) { ctx.io.stderr.write("\n"); reasoningStarted = false; }
            writeText(fr.text);
          }
          return;
        }
        case "snapshot": {
          const m = (fr.messages ?? []).find((x) => x.id === assistantMessageId);
          if (!m || typeof m.content !== "string") return;
          if (m.content === "" && printed) {
            // A tool round ended: the server drops intermediate text. Keep what was shown, separate it.
            if (!printed.endsWith("\n")) writeText("\n");
          } else if (m.content.length > printed.length && m.content.startsWith(printed)) {
            writeText(m.content.slice(printed.length));
          }
          return;
        }
        case "tool": {
          if (fr.messageId !== assistantMessageId || !fr.call) return;
          const c = fr.call;
          const key = `${c.id}:${c.status}`;
          if (seenTool.has(key) || c.status === "pending") return;
          seenTool.add(key);
          let line = `[tool] ${c.name} `;
          if (c.status === "running") line += `${summarizeArgs(c.arguments)} ...`;
          else if (c.status === "done") line += `done${c.durationMs != null ? ` (${c.durationMs} ms)` : ""}: ${truncate(c.result ?? "", 60)}`;
          else line += `${c.status}${c.error ? `: ${truncate(c.error, 80)}` : ""}`;
          ctx.info(line);
          return;
        }
        case "tool_approval": {
          if (fr.messageId !== assistantMessageId) return;
          approvalChain = approvalChain.then(() => handleApproval(fr)).catch((e) => ctx.err(`approval error: ${e.message}`));
          return;
        }
        case "upsert": {
          const m = (fr.messages ?? []).find((x) => x.id === assistantMessageId);
          if (m && m.status && m.status !== "streaming") done({ status: m.status, message: m });
          return;
        }
        case "error": {
          done({ status: "frame-error", code: fr.code, error: fr.message || "server error" });
          return;
        }
        default:
      }
    };
    const onClose = (info) => {
      if (info?.code === 4001) done({ status: "closed", error: "this device was revoked by the server: run `omnichat login`" });
      else done({ status: "closed", error: "connection closed before the reply finished" });
    };

    ctx.io.interrupt = () => {
      // used by the interactive prompt when Ctrl+C is pressed at the question
      if (!interrupted) {
        interrupted = true;
        try { conn.send({ type: "stop", messageId: assistantMessageId }); } catch { /* ignore */ }
        clearTimeout(stopTimer);
        stopTimer = setTimeout(() => done({ status: "stopped" }), 3000);
      }
    };
    resetIdle();
    conn.listen(onFrame, onClose);
    conn.send(frame);
  });
}

function finish(ctx, r, convId) {
  const f = ctx.flags;
  const msg = r.message;
  // Show any text the live stream missed (e.g. only delivered in the final message).
  if (msg && !f.json && typeof msg.content === "string" && msg.status !== "error") {
    if (msg.content.length > r.printed.length && msg.content.startsWith(r.printed)) {
      ctx.out(msg.content.slice(r.printed.length));
      r.printed = msg.content;
    } else if (!r.printed && msg.content) {
      ctx.out(msg.content);
      r.printed = msg.content;
    }
  }
  const endNl = () => { if (r.printed && !r.printed.endsWith("\n")) ctx.out("\n"); };

  if (f.json) {
    const status = r.interrupted ? "stopped" : r.status;
    ctx.out(JSON.stringify({
      conversationId: convId,
      status,
      message: msg ?? null,
      metrics: msg?.metrics ?? null,
      ...(r.error ? { error: r.error } : {}),
    }, null, 2) + "\n");
  } else {
    endNl();
  }

  if (r.interrupted) {
    ctx.info("stopped");
    return 130;
  }
  if (r.status === "frame-error") {
    if (r.code === "context_overflow") {
      ctx.err(`${ctx.style.red("error")}: context window exceeded: ${r.error}\n  Start a new conversation (--new), shorten the message, or set the context overflow behaviour to "truncate" in OmniChat settings.`);
    } else {
      ctx.err(`${ctx.style.red("error")}: ${r.error}`);
    }
    return 1;
  }
  if (r.status === "error") {
    ctx.err(`${ctx.style.red("error")}: ${msg?.content || "generation failed"}`);
    return 1;
  }
  if (r.status === "timeout" || r.status === "closed") {
    ctx.err(`${ctx.style.red("error")}: ${r.error}`);
    return 1;
  }
  if (r.status === "stopped") {
    ctx.err("the reply was stopped (by another device or the server)");
    return 1;
  }

  if (!f.json && !f.noSources && Array.isArray(msg?.sources) && msg.sources.length) {
    ctx.out("\n" + msg.sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n") + "\n");
  }
  const m = msg?.metrics;
  if (f.stats && m) {
    const bits = [];
    if (m.ttftMs != null) bits.push(`ttft ${Math.round(m.ttftMs)} ms`);
    if (m.decodeTps != null) bits.push(`decode ${Number(m.decodeTps).toFixed(1)} tok/s`);
    if (m.completionTokens != null) bits.push(`${m.completionTokens} tokens`);
    if (bits.length) ctx.info(bits.join(", "));
  }
  ctx.info(`conversation: ${convId}`);
  return 0;
}
