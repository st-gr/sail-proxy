/**
 * Where a Library model comes from: SAP AI Core, or a Connection (origin 'external', with the
 * connection's name). Returns the i18n key and its arguments; the caller translates.
 */
export function originText(origin: string | null, connection: string | null): { key: string; args: string[] } {
  if (origin !== 'external') return { key: 'originSap', args: [] };
  return connection ? { key: 'originConnection', args: [connection] } : { key: 'originConnectionUnnamed', args: [] };
}

/** The label for the view: the bundle texts for the three cases; {0} takes the connection name literally (a function replacer, so "$&" in a name stays as typed). */
export function originLabel(origin: string | null, connection: string | null, sapText: string, connectionText: string, unnamedText: string): string {
  const { key, args } = originText(origin, connection);
  return key === 'originSap' ? sapText : key === 'originConnection' ? connectionText.replace('{0}', () => args[0]) : unnamedText;
}
