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

// Load .env automatically so callers don't have to.
config();

export interface RouterOSOptions {
  host?: string;
  port?: number;
  login?: string;
  password?: string;
  /** TCP connect timeout in seconds. Default: 15. */
  connectTimeout?: number;
  /** Time to wait for a RouterOS command response in ms. Default: 10 000. */
  commandTimeout?: number;
}

/**
 * Resolve options using a three-tier priority:
 *   explicit option > environment variable > built-in default
 */
function resolveOptions(opts: RouterOSOptions = {}): Required<RouterOSOptions> {
  return {
    host: opts.host ?? process.env['MIKROTIK_HOST'] ?? '192.168.4.1',
    port: opts.port ?? parseInt(process.env['MIKROTIK_PORT'] ?? '23', 10),
    login: opts.login ?? process.env['MIKROTIK_LOGIN'] ?? 'admin',
    password: opts.password ?? process.env['MIKROTIK_PASSWORD'] ?? '',
    connectTimeout: opts.connectTimeout ?? 15,
    commandTimeout: opts.commandTimeout ?? 10_000,
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

  async execute(command: string, timeoutMs?: number): Promise<string> {
    if (!this.conn) throw new Error('Not connected — call connect() first');
    this.conn.sendline(command);
    const raw = await readUntilPrompt(this.conn, this.creds.password, timeoutMs ?? this.opts.commandTimeout);
    return cleanOutput(raw, command);
  }

  /** Run multiple commands over the same connection and return a result map keyed by command. */
  async executeBatch(commands: string[], timeoutMs?: number): Promise<Record<string, string>> {
    const results: Record<string, string> = {};
    for (const cmd of commands) {
      results[cmd] = await this.execute(cmd, timeoutMs);
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
    const raw = await readUntilPrompt(conn, creds.password, opts.commandTimeout);
    return cleanOutput(raw, command);
  } finally {
    conn.close();
  }
}

export type { Credentials };
export type { TelnetOptions } from './lib/telnet';
