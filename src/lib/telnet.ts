/**
 * Raw Telnet transport layer for RouterOS.
 *
 * Handles the TCP connection, Telnet IAC option negotiation, and async
 * byte-stream reading. Higher-level RouterOS logic (login, prompts) lives
 * in routeros.ts and never touches the socket directly.
 */
import * as net from 'net';

// Telnet IAC (Interpret As Command) control codes — RFC 854
const IAC = 255; // start of a command sequence
const DO = 253; // "please enable option X"
const DONT = 254; // "please disable option X"
const WILL = 251; // "I will enable option X"
const WONT = 252; // "I won't enable option X"
const SB = 250; // sub-negotiation begin
const SE = 240; // sub-negotiation end
const ECHO = 1; // option: echo
const SGA = 3; // option: suppress go-ahead

export interface TelnetOptions {
  host: string;
  port: number;
  /** Connection timeout in seconds. */
  connectTimeout: number;
}

/**
 * A pending read waiting for the next data chunk.
 * At most one Waiter exists at a time — see onData() for the dispatch logic.
 */
interface Waiter {
  resolve: (data: Buffer | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Async Telnet connection with IAC negotiation and a non-blocking read API.
 *
 * Data flow:
 *   socket → onData() → processIac() strips control bytes
 *                      → if a readRaw() call is waiting: deliver immediately
 *                      → otherwise: push to recvQueue for the next readRaw()
 *
 * This single-waiter design avoids Node.js stream buffering pitfalls: the
 * 'data' listener runs continuously so nothing is lost between read calls.
 */
export class TelnetConn {
  readonly host: string;
  readonly port: number;
  private readonly connectTimeout: number;
  private socket: net.Socket | null = null;
  /** Chunks received while no readRaw() call is active. */
  private recvQueue: Buffer[] = [];
  /** The one pending readRaw() call, if any. */
  private waiter: Waiter | null = null;

  constructor(options: TelnetOptions) {
    this.host = options.host;
    this.port = options.port;
    this.connectTimeout = options.connectTimeout;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      // Timeout applies only to the TCP handshake; cleared once connected.
      sock.setTimeout(this.connectTimeout * 1000);
      sock.once('connect', () => {
        sock.setTimeout(0);
        this.socket = sock;
        // Start listening immediately so data is never dropped between reads.
        sock.on('data', (data: Buffer) => this.onData(data));
        resolve();
      });
      sock.once('error', reject);
      sock.once('timeout', () => reject(new Error(`Connection to ${this.host}:${this.port} timed out`)));
    });
  }

  private send(text: string): void {
    if (!this.socket) throw new Error('Not connected');
    this.socket.write(Buffer.from(text, 'utf8'));
  }

  /** RouterOS expects CR (\r) as the line terminator, not CRLF. */
  sendline(text = ''): void {
    this.send(text + '\r');
  }

  /**
   * Strip Telnet IAC sequences from a raw buffer and reply to option
   * negotiations inline.
   *
   * We agree to ECHO and SGA (suppress go-ahead) because RouterOS requests
   * them during the Telnet handshake. All other options are declined. IAC SB
   * sub-negotiation blocks are skipped entirely — we never need their content.
   */
  private processIac(data: Buffer): Buffer {
    const result: number[] = [];
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      if (b === IAC && i + 1 < data.length) {
        const cmd = data[i + 1];
        if ((cmd === DO || cmd === DONT || cmd === WILL || cmd === WONT) && i + 2 < data.length) {
          const opt = data[i + 2];
          let reply: number;
          if (cmd === DO) {
            reply = opt === ECHO || opt === SGA ? WILL : WONT;
          } else if (cmd === WILL) {
            reply = opt === ECHO || opt === SGA ? DO : DONT;
          } else {
            // DONT / WONT — echo the same command back as acknowledgement
            reply = cmd;
          }
          try {
            this.socket?.write(Buffer.from([IAC, reply, opt]));
          } catch {
            // socket may have closed mid-negotiation
          }
          i += 3;
        } else if (cmd === SB) {
          // Skip the entire sub-negotiation block up to IAC SE
          const iacSe = Buffer.from([IAC, SE]);
          const end = data.indexOf(iacSe, i + 2);
          i = end !== -1 ? end + 2 : data.length;
        } else if (cmd === IAC) {
          // IAC IAC is an escaped literal 0xFF byte
          result.push(IAC);
          i += 2;
        } else {
          i += 2;
        }
      } else {
        result.push(b);
        i++;
      }
    }
    return Buffer.from(result);
  }

  /**
   * Called for every incoming socket chunk.
   *
   * If readRaw() is currently awaiting data the chunk is delivered directly
   * (cancelling the timeout). Otherwise it is queued so the next readRaw()
   * call can drain it without waiting.
   */
  private onData(raw: Buffer): void {
    const data = this.processIac(raw);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(data);
    } else {
      this.recvQueue.push(data);
    }
  }

  /**
   * Return the next queued chunk immediately, or wait up to timeoutMs for one
   * to arrive. Returns null on timeout.
   */
  private waitForChunk(timeoutMs: number): Promise<Buffer | null> {
    if (this.recvQueue.length > 0) {
      return Promise.resolve(this.recvQueue.shift()!);
    }
    if (timeoutMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise<Buffer | null>((resolve) => {
      const entry: Waiter = {
        resolve,
        timer: setTimeout(() => {
          if (this.waiter === entry) this.waiter = null;
          resolve(null);
        }, timeoutMs),
      };
      this.waiter = entry;
    });
  }

  /**
   * Wait up to waitMs for the first data chunk, then keep reading until
   * 50 ms of silence (no new chunk arrives).
   *
   * The 50 ms inactivity window mirrors the Python implementation's
   * `select(..., 0.05)` drain loop: RouterOS sends output in rapid bursts
   * separated by gaps, so we collect an entire burst before returning.
   * Returning too early causes the next read to capture leftover output
   * from the current command instead of the next command's response.
   *
   * Returns "" if no data arrives within waitMs.
   */
  async readRaw(waitMs: number): Promise<string> {
    const chunks: Buffer[] = [];
    const first = await this.waitForChunk(waitMs);
    if (!first) return '';
    chunks.push(first);
    while (true) {
      const more = await this.waitForChunk(50);
      if (!more) break;
      chunks.push(more);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  close(): void {
    // Unblock any pending readRaw() before destroying the socket.
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.resolve(null);
      this.waiter = null;
    }
    if (this.socket) {
      try {
        this.sendline('/quit');
      } catch {
        // ignore if already closed
      }
      this.socket.destroy();
      this.socket = null;
    }
    this.recvQueue = [];
  }
}
