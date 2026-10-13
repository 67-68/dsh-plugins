// Shared text-output factory for tool registrations.
//
// Inter-module leaf: imported by lib/tools/* (all 7 domain files), imports
// nothing inside lib/ — dependency direction is strictly one-way inward.
export function textOutput() {
  return { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };
}
