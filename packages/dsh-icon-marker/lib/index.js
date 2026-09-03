import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

/**
 * dsh-icon-marker — host half.
 *
 * Only job: register the settings namespace `dsh-icon-marker`. The browser
 * half reads/writes it through `settingsScope`; the host does no business
 * logic and no session-log scanning in v1.
 */

export const name = 'dsh-icon-marker';
export const inject = ['settings'];

const SymbolSchema = z.object({
  key: z.string(),
  char: z.string(),
  label: z.string(),
});

const AutoRuleSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  flags: z.string().default(''),
  symbolKey: z.string(),
});

export const MARKER_SCHEMA = z.object({
  symbols: z.array(SymbolSchema).default([]),
  sessions: z.dict(z.string()).default({}),
  stateSymbols: z.dict(z.string()).default({}),
  autoRules: z.array(AutoRuleSchema).default([]),
  autoSessions: z.dict(z.string()).default({}),
  hideStatus: z.boolean().default(false),
});

export function apply(ctx) {
  ctx.settings.register(settingsNamespace('dsh-icon-marker'), MARKER_SCHEMA);
}
