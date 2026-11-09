import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, createReadStream, watchFile, unwatchFile } from 'fs';
import { Writable, Readable } from 'stream';
import { join } from 'path';
import { getLogPath, ensureLogDir } from './paths';
import readline from 'readline';
import chalk from 'chalk';

// Configuration
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;

export type LogService = 'gateway' | 'ollama';

export interface LogOptions {
  follow?: boolean;
  tail?: number;
  since?: string;
  clear?: boolean;
}

/**
 * Create a write stream for service logs
 */
export function createLogStream(service: LogService): Writable {
  ensureLogDir();
  const logPath = getLogPath(`${service}.log`);
  
  // Rotate logs if needed before creating new stream
  rotateLogsIfNeeded(service);
  
  return createWriteStream(logPath, { flags: 'a' });
}

/**
 * Rotate logs if they exceed the size limit
 */
export function rotateLogsIfNeeded(service: LogService): void {
  const logPath = getLogPath(`${service}.log`);
  
  if (!existsSync(logPath)) {
    return;
  }
  
  try {
    const stats = statSync(logPath);
    if (stats.size > MAX_LOG_SIZE) {
      // Rotate existing logs
      for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
        const oldPath = getLogPath(`${service}.log.${i}`);
        const newPath = getLogPath(`${service}.log.${i + 1}`);
        
        if (existsSync(oldPath)) {
          if (i === MAX_ROTATED_FILES - 1) {
            // Delete the oldest file
            unlinkSync(oldPath);
          } else {
            // Rename to next number
            renameSync(oldPath, newPath);
          }
        }
      }
      
      // Rename current log to .1
      renameSync(logPath, getLogPath(`${service}.log.1`));
    }
  } catch (error) {
    console.warn(`Failed to rotate logs for ${service}:`, error);
  }
}

/**
 * Read logs with options
 */
export async function readLogs(service: LogService, options: LogOptions = {}): Promise<void> {
  const logPath = getLogPath(`${service}.log`);
  
  if (!existsSync(logPath)) {
    console.log(chalk.yellow(`No logs found for ${service}`));
    return;
  }
  
  if (options.clear) {
    clearLogs(service);
    console.log(chalk.green(`✓ Cleared logs for ${service}`));
    return;
  }
  
  if (options.follow) {
    await followLogs([service]);
    return;
  }
  
  // Read logs with tail option
  const lines = await readLastLines(logPath, options.tail || 100);
  
  // Filter by time if 'since' option is provided
  const filteredLines = options.since ? filterLinesBySince(lines, options.since) : lines;
  
  if (filteredLines.length === 0) {
    console.log(chalk.gray(`No logs found for ${service}`));
  } else {
    filteredLines.forEach(line => console.log(line));
  }
}

/**
 * Read last N lines from a file
 */
async function readLastLines(filePath: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const stream = createReadStream(filePath);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length > count) {
        lines.shift();
      }
    });
    
    rl.on('close', () => resolve(lines));
    rl.on('error', reject);
  });
}

/**
 * Filter lines by time
 */
function filterLinesBySince(lines: string[], since: string): string[] {
  const sinceTime = parseSinceTime(since);
  if (!sinceTime) return lines;
  
  return lines.filter(line => {
    // Try to extract timestamp from log line
    const timestampMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
    if (timestampMatch) {
      const lineTime = new Date(timestampMatch[1]).getTime();
      return lineTime >= sinceTime;
    }
    return true; // Include lines without timestamps
  });
}

/**
 * Parse since time string (e.g., "1h", "30m", "2d")
 */
function parseSinceTime(since: string): number | null {
  const match = since.match(/^(\d+)([hmsd])$/);
  if (!match) return null;
  
  const value = parseInt(match[1]);
  const unit = match[2];
  const now = Date.now();
  
  switch (unit) {
    case 's': return now - (value * 1000);
    case 'm': return now - (value * 60 * 1000);
    case 'h': return now - (value * 60 * 60 * 1000);
    case 'd': return now - (value * 24 * 60 * 60 * 1000);
    default: return null;
  }
}

/**
 * Clear logs for a service
 */
export function clearLogs(service: LogService): void {
  const logPath = getLogPath(`${service}.log`);
  
  try {
    if (existsSync(logPath)) {
      unlinkSync(logPath);
    }
    
    // Also remove rotated logs
    for (let i = 1; i <= MAX_ROTATED_FILES; i++) {
      const rotatedPath = getLogPath(`${service}.log.${i}`);
      if (existsSync(rotatedPath)) {
        unlinkSync(rotatedPath);
      }
    }
  } catch (error) {
    console.error(chalk.red(`Failed to clear logs for ${service}:`, error));
  }
}

/**
 * Follow logs in real-time
 */
export async function followLogs(services: LogService[]): Promise<void> {
  console.log(chalk.gray('Following logs... (Press Ctrl+C to stop)\n'));
  
  const watchers: Map<string, Readable> = new Map();
  
  // Set up tail for each service
  for (const service of services) {
    const logPath = getLogPath(`${service}.log`);
    
    if (!existsSync(logPath)) {
      console.log(chalk.yellow(`No logs found for ${service}, waiting for logs...\n`));
      continue;
    }
    
    // Start tailing from end of file
    const stream = createReadStream(logPath, { 
      encoding: 'utf8',
      start: Math.max(0, statSync(logPath).size - 1024) // Start from last 1KB
    });
    
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    
    rl.on('line', (line) => {
      console.log(`${chalk.blue(`[${service}]`)} ${line}`);
    });
    
    // Watch for file changes
    watchFile(logPath, { interval: 100 }, () => {
      // File changed, read new content
      const newStream = createReadStream(logPath, {
        encoding: 'utf8',
        start: stream.readableLength
      });
      
      const newRl = readline.createInterface({
        input: newStream,
        crlfDelay: Infinity
      });
      
      newRl.on('line', (line) => {
        console.log(`${chalk.blue(`[${service}]`)} ${line}`);
      });
    });
  }
  
  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\nStopping log tail...'));
    services.forEach(service => {
      unwatchFile(getLogPath(`${service}.log`));
    });
    process.exit(0);
  });
  
  // Keep process alive
  await new Promise(() => {});
}

/**
 * Get timestamp for log entries
 */
export function getLogTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format log line with timestamp
 */
export function formatLogLine(message: string, includeTimestamp = true): string {
  return includeTimestamp ? `${getLogTimestamp()} ${message}` : message;
}