import { NamespacedEdit } from '../config-writer';
export { NamespacedEdit };
export interface LaunchContext { rootUrl: string; apiKey: string; webSearch: boolean; dryRun: boolean }
export interface LaunchPlan { fileEdits: NamespacedEdit[]; env: Record<string, string>; notes: string[]; argv: string[] }
export interface HarnessAdapter {
  name: 'codex' | 'claude' | 'opencode' | 'gemini' | 'pi';
  locate(): Promise<string>;
  plan(ctx: LaunchContext, passthrough: string[]): Promise<LaunchPlan>;
}
