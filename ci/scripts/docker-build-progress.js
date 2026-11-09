/**
 * Progress for the image builds in Phase 7. `docker compose build` used to run through exec, which
 * collects its output and shows nothing until it ends: the admin image alone takes 15 minutes or
 * more, with no sign of what it is doing or whether it still runs.
 *
 * streamBuild runs the same command through the same shell, writes every line to a log file, and
 * prints only milestones read from BuildKit's plain progress format (what BuildKit writes to a pipe,
 * and what BUILDKIT_PROGRESS=plain asks for):
 *   - a Dockerfile step that took 10 s or more, when it is done ("admin: ui5 11/15 … done in 4m12s")
 *   - a step that failed, with BuildKit's error
 *   - each UI5 app of the admin build as it starts ("admin: UI5 app 3: config-app")
 *   - a heartbeat every minute naming the step that has run longest
 * On a non-zero exit it prints the last lines and the log path and rejects, as exec did.
 */
const fs = require('fs');
const { spawn } = require('child_process');

/** A step done in less than this is not worth a line. */
const MILESTONE_MS = 10_000;

// "#7 [build  2/12] RUN …" when compose builds one service (Phase 7), "#73 [admin ui5 11/15] RUN …"
// when it builds several; the stage name may be followed by two spaces.
const STEP = /^#(\d+) \[(?:(\S+) )?(\S+)\s+(\d+)\/(\d+)\] (.*)$/;
const DONE = /^#(\d+) DONE ([\d.]+)s\s*$/;
const CACHED = /^#(\d+) CACHED\s*$/;
const ERROR = /^#(\d+) ERROR:?\s*(.*)$/;
// "#73 4.527 > admin.apikeysapp@1.0.0 build:docker /app/services/admin/app/api-keys-app"
const UI5_APP = /^#\d+ [\d.]+ > \S+@\S+ build:docker \S*\/app\/([^/\s]+)\s*$/;

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * A step's instruction in a few words: the text of an `echo "=== … ==="` banner, else the command,
 * without the RUN keyword, mount options and leading `echo "…" >> file &&` setting writes.
 */
function labelOf(instruction) {
  const banner = /echo "=== (.+?) ===/.exec(instruction);
  if (banner) return banner[1];
  const text = instruction
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^RUN (--\S+ )*/, '')
    .replace(/^(echo "[^"]*" >>? \S+ && )+/, '');
  return text.length > 70 ? `${text.slice(0, 67)}...` : text;
}

function createBuildProgress(service, { now = () => Date.now(), tailLines = 60 } = {}) {
  const started = now();
  const steps = new Map(); // BuildKit step id -> { name, start, done }
  const lastLines = [];
  let ui5Apps = 0;

  const nameOf = (s) => `${s.stage} ${s.n}/${s.total} ${s.label}`;

  return {
    /** One line of build output in; the milestone lines it gives, if any, out. */
    feed(line) {
      lastLines.push(line);
      if (lastLines.length > tailLines) lastLines.shift();
      let m = STEP.exec(line);
      if (m) {
        const [, id, , stage, n, total, instruction] = m;
        if (!steps.has(id)) steps.set(id, { stage, n, total, label: labelOf(instruction), start: now(), done: false });
        return [];
      }
      m = DONE.exec(line);
      if (m) {
        const step = steps.get(m[1]);
        if (!step) return [];
        step.done = true;
        const ms = Math.round(parseFloat(m[2]) * 1000);
        return ms >= MILESTONE_MS ? [`${service}: ${nameOf(step)} done in ${formatDuration(ms)}`] : [];
      }
      m = CACHED.exec(line);
      if (m) {
        const step = steps.get(m[1]);
        if (step) step.done = true;
        return [];
      }
      m = ERROR.exec(line);
      if (m) {
        const step = steps.get(m[1]);
        if (step) step.done = true;
        return [`${service}: ${step ? nameOf(step) : `step #${m[1]}`} FAILED: ${m[2]}`];
      }
      m = UI5_APP.exec(line);
      if (m) return [`${service}: UI5 app ${++ui5Apps}: ${m[1]}`];
      return [];
    },
    /** What to say when the build has been quiet for a while. */
    heartbeat() {
      const t = now();
      const running = [...steps.values()].filter((s) => !s.done).sort((a, b) => a.start - b.start);
      if (running.length === 0) return `${service}: still building, ${formatDuration(t - started)} so far`;
      const longest = running[0];
      return `${service}: ${nameOf(longest)} still running, ${formatDuration(t - longest.start)} (image ${formatDuration(t - started)} so far)`;
    },
    tail: () => [...lastLines],
  };
}

/**
 * Runs `command` through the shell, as exec does, with milestones instead of collected output.
 * Resolves when it exits 0; otherwise prints the last lines and the log path and rejects with an
 * Error carrying the exit code.
 */
function streamBuild(command, { cwd, env, service, logFile, logger, heartbeatMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const progress = createBuildProgress(service);
    const log = fs.createWriteStream(logFile);
    const child = spawn(command, { cwd, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = heartbeatMs > 0 ? setInterval(() => logger.info(progress.heartbeat()), heartbeatMs) : null;

    // stdout and stderr each get their own line buffer: BuildKit writes its progress to stderr.
    const reader = () => {
      let rest = '';
      return {
        data(chunk) {
          log.write(chunk);
          const parts = (rest + chunk.toString()).split(/\r?\n/);
          rest = parts.pop();
          for (const line of parts) for (const out of progress.feed(line)) logger.info(out);
        },
        end() {
          if (rest) for (const out of progress.feed(rest)) logger.info(out);
          rest = '';
        },
      };
    };
    const out = reader();
    const err = reader();
    child.stdout.on('data', out.data);
    child.stderr.on('data', err.data);

    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      out.end();
      err.end();
      log.end(() => (error ? reject(error) : resolve()));
    };
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (code === 0) return finish();
      logger.error(`Command failed: ${command}`);
      logger.error(`Last lines of the ${service} build (full log: ${logFile}):`);
      for (const line of progress.tail()) logger.error(line);
      const error = new Error(`Command failed with exit code ${code ?? signal}: ${command}`);
      error.code = code;
      finish(error);
    });
  });
}

module.exports = { createBuildProgress, formatDuration, streamBuild, labelOf };
