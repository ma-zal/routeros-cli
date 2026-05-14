import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { printOutput, printError } from './output';

describe('printOutput', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('writes text followed by a newline in plain mode', () => {
    printOutput('hello world', false);
    expect(stdoutSpy).toHaveBeenCalledWith('hello world\n');
  });

  it('wraps output in {"output":"..."} in JSON mode', () => {
    printOutput('some result', true);
    expect(stdoutSpy).toHaveBeenCalledWith('{"output":"some result"}\n');
  });

  it('escapes special characters in JSON mode', () => {
    printOutput('line1\nline2', true);
    expect(stdoutSpy).toHaveBeenCalledWith('{"output":"line1\\nline2"}\n');
  });

  it('skips write for empty text in plain mode', () => {
    printOutput('', false);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('writes empty JSON object in JSON mode even for empty text', () => {
    printOutput('', true);
    expect(stdoutSpy).toHaveBeenCalledWith('{"output":""}\n');
  });
});

describe('printError', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('writes "ERROR: message\\n" to stderr in plain mode', () => {
    printError('something went wrong', false);
    expect(stderrSpy).toHaveBeenCalledWith('ERROR: something went wrong\n');
  });

  it('wraps error in {"error":"..."} in JSON mode', () => {
    printError('connection refused', true);
    expect(stderrSpy).toHaveBeenCalledWith('{"error":"connection refused"}\n');
  });

  it('writes to stderr, not stdout, in both modes', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printError('oops', false);
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
