/**
 * Public API for the routeros-cli library.
 *
 * Two usage patterns:
 *
 *   RouterOSSession  — keeps a single Telnet connection open for multiple
 *                      execute() calls. Preferred for AI agents or scripts
 *                      that run many commands, as login overhead is paid once.
 *
 *   executeCommand() — one-shot helper that opens a connection, runs one
 *                      command, and closes. Simpler for single-call use cases.
 *
 * Both patterns read connection defaults from the environment
 * (MIKROTIK_HOST, MIKROTIK_PORT, MIKROTIK_LOGIN, MIKROTIK_PASSWORD) and
 * accept explicit overrides via RouterOSOptions.
 *
 * Errors are thrown as plain Error instances with a descriptive message.
 */
import { config } from 'dotenv';
import { TelnetConn } from './lib/telnet';
import { login, readUntilPrompt, cleanOutput, Credentials } from './lib/routeros';
import { nonEmptyEnv } from './lib/env';

// Load .env automatically so callers don't have to.
config();

export interface RouterOSOptions {
  host?: string;
  port?: number;
  login?: string;
  password?: string;
  /** TCP connect timeout in seconds. Default: 15. */
  connectTimeout?: number;
  /** Time to wait for a RouterOS command response in seconds. Default: 10. */
  commandTimeout?: number;
}

/**
 * Resolve options using a three-tier priority:
 *   explicit option > environment variable > built-in default
 *
 * host has no built-in default — it must be supplied explicitly or via MIKROTIK_HOST.
 */
function resolveOptions(opts: RouterOSOptions = {}): Required<RouterOSOptions> {
  const host = opts.host ?? nonEmptyEnv('MIKROTIK_HOST');
  if (!host) {
    throw new Error('host is required — pass it via RouterOSOptions or set MIKROTIK_HOST');
  }

  const portStr = nonEmptyEnv('MIKROTIK_PORT');
  const port = opts.port ?? (portStr !== undefined ? parseInt(portStr, 10) : 23);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port value: ${opts.port ?? portStr} — must be 1–65535`);
  }

  const timeoutStr = nonEmptyEnv('MIKROTIK_TIMEOUT');
  const commandTimeout = opts.commandTimeout ?? (timeoutStr !== undefined ? parseFloat(timeoutStr) : 10);

  const connectTimeoutStr = nonEmptyEnv('MIKROTIK_CONNECT_TIMEOUT');
  const connectTimeout = opts.connectTimeout ?? (connectTimeoutStr !== undefined ? parseFloat(connectTimeoutStr) : 15);

  return {
    host,
    port,
    login: opts.login ?? nonEmptyEnv('MIKROTIK_LOGIN') ?? 'admin',
    password: opts.password ?? nonEmptyEnv('MIKROTIK_PASSWORD') ?? '',
    connectTimeout,
    commandTimeout,
  };
}

/**
 * A persistent RouterOS session over Telnet.
 *
 * Call connect() once, then execute() as many times as needed.
 * Always call close() when done so the router's session slot is freed.
 *
 * @example
 * const session = new RouterOSSession({ host: '192.168.4.1' });
 * await session.connect();
 * const output = await session.execute('/ip address print');
 * await session.close();
 */
export class RouterOSSession {
  private conn: TelnetConn | null = null;
  private creds: Credentials;
  private opts: Required<RouterOSOptions>;

  constructor(options?: RouterOSOptions) {
    this.opts = resolveOptions(options);
    this.creds = { login: this.opts.login, password: this.opts.password };
  }

  async connect(): Promise<void> {
    const conn = new TelnetConn({
      host: this.opts.host,
      port: this.opts.port,
      connectTimeout: this.opts.connectTimeout,
    });
    try {
      await conn.connect();
      await login(conn, this.creds);
    } catch (err) {
      conn.close();
      throw err;
    }
    this.conn = conn;
  }

  async execute(command: string, timeoutSec?: number): Promise<string> {
    if (!this.conn) throw new Error('Not connected — call connect() first');
    this.conn.sendline(command);
    const raw = await readUntilPrompt(this.conn, this.creds.password, (timeoutSec ?? this.opts.commandTimeout) * 1000);
    return cleanOutput(raw, command);
  }

  /** Run multiple commands over the same connection and return a result map keyed by command. */
  async executeBatch(commands: string[], timeoutSec?: number): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const cmd of commands) {
      results[cmd] = await this.execute(cmd, timeoutSec);
    }
    return results;
  }

  async close(): Promise<void> {
    this.conn?.close();
    this.conn = null;
  }
}

/**
 * One-shot helper: connect → login → execute command → disconnect.
 *
 * Convenient for scripts that run a single command. For multiple commands,
 * use RouterOSSession to avoid the login overhead on every call.
 */
export async function executeCommand(command: string, options?: RouterOSOptions): Promise<string> {
  const opts = resolveOptions(options);
  const conn = new TelnetConn({
    host: opts.host,
    port: opts.port,
    connectTimeout: opts.connectTimeout,
  });
  const creds: Credentials = { login: opts.login, password: opts.password };
  try {
    await conn.connect();
    await login(conn, creds);
    conn.sendline(command);
    const raw = await readUntilPrompt(conn, creds.password, opts.commandTimeout * 1000);
    return cleanOutput(raw, command);
  } finally {
    conn.close();
  }
}

export type { Credentials };
export type { TelnetOptions } from './lib/telnet';
