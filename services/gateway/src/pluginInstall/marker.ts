/**
 * Name of the file that marks a plugin folder as installed (as opposed to
 * shipped). Import-free so the sync engine can use it without pulling in the
 * loader and, through it, configService.
 */
export const INSTALLED_MARKER = '.installed.json';
