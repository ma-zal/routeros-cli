# routeros-cli

MikroTik RouterOS CLI and Node.js library via Telnet.

Execute RouterOS commands from your terminal, scripts, or AI agents — cross-platform, no native dependencies.

Works with both connection methods:

- **Direct Telnet** — connect straight to the MikroTik device IP (port 23)
- **Woobm USB serial console** — connect via a Woobm USB-to-serial adapter (typically at `192.168.4.1`)

## Requirements

- **Node.js 16+**
- A MikroTik device with Telnet enabled (port 23 by default)

## Installation

> **Note:** The package is not yet published to NPM. The commands below reflect
> the intended state once it is. For now, clone the repository and run
> `npm install && npm run build` to build locally, then use `node dist/cli.js`
> in place of `routeros-cli`.

**Global CLI (recommended for terminal use):**

```bash
npm install -g routeros-cli
```

**Run without installing (npx):**

```bash
npx routeros-cli exec "/ip address print"
```

**As a library in your project:**

```bash
npm install routeros-cli
```

## Configuration

Connection defaults are read from environment variables. Create a `.env` file in your working directory:

```env
MIKROTIK_HOST=192.168.88.1   # direct Telnet (MikroTik default IP)
# MIKROTIK_HOST=192.168.4.1  # Woobm USB serial console
MIKROTIK_PORT=23
MIKROTIK_LOGIN=admin
MIKROTIK_PASSWORD=yourpassword
```

Any option can also be passed directly on the command line and overrides the environment.

## CLI Usage

### Execute a single command

```bash
routeros-cli exec "/ip address print"
routeros-cli exec "/system identity print" --host 10.0.0.1
routeros-cli exec "/interface print" --json
```

### Pipe commands via stdin

```bash
echo "/ip address print" | routeros-cli exec
cat commands.txt | routeros-cli exec
```

### Run a batch file

One command per line. Lines starting with `#` are treated as comments.

```bash
routeros-cli batch -f commands.txt
routeros-cli batch -f commands.txt --json
```

Example `commands.txt`:

```
# Print network interfaces
/interface print
# Print IP addresses
/ip address print
```

### Open an interactive console session

```bash
routeros-cli console
routeros-cli console --host 10.0.0.1
```

Type `quit` or press `Ctrl+C` to exit.

### Global options

| Option              | Default                        | Description                          |
| ------------------- | ------------------------------ | ------------------------------------ |
| `--host <ip>`       | `MIKROTIK_HOST` env / `192.168.88.1` | Device IP (direct Telnet) or `192.168.4.1` (Woobm USB) |
| `--port <port>`     | `MIKROTIK_PORT` env / `23`     | Telnet port                          |
| `--login <user>`    | `MIKROTIK_LOGIN` env / `admin` | Username                             |
| `--password <pass>` | `MIKROTIK_PASSWORD` env        | Password                             |
| `--timeout <sec>`   | `10`                           | Command response timeout in seconds  |
| `--json`            | —                              | Output as JSON (`{"output": "..."}`) |

### Exit codes

| Code | Meaning                   |
| ---- | ------------------------- |
| `0`  | Success                   |
| `1`  | Connection or login error |

## JSON output

The `--json` flag makes output machine-readable. Useful for AI agents and scripts:

```bash
routeros-cli exec "/ip address print" --json
# {"output":"Columns: ADDRESS, NETWORK, INTERFACE, VRF\n..."}
```

Errors are also JSON on stderr:

```json
{ "error": "RouterOS login failed — check MIKROTIK_LOGIN / MIKROTIK_PASSWORD" }
```

## Node.js Library

### One-shot command

```typescript
import { executeCommand } from 'routeros-cli';

const output = await executeCommand('/ip address print');
console.log(output);

// With explicit options
const result = await executeCommand('/system identity print', {
  host: '10.0.0.1',
  login: 'admin',
  password: 'secret',
});
```

### Persistent session (efficient for multiple commands)

```typescript
import { RouterOSSession } from 'routeros-cli';

const session = new RouterOSSession({
  host: '192.168.88.1', // or 192.168.4.1 for Woobm USB
  commandTimeout: 15_000, // ms
});

await session.connect();

const addresses = await session.execute('/ip address print');
const identity = await session.execute('/system identity print');

// Run multiple commands and get a result map
const results = await session.executeBatch(['/ip address print', '/interface print', '/system resource print']);

await session.close();
```

### `RouterOSOptions`

```typescript
interface RouterOSOptions {
  host?: string; // default: MIKROTIK_HOST env | 192.168.88.1 (direct) or 192.168.4.1 (Woobm USB)
  port?: number; // default: MIKROTIK_PORT env | 23
  login?: string; // default: MIKROTIK_LOGIN env | admin
  password?: string; // default: MIKROTIK_PASSWORD env
  connectTimeout?: number; // TCP connect timeout in seconds (default: 15)
  commandTimeout?: number; // Command response timeout in ms (default: 10 000)
}
```

## Tested hardware

| Device | Connection | RouterOS |
| ------ | ---------- | -------- |
| MikroTik hAP ac² (RBD52G-5HacD2HnD) | Direct Telnet (port 23) | 7.21.4 |
| MikroTik hAP ac² (RBD52G-5HacD2HnD) | Woobm USB serial console | 7.21.4 |

The library should work on any MikroTik device running RouterOS 7.x with Telnet enabled.

## Issue fix: Git Bash on Windows

Git Bash converts paths starting with `/` to Windows filesystem paths  
(e.g. `/ip` → `C:/Program Files/Git/ip`).

**Fix — add to your `~/.bashrc`:**

```bash
export MSYS_NO_PATHCONV=1
```

Then restart Git Bash. Alternatively, use **PowerShell** or **CMD** instead.
