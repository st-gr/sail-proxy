import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';

export type NamespacedEdit = { file: string; format: 'toml' | 'json'; blocks: Record<string, string> };

/** Replace or append each named [section]; every other byte is preserved. */
export function spliceTomlSections(content: string, sections: Record<string, string>): string {
  let out = content.replace(/\s*$/, '') + '\n';
  for (const [name, body] of Object.entries(sections)) {
    const header = `[${name}]`;
    // Match "[name]\n<body lines up to next header or EOF>"
    const re = new RegExp(`(^|\\n)\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n\\[|$)`);
    const block = `${header}\n${body.replace(/\s*$/, '')}\n`;
    if (re.test(out)) {
      out = out.replace(re, (m, pre) => `${pre}${block}`);
    } else {
      out = out.replace(/\s*$/, '') + `\n\n${block}`;
    }
  }
  return out;
}

export function setJsonPath(content: string, dottedKey: string, valueJson: string): string {
  const root = content.trim() ? JSON.parse(content) : {};
  const parts = dottedKey.split('.');
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] ??= {};
  cur[parts[parts.length - 1]] = JSON.parse(valueJson);
  return JSON.stringify(root, null, 2) + '\n';
}

export function diffEdit(edit: NamespacedEdit): string {
  const existing = existsSync(edit.file) ? readFileSync(edit.file, 'utf8') : '(new file)';
  let next: string;
  try {
    next = renderNext(edit, existsSync(edit.file) ? existing : '');
  } catch (e: any) {
    throw new Error(`Failed to read ${edit.file}: ${e.message}`);
  }
  return `--- ${edit.file}\n+++ (sail-proxy will write only its own blocks: ${Object.keys(edit.blocks).join(', ')})\n` +
         next;
}

function renderNext(edit: NamespacedEdit, current: string): string {
  if (edit.format === 'toml') return spliceTomlSections(current, edit.blocks);
  let out = current || '{}';
  for (const [k, v] of Object.entries(edit.blocks)) out = setJsonPath(out, k, v);
  return out;
}

export function applyEdit(edit: NamespacedEdit, opts: { dryRun?: boolean } = {}): { backupPath?: string } {
  const current = existsSync(edit.file) ? readFileSync(edit.file, 'utf8') : '';
  let next: string;
  try {
    next = renderNext(edit, current);
  } catch (e: any) {
    throw new Error(`Failed to read ${edit.file}: ${e.message}`);
  }
  if (opts.dryRun) return {};
  let backupPath: string | undefined;
  if (existsSync(edit.file)) {
    backupPath = `${edit.file}.sailproxy-bak-${Date.now()}`;
    copyFileSync(edit.file, backupPath);
  }
  writeFileSync(edit.file, next);
  return { backupPath };
}
