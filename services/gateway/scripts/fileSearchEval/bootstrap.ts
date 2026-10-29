/**
 * The first import of file-search-eval.ts: parses the command line and prepares the environment
 * before any gateway module is loaded (they read CONFIG_FILE_PATH, the standalone flags and the log
 * settings at load time). A --compare run needs no environment.
 */
import { CONFIGS, Options, parseArgs, USAGE } from './options';
import { prepareEnvironment } from './environment';

function parse(): Options {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error: any) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

export const options = parse();

if (!options.compare) prepareEnvironment(options, CONFIGS[options.config]);
