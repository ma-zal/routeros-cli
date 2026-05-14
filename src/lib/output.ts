/**
 * Output helpers shared between the CLI and tests.
 *
 * Extracted from cli.ts so that tests can import these functions without
 * triggering the side-effects in cli.ts (commander.parseAsync).
 */

/**
 * Write command output to stdout.
 * In JSON mode the result is wrapped as {"output":"..."} so callers
 * (scripts, AI agents) can parse it reliably regardless of content.
 */
export function printOutput(text: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({ output: text }) + '\n');
  } else {
    if (text) process.stdout.write(text + '\n');
  }
}

/**
 * Write an error message to stderr.
 * Mirrors printOutput's JSON mode so a caller using --json always gets
 * structured output on both stdout and stderr.
 */
export function printError(message: string, json: boolean): void {
  if (json) {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
  } else {
    process.stderr.write(`ERROR: ${message}\n`);
  }
}
