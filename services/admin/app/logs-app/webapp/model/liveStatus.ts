/**
 * What the Live button and the status line beside the table say, in words and icon (not colour
 * alone). No UI5 imports; the keys are bundle keys.
 */
import type { Order } from './liveLog';

export interface LiveState { live: boolean; range: boolean; order: Order; following: boolean }

export function liveStatusKey(state: LiveState): string {
  if (state.range) return 'statusRange';
  if (!state.live) return 'statusLiveOff';
  if (state.order === 'newestFirst') return 'statusNewestFirst';
  return state.following ? 'statusFollowing' : 'statusPaused';
}

export function liveButton(live: boolean): { icon: string; textKey: string; type: string } {
  return live
    ? { icon: 'sap-icon://pause', textKey: 'liveOn', type: 'Emphasized' }
    : { icon: 'sap-icon://media-play', textKey: 'liveOff', type: 'Default' };
}
