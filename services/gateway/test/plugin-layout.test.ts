import * as fs from 'fs';
import * as path from 'path';

/**
 * The layout that lets a built-in be packaged: a plugin folder can be deleted or replaced by a
 * package only if nothing else needs its files, and if everything it needs resolves from there.
 */
const SRC = path.resolve(__dirname, '..', 'src');
const PLUGINS = path.join(SRC, 'plugins');

const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });

const IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"](\.\.?\/[^'"]+)['"]/g;
const relativeImports = (file: string): string[] =>
  [...fs.readFileSync(file, 'utf8').matchAll(IMPORT)].map(match => match[1] as string);

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

describe('plugin layout', () => {
  it('nothing outside plugins/ imports from it', () => {
    const offenders = sourceFiles(SRC)
      .filter(file => !isInside(PLUGINS, file))
      .flatMap(file => relativeImports(file)
        .filter(spec => isInside(PLUGINS, path.resolve(path.dirname(file), spec)))
        .map(spec => `${path.relative(SRC, file)} -> ${spec}`));
    expect(offenders).toEqual([]);
  });

  it('a plugin imports only from its own folder or from outside plugins/', () => {
    const offenders = sourceFiles(PLUGINS).flatMap(file => {
      const own = path.join(PLUGINS, path.relative(PLUGINS, file).split(path.sep)[0] as string);
      return relativeImports(file)
        .map(spec => ({ spec, target: path.resolve(path.dirname(file), spec) }))
        .filter(({ target }) => isInside(PLUGINS, target) && !isInside(own, target))
        .map(({ spec }) => `${path.relative(SRC, file)} -> ${spec}`);
    });
    expect(offenders).toEqual([]);
  });
});
