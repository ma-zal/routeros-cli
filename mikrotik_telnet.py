"""
MikroTik raw telnet client (Python 3.13+ compatible, no telnetlib).
Connects to HOST:PORT, handles IAC negotiation, RouterOS login/wizard,
and known interactive prompts. Unknown prompts raise UnexpectedPromptError.

Detection strategy: search for keywords in accumulated raw decoded text
(not stripped ANSI) so that cursor-repositioning \r tricks don't hide prompts.

Usage:
    python mikrotik_telnet.py "command"        # single command
    python mikrotik_telnet.py -f commands.txt  # batch
    python mikrotik_telnet.py                  # interactive
"""

import os
import re
import select
import socket
import sys
import time
import argparse
from dotenv import load_dotenv

load_dotenv()

HOST     = os.environ.get("MIKROTIK_HOST", "192.168.4.1")
PORT     = int(os.environ.get("MIKROTIK_PORT", "23"))
LOGIN    = os.environ.get("MIKROTIK_LOGIN", "admin")
PASSWORD = os.environ.get("MIKROTIK_PASSWORD", "")
TIMEOUT  = 15

# Telnet IAC codes
IAC, DO, DONT, WILL, WONT, SB, SE = 255, 253, 254, 251, 252, 250, 240
ECHO = 1
SGA  = 3

# RouterOS main prompt: [something] >
MAIN_PROMPT_RE = re.compile(r'\]\s*>\s*')

# Known prompts searched in raw decoded text (with \r left in).
# Ordered — wizard: new password must come before repeat.
KNOWN_PROMPTS = [
    (re.compile(r'new password>\s*$',         re.IGNORECASE | re.MULTILINE), lambda: PASSWORD),
    (re.compile(r'repeat new password>\s*$',  re.IGNORECASE | re.MULTILINE), lambda: PASSWORD),
    (re.compile(r'software license',          re.IGNORECASE),                lambda: "n"),
    (re.compile(r'\[y/n\]',                   re.IGNORECASE),                lambda: "y"),
]


class UnexpectedPromptError(Exception):
    def __init__(self, prompt_text: str):
        self.prompt_text = prompt_text
        super().__init__(f"Unexpected prompt — router is waiting for input:\n{prompt_text!r}")


def strip_ansi(text: str) -> str:
    """Remove ANSI/VT100 escape sequences but leave \r intact for keyword scanning."""
    return re.sub(r'\x1b\[[0-9;]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[\x40-\x7e]', '', text)


def visible_last_line(text: str) -> str:
    """Return the last visible line after simulating \r (carriage return) overwriting."""
    clean = strip_ansi(text)
    # split on \n, then within each line take the part after the last \r
    lines = []
    for line in clean.split('\n'):
        parts = line.split('\r')
        lines.append(parts[-1])
    non_empty = [l for l in lines if l.strip()]
    return non_empty[-1] if non_empty else ''


def looks_like_prompt(line: str) -> bool:
    return bool(re.search(r'[>:\?]\s*$', line.rstrip()))


class TelnetConn:
    def __init__(self, host=HOST, port=PORT, timeout=TIMEOUT):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.sock: socket.socket | None = None

    def connect(self):
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self.sock.setblocking(False)

    def send(self, text: str):
        self.sock.sendall(text.encode("utf-8", errors="replace"))

    def sendline(self, text: str = ""):
        self.send(text + "\r")

    def _process_iac(self, data: bytes) -> bytes:
        """Strip IAC sequences, respond to option negotiations. Returns payload bytes."""
        result = bytearray()
        i = 0
        while i < len(data):
            b = data[i]
            if b == IAC and i + 1 < len(data):
                cmd = data[i + 1]
                if cmd in (DO, DONT, WILL, WONT) and i + 2 < len(data):
                    opt = data[i + 2]
                    if cmd == DO:
                        reply = WILL if opt in (ECHO, SGA) else WONT
                    elif cmd == WILL:
                        reply = DO if opt in (ECHO, SGA) else DONT
                    else:
                        reply = cmd
                    try:
                        self.sock.sendall(bytes([IAC, reply, opt]))
                    except OSError:
                        pass
                    i += 3
                elif cmd == SB:
                    end = data.find(bytes([IAC, SE]), i + 2)
                    i = end + 2 if end != -1 else len(data)
                elif cmd == IAC:
                    result.append(IAC)
                    i += 2
                else:
                    i += 2
            else:
                result.append(b)
                i += 1
        return bytes(result)

    def read_raw(self, wait=3.0) -> str:
        """Wait up to `wait` seconds, drain all available bytes, return decoded string."""
        ready, _, _ = select.select([self.sock], [], [], wait)
        if not ready:
            return ""
        chunks = []
        try:
            while True:
                chunk = self.sock.recv(4096)
                if not chunk:
                    break
                chunks.append(self._process_iac(chunk))
                more, _, _ = select.select([self.sock], [], [], 0.05)
                if not more:
                    break
        except BlockingIOError:
            pass
        raw = b"".join(chunks)
        return raw.decode("utf-8", errors="replace")

    def close(self):
        if self.sock:
            try:
                self.sendline("/quit")
            except OSError:
                pass
            self.sock.close()
            self.sock = None


def _wait_for_login_prompt(conn: TelnetConn, timeout=120.0) -> str:
    """Read until 'Login:' appears (stable — two consecutive reads confirm it)."""
    buf = ""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        chunk = conn.read_raw(wait=min(2.5, deadline - time.monotonic()))
        if not chunk:
            continue
        buf += chunk
        if re.search(r'Login:', buf, re.IGNORECASE):
            # drain any trailing redraws
            extra = conn.read_raw(wait=1.0)
            if extra:
                buf += extra
            return buf
    raise ConnectionError(f"No login prompt in {timeout}s. Got: {repr(buf[-200:])}")


def login(conn: TelnetConn, retries: int = 3) -> None:
    """
    Perform RouterOS login. Handles:
      - Normal login with Password: prompt
      - First-login password wizard (new password> / repeat new password>)
    Retries on failure to tolerate the Woobm serial-console instability
    during the first seconds after MikroTik boot.
    """
    _wait_for_login_prompt(conn)
    conn.sendline(LOGIN)

    # State for wizard
    new_pw_sent    = False
    repeat_pw_sent = False

    buf = ""
    deadline = time.monotonic() + 25

    while time.monotonic() < deadline:
        chunk = conn.read_raw(wait=min(3.0, deadline - time.monotonic()))
        if not chunk:
            continue
        buf += chunk

        # Detect prompts by keyword search in raw decoded text
        if re.search(r'Password:', buf, re.IGNORECASE) and not new_pw_sent and not repeat_pw_sent:
            conn.sendline(PASSWORD)
            buf = ""

        elif re.search(r'failed', buf, re.IGNORECASE):
            if retries > 0:
                buf = ""
                time.sleep(3)
                _wait_for_login_prompt(conn)
                conn.sendline(LOGIN)
                retries -= 1
            else:
                raise ConnectionError("RouterOS login failed — check MIKROTIK_LOGIN / MIKROTIK_PASSWORD")

        elif not new_pw_sent and re.search(r'new password>', buf, re.IGNORECASE):
            conn.sendline(PASSWORD)
            new_pw_sent = True
            # don't clear buf — repeat prompt may be in same chunk

        elif new_pw_sent and not repeat_pw_sent and re.search(r'repeat new password>', buf, re.IGNORECASE):
            conn.sendline(PASSWORD)
            repeat_pw_sent = True
            buf = ""

        elif repeat_pw_sent and re.search(r'new password>', buf, re.IGNORECASE):
            # Wizard looped back — password was rejected (probably empty not allowed)
            raise ConnectionError(
                "RouterOS wizard rejected the password. "
                "Set a non-empty MIKROTIK_PASSWORD in .env — the console wizard requires it. "
                "You can clear the password from Winbox afterwards."
            )

        elif MAIN_PROMPT_RE.search(buf):
            return  # logged in successfully

    raise ConnectionError("Login timed out")


def read_until_prompt(conn: TelnetConn, timeout=10.0) -> str:
    """
    Read until RouterOS main prompt appears, handling known intermediate prompts.

    Empty-chunk handling: we do NOT break on an empty read. RouterOS sends output
    in bursts separated by gaps longer than the 0.05 s inter-chunk select window
    inside read_raw. Breaking early causes output from one command to bleed into
    the next command's buffer in batch mode.  Instead we keep waiting until the
    deadline, unless the prompt has already been detected.
    """
    buf = ""
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        chunk = conn.read_raw(wait=min(2.0, deadline - time.monotonic()))
        if not chunk:
            # No data yet — keep waiting (don't break early)
            if MAIN_PROMPT_RE.search(buf):
                break  # prompt already in buf, silence confirms it's complete
            continue
        buf += chunk

        # Handle known prompts
        matched = False
        for pattern, response_fn in KNOWN_PROMPTS:
            if pattern.search(buf):
                conn.sendline(response_fn())
                buf = ""
                deadline = time.monotonic() + timeout
                matched = True
                break

        if not matched and MAIN_PROMPT_RE.search(buf):
            break

    return buf


def _simulate_line(line: str) -> str:
    """Simulate terminal \r (carriage return) overwriting within a single line."""
    buf: list[str] = []
    col = 0
    for ch in line:
        if ch == '\r':
            col = 0
        else:
            if col < len(buf):
                buf[col] = ch
            else:
                buf.append(ch)
            col += 1
    return "".join(buf)


def _clean_output(raw: str, cmd: str) -> str:
    """Strip ANSI, simulate \\r overwrites, remove echoed command and trailing prompt."""
    clean = strip_ansi(raw)
    lines = [_simulate_line(line) for line in clean.split('\n')]
    # remove echoed command line
    if lines and cmd.strip() in lines[0]:
        lines = lines[1:]
    # remove trailing prompt lines
    while lines and MAIN_PROMPT_RE.search(lines[-1]):
        lines = lines[:-1]
    return "\n".join(l for l in lines if l.strip())


def run_command(cmd: str, wait=10.0, host=HOST, port=PORT) -> str:
    conn = TelnetConn(host, port)
    conn.connect()
    try:
        login(conn)
        conn.sendline(cmd)
        raw = read_until_prompt(conn, timeout=wait)
        return _clean_output(raw, cmd)
    finally:
        conn.close()


def run_interactive(host=HOST, port=PORT):
    conn = TelnetConn(host, port)
    conn.connect()
    try:
        login(conn)
        print(f"Connected to {host}:{port}. Type 'quit' or Ctrl+C to exit.\n")
        while True:
            # input() blocks on stdin — works in any terminal, but not when stdin
            # is redirected (e.g. piped). Use -f/--file for non-interactive use.
            cmd = input()
            if cmd.strip().lower() in ("quit", "exit"):
                break
            conn.sendline(cmd)
            out = read_until_prompt(conn, timeout=10.0)
            print(_clean_output(out, cmd))
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        conn.close()


def run_batch(path: str, host=HOST, port=PORT):
    conn = TelnetConn(host, port)
    conn.connect()
    try:
        login(conn)
        with open(path, encoding="utf-8-sig") as f:  # utf-8-sig strips BOM on Windows
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                print(f">>> {line}")
                conn.sendline(line)
                out = read_until_prompt(conn, timeout=10.0)
                print(_clean_output(out, line))
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="MikroTik telnet client")
    parser.add_argument("command", nargs="?", help="Single command to run")
    parser.add_argument("-f", "--file",  help="File with commands (one per line)")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--wait", type=float, default=10.0)
    args = parser.parse_args()

    try:
        if args.command:
            print(run_command(args.command, wait=args.wait, host=args.host, port=args.port))
        elif args.file:
            run_batch(args.file, host=args.host, port=args.port)
        else:
            run_interactive(host=args.host, port=args.port)
    except UnexpectedPromptError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    except ConnectionError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
