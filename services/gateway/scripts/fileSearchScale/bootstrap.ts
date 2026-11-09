/**
 * The first import of file-search-scale.ts: parses the command line and prepares the environment before
 * any gateway module loads (configService reads CONFIG_FILE_PATH and the standalone flags at load time).
 * The environment is the evaluation runner's (no Valkey, admin, database or config URL from the shell);
 * the generated api_config holds only `file_search.embedding_dimensions`, which the schema migration
 * builds the vector column with. No credentials are read: the bench makes no SAP calls.
 */
import { Options, parseArgs, USAGE } from './options';
import { prepareEnvironment } from '../fileSearchEval/environment';

function parse(): Options {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error: any) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

export const options = parse();

prepareEnvironment({ env: null, verbose: false },
  { description: 'file_search scale bench', fileSearch: { embedding_dimensions: options.dims } });
