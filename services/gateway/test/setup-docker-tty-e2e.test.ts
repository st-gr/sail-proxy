/**
 * setup-docker.js end to end on a real pseudo-terminal: the script runs as a child process in a
 * temporary project root (script and setup-flow copied there, so __dirname points into the root),
 * a fake `docker` first on PATH records its arguments, and a Python pty driver feeds keystrokes
 * (answers, the Up arrow to go back, a jump from the review screen). Skipped where python3 is
 * missing (as npm-dist/sail-proxy/test/connection-e2e.test.js does) and on Windows.
 */
import { spawn, spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeDockerRoot } from './helpers/setupDockerHarness';

const REPO = path.resolve(__dirname, '../../..');
const PTY_DRIVER = 'import pty, sys; sys.exit(pty.spawn(sys.argv[1:]) >> 8)';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
const PROMPT_TIMEOUT_MS = 30000;

const hasPython = process.platform !== 'win32' && spawnSync('python3', ['--version']).status === 0;
const describeTty = hasPython ? describe : describe.skip;

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Drives the child: waits for prompt text (searched after the last send) before each write. */
class TtyDriver {
  output = '';
  private cursor = 0;
  private exited: number | null = null;
  constructor(private child: ChildProcess) {
    const onData = (chunk: Buffer) => {
      this.output += chunk.toString();
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('exit', (code) => {
      this.exited = code ?? 1;
    });
  }

  /** Text since the last send, ANSI stripped. */
  private fresh(): string {
    return stripAnsi(this.output.slice(this.cursor));
  }

  async expect(pattern: RegExp, timeoutMs = PROMPT_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.fresh())) return;
      if (this.exited !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${pattern} (exit ${this.exited}). Screen since last input:\n${this.fresh()}`);
  }

  /** Waits for the prompt, then types. */
  async answer(pattern: RegExp, keys: string): Promise<void> {
    await this.expect(pattern);
    this.send(keys);
  }

  send(keys: string): void {
    this.cursor = this.output.length;
    this.child.stdin!.write(keys);
  }

  /** Index of the choice matching `pattern` relative to the one matching `from`, in the last rendered frame. */
  choiceOffset(frameStart: RegExp, from: RegExp, pattern: RegExp): number {
    const frame = stripAnsi(this.output);
    const starts = [...frame.matchAll(new RegExp(frameStart.source, 'g'))];
    // Choice lines start with the pointer or two spaces; a wrapped continuation line does not.
    // Separator lines (two spaces, then ─) are skipped by the arrow keys, so they are not counted.
    const lines = frame
      .slice(starts[starts.length - 1].index)
      .split('\n')
      .filter((l) => /^(\s\s|❯ )/.test(l) && !/^\s\s─/.test(l));
    const fromAt = lines.findIndex((l) => from.test(l));
    const toAt = lines.findIndex((l) => pattern.test(l));
    if (fromAt < 0 || toAt < 0) throw new Error(`Choice not found in:\n${lines.join('\n')}`);
    return toAt - fromAt;
  }

  async waitForExit(timeoutMs = PROMPT_TIMEOUT_MS): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.exited === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    if (this.exited === null) throw new Error(`The script did not exit. Screen:\n${stripAnsi(this.output).slice(-2000)}`);
    return this.exited;
  }
}

function readEnvValue(file: string, key: string): string | undefined {
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1).replace(/^["']|["']$/g, '');
}

describeTty('setup-docker on a pseudo-terminal', () => {
  let root: string;
  let binDir: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    root = makeDockerRoot();
    fs.mkdirSync(path.join(root, 'docker', 'setup-flow'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'docker/setup-docker.js'), path.join(root, 'docker', 'setup-docker.js'));
    fs.cpSync(path.join(REPO, 'docker/setup-flow'), path.join(root, 'docker', 'setup-flow'), { recursive: true });
    // setup-docker.js finds inquirer at ../npm-dist/sail-proxy/node_modules/inquirer from docker/.
    fs.mkdirSync(path.join(root, 'npm-dist', 'sail-proxy'), { recursive: true });
    fs.symlinkSync(
      path.join(REPO, 'npm-dist/sail-proxy/node_modules'),
      path.join(root, 'npm-dist', 'sail-proxy', 'node_modules'),
      'dir'
    );
    // A fake docker that records its arguments and answers nothing (no volumes, no daemon).
    binDir = path.join(root, 'fakebin');
    fs.mkdirSync(binDir);
    for (const name of ['docker', 'docker-compose']) {
      const file = path.join(binDir, name);
      fs.writeFileSync(file, `#!/bin/sh\necho "$@" >> "${path.join(root, 'docker-calls.log')}"\nexit 0\n`);
      fs.chmodSync(file, 0o755);
    }
  });

  afterEach(() => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = null;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function startScript(): TtyDriver {
    // A minimal environment: nothing of the developer's shell (secrets, SAP_AI_CORE_SERVICE_KEY) is inherited.
    const env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      HOME: root,
      NODE_PATH: path.join(REPO, 'npm-dist/sail-proxy/node_modules'),
      TERM: 'xterm',
      NO_COLOR: '1'
    };
    child = spawn('python3', ['-c', PTY_DRIVER, process.execPath, path.join(root, 'docker', 'setup-docker.js')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return new TtyDriver(child);
  }

  it('goes back with the Up arrow, jumps from the review screen, writes the changes and prints no secret', async () => {
    const typedPassword = 'Zq9-tty-secret-Pw-4711x';
    const tty = startScript();
    try {
      await tty.answer(/Database username:/, `first_user${ENTER}`);
      // Up on the password question returns to the username question.
      await tty.expect(/Database password \(leave empty/);
      tty.send(UP);
      await tty.answer(/Database username:/, `alt_user${ENTER}`);
      await tty.answer(/Database password \(leave empty/, `${typedPassword}${ENTER}`);
      await tty.answer(/Confirm database password:/, `${typedPassword}${ENTER}`);
      // Configure SAP AI Core? -> Skip (third choice)
      await tty.answer(/Configure SAP AI Core\?/, `${DOWN}${DOWN}${ENTER}`);
      await tty.answer(/Select authentication provider:/, ENTER);
      await tty.answer(/Logout redirect URL/, ENTER);
      await tty.answer(/Use localhost for development\?/, ENTER);
      await tty.answer(/Select image mode:/, ENTER);
      await tty.answer(/SAP billing currency/, ENTER);
      await tty.answer(/Allow admins to install plugins\?/, ENTER);

      // Review: nothing is written yet; jump to the base URL question.
      await tty.expect(/Review your answers/);
      expect(fs.existsSync(path.join(root, 'services/gateway/.env'))).toBe(false);
      const steps = tty.choiceOffset(/Review your answers \(choose one to change it\) \(Use arrow keys\)/, /Write configuration/, /Use localhost for development/);
      expect(steps).toBeGreaterThan(0);
      tty.send(DOWN.repeat(steps) + ENTER);
      await tty.answer(/Use localhost for development\?/, `${DOWN}${ENTER}`); // No
      await tty.answer(/Enter your domain/, `https://sail.example.com${ENTER}`);
      // The questions after the jump target are shown again with the remembered answers.
      await tty.answer(/Select image mode:/, ENTER);
      await tty.answer(/SAP billing currency/, ENTER);
      await tty.answer(/Allow admins to install plugins\?/, ENTER);
      await tty.expect(/Review your answers/);
      tty.send(ENTER); // Write configuration (first choice)

      expect(await tty.waitForExit()).toBe(0);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n--- full transcript ---\n${stripAnsi(tty.output)}`);
    }

    const adminEnv = path.join(root, 'services/admin/.env');
    const gatewayEnv = path.join(root, 'services/gateway/.env');
    expect(fs.existsSync(gatewayEnv)).toBe(true);
    expect(readEnvValue(adminEnv, 'cds.requires.db.credentials.user')).toBe('alt_user');
    const written = ['services/admin/.env', 'services/gateway/.env', 'docker/.env', 'docker/.env.auth', 'docker/.env.postgres']
      .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
      .join('\n');
    expect(written).not.toContain('first_user');
    expect(written).toContain('https://sail.example.com');
    expect(written).toContain(typedPassword);
    // The typed password never appears on the terminal.
    expect(tty.output).not.toContain(typedPassword);
  }, 120000);
});
