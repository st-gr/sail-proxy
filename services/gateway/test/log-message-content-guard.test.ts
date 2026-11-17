/**
 * The message of an INFO, WARN or ERROR log line is stored and shown to every administrator (the
 * metadata is not). This guard reads the gateway's source with the TypeScript compiler API, finds
 * every `info`/`warn`/`error` call on a logger, and fails when its message interpolates something
 * of a kind that has carried conversation content or a secret in this codebase: a JSON.stringify,
 * a substring/slice of something, or a name such as `query`, `content`, `prompt`, `data`, `body`,
 * `arguments`, `headers`, `token`, `apiKey`. For an `error` call it also looks at the error
 * argument. Such content belongs in the metadata argument; a secret belongs nowhere.
 *
 * A flagged call that was reviewed and holds no content goes on ALLOWED below with its reason.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC = path.join(__dirname, '..', 'src');
const LEVELS = new Set(['info', 'warn', 'error']);
const RECEIVER = /(^|\.)(logger|pluginLogger|log)$/;

// Calls whose result never holds content, whatever goes in. errorText is an error's message, like
// the many `${error.message}` this guard passes; the one kind of message that quotes its input
// (JSON.parse) is cut by the shipper (logShipper.ts).
const SAFE_WRAPPERS = new Set(['redactUrl', 'secretLabel', 'describeErrorWithoutContent', 'safeErrorMessage',
  'errorName', 'driverErrorCode', 'busyReason', 'retryReason', 'httpStatusOf', 'errorText',
  // utils/upstreamErrorLogText.ts: an error's text (an upstream's message only cut), a status, a classification
  'loggableErrorText', 'upstreamRefusal', 'upstreamErrorKind']);
// The one way an upstream's own message may enter a line: upstreamErrorText cuts it to 300 characters.
// Its arguments are still checked for everything else (a body, a JSON dump, a slice).
const UPSTREAM_TEXT_HELPERS = new Set(['upstreamErrorText']);
// Names that hold what a log line may say (geminiFailure's `logText`).
const SAFE_NAMES = new Set(['logtext']);
// Whole identifiers (lower-cased) that name content or a secret.
const DENY_EXACT = new Set(['url', 'imageurl', 'input', 'inputs', 'output', 'outputs', 'apikey', 'accesskeyid',
  'secretaccesskey', 'authtoken', 'accesstoken', 'bearer', 'raw', 'snippet', 'preview',
  // a child process's output (it can quote the document it read) and an error's stack
  'stderr', 'stdout', 'stack']);
// The last word of a camelCase or snake_case name (its head noun: `searchQuery`, `fullContent`,
// `toolCall.function.arguments`) that names content or a secret. `contentBlockIndex` or
// `finalTokenCount` end in a word that names a number, and pass.
const DENY_WORDS = new Set(['query', 'prompt', 'prompts', 'content', 'contents', 'arguments', 'args', 'body',
  'payload', 'data', 'messages', 'completion', 'delta', 'text', 'transcript', 'headers', 'header',
  'authorization', 'cookie', 'token', 'secret', 'password', 'filename', 'signature']);
// `<owner>.message` or `.error` where the owner is an upstream failure, an in-stream chunk or an
// upstream body: the upstream's own error text (utils/upstreamErrorLogText.ts has what may be logged).
const UPSTREAM_TEXT_OWNERS = new Set(['failure', 'chunk', 'upstream', 'response', 'sapError']);
const UPSTREAM_TEXT_NAMES = new Set(['upstreammessage']);

const lastWord = (identifier: string): string =>
  identifier.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_]+/).filter(Boolean).pop()?.toLowerCase() ?? '';
/** `reason` as a WebSocket close event's (code, reason): the peer's free text. Other `reason`s in
 *  this codebase are codes from a fixed vocabulary. */
function isCloseReason(n: ts.Identifier): boolean {
  if (n.text !== 'reason') return false;
  for (let node: ts.Node | undefined = n.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      const names = node.parameters.map((p) => p.name.getText());
      if (names.includes('reason')) return names.includes('code');
    }
  }
  return false;
}

const deniedName = (name: string): boolean => DENY_EXACT.has(name.toLowerCase()) || DENY_WORDS.has(lastWord(name));

/** Why this expression may hold content, or null. */
function riskIn(expr: ts.Node, sf: ts.SourceFile): string | null {
  let found: string | null = null;
  let upstreamTextAllowed = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (SAFE_WRAPPERS.has(name)) return;
      if (UPSTREAM_TEXT_HELPERS.has(name) && ts.isIdentifier(callee)) {
        const outer = upstreamTextAllowed;
        upstreamTextAllowed = true;
        n.arguments.forEach(visit);
        upstreamTextAllowed = outer;
        return;
      }
      if (callee.getText(sf) === 'JSON.stringify') { found = 'JSON.stringify('; return; }
      if (ts.isPropertyAccessExpression(callee) && ['substring', 'slice', 'substr'].includes(name)) { found = `.${name}(`; return; }
      // a method call: look at its receiver and arguments, not at the method's name
      if (ts.isPropertyAccessExpression(callee)) { visit(callee.expression); n.arguments.forEach(visit); return; }
    }
    // a boolean or a type name never carries the value
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return;
    if (ts.isTypeOfExpression(n)) return;
    // `a.b.c`: the last name says what it is (`req.body.model` is a model name, `error.response.data` a body)
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === 'length' || n.name.text === 'size') return;
      if (deniedName(n.name.text)) { found = n.getText(sf); return; }
      const owner = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
      if (!upstreamTextAllowed && (n.name.text === 'message' || n.name.text === 'error') && (UPSTREAM_TEXT_OWNERS.has(owner) || UPSTREAM_TEXT_OWNERS.has(lastWord(owner)))) {
        found = n.getText(sf); return;
      }
      if (!ts.isIdentifier(n.expression) && !ts.isPropertyAccessExpression(n.expression)) visit(n.expression);
      return;
    }
    if (ts.isIdentifier(n)) {
      if (SAFE_NAMES.has(n.text.toLowerCase())) return;
      if (deniedName(n.text) || (!upstreamTextAllowed && UPSTREAM_TEXT_NAMES.has(n.text.toLowerCase())) || isCloseReason(n)) found = n.text;
      return;
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isTemplateExpression(expr)) expr.templateSpans.forEach((s) => visit(s.expression));
  else if (!ts.isStringLiteral(expr) && !ts.isNoSubstitutionTemplateLiteral(expr)) visit(expr);
  return found;
}

const isComponentArg = (a: ts.Expression): boolean =>
  ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isIdentifier(a) || ts.isPropertyAccessExpression(a);
const isMessageLike = (a: ts.Expression): boolean =>
  !ts.isObjectLiteralExpression(a) && !ts.isArrayLiteralExpression(a) && !ts.isNumericLiteral(a);

interface LogCallFinding { file: string; line: number; text: string; risk: string }

type LoggerKind = 'gateway' | 'plugin';
const GATEWAY_INIT = /^(getDefaultLogger|createLogger)\(/;
const PLUGIN_PROPS = new Set(['logger']); // `utils.logger`, `ctx.logger`, `opts.logger`: a plugin's logger

/** Names a binding pattern or name declares. */
function boundNames(name: ts.BindingName): Array<{ id: string; element?: ts.BindingElement }> {
  if (ts.isIdentifier(name)) return [{ id: name.text }];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : ts.isIdentifier(el.name) ? [{ id: el.name.text, element: el }] : boundNames(el.name)));
}

/** What a logger expression is: the gateway's (component, message, …) or a plugin's (message, meta). */
function kindOfLoggerExpr(expr: ts.Expression, sf: ts.SourceFile, depth = 0): LoggerKind | null {
  if (depth > 5) return null;
  if (ts.isCallExpression(expr) && GATEWAY_INIT.test(expr.getText(sf))) return 'gateway';
  if (ts.isPropertyAccessExpression(expr)) {
    if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) return 'gateway';
    if (PLUGIN_PROPS.has(expr.name.text)) return 'plugin';
    return null;
  }
  if (!ts.isIdentifier(expr)) return null;
  const name = expr.text;
  // the nearest declaration of `name`, walking out through the enclosing scopes
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        const hit = boundNames(p.name).find((b) => b.id === name);
        if (hit) {
          if (hit.element) return 'plugin'; // destructured from a plugin context: `({ logger })`
          const type = p.type?.getText(sf) ?? '';
          return /^Logger$/.test(type) && /from '@libs\/logger'/.test(sf.text) && /import \{[^}]*\bLogger\b[^}]*\} from '@libs\/logger'/.test(sf.text) ? 'gateway' : 'plugin';
        }
      }
    }
    const statements = ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) ? (node as any).statements as ts.NodeArray<ts.Statement> : undefined;
    for (const st of statements ?? []) {
      if (ts.isImportDeclaration(st) && /@libs\/logger/.test(st.moduleSpecifier.getText(sf))
        && st.importClause?.getText(sf).match(new RegExp(`\\b${name}\\b`))) return 'gateway';
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        const hit = boundNames(d.name).find((b) => b.id === name);
        if (!hit || !d.initializer) continue;
        if (hit.element) return kindOfLoggerExpr(d.initializer, sf, depth + 1) ?? 'plugin';
        return kindOfLoggerExpr(d.initializer, sf, depth + 1);
      }
    }
  }
  return null;
}

/** A call on a method taken off a logger: `const { warn } = logger` or `logger.warn.bind(logger)`. */
function boundMethod(id: ts.Identifier, sf: ts.SourceFile): { level: string; kind: LoggerKind | null } | null {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    const statements = ts.isSourceFile(node) || ts.isBlock(node) ? (node as any).statements as ts.NodeArray<ts.Statement> : undefined;
    for (const st of statements ?? []) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!d.initializer) continue;
        const hit = boundNames(d.name).find((b) => b.id === id.text);
        if (!hit) continue;
        if (hit.element) {
          const key = hit.element.propertyName?.getText(sf) ?? id.text;
          if (LEVELS.has(key)) return { level: key, kind: kindOfLoggerExpr(d.initializer, sf) };
        }
        let init: ts.Expression = d.initializer;
        if (ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'bind') init = init.expression.expression;
        if (ts.isPropertyAccessExpression(init) && LEVELS.has(init.name.text)) return { level: init.name.text, kind: kindOfLoggerExpr(init.expression, sf) };
      }
    }
  }
  return null;
}

/**
 * Every info/warn/error log call of one source file, and the risky ones among them. The gateway
 * logger takes (component, message, metadata | error, metadata); a plugin's logger takes
 * (message, meta). Which one a call is comes from its receiver's declaration; only where that
 * cannot be resolved does the shape of the arguments decide.
 */
function scan(file: string, source: string): { calls: number; findings: LogCallFinding[] } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const findings: LogCallFinding[] = [];
  let calls = 0;
  // only a file that takes a level method off something can call one by a bare name
  const mayBind = /\.(info|warn|error)\.bind\(|\{[^}]*\b(info|warn|error)\b[^}]*\}\s*=/.test(source);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.arguments.length > 0) {
      const callee = n.expression;
      let level = '';
      let kind: LoggerKind | null = null;
      let isLogCall = false;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        level = ts.isPropertyAccessExpression(callee) ? callee.name.text : 'dynamic';
        const receiver = callee.expression;
        const receiverText = receiver.getText(sf);
        if ((LEVELS.has(level) || level === 'dynamic') && (RECEIVER.test(receiverText) || /getDefaultLogger\(\)$/.test(receiverText))) {
          isLogCall = true;
          kind = kindOfLoggerExpr(receiver, sf);
        }
      } else if (mayBind && ts.isIdentifier(callee)) {
        const bound = boundMethod(callee, sf);
        if (bound) { isLogCall = true; level = bound.level; kind = bound.kind; }
      }
      if (isLogCall) {
        calls++;
        const args = n.arguments;
        const gatewayShape = kind ? kind === 'gateway' && args.length >= 2 : args.length >= 2 && isComponentArg(args[0]) && isMessageLike(args[1]);
        const message = gatewayShape ? args[1] : args[0];
        let risk = riskIn(message, sf);
        if (!risk && gatewayShape && level === 'error' && args[2]) {
          const e = riskIn(args[2], sf);
          if (e) risk = `error argument: ${e}`;
        }
        if (risk) {
          findings.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf), risk });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, findings };
}

/**
 * Reviewed calls: the file and a short piece of the call's text. One entry covers every flagged
 * call of that file whose text contains the marker.
 */
const ALLOWED: Array<{ file: string; marker: string; reason: string }> = [
  // provider, model names, streaming mode, status, latency and request id (the LogEvent interface)
  { file: 'src/controllers/anthropicController.ts', marker: 'JSON.stringify(eventWithTs)', reason: 'structured event without content' },
  // `${timestamp}_${requestId}_04_client_native_stream_response.txt`, made by the gateway
  { file: 'src/controllers/anthropicController.ts', marker: 'Saved SSE stream to ${filename}', reason: 'the payload file name' },
  { file: 'src/controllers/anthropicController.ts', marker: '${latencyMsEmulationData}ms', reason: 'a duration' },
  // sapAIService's own cancel chunk: 'Client connection (already) aborted' or 'Request aborted by client'
  { file: 'src/controllers/openaiController.ts', marker: 'Request canceled by client: ${chunk.message}', reason: "the gateway's own text" },
  { file: 'src/controllers/countTokensController.ts', marker: '${tokenCount.input}', reason: 'token counts' },
  // the operator's own FILE_SEARCH_OCR environment switch, cut to 32 characters
  { file: 'src/fileSearch/extractors/ocrAvailability.ts', marker: 'raw.slice(0, 32)', reason: 'an environment switch value' },
  // the cache key is a SHA-256 hash of the request; a prefix of it names the entry, never content
  { file: 'src/plugins/awsBedrockResponseCache/index.ts', marker: 'acheKey.substring(0, ', reason: 'a hash prefix' },
  { file: 'src/plugins/awsBedrockResponseCache/index.ts', marker: 'for key ${key.substring(0, 8)}', reason: 'a hash prefix' },
  // MASKED_<TYPE>_<hex>: the stand-in the model saw, never the masked value
  { file: 'src/plugins/pseudonymization/index.ts', marker: 'Unmask miss on streaming block ${key}: ${token} was in the replacement map', reason: 'a masked placeholder token' },
  { file: 'src/plugins/pseudonymization/index.ts', marker: 'Unresolvable masked residue in streaming block ${key}: ${token} is not in', reason: 'a masked placeholder token' },
  // logged only when the content is empty: a blank string or text blocks without text
  { file: 'src/plugins/removeEmptyAssistantMessages/index.ts', marker: 'JSON.stringify(message.content)', reason: 'empty content' },
  // a tool_choice is a mode and at most a tool name
  { file: 'src/services/anthropicToolsService.ts', marker: 'Transformed tool_choice for SAP AI Core format: ${JSON.stringify(toolChoiceConfig)}', reason: 'a mode and a tool name' },
  { file: 'src/services/anthropicToolsService.ts', marker: 'Unsupported tool_choice format: ${JSON.stringify(anthropicToolChoice)}', reason: 'a mode and a tool name' },
  { file: 'src/services/awsBedrockService.ts', marker: "JSON.stringify(hookConfig ? 'present' : 'missing')", reason: 'a fixed word' },
  // generateBackupFilename(): configuration backups the gateway writes
  { file: 'src/services/configService.ts', marker: 'from backup: ${backupFilename}', reason: 'a configuration backup file name' },
  { file: 'src/services/configService.ts', marker: 'backup: ${backup.filename}', reason: 'a configuration backup file name' },
  { file: 'src/services/configService.ts', marker: 'JSON.stringify(configured)', reason: 'a configured number' },
  // an object of functions; serialises to {}
  { file: 'src/services/pluginExecutor.ts', marker: 'JSON.stringify(utils.logger)', reason: 'no data' },
  // `${destination.url}/v2/inference/deployments/${deploymentId}/v2/completion`
  { file: 'src/services/sapAIService.ts', marker: 'Calling SAP AI Core at URL: ${url}', reason: 'the SAP AI Core deployment URL' },
  // `${timestamp}_${requestId}_${stage}.json`, made by the gateway
  { file: 'src/utils/payloadLogger.ts', marker: 'Saved enhanced ${stage} to ${filename}', reason: 'the payload file name' },
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

const allowed = (f: LogCallFinding): boolean =>
  ALLOWED.some((a) => f.file === a.file && f.text.includes(a.marker));

describe('log message content guard', () => {
  it('flags a planted log call that puts content into the message, and passes a clean one', () => {
    const fixture = [
      "logger.warn('X', `Failed to parse tool arguments: ${toolCall.function.arguments}`);",
      "logger.info('X', `query: \"${searchQuery}\"`);",
      "pluginLogger.info(`Unrecognized: ${JSON.stringify(item).substring(0, 100)}`);",
      "logger.error('X', 'Request failed', error.response?.data);",
      "logger.error('X', `Problematic chunk: ${rawText}`);",
      "logger.error('X', `Orchestration stream refused (${failure.status}): ${failure.message}`);",
      "logger.error('X', `Error chunk received: ${chunk.message || sapError?.message}`);",
      "logger.info('X', `Calling ${redactUrl(req.originalUrl)} for ${req.body.model}: ${inputTokens} in, ${messages.length} messages, body ${!!req.body}`);",
      "logger.warn('X', 'Failed to parse tool arguments', { arguments: toolCall.function.arguments });",
      "logger.debug('X', `query: ${searchQuery}`);",
      // the receiver decides the argument positions, not the arguments' shape
      "getDefaultLogger().warn('X', `Allow-list pattern ${JSON.stringify(source)} also matches`);",
      'const pluginLogger = utils.logger; pluginLogger.warn(rawText, details);',
      "const { warn } = getDefaultLogger(); warn('X', `query ${searchQuery}`);",
      "const err = logger.error.bind(logger); err('X', `Problematic chunk: ${rawText}`);",
      "logger.error('X', `${cmd} failed: ${child.stderr}`);",
      "logger.error('X', `Error executing plugin: ${error.message}. Stack: ${error.stack}`);",
      "function onClosed(side, code, reason) { logger.info('X', `closed by ${side} (${code} ${reason})`); }",
      "function closed(reason) { logger.info('X', `closed: ${reason}`); }",
      // an upstream's message goes into a line only through upstreamErrorText, which cuts it; the
      // rest of a body never does, not even through it
      "logger.error('X', `refused: ${upstreamErrorText(failure.status, upstreamErrorKind(chunk.error), failure.message)}`);",
      "logger.error('X', `refused: ${upstreamErrorText(failure.status, undefined, chunk.error)}`);",
      "logger.error('X', `refused: ${upstreamErrorText(status, undefined, JSON.stringify(sapError))}`);",
      "logger.error('X', `refused: ${upstreamErrorText(status, undefined, error.response.data)}`);",
    ].join('\n');
    const { calls, findings } = scan('fixture.ts', fixture);
    expect(calls).toBe(21);
    expect(findings.map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 17, 21, 22]);
    expect(findings.map((f) => f.risk)).toEqual([
      'toolCall.function.arguments', 'searchQuery', '.substring(', 'error argument: error.response?.data', 'rawText',
      'failure.message', 'chunk.message',
      'JSON.stringify(', 'rawText', 'searchQuery', 'rawText', 'child.stderr', 'error.stack', 'reason',
      'JSON.stringify(', 'error.response.data',
    ]);
  });

  it('finds no unreviewed info/warn/error log call in the gateway whose message interpolates content', () => {
    let calls = 0;
    const flagged: LogCallFinding[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
      const result = scan(rel, fs.readFileSync(file, 'utf8'));
      calls += result.calls;
      flagged.push(...result.findings);
    }
    // The scan sees the calls (a parser change that finds none would pass vacuously).
    expect(calls).toBeGreaterThan(1000);
    const unreviewed = flagged.filter((f) => !allowed(f)).map((f) => `${f.file}:${f.line} [${f.risk}] ${f.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    expect(unreviewed).toEqual([]);
    // Every allow-list entry still matches a call (no stale entries).
    const stale = ALLOWED.filter((a) => !flagged.some((f) => f.file === a.file && f.text.includes(a.marker)));
    expect(stale).toEqual([]);
  });
});
