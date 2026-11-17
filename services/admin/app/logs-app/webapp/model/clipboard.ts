/** Copying a request id: the clipboard is missing outside a secure context, or may refuse. No UI5 imports. */
export async function copyText(clipboard: { writeText(text: string): Promise<void> } | undefined, text: string): Promise<'requestIdCopied' | 'copyUnavailable'> {
  if (!clipboard) return 'copyUnavailable';
  try {
    await clipboard.writeText(text);
    return 'requestIdCopied';
  } catch (error) {
    return 'copyUnavailable';
  }
}
