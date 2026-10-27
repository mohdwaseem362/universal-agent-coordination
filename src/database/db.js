'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const WORKER_PATH = path.join(__dirname, 'sqlite_worker.py');

class DatabaseError extends Error {
  constructor(message, code = 'DB_ERROR') {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
  }
}

class CoordinationDatabase {
  /**
   * @param {string} dbPath Path to the SQLite database file
   */
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    this.worker = null;
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

      this.worker = spawn('python3', ['-u', WORKER_PATH, this.dbPath], {
        stdio: ['pipe', 'pipe', 'pipe']
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
            new DatabaseError(`Database worker exited unexpectedly with code ${code}`, 'WORKER_EXIT')
          );
        }
        this.pending.clear();
      });

      const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      await this._send({ op: 'exec_script', sql: schemaSql });

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

  _send(payload) {
    if (this.closed) {
      return Promise.reject(new DatabaseError('Database connection is closed', 'DB_CLOSED'));
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

  /**
   * Executes an interactive function inside an atomic BEGIN IMMEDIATE ... COMMIT transaction.
   * Ensures serialized execution per Database connection and SQLite WAL lock coordination across processes.
   * @param {(tx: {all: Function, get: Function, run: Function}) => Promise<any>} fn
   */
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
          // ignore rollback error if already rolled back
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
    this.closed = true;
    if (this.worker) {
      try {
        await this._send({ op: 'close' });
      } catch (_) {
        // ignore
      }
      if (this.rl) this.rl.close();
      if (this.worker.stdin) this.worker.stdin.end();
      this.worker.kill();
      this.worker = null;
    }
  }
}

module.exports = {
  CoordinationDatabase,
  DatabaseError
};
