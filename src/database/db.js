'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { PureNodeDatabaseEngine } = require('./pure_node_engine');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const WORKER_PATH = path.join(__dirname, 'sqlite_worker.py');

let cachedPythonCmd = undefined;

/**
 * Probes for a working Python 3 interpreter that has `sqlite3` available.
 * Avoids the Windows Store `python3.exe` alias stub (which exits with code 9009 on Windows
 * when Python is installed as `python` / `py` or when Python is not installed).
 */
function detectWorkingPython() {
  if (process.env.UAC_FORCE_PURE_NODE_DB === '1') {
    return null;
  }
  if (cachedPythonCmd !== undefined) {
    return cachedPythonCmd;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          { cmd: 'python', args: [] },
          { cmd: 'py', args: ['-3'] },
          { cmd: 'python3', args: [] }
        ]
      : [
          { cmd: 'python3', args: [] },
          { cmd: 'python', args: [] }
        ];

  for (const c of candidates) {
    try {
      const res = spawnSync(
        c.cmd,
        [...c.args, '-c', 'import sqlite3; print(sqlite3.sqlite_version)'],
        {
          timeout: 3000,
          encoding: 'utf8',
          windowsHide: true
        }
      );
      if (res && res.status === 0 && res.stdout && /^\d+\.\d+/.test(res.stdout.trim())) {
        cachedPythonCmd = c;
        return cachedPythonCmd;
      }
    } catch (_) {
      // Try next candidate
    }
  }

  cachedPythonCmd = null;
  return null;
}

class DatabaseError extends Error {
  constructor(message, code = 'DB_ERROR') {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

class CoordinationDatabase {
  /**
   * @param {string} dbPath Path to the SQLite / UAC database file
   */
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.worker = null;
    this.pureEngine = null;
    this.rl = null;
    this.reqSeq = 0;
    this.pending = new Map();
    this.mutex = Promise.resolve();
    this.initialized = false;
    this._initPromise = null;
    this.closed = false;
  }

  async init() {
    if (this.initialized) return this;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

      const py = detectWorkingPython();
      if (!py) {
        this.pureEngine = new PureNodeDatabaseEngine(this.dbPath);
        await this.pureEngine.execScript();
      } else {
        this.worker = spawn(py.cmd, [...py.args, '-u', WORKER_PATH, this.dbPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });

        this.rl = readline.createInterface({
          input: this.worker.stdout,
          crlfDelay: Infinity
        });

        this.rl.on('line', (line) => {
          if (!line.trim()) return;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (err) {
            return;
          }
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.ok) {
              entry.resolve(msg);
            } else {
              entry.reject(new DatabaseError(msg.error || 'Database error', msg.error_code));
            }
          }
        });

        this.worker.on('exit', (code) => {
          for (const [, entry] of this.pending.entries()) {
            entry.reject(
              new DatabaseError(
                `Database worker exited unexpectedly with code ${code}`,
                'WORKER_EXIT'
              )
            );
          }
          this.pending.clear();
        });

        const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
        await this._send({ op: 'exec_script', sql: schemaSql });
      }

      const migRes = await this._send({
        op: 'query',
        sql: 'SELECT version FROM schema_migrations WHERE version = 1',
        params: []
      });
      if (!migRes.rows || migRes.rows.length === 0) {
        await this._send({
          op: 'run',
          sql: 'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
          params: [1, '001_initial_uac_schema', new Date().toISOString()]
        });
      }

      this.initialized = true;
      return this;
    })();

    return this._initPromise;
  }

  async _send(payload) {
    if (this.closed) {
      throw new DatabaseError('Database connection is closed', 'DB_CLOSED');
    }

    if (this.pureEngine) {
      try {
        const op = payload.op;
        if (op === 'exec_script') return await this.pureEngine.execScript();
        if (op === 'begin_immediate') return await this.pureEngine.beginImmediate();
        if (op === 'commit') return await this.pureEngine.commit();
        if (op === 'rollback') return await this.pureEngine.rollback();
        if (op === 'query') return await this.pureEngine.query(payload.sql, payload.params || []);
        if (op === 'run') return await this.pureEngine.run(payload.sql, payload.params || []);
        if (op === 'close') {
          await this.pureEngine.close();
          return { ok: true, closed: true };
        }
        return { ok: true };
      } catch (err) {
        throw new DatabaseError(err.message, err.code || 'PURE_DB_ERROR');
      }
    }

    const id = ++this.reqSeq;
    const msg = JSON.stringify({ ...payload, id }) + '\n';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.stdin.write(msg, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new DatabaseError(err.message, 'WRITE_ERROR'));
        }
      });
    });
  }

  async all(sql, params = []) {
    await this.init();
    const res = await this._send({ op: 'query', sql, params });
    return res.rows || [];
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async run(sql, params = []) {
    await this.init();
    const res = await this._send({ op: 'run', sql, params });
    return { changes: res.changes, lastrowid: res.lastrowid };
  }

  async transaction(fn) {
    await this.init();
    const runTx = async () => {
      await this._send({ op: 'begin_immediate', keep_tx: true });
      const txApi = {
        all: async (sql, params = []) => {
          const r = await this._send({ op: 'query', sql, params, keep_tx: true });
          return r.rows || [];
        },
        get: async (sql, params = []) => {
          const r = await this._send({ op: 'query', sql, params, keep_tx: true });
          return r.rows && r.rows.length > 0 ? r.rows[0] : null;
        },
        run: async (sql, params = []) => {
          const r = await this._send({ op: 'run', sql, params, keep_tx: true });
          return { changes: r.changes, lastrowid: r.lastrowid };
        }
      };
      try {
        const result = await fn(txApi);
        await this._send({ op: 'commit' });
        return result;
      } catch (err) {
        try {
          await this._send({ op: 'rollback' });
        } catch (_) {
          // ignore
        }
        throw err;
      }
    };

    const next = this.mutex.then(runTx, runTx);
    this.mutex = next.catch(() => {});
    return next;
  }

  async close() {
    if (this.closed) return;
    try {
      await this.mutex;
    } catch (_) {
      // ignore prior transaction errors
    }
    if (this.closed) return;

    if (this.pureEngine) {
      this.closed = true;
      await this.pureEngine.close();
      this.pureEngine = null;
      return;
    }

    if (this.worker) {
      const workerProc = this.worker;
      const exitPromise = new Promise((resolve) => {
        if (workerProc.exitCode !== null || workerProc.killed) {
          resolve();
          return;
        }
        workerProc.once('close', () => resolve());
        workerProc.once('exit', () => resolve());
      });

      try {
        await this._send({ op: 'close' });
      } catch (_) {
        // ignore
      }

      this.closed = true;
      if (this.rl) this.rl.close();
      if (workerProc.stdin) workerProc.stdin.end();

      // Wait for Python process to fully exit so Windows NTFS releases .db/.db-wal/.db-shm locks
      await Promise.race([
        exitPromise,
        new Promise((resolve) =>
          setTimeout(() => {
            try {
              workerProc.kill();
            } catch (_) {
              // ignore
            }
            resolve();
          }, 500)
        )
      ]);
      await exitPromise;

      if (process.platform === 'win32') {
        await new Promise((r) => setTimeout(r, 40));
      }

      this.worker = null;
    } else {
      this.closed = true;
    }
  }
}

module.exports = {
  CoordinationDatabase,
  DatabaseError,
  detectWorkingPython
};
