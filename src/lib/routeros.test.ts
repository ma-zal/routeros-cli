import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanOutput, login, readUntilPrompt } from './routeros';
import type { TelnetConn } from './telnet';

// ---------------------------------------------------------------------------
// cleanOutput — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe('cleanOutput', () => {
  it('removes ANSI colour escape codes', () => {
    const raw = '\x1b[32mGreen text\x1b[0m\n[admin@MikroTik] > ';
    expect(cleanOutput(raw, '')).toBe('Green text');
  });

  it('simulates \\r carriage-return overwriting within a line', () => {
    // RouterOS echoes typed characters then sends \r to reposition cursor.
    // "old\rnew" should resolve to "new" (new overwrites old from col 0).
    const raw = 'old content\rnew content\n[admin@MikroTik] > ';
    expect(cleanOutput(raw, '')).toBe('new content');
  });

  it('removes the echoed command from the first line', () => {
    const raw = '/ip address print\r[admin@MikroTik] > /ip address print\r\nFlags: R\n192.168.1.1\n[admin@MikroTik] > ';
    const result = cleanOutput(raw, '/ip address print');
    expect(result).not.toContain('/ip address print');
    expect(result).toContain('Flags: R');
    expect(result).toContain('192.168.1.1');
  });

  it('removes the trailing command prompt line', () => {
    const raw = 'some output\n[admin@MikroTik] > ';
    expect(cleanOutput(raw, '')).toBe('some output');
  });

  it('removes trailing prompt regardless of the username in the prompt', () => {
    const raw = 'result\n[martin@OtherRouter] > ';
    expect(cleanOutput(raw, '')).toBe('result');
  });

  it('filters blank lines from output', () => {
    const raw = 'line1\n\n\nline2\n[admin@MikroTik] > ';
    expect(cleanOutput(raw, '')).toBe('line1\nline2');
  });

  it('returns empty string when output contains only the prompt', () => {
    const raw = '[admin@MikroTik] > ';
    expect(cleanOutput(raw, '')).toBe('');
  });

  it('does not remove first line if it does not contain the command', () => {
    const raw = 'real output\n[admin@MikroTik] > ';
    expect(cleanOutput(raw, '/some/other/command')).toBe('real output');
  });

  it('handles combined ANSI, \\r overwrite, echo, and prompt stripping', () => {
    const cmd = '/system identity print';
    // Realistic raw RouterOS output for /system identity print
    const raw =
      '\x1b[9999B/system identity print\r[admin@MikroTik] > /system identity print\r\n' +
      '  name: MikroTik\r\n' +
      '[admin@MikroTik] > ';
    const result = cleanOutput(raw, cmd);
    // RouterOS indents property output with two spaces; preserve that.
    expect(result).toBe('  name: MikroTik');
  });
});

// ---------------------------------------------------------------------------
// login + readUntilPrompt — mocked TelnetConn
//
// Mock data reflects the Woobm USB serial console connection to MikroTik.
// Direct Telnet to the MikroTik IP may produce slightly different prompt and
// sequence behaviour that is not yet verified.
// ---------------------------------------------------------------------------

describe('via Woobm USB serial console', () => {
  let readRaw: ReturnType<typeof vi.fn>;
  let sendline: ReturnType<typeof vi.fn>;
  let conn: TelnetConn;

  beforeEach(() => {
    readRaw = vi.fn();
    sendline = vi.fn();
    conn = { readRaw, sendline } as unknown as TelnetConn;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------

  describe('login', () => {
    const creds = { login: 'admin', password: 'secret' };

    it('handles normal login: Login → username → Password → password → prompt', async () => {
      readRaw
        .mockResolvedValueOnce('Login: ')   // waitForLoginPrompt
        .mockResolvedValueOnce('')           // drain
        .mockResolvedValueOnce('Password: ') // login loop
        .mockResolvedValueOnce('[admin@MikroTik] > '); // main prompt

      await login(conn, creds);

      expect(sendline).toHaveBeenCalledWith('admin');
      expect(sendline).toHaveBeenCalledWith('secret');
    });

    it('handles first-login wizard: new password → repeat → prompt', async () => {
      readRaw
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        // No Password: prompt — wizard starts immediately
        .mockResolvedValueOnce('new password> ')
        .mockResolvedValueOnce('repeat new password> ')
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      await login(conn, creds);

      const calls = sendline.mock.calls.map((c: string[]) => c[0]);
      expect(calls).toContain('secret'); // sent twice (new + repeat)
      expect(calls.filter((c: string) => c === 'secret')).toHaveLength(2);
    });

    it('throws when wizard loops back (empty/rejected password)', async () => {
      readRaw
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('new password> ')
        .mockResolvedValueOnce('repeat new password> ')
        // Wizard rejects and asks for new password again
        .mockResolvedValueOnce('new password> ');

      await expect(login(conn, creds)).rejects.toThrow(/wizard rejected/i);
    });

    it('throws immediately when retries=0 and login fails', async () => {
      readRaw
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('Login failed\n');

      await expect(login(conn, creds, 0)).rejects.toThrow(/login failed/i);
    });

    it('retries once and succeeds on the second attempt', async () => {
      vi.useFakeTimers();

      readRaw
        // First attempt: fails
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('Login failed\n')
        // Second attempt (after 2 s retry delay): succeeds
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('Password: ')
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      const p = login(conn, creds, 1);
      await vi.runAllTimersAsync();
      await p; // must not throw
    });

    it('retries immediately when Login: is embedded in the failure message (direct Telnet)', async () => {
      // Direct MikroTik Telnet sends "Login failed...\r\nLogin: " in one chunk
      // instead of a separate chunk. login() must not call waitForLoginPrompt
      // again (which would timeout) but instead send the username right away.
      readRaw
        .mockResolvedValueOnce('Login: ')
        .mockResolvedValueOnce('')
        .mockResolvedValueOnce('Login failed, incorrect username or password\r\n\r\nLogin: ')
        .mockResolvedValueOnce('')           // empty read after retry
        .mockResolvedValueOnce('Password: ')
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      await login(conn, creds, 1); // must not throw or need fake timers
    });
  });

  // -------------------------------------------------------------------------
  // readUntilPrompt
  // -------------------------------------------------------------------------

  describe('readUntilPrompt', () => {
    it('returns buffer when main prompt is detected', async () => {
      readRaw.mockResolvedValueOnce('  name: MikroTik\r\n[admin@MikroTik] > ');

      const result = await readUntilPrompt(conn, 'secret');
      expect(result).toContain('[admin@MikroTik] > ');
    });

    it('does not break on empty read if prompt not yet in buffer', async () => {
      readRaw
        .mockResolvedValueOnce('')                              // empty — keep waiting
        .mockResolvedValueOnce('output\n[admin@MikroTik] > '); // prompt arrives later

      const result = await readUntilPrompt(conn, 'secret');
      expect(result).toContain('output');
    });

    it('auto-responds "n" to software license dialog', async () => {
      readRaw
        .mockResolvedValueOnce('software license\nAccept? ')
        // After sending 'n', buf is cleared; next read returns the main prompt
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      await readUntilPrompt(conn, 'secret');
      expect(sendline).toHaveBeenCalledWith('n');
    });

    it('auto-responds "y" to [y/n] confirmation dialog', async () => {
      readRaw
        .mockResolvedValueOnce('Do you want to continue? [y/n]: ')
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      await readUntilPrompt(conn, 'secret');
      expect(sendline).toHaveBeenCalledWith('y');
    });

    it('does not break on command-echo line that contains an inline prompt', async () => {
      // Direct MikroTik Telnet echoes each command as "[prompt] > cmd\r\n"
      // before the actual output. The prompt pattern appears mid-buffer here,
      // not at the end. readUntilPrompt must wait for the trailing prompt.
      readRaw
        .mockResolvedValueOnce('/ip address print\r[admin@MikroTik] > /ip address print\r\n')
        .mockResolvedValueOnce('192.168.88.1/24\n[admin@MikroTik] > ');

      const result = await readUntilPrompt(conn, 'secret');
      expect(result).toContain('192.168.88.1/24');
    });

    it('resets the deadline after an auto-response', async () => {
      // If deadline were NOT reset, the second read would use a near-zero
      // timeout and might return early. A proper implementation gives the
      // full timeout budget again after each auto-response.
      readRaw
        .mockResolvedValueOnce('[y/n]: ')
        .mockResolvedValueOnce('[admin@MikroTik] > ');

      // Use a very short timeout to surface a missing deadline reset quickly
      const result = await readUntilPrompt(conn, 'secret', 100);
      expect(result).toContain('[admin@MikroTik] > ');
    });
  });
});
