// Local openAGI Kanban board.
//
// This database is intentionally local to one openAGI installation at
// <dataDir>/kanban.db. A future shared Legion board (including any
// ~/.hermes/kanban.db instance) is outside this module's scope.
//
// SQLite is the authoritative state. Each committed mutation is also written
// to an append-only JSONL audit log and projected to an atomic JSON snapshot
// through file-utils.js so operators retain the standard openAGI durability
// and inspection surfaces.

import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  appendJsonLine,
  ensureDir,
  writeJsonAtomic
} from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { readOrCreateIdentity } from "./node-registry.js";
import { createId, nowIso } from "./utils.js";

export const KANBAN_COLUMNS = [
  "backlog",
  "in-progress",
  "blocked",
  "review",
  "done"
];

const RUN_STATES = new Set(["running", "heartbeat", "review", "succeeded", "failed"]);
const LINK_RELATIONS = new Set(["related", "blocked_by"]);
const DEFAULT_BOARD_ID = "default";
const DEFAULT_BOARD_NAME = "Default";
const PROCESS_STARTED_AT = new Date(Date.now() - (process.uptime() * 1000)).toISOString();

let sqliteModule = null;

async function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
    return sqliteModule;
  } catch {
    sqliteModule = null;
    return null;
  }
}

export class KanbanStore {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.dbPath = options.dbPath ?? path.join(this.dataDir, "kanban.db");
    this.auditDir = options.auditDir ?? path.join(this.dataDir, "kanban");
    this.eventsPath = path.join(this.auditDir, "events.jsonl");
    this.snapshotPath = path.join(this.auditDir, "snapshot.json");
    this.forceUnavailable = options.sqlite === false;
    this.db = null;
    this.unavailableReason = null;
    ensureDir(this.dataDir);
    ensureDir(this.auditDir);
    this.installIdentity = readOrCreateIdentity(this.dataDir);
    this.ready = this.init();
  }

  async init() {
    const sqlite = this.forceUnavailable ? null : await loadSqlite();
    if (!sqlite) {
      this.unavailableReason = "node:sqlite is unavailable; Kanban requires Node 22.5 or newer";
      return;
    }
    try {
      this.db = new sqlite.DatabaseSync(this.dbPath);
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS boards (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          assignee TEXT,
          status TEXT NOT NULL,
          block_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS kanban_tasks_board_status
          ON tasks(board_id, status, updated_at);
        CREATE INDEX IF NOT EXISTS kanban_tasks_assignee
          ON tasks(assignee, status);

        CREATE TABLE IF NOT EXISTS comments (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          author TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS kanban_comments_task
          ON comments(task_id, created_at);

        CREATE TABLE IF NOT EXISTS workers (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL,
          node_name TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          pid INTEGER NOT NULL,
          ppid INTEGER,
          hostname TEXT NOT NULL,
          cwd TEXT NOT NULL,
          exec_path TEXT NOT NULL,
          platform TEXT NOT NULL,
          arch TEXT NOT NULL,
          node_version TEXT NOT NULL,
          process_started_at TEXT NOT NULL,
          session_id TEXT,
          channel TEXT,
          sender TEXT,
          first_seen_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE RESTRICT,
          attempt INTEGER NOT NULL,
          state TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          ended_at TEXT,
          UNIQUE(task_id, attempt)
        );

        CREATE INDEX IF NOT EXISTS kanban_runs_task
          ON runs(task_id, attempt);

        CREATE TABLE IF NOT EXISTS handoffs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          worker_id TEXT REFERENCES workers(id) ON DELETE SET NULL,
          from_assignee TEXT,
          to_assignee TEXT NOT NULL,
          reason TEXT,
          summary TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS kanban_handoffs_task
          ON handoffs(task_id, created_at);

        CREATE TABLE IF NOT EXISTS task_links (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          linked_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(task_id, linked_task_id, relation)
        );

        CREATE INDEX IF NOT EXISTS kanban_links_task
          ON task_links(task_id, relation);
      `);
      this._ensureColumn("handoffs", "summary", "TEXT");
      this._ensureColumn("handoffs", "metadata_json", "TEXT NOT NULL DEFAULT '{}'");
      this._ensureBoard(DEFAULT_BOARD_ID, DEFAULT_BOARD_NAME);
    } catch (error) {
      try { this.db?.close?.(); } catch { /* best effort */ }
      this.db = null;
      this.unavailableReason = `Kanban SQLite initialization failed: ${error.message}`;
      console.error(`[openagi] kanban: ${this.unavailableReason}`);
    }
  }

  async createTask(input = {}, context = {}) {
    await this._requireReady();
    const title = requiredText(input.title, "Kanban task title", 300);
    const body = optionalText(input.body, "Kanban task body", 20000);
    const boardId = normalizeBoardId(input.board ?? input.boardId ?? DEFAULT_BOARD_ID);
    const boardName = optionalText(input.boardName, "Kanban board name", 200)
      || (boardId === DEFAULT_BOARD_ID ? DEFAULT_BOARD_NAME : boardId);
    const assignee = normalizeAssignee(input.assignee);
    const blockers = uniqueStrings(input.blockedBy, "blockedBy", 100);
    const requestedStatus = input.status === undefined ? "backlog" : normalizeStatus(input.status);
    if (requestedStatus === "done") {
      throw new Error("Create Kanban tasks before completing them; status 'done' is not valid at creation.");
    }
    const status = blockers.length > 0 ? "blocked" : requestedStatus;
    const createdAt = nowIso();
    const taskId = createId("kanban");
    let task;

    this._transaction(() => {
      this._ensureBoard(boardId, boardName);
      for (const blockerId of blockers) {
        this._requireTaskRow(blockerId);
        if (blockerId === taskId) throw new Error("A Kanban task cannot block itself.");
      }
      this.db.prepare(`
        INSERT INTO tasks (
          id, board_id, title, body, assignee, status, block_reason,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        taskId,
        boardId,
        title,
        body ?? "",
        assignee,
        status,
        blockers.length ? optionalText(input.reason, "Kanban block reason", 2000) : null,
        createdAt,
        createdAt
      );
      for (const blockerId of blockers) {
        this._insertLink(taskId, blockerId, "blocked_by", context, createdAt);
      }
      if (blockers.length > 0 && this._blockedBy(taskId).length === 0) {
        this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(requestedStatus, taskId);
      }
      if (assignee) {
        const worker = this._upsertWorker(context);
        this._insertHandoff({
          taskId,
          workerId: worker.id,
          fromAssignee: context.agentId ?? null,
          toAssignee: assignee,
          reason: "initial assignment",
          createdAt
        });
      }
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "create",
      task,
      previousStatus: null,
      context
    });
    return task;
  }

  async listTasks(options = {}) {
    await this._requireReady();
    const where = [];
    const params = [];
    if (options.board || options.boardId) {
      where.push("board_id = ?");
      params.push(normalizeBoardId(options.board ?? options.boardId));
    }
    if (options.status) {
      where.push("status = ?");
      params.push(normalizeStatus(options.status));
    }
    if (options.assignee) {
      where.push("assignee = ?");
      params.push(normalizeAssignee(options.assignee));
    }
    const limit = clampInteger(options.limit, 1, 500, 100);
    params.push(limit);
    const sql = `
      SELECT id
      FROM tasks
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'in-progress' THEN 0
          WHEN 'blocked' THEN 1
          WHEN 'review' THEN 2
          WHEN 'backlog' THEN 3
          ELSE 4
        END,
        updated_at DESC,
        created_at ASC
      LIMIT ?
    `;
    return this.db.prepare(sql).all(...params).map((row) => this._taskDetail(row.id));
  }

  async listBoards() {
    await this._requireReady();
    return this._listBoardsSync();
  }

  async boardView(options = {}) {
    const [boards, tasks] = await Promise.all([
      this.listBoards(),
      this.listTasks(options)
    ]);
    return {
      columns: [...KANBAN_COLUMNS],
      boards,
      tasks
    };
  }

  async getTask(id) {
    await this._requireReady();
    return this._taskDetail(normalizeTaskId(id));
  }

  async assignTask(id, assignee, context = {}, options = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const nextAssignee = requiredText(assignee, "Kanban assignee", 200);
    const reason = optionalText(options.reason, "Kanban handoff reason", 2000);
    let previousStatus;
    let task;

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task cannot be reassigned.");
      previousStatus = current.status;
      const nextStatus = current.status === "backlog" ? "in-progress" : current.status;
      const at = nowIso();
      const worker = this._upsertWorker(context);
      this.db.prepare(`
        UPDATE tasks
        SET assignee = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run(nextAssignee, nextStatus, at, taskId);
      this._insertHandoff({
        taskId,
        workerId: worker.id,
        fromAssignee: current.assignee,
        toAssignee: nextAssignee,
        reason,
        createdAt: at
      });
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "assign",
      task,
      previousStatus,
      context
    });
    return task;
  }

  async blockTask(id, input = {}, context = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const blockers = uniqueStrings(input.blockedBy, "blockedBy", 100);
    const reason = optionalText(input.reason, "Kanban block reason", 2000);
    let previousStatus;
    let task;

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task cannot be blocked.");
      previousStatus = current.status;
      const at = nowIso();
      for (const blockerId of blockers) {
        if (blockerId === taskId) throw new Error("A Kanban task cannot block itself.");
        this._requireTaskRow(blockerId);
        this._insertLink(taskId, blockerId, "blocked_by", context, at);
      }
      this.db.prepare(`
        UPDATE tasks
        SET status = 'blocked', block_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(reason, at, taskId);
      if (reason) this._insertComment(taskId, reason, context.agentId ?? "system", at);
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "block",
      task,
      previousStatus,
      context
    });
    return task;
  }

  async unblockTask(id, input = {}, context = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const blockerId = input.blockerId === undefined || input.blockerId === null
      ? null
      : normalizeTaskId(input.blockerId);
    let previousStatus;
    let task;

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task cannot be unblocked.");
      previousStatus = current.status;
      if (blockerId) {
        this.db.prepare(`
          DELETE FROM task_links
          WHERE task_id = ? AND linked_task_id = ? AND relation = 'blocked_by'
        `).run(taskId, blockerId);
      } else {
        this.db.prepare(`
          DELETE FROM task_links
          WHERE task_id = ? AND relation = 'blocked_by'
        `).run(taskId);
      }
      const remaining = this._blockedBy(taskId);
      const nextStatus = remaining.length > 0 ? "blocked" : "in-progress";
      const at = nowIso();
      this.db.prepare(`
        UPDATE tasks
        SET status = ?, block_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(nextStatus, remaining.length > 0 ? current.block_reason : null, at, taskId);
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "unblock",
      task,
      previousStatus,
      context
    });
    return task;
  }

  async completeTask(id, input = {}, context = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const summary = optionalText(
      input.summary ?? input.comment,
      "Kanban completion summary",
      5000
    );
    const metadata = normalizeDetail(input.metadata);
    const handoffTo = normalizeAssignee(input.handoffTo);
    let previousStatus;
    let task;
    const unblockedChildren = [];

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task is already complete.");
      const blockers = this._blockedBy(taskId);
      if (current.status === "blocked" || blockers.length > 0) {
        throw new Error(
          blockers.length > 0
            ? `Kanban task ${taskId} is blocked by: ${blockers.join(", ")}. Unblock it before completion.`
            : `Kanban task ${taskId} is blocked. Unblock it before completion.`
        );
      }
      previousStatus = current.status;
      const at = nowIso();
      const worker = this._upsertWorker(context);
      this.db.prepare(`
        UPDATE tasks
        SET status = 'done', block_reason = NULL, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(at, at, taskId);
      this.db.prepare(`
        UPDATE runs
        SET state = CASE WHEN state IN ('running', 'heartbeat', 'review') THEN 'succeeded' ELSE state END,
            heartbeat_at = ?,
            ended_at = CASE WHEN state IN ('running', 'heartbeat', 'review') THEN ? ELSE ended_at END
        WHERE task_id = ? AND ended_at IS NULL
      `).run(at, at, taskId);
      this._insertHandoff({
        taskId,
        workerId: worker.id,
        fromAssignee: current.assignee ?? worker.agentName,
        toAssignee: handoffTo ?? current.assignee ?? "board",
        reason: "completion",
        summary,
        metadata,
        createdAt: at
      });
      if (summary) this._insertComment(taskId, summary, context.agentId ?? "system", at);

      // A completed parent no longer blocks its children. Preserve the
      // dependency edge for history, but advance children whose remaining
      // parents are all done and which have no explicit block reason.
      const children = this.db.prepare(`
        SELECT task_id
        FROM task_links
        WHERE linked_task_id = ? AND relation = 'blocked_by'
      `).all(taskId);
      for (const child of children) {
        const childRow = this._requireTaskRow(child.task_id);
        if (
          childRow.status === "blocked"
          && !childRow.block_reason
          && this._blockedBy(child.task_id).length === 0
        ) {
          this.db.prepare(`
            UPDATE tasks SET status = 'in-progress', updated_at = ? WHERE id = ?
          `).run(at, child.task_id);
          unblockedChildren.push({
            task: this._taskDetail(child.task_id),
            previousStatus: "blocked"
          });
        }
      }
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "complete",
      task,
      previousStatus,
      context
    });
    for (const child of unblockedChildren) {
      this._afterMutation({
        op: "dependency-unblocked",
        task: child.task,
        previousStatus: child.previousStatus,
        context
      });
    }
    return task;
  }

  async commentTask(id, body, context = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const text = requiredText(body, "Kanban comment", 5000);
    let task;
    let comment;

    this._transaction(() => {
      this._requireTaskRow(taskId);
      const at = nowIso();
      comment = this._insertComment(taskId, text, context.agentId ?? "system", at);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(at, taskId);
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "comment",
      task,
      previousStatus: task.status,
      context,
      details: { commentId: comment.id }
    });
    return { task, comment };
  }

  async heartbeatTask(id, input = {}, context = {}) {
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const requestedState = String(input.state ?? "heartbeat").trim().toLowerCase();
    const state = requestedState === "start" ? "running" : requestedState;
    if (!RUN_STATES.has(state)) {
      throw new Error(`Unknown Kanban run state: ${requestedState}`);
    }
    const detail = normalizeDetail(input.detail);
    const requestedRunId = input.runId ? normalizeRunId(input.runId) : null;
    let previousStatus;
    let task;
    let run;
    let worker;

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task cannot accept a heartbeat.");
      previousStatus = current.status;
      worker = this._upsertWorker(context);
      const at = nowIso();

      if (input.assignee || !current.assignee) {
        const nextAssignee = normalizeAssignee(input.assignee) || worker.agentName;
        if (nextAssignee && nextAssignee !== current.assignee) {
          this._insertHandoff({
            taskId,
            workerId: worker.id,
            fromAssignee: current.assignee,
            toAssignee: nextAssignee,
            reason: optionalText(input.reason, "Kanban heartbeat reason", 2000) || "worker claimed task",
            createdAt: at
          });
          this.db.prepare("UPDATE tasks SET assignee = ? WHERE id = ?").run(nextAssignee, taskId);
        }
      }

      let existingRun = null;
      if (requestedRunId) {
        existingRun = this.db.prepare(`
          SELECT * FROM runs WHERE id = ? AND task_id = ?
        `).get(requestedRunId, taskId) ?? null;
        if (!existingRun) throw new Error(`Unknown Kanban run: ${requestedRunId}`);
        if (existingRun.worker_id !== worker.id) {
          throw new Error(`Kanban run ${requestedRunId} belongs to another worker.`);
        }
        if (existingRun.ended_at) {
          throw new Error(`Kanban run ${requestedRunId} is already terminal.`);
        }
      } else if (state !== "running") {
        existingRun = this.db.prepare(`
          SELECT * FROM runs
          WHERE task_id = ? AND worker_id = ? AND ended_at IS NULL
          ORDER BY attempt DESC
          LIMIT 1
        `).get(taskId, worker.id) ?? null;
      }

      if (!existingRun) {
        const attemptRow = this.db.prepare(`
          SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
          FROM runs
          WHERE task_id = ?
        `).get(taskId);
        const runId = createId("run");
        const terminal = state === "succeeded" || state === "failed";
        this.db.prepare(`
          INSERT INTO runs (
            id, task_id, worker_id, attempt, state, detail_json,
            started_at, heartbeat_at, ended_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runId,
          taskId,
          worker.id,
          Number(attemptRow.next_attempt),
          state,
          JSON.stringify(detail),
          at,
          at,
          terminal ? at : null
        );
        existingRun = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
      } else {
        const terminal = state === "succeeded" || state === "failed";
        this.db.prepare(`
          UPDATE runs
          SET state = ?, detail_json = ?, heartbeat_at = ?,
              ended_at = CASE WHEN ? THEN ? ELSE ended_at END
          WHERE id = ?
        `).run(state, JSON.stringify(detail), at, terminal ? 1 : 0, at, existingRun.id);
        existingRun = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(existingRun.id);
      }

      let nextStatus = current.status;
      if (state === "review" || state === "succeeded") nextStatus = "review";
      else if (current.status !== "blocked") nextStatus = "in-progress";
      this.db.prepare(`
        UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
      `).run(nextStatus, at, taskId);
      run = this._mapRun(existingRun);
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "heartbeat",
      task,
      previousStatus,
      context,
      details: { runId: run.id, workerId: worker.id, runState: run.state }
    });
    return { task, run, worker };
  }

  async linkTask(id, input = {}, context = {}) {
    if (input.assignee !== undefined) {
      return this.assignTask(id, input.assignee, context, { reason: input.reason });
    }
    await this._requireReady();
    const taskId = normalizeTaskId(id);
    const linkedTaskId = normalizeTaskId(input.linkedTaskId);
    if (taskId === linkedTaskId) throw new Error("A Kanban task cannot link to itself.");
    const relation = String(input.relation ?? "related").trim().toLowerCase();
    if (!LINK_RELATIONS.has(relation)) throw new Error(`Unknown Kanban link relation: ${relation}`);
    let previousStatus;
    let task;

    this._transaction(() => {
      const current = this._requireTaskRow(taskId);
      if (current.status === "done") throw new Error("A completed Kanban task cannot be linked.");
      this._requireTaskRow(linkedTaskId);
      previousStatus = current.status;
      const at = nowIso();
      this._insertLink(taskId, linkedTaskId, relation, context, at);
      const nextStatus = relation === "blocked_by" && this._blockedBy(taskId).length > 0
        ? "blocked"
        : current.status;
      this.db.prepare(`
        UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
      `).run(nextStatus, at, taskId);
      task = this._taskDetail(taskId);
    });

    this._afterMutation({
      op: "link",
      task,
      previousStatus,
      context,
      details: { linkedTaskId, relation }
    });
    return task;
  }

  async linkTasks(parentId, childId, context = {}) {
    return this.linkTask(
      childId,
      { linkedTaskId: parentId, relation: "blocked_by" },
      context
    );
  }

  async close() {
    await this.ready;
    try { this.db?.close?.(); } finally { this.db = null; }
  }

  async _requireReady() {
    await this.ready;
    if (!this.db) throw new Error(this.unavailableReason ?? "Kanban store is unavailable.");
  }

  _transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const value = fn();
      this.db.exec("COMMIT;");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK;"); } catch { /* preserve original error */ }
      throw error;
    }
  }

  _ensureBoard(id, name) {
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO boards (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE boards.name END,
        updated_at = excluded.updated_at
    `).run(id, name, at, at);
  }

  _ensureColumn(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((entry) => entry.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }

  _requireTaskRow(id) {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(normalizeTaskId(id));
    if (!row) throw new Error(`Unknown Kanban task: ${id}`);
    return row;
  }

  _insertLink(taskId, linkedTaskId, relation, context, createdAt) {
    if (relation === "blocked_by") {
      const child = this._requireTaskRow(taskId);
      const parent = this._requireTaskRow(linkedTaskId);
      if (child.board_id !== parent.board_id) {
        throw new Error("Kanban dependency links must stay within one board.");
      }
      if (this._wouldCreateDependencyCycle(linkedTaskId, taskId)) {
        throw new Error("Kanban dependency link would create a cycle.");
      }
    }
    this.db.prepare(`
      INSERT INTO task_links (
        task_id, linked_task_id, relation, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id, linked_task_id, relation) DO NOTHING
    `).run(
      taskId,
      linkedTaskId,
      relation,
      String(context.agentId ?? "system"),
      createdAt
    );
  }

  _insertComment(taskId, body, author, createdAt) {
    const comment = {
      id: createId("comment"),
      taskId,
      author: String(author ?? "system"),
      body,
      createdAt
    };
    this.db.prepare(`
      INSERT INTO comments (id, task_id, author, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(comment.id, comment.taskId, comment.author, comment.body, comment.createdAt);
    return comment;
  }

  _insertHandoff({
    taskId,
    workerId,
    fromAssignee,
    toAssignee,
    reason,
    summary,
    metadata,
    createdAt
  }) {
    this.db.prepare(`
      INSERT INTO handoffs (
        id, task_id, worker_id, from_assignee, to_assignee, reason,
        summary, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createId("handoff"),
      taskId,
      workerId,
      fromAssignee ?? null,
      toAssignee,
      reason ?? null,
      summary ?? null,
      JSON.stringify(metadata ?? {}),
      createdAt
    );
  }

  _workerIdentity(context = {}, overrides = {}) {
    const agentName = normalizeAssignee(overrides.agentName)
      || normalizeAssignee(context.agentId)
      || "main";
    const sessionId = optionalText(context.sessionId, "Kanban worker session id", 500);
    const key = [
      this.installIdentity.nodeId,
      process.pid,
      PROCESS_STARTED_AT,
      agentName,
      sessionId ?? ""
    ].join("\0");
    const id = `worker_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    return {
      id,
      nodeId: this.installIdentity.nodeId,
      nodeName: this.installIdentity.name,
      agentName,
      pid: process.pid,
      ppid: process.ppid,
      hostname: os.hostname() || "openagi",
      cwd: process.cwd(),
      execPath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      processStartedAt: PROCESS_STARTED_AT,
      sessionId,
      channel: optionalText(context.channel, "Kanban worker channel", 200),
      sender: optionalText(context.from, "Kanban worker sender", 500)
    };
  }

  _upsertWorker(context = {}, overrides = {}) {
    const worker = this._workerIdentity(context, overrides);
    const at = nowIso();
    this.db.prepare(`
      INSERT INTO workers (
        id, node_id, node_name, agent_name, pid, ppid, hostname, cwd,
        exec_path, platform, arch, node_version, process_started_at,
        session_id, channel, sender, first_seen_at, last_heartbeat_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        node_name = excluded.node_name,
        session_id = excluded.session_id,
        channel = excluded.channel,
        sender = excluded.sender,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run(
      worker.id,
      worker.nodeId,
      worker.nodeName,
      worker.agentName,
      worker.pid,
      worker.ppid,
      worker.hostname,
      worker.cwd,
      worker.execPath,
      worker.platform,
      worker.arch,
      worker.nodeVersion,
      worker.processStartedAt,
      worker.sessionId,
      worker.channel,
      worker.sender,
      at,
      at
    );
    return {
      ...worker,
      firstSeenAt: this.db.prepare("SELECT first_seen_at FROM workers WHERE id = ?").get(worker.id).first_seen_at,
      lastHeartbeatAt: at
    };
  }

  _blockedBy(taskId) {
    return this.db.prepare(`
      SELECT task_links.linked_task_id
      FROM task_links
      JOIN tasks AS parent ON parent.id = task_links.linked_task_id
      WHERE task_links.task_id = ?
        AND task_links.relation = 'blocked_by'
        AND parent.status <> 'done'
      ORDER BY task_links.created_at, task_links.linked_task_id
    `).all(taskId).map((row) => row.linked_task_id);
  }

  _wouldCreateDependencyCycle(parentId, childId) {
    if (parentId === childId) return true;
    const hit = this.db.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT linked_task_id
        FROM task_links
        WHERE task_id = ? AND relation = 'blocked_by'
        UNION
        SELECT task_links.linked_task_id
        FROM task_links
        JOIN ancestors ON task_links.task_id = ancestors.id
        WHERE task_links.relation = 'blocked_by'
      )
      SELECT 1 AS found FROM ancestors WHERE id = ? LIMIT 1
    `).get(parentId, childId);
    return Boolean(hit);
  }

  _taskDetail(id) {
    const row = this.db.prepare(`
      SELECT
        tasks.*,
        boards.name AS board_name
      FROM tasks
      JOIN boards ON boards.id = tasks.board_id
      WHERE tasks.id = ?
    `).get(id);
    if (!row) return null;

    const comments = this.db.prepare(`
      SELECT id, task_id, author, body, created_at
      FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(id).map((comment) => ({
      id: comment.id,
      taskId: comment.task_id,
      author: comment.author,
      body: comment.body,
      createdAt: comment.created_at
    }));

    const runs = this.db.prepare(`
      SELECT runs.*, workers.agent_name, workers.node_id, workers.node_name,
             workers.pid, workers.ppid, workers.hostname, workers.cwd,
             workers.exec_path, workers.platform, workers.arch,
             workers.node_version, workers.process_started_at,
             workers.session_id, workers.channel, workers.sender,
             workers.first_seen_at, workers.last_heartbeat_at
      FROM runs
      JOIN workers ON workers.id = runs.worker_id
      WHERE runs.task_id = ?
      ORDER BY runs.attempt
    `).all(id).map((run) => this._mapRun(run));

    const links = this.db.prepare(`
      SELECT linked_task_id, relation, created_by, created_at
      FROM task_links
      WHERE task_id = ?
      ORDER BY created_at, linked_task_id
    `).all(id).map((link) => ({
      taskId: link.linked_task_id,
      relation: link.relation,
      createdBy: link.created_by,
      createdAt: link.created_at
    }));

    const handoffs = this.db.prepare(`
      SELECT id, task_id, worker_id, from_assignee, to_assignee, reason,
             summary, metadata_json, created_at
      FROM handoffs
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(id).map((handoff) => {
      let metadata = {};
      try { metadata = JSON.parse(handoff.metadata_json || "{}"); } catch { metadata = {}; }
      return {
        id: handoff.id,
        taskId: handoff.task_id,
        workerId: handoff.worker_id,
        fromAssignee: handoff.from_assignee,
        toAssignee: handoff.to_assignee,
        reason: handoff.reason,
        summary: handoff.summary,
        metadata,
        createdAt: handoff.created_at
      };
    });

    return {
      id: row.id,
      board: row.board_id,
      boardName: row.board_name,
      title: row.title,
      body: row.body,
      assignee: row.assignee,
      status: row.status,
      blockReason: row.block_reason,
      blockedBy: this._blockedBy(id),
      links,
      comments,
      runs,
      handoffs,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  _mapRun(row) {
    let detail = {};
    try { detail = JSON.parse(row.detail_json || "{}"); } catch { detail = {}; }
    const worker = row.agent_name === undefined ? undefined : {
      id: row.worker_id,
      nodeId: row.node_id,
      nodeName: row.node_name,
      agentName: row.agent_name,
      pid: row.pid,
      ppid: row.ppid,
      hostname: row.hostname,
      cwd: row.cwd,
      execPath: row.exec_path,
      platform: row.platform,
      arch: row.arch,
      nodeVersion: row.node_version,
      processStartedAt: row.process_started_at,
      sessionId: row.session_id,
      channel: row.channel,
      sender: row.sender,
      firstSeenAt: row.first_seen_at,
      lastHeartbeatAt: row.last_heartbeat_at
    };
    return {
      id: row.id,
      taskId: row.task_id,
      workerId: row.worker_id,
      attempt: Number(row.attempt),
      state: row.state,
      detail,
      startedAt: row.started_at,
      heartbeatAt: row.heartbeat_at,
      endedAt: row.ended_at,
      ...(worker ? { worker } : {})
    };
  }

  _listBoardsSync() {
    return this.db.prepare(`
      SELECT
        boards.id,
        boards.name,
        boards.created_at,
        boards.updated_at,
        COUNT(tasks.id) AS total,
        SUM(CASE WHEN tasks.status = 'backlog' THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN tasks.status = 'in-progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN tasks.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN tasks.status = 'review' THEN 1 ELSE 0 END) AS review,
        SUM(CASE WHEN tasks.status = 'done' THEN 1 ELSE 0 END) AS done
      FROM boards
      LEFT JOIN tasks ON tasks.board_id = boards.id
      GROUP BY boards.id
      ORDER BY boards.name, boards.id
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      counts: {
        total: Number(row.total),
        backlog: Number(row.backlog),
        "in-progress": Number(row.in_progress),
        blocked: Number(row.blocked),
        review: Number(row.review),
        done: Number(row.done)
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  _afterMutation({
    op,
    task,
    previousStatus,
    context = {},
    details = {}
  }) {
    const at = nowIso();
    const event = {
      version: 1,
      at,
      op,
      taskId: task.id,
      board: task.board,
      status: task.status,
      previousStatus,
      assignee: task.assignee,
      agentId: context.agentId ?? null,
      sessionId: context.sessionId ?? null,
      ...details
    };
    try {
      appendJsonLine(this.eventsPath, event);
      writeJsonAtomic(this.snapshotPath, {
        version: 1,
        writtenAt: at,
        columns: [...KANBAN_COLUMNS],
        boards: this._listBoardsSync(),
        tasks: this.db.prepare("SELECT id FROM tasks ORDER BY created_at, id")
          .all()
          .map((row) => this._taskDetail(row.id))
      });
    } catch (error) {
      console.warn(`[openagi] kanban audit projection failed: ${error.message}`);
    }
    this.runtime?.events?.emit?.("kanban-updated", event);
    if (previousStatus !== task.status) {
      this.runtime?.events?.emit?.("kanban-status", {
        at,
        taskId: task.id,
        title: task.title,
        board: task.board,
        fromStatus: previousStatus,
        status: task.status,
        assignee: task.assignee,
        sessionId: context.sessionId ?? null
      });
    }
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return text;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return text;
}

function normalizeTaskId(value) {
  return requiredText(value, "Kanban task id", 200);
}

function normalizeRunId(value) {
  return requiredText(value, "Kanban run id", 200);
}

function normalizeBoardId(value) {
  const id = requiredText(value, "Kanban board id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error("Kanban board id must use only ASCII letters, digits, dots, underscores, or hyphens.");
  }
  return id;
}

function normalizeAssignee(value) {
  return optionalText(value, "Kanban assignee", 200);
}

function normalizeStatus(value) {
  const status = String(value ?? "").trim().toLowerCase();
  if (!KANBAN_COLUMNS.includes(status)) throw new Error(`Unknown Kanban status: ${status}`);
  return status;
}

function uniqueStrings(value, label, maxItems) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Kanban ${label} must be an array.`);
  if (value.length > maxItems) throw new Error(`Kanban ${label} accepts at most ${maxItems} entries.`);
  return [...new Set(value.map((item) => requiredText(item, `Kanban ${label} item`, 200)))];
}

function normalizeDetail(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === "string") return { message: value.slice(0, 5000) };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Kanban run detail must be an object or string.");
  }
  const json = JSON.stringify(value);
  if (json.length > 10000) throw new Error("Kanban run detail is too large.");
  return JSON.parse(json);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
