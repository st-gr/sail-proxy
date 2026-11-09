/** What stops a file before it is uploaded. The gateway enforces the same limits; this saves the round trip. */

export type UploadProblem = 'empty' | 'too_large' | 'bad_name';

const MAX_FILENAME_LENGTH = 255;

export function uploadProblem(file: { name: string; size: number }, maxFileBytes: number): UploadProblem | null {
  if (!file.name || file.name.length > MAX_FILENAME_LENGTH) return 'bad_name';
  if (!(file.size > 0)) return 'empty';
  if (maxFileBytes > 0 && file.size > maxFileBytes) return 'too_large';
  return null;
}
