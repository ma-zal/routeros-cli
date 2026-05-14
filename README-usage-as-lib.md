# routeros-cli — Node.js Library

Install the package and import it directly into your TypeScript or JavaScript project.
No native dependencies — works on Windows, macOS, and Linux.

> **Note:** The library does not load `.env` files automatically. Pass connection options explicitly, use environment variables, or call `require('dotenv').config()` yourself before using the library.

```bash
npm install routeros-cli
```

## One-shot command

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

## Persistent session (efficient for multiple commands)

```typescript
import { RouterOSSession } from 'routeros-cli';

const session = new RouterOSSession({
  host: '192.168.88.1', // or 192.168.4.1 for Woobm USB
  commandTimeout: 15, // seconds
});

await session.connect();

const addresses = await session.execute('/ip address print');
const identity = await session.execute('/system identity print');

// Run multiple commands and get a result map
const results = await session.executeBatch(['/ip address print', '/interface print', '/system resource print']);

await session.close();
```

## `RouterOSOptions`

```typescript
interface RouterOSOptions {
  host?: string; // required — MIKROTIK_HOST env or explicit value
  port?: number; // default: MIKROTIK_PORT env | 23
  login?: string; // default: MIKROTIK_LOGIN env | 'admin'
  password?: string; // default: MIKROTIK_PASSWORD env | ''
  connectTimeout?: number; // TCP connect timeout in seconds — MIKROTIK_CONNECT_TIMEOUT env | 15
  commandTimeout?: number; // command response timeout in seconds — MIKROTIK_TIMEOUT env | 10
}
```
