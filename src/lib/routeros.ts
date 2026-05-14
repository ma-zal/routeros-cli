/**
 * RouterOS session helpers: login state machine, prompt detection, and
 * output cleaning. All functions take a TelnetConn and operate at the
 * RouterOS protocol level (text prompts, ANSI sequences).
 */
import { TelnetConn } from './telnet';

/** Matches the RouterOS main command prompt, e.g. "[admin@MikroTik] >" */
export const MAIN_PROMPT_RE = /\]\s*>\s*/;

/**
 * Interactive prompts that may appear mid-session and require an automatic
 * response to keep the flow unblocked.
 *
 * The first two handle the first-login password wizard: RouterOS forces a
 * password change on a fresh device before granting access to the CLI.
 * The last two handle the software license dialog and generic yes/no
 * confirmations that some commands produce.
 *
 * Order matters: "new password" must be matched before "repeat new password"
 * because the latter is a substring of the former when read naively.
 */
const KNOWN_PROMPTS: Array<{ pattern: RegExp; response: (password: string) => string }> = [
  { pattern: /new password>\s*$/im, response: (pw) => pw },
  { pattern: /repeat new password>\s*$/im, response: (pw) => pw },
  { pattern: /software license/i, response: () => 'n' },
  { pattern: /\[y\/n\]/i, response: () => 'y' },
];

export interface Credentials {
  login: string;
  password: string;
}

/**
 * Block until RouterOS emits the "Login:" prompt.
 *
 * The 120 s default covers a cold router boot where the device may still be
 * initialising its network stack when we connect.
 */
async function waitForLoginPrompt(conn: TelnetConn, timeoutMs = 120_000): Promise<void> {
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await conn.readRaw(Math.min(2500, deadline - Date.now()));
    if (!chunk) continue;
    buf += chunk;
    if (/Login:/i.test(buf)) {
      // RouterOS sometimes redraws the login line; drain to get a stable state.
      const extra = await conn.readRaw(1000);
      if (extra) buf += extra;
      return;
    }
  }
  throw new Error(`No login prompt received within ${timeoutMs / 1000}s. Got: ${JSON.stringify(buf.slice(-200))}`);
}

/**
 * Log in to RouterOS and wait for the main command prompt.
 *
 * Handles three scenarios:
 *   1. Normal login — "Login:" → send username → "Password:" → send password
 *   2. First-login wizard — RouterOS requires setting a new password before
 *      granting CLI access. The wizard sequence is:
 *        "new password>" → send password
 *        "repeat new password>" → send password again
 *      If the wizard loops back to "new password>" the password was rejected
 *      (e.g. empty string), and we throw rather than looping forever.
 *   3. Login failure — "failed" in the response triggers a retry with a 3 s
 *      delay, useful when connecting immediately after a reboot.
 */
export async function login(conn: TelnetConn, creds: Credentials, retries = 3): Promise<void> {
  await waitForLoginPrompt(conn);
  conn.sendline(creds.login);

  let newPwSent = false;
  let repeatPwSent = false;
  let buf = '';
  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    const chunk = await conn.readRaw(Math.min(3000, deadline - Date.now()));
    if (!chunk) continue;
    buf += chunk;

    if (/Password:/i.test(buf) && !newPwSent && !repeatPwSent) {
      conn.sendline(creds.password);
      buf = '';
    } else if (/failed/i.test(buf)) {
      if (retries > 0) {
        buf = '';
        await new Promise((r) => setTimeout(r, 3000));
        await waitForLoginPrompt(conn);
        conn.sendline(creds.login);
        retries--;
      } else {
        throw new Error('RouterOS login failed — check MIKROTIK_LOGIN / MIKROTIK_PASSWORD');
      }
    } else if (!newPwSent && /new password>/i.test(buf)) {
      conn.sendline(creds.password);
      newPwSent = true;
      // Do NOT clear buf here: "repeat new password>" may be in the same
      // chunk and would be missed if we reset before checking it.
    } else if (newPwSent && !repeatPwSent && /repeat new password>/i.test(buf)) {
      conn.sendline(creds.password);
      repeatPwSent = true;
      buf = '';
    } else if (repeatPwSent && /new password>/i.test(buf)) {
      // Wizard looped — the password was rejected (blank passwords are not allowed).
      throw new Error(
        'RouterOS first-login wizard rejected the password. ' +
          'Set a non-empty MIKROTIK_PASSWORD — the console wizard requires it.',
      );
    } else if (MAIN_PROMPT_RE.test(buf)) {
      return;
    }
  }
  throw new Error('Login timed out');
}

/**
 * Read RouterOS output until the main command prompt reappears.
 *
 * RouterOS sends output in bursts. We must NOT break on an empty read — the
 * device may pause between chunks (e.g. for a large table). We only stop when
 * the main prompt is visible AND a subsequent read returns nothing (confirming
 * the burst is complete).
 *
 * Any KNOWN_PROMPTS that appear mid-output (e.g. license dialogs) are
 * answered automatically and the deadline is reset so the command can finish.
 */
export async function readUntilPrompt(conn: TelnetConn, password: string, timeoutMs = 10_000): Promise<string> {
  let buf = '';
  let deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await conn.readRaw(Math.min(2000, remaining));

    if (!chunk) {
      // No data arrived — stop only if the prompt is already in the buffer.
      if (MAIN_PROMPT_RE.test(buf)) break;
      continue;
    }
    buf += chunk;

    const hit = KNOWN_PROMPTS.find(({ pattern }) => pattern.test(buf));
    if (hit) {
      conn.sendline(hit.response(password));
      buf = '';
      deadline = Date.now() + timeoutMs;
    } else if (MAIN_PROMPT_RE.test(buf)) {
      break;
    }
  }

  return buf;
}

/** Remove ANSI / VT100 escape sequences (colours, cursor movements). */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[\x40-\x7e]/g, '');
}

/**
 * Simulate VT100 carriage-return (\r) overwriting within a single line.
 *
 * RouterOS uses \r (without \n) to redraw the current line in place — for
 * example when echoing what you typed, it sends the command followed by \r
 * to reposition the cursor at the start. Without this simulation, the raw
 * text would contain overlapping characters that produce garbled output.
 *
 * We replay the byte stream character by character, treating \r as "move
 * cursor to column 0" (not a newline), and overwriting buffer positions
 * instead of appending. The final buffer content is what a real terminal
 * would display.
 */
function simulateLine(line: string): string {
  const buf: string[] = [];
  let col = 0;
  for (const ch of line) {
    if (ch === '\r') {
      col = 0;
    } else {
      if (col < buf.length) {
        buf[col] = ch;
      } else {
        buf.push(ch);
      }
      col++;
    }
  }
  return buf.join('');
}

/**
 * Convert raw RouterOS terminal output to clean plain text.
 *
 * Pipeline:
 *   1. stripAnsi   — remove colour/cursor escape codes
 *   2. simulateLine — resolve \r overwrites so each line is its final state
 *   3. Drop the first line if it contains the echoed command
 *   4. Drop trailing lines that match the command prompt
 *   5. Drop blank lines
 */
export function cleanOutput(raw: string, cmd: string): string {
  const clean = stripAnsi(raw);
  const lines = clean.split('\n').map(simulateLine);

  // RouterOS echoes the command back on the first line of the response.
  // Guard against empty cmd: every string includes '', which would always drop line 0.
  const trimmedCmd = cmd.trim();
  const start = trimmedCmd !== '' && lines.length > 0 && lines[0].includes(trimmedCmd) ? 1 : 0;
  const filtered = lines.slice(start);

  // Strip the trailing prompt (e.g. "[admin@MikroTik] > ") from the output.
  while (filtered.length > 0 && MAIN_PROMPT_RE.test(filtered[filtered.length - 1])) {
    filtered.pop();
  }

  return filtered.filter((l) => l.trim()).join('\n');
}
