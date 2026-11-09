import { uploadProblem } from '../webapp/model/upload';

describe('uploadProblem', () => {
  const MAX = 33554432;
  it('accepts a file within the limit', () => {
    expect(uploadProblem({ name: 'note.txt', size: 5 }, MAX)).toBeNull();
    expect(uploadProblem({ name: 'big.pdf', size: MAX }, MAX)).toBeNull();
  });
  it('refuses an empty file', () => {
    expect(uploadProblem({ name: 'empty.txt', size: 0 }, MAX)).toBe('empty');
  });
  it('refuses a file over the limit', () => {
    expect(uploadProblem({ name: 'huge.pdf', size: MAX + 1 }, MAX)).toBe('too_large');
  });
  it('does not guess a limit it was not given', () => {
    expect(uploadProblem({ name: 'huge.pdf', size: 10 ** 12 }, 0)).toBeNull();
  });
  it('refuses a missing name and a name over 255 characters', () => {
    expect(uploadProblem({ name: '', size: 5 }, MAX)).toBe('bad_name');
    expect(uploadProblem({ name: `${'a'.repeat(252)}.txt`, size: 5 }, MAX)).toBe('bad_name');
    expect(uploadProblem({ name: `${'a'.repeat(251)}.txt`, size: 5 }, MAX)).toBeNull();
  });
});
