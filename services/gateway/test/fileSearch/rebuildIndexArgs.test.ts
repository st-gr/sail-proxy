// W4 Task 2: `migrateCli.js rebuild-index` arguments.
import { parseRebuildIndexArgs, RebuildIndexUsageError, REBUILD_INDEX_USAGE } from '../../src/fileSearch/rebuildIndex';

describe('parseRebuildIndexArgs', () => {
  it('defaults: build for real, m 16, ef_construction 200, serial, the server maintenance_work_mem', () => {
    expect(parseRebuildIndexArgs([])).toEqual({
      dryRun: false, m: 16, efConstruction: 200, parallel: false, maintenanceWorkMemMb: null, help: false,
    });
  });

  it('reads every flag, in both --flag value and --flag=value forms', () => {
    expect(parseRebuildIndexArgs([
      '--dry-run', '--ef-construction', '120', '--m=24', '--parallel', '--maintenance-work-mem', '2048',
    ])).toEqual({ dryRun: true, m: 24, efConstruction: 120, parallel: true, maintenanceWorkMemMb: 2048, help: false });
  });

  it('--help', () => {
    expect(parseRebuildIndexArgs(['--help']).help).toBe(true);
    expect(REBUILD_INDEX_USAGE).toMatch(/rebuild-index \[--dry-run\]/);
  });

  it('the usage names the command of every way it is run, not only the compiled entry', () => {
    // `sail-proxy file-search rebuild-index --help` prints this text too.
    expect(REBUILD_INDEX_USAGE).not.toMatch(/^Usage: migrateCli\.js/);
    expect(REBUILD_INDEX_USAGE).toContain('sail-proxy file-search rebuild-index');
    expect(REBUILD_INDEX_USAGE).toContain('node cli-tools/file-search-migrate.js rebuild-index');
    expect(REBUILD_INDEX_USAGE).toContain('node services/gateway/dist/services/gateway/src/fileSearch/migrateCli.js rebuild-index');
  });

  it.each([
    [['--bogus'], /unknown option --bogus/],
    [['extra'], /unknown argument extra/],
    [['--m'], /--m needs a value/],
    [['--m', '--parallel'], /--m needs a value/],
    [['--m', '1'], /--m must be a whole number from 2 to 100/],
    [['--m', '101'], /--m must be a whole number from 2 to 100/],
    [['--m', '16.5'], /--m must be a whole number/],
    [['--ef-construction', '3'], /--ef-construction must be a whole number from 4 to 1000/],
    [['--ef-construction', '1001'], /--ef-construction must be a whole number from 4 to 1000/],
    [['--m', '64', '--ef-construction', '100'], /--ef-construction must be at least twice --m/],
    [['--maintenance-work-mem', '0'], /--maintenance-work-mem must be a whole number of megabytes from 1 to 2097151/],
    [['--maintenance-work-mem', '1GB'], /--maintenance-work-mem must be a whole number of megabytes/],
    [['--dry-run=yes'], /--dry-run takes no value/],
  ])('%p is refused', (argv, message) => {
    expect(() => parseRebuildIndexArgs(argv as string[])).toThrow(RebuildIndexUsageError);
    expect(() => parseRebuildIndexArgs(argv as string[])).toThrow(message);
  });
});
