#!/usr/bin/env node
/**
 * CLI entry point for routeros-cli.
 *
 * Three subcommands:
 *   exec [command]   — execute one RouterOS command (or read from stdin)
 *   batch -f <file>  — execute commands from a file, one per line
 *   console          — interactive readline session
 *
 * Global connection options (--host, --port, --login, --password, --timeout,
 * --json) are defined on the root program. Subcommand action handlers receive
 * them via Commander's built-in cmd.optsWithGlobals().
 */
import * as fs from 'fs';
import { version } from '../package.json';
import * as readline from 'readline';
import { Command, OptionValues } from 'commander';
import { config } from 'dotenv';
import { TelnetConn } from './lib/telnet';
import { login, readUntilPrompt, cleanOutput, Credentials } from './lib/routeros';
import { printOutput, printError } from './lib/output';
import { nonEmptyEnv } from './lib/env';

config();

const DEFAULT_HOST = nonEmptyEnv('MIKROTIK_HOST'); // undefined = required
const DEFAULT_PORT = nonEmptyEnv('MIKROTIK_PORT') ?? '23';
const DEFAULT_LOGIN = nonEmptyEnv('MIKROTIK_LOGIN') ?? 'admin';
const DEFAULT_PASSWORD = nonEmptyEnv('MIKROTIK_PASSWORD') ?? '';
const DEFAULT_TIMEOUT = nonEmptyEnv('MIKROTIK_TIMEOUT') ?? '10';
const DEFAULT_CONNECT_TIMEOUT_SEC = parseFloat(nonEmptyEnv('MIKROTIK_CONNECT_TIMEOUT') ?? '15');

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

/** Build a TelnetConn + Credentials pair from the parsed CLI options. */
function buildConn(opts: OptionValues): { conn: TelnetConn; creds: Credentials; timeoutMs: number } {
  const json = opts['json'] as boolean;

  const host = opts['host'] as string | undefined;
  if (!host) {
    printError('--host is required (or set env MIKROTIK_HOST)', json);
    process.exit(1);
  }

  const portStr = opts['port'] as string;
  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    printError(`Invalid port: "${portStr}" — must be 1–65535`, json);
    process.exit(1);
  }

  const timeoutSec = parseFloat(opts['timeout'] as string);
  if (isNaN(timeoutSec) || timeoutSec <= 0) {
    printError(`Invalid timeout: "${opts['timeout']}" — must be a positive number`, json);
    process.exit(1);
  }

  const conn = new TelnetConn({ host, port, connectTimeout: DEFAULT_CONNECT_TIMEOUT_SEC });
  const creds: Credentials = {
    login: opts['login'] as string,
    password: opts['password'] as string,
  };
  return { conn, creds, timeoutMs: timeoutSec * 1000 };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/**
 * Execute one RouterOS command and print the output.
 *
 * Two input modes:
 *   - Inline argument: `exec "/ip address print"` — single command, one round-trip.
 *   - Stdin pipe:      `echo "/ip address print" | exec` — each non-empty,
 *     non-comment line is run sequentially over a single connection so the
 *     login overhead is paid only once.
 */
async function cmdExec(command: string | undefined, opts: OptionValues): Promise<void> {
  const json = opts['json'] as boolean;
  const { conn, creds, timeoutMs } = buildConn(opts);

  let stdinData = '';
  if (!command) {
    // No inline command — read from stdin if it's a pipe, otherwise error.
    if (!process.stdin.isTTY) {
      stdinData = await readStdin();
    } else {
      printError('Provide a command argument or pipe commands via stdin', json);
      process.exit(1);
    }
  }

  try {
    await conn.connect();
    await login(conn, creds);

    if (command) {
      conn.sendline(command);
      const raw = await readUntilPrompt(conn, creds.password, timeoutMs);
      printOutput(cleanOutput(raw, command), json);
    } else {
      // Stdin lines share one connection — login happens once.
      const lines = stdinData
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      for (const line of lines) {
        conn.sendline(line);
        const raw = await readUntilPrompt(conn, creds.password, timeoutMs);
        printOutput(cleanOutput(raw, line), json);
      }
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), json);
    process.exit(1);
  } finally {
    conn.close();
  }
}

/**
 * Execute every command in a file over a single connection.
 *
 * File format: one RouterOS command per line; lines starting with # and
 * blank lines are ignored. UTF-8 BOM (added by some Windows editors) is
 * stripped automatically.
 */
async function cmdBatch(filePath: string, opts: OptionValues): Promise<void> {
  const json = opts['json'] as boolean;

  let content: string;
  try {
    // replace() strips the UTF-8 BOM that Windows editors sometimes prepend.
    content = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  } catch {
    printError(`Cannot read file: ${filePath}`, json);
    process.exit(1);
  }

  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const { conn, creds, timeoutMs } = buildConn(opts);

  try {
    await conn.connect();
    await login(conn, creds);
    for (const line of lines) {
      if (!json) process.stdout.write(`>>> ${line}\n`);
      conn.sendline(line);
      const raw = await readUntilPrompt(conn, creds.password, timeoutMs);
      printOutput(cleanOutput(raw, line), json);
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), json);
    process.exit(1);
  } finally {
    conn.close();
  }
}

/**
 * Open an interactive console session using Node's readline.
 *
 * The `terminal: isTTY` flag matters: when stdin is a TTY readline enables
 * line-editing (arrow keys, history). When it is not (e.g. a test harness
 * piping input) readline falls into raw line-by-line mode without special
 * character handling.
 */
async function cmdConsole(opts: OptionValues): Promise<void> {
  const json = opts['json'] as boolean;
  const { conn, creds, timeoutMs } = buildConn(opts);

  try {
    await conn.connect();
    await login(conn, creds);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err), json);
    process.exit(1);
  }

  console.log(`Connected to ${opts['host']}:${opts['port']}. Type "quit" or press Ctrl+C to exit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  const question = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const line = await question('> ');
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'quit' || trimmed.toLowerCase() === 'exit') break;
      conn.sendline(trimmed);
      const raw = await readUntilPrompt(conn, creds.password, timeoutMs);
      printOutput(cleanOutput(raw, trimmed), json);
    }
  } catch {
    // Ctrl+C or EOF — exit gracefully without printing an error.
  } finally {
    rl.close();
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Stdin helper
// ---------------------------------------------------------------------------

/** Collect all stdin bytes and return them as a UTF-8 string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('roscli')
  .description('MikroTik RouterOS CLI — execute commands via Telnet')
  .version(version)
  .option('--host <ip>', 'Device IP address', DEFAULT_HOST)
  .option('--port <port>', 'Telnet port', DEFAULT_PORT)
  .option('--login <user>', 'Username', DEFAULT_LOGIN)
  .option('--password <pass>', 'Password', DEFAULT_PASSWORD)
  .option('--timeout <sec>', 'Command timeout (s)', DEFAULT_TIMEOUT)
  .option('--json', 'Output as JSON');

program
  .command('exec [command]')
  .description('Execute one RouterOS command (reads stdin if no command given)')
  .action(async (command: string | undefined, _opts: OptionValues, cmd: Command) => {
    await cmdExec(command, cmd.optsWithGlobals());
  });

program
  .command('batch')
  .description('Execute commands from a file (one per line, # = comment)')
  .requiredOption('-f, --file <path>', 'Path to the commands file')
  .action(async (opts: OptionValues, cmd: Command) => {
    await cmdBatch(opts['file'] as string, cmd.optsWithGlobals());
  });

program
  .command('console')
  .description('Open an interactive RouterOS console session')
  .action(async (_opts: OptionValues, cmd: Command) => {
    await cmdConsole(cmd.optsWithGlobals());
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
