/**
 * What a click or tap does while picking a home on the map.
 *
 * With a mouse the cursor already shows the preview, so a click picks the spot. A finger has no
 * hover, so the first tap only previews the spot (the start radius and how many runs start there);
 * a second tap on (or next to) that preview, or the "Use this spot" button, picks it. A click or tap
 * on a known home selects that home instead of adding a duplicate; fingers get a larger hit radius.
 */
export type PointerKind = 'mouse' | 'touch' | 'pen';

/** Hit radius in screen px around a known home or the previewed spot. */
export const HIT_PX: Record<PointerKind, number> = { mouse: 12, touch: 24, pen: 24 };

export type PickAction =
  | { kind: 'select'; id: string }  // a known home
  | { kind: 'add' }                 // pick the clicked / previewed spot as a new home
  | { kind: 'preview' };            // touch: show the spot first, pick on the second tap

/**
 * @param homes  screen distance (px) from the click to each known home
 * @param previewDist  screen distance to the spot previewed by an earlier tap, or null if none
 */
export function pickAction(pointer: PointerKind, homes: { id: string; d: number }[], previewDist: number | null): PickAction {
  const r = HIT_PX[pointer] ?? HIT_PX.touch;
  const hit = homes.filter((h) => h.d <= r).sort((a, b) => a.d - b.d)[0];
  if (hit) return { kind: 'select', id: hit.id };
  if (pointer === 'mouse') return { kind: 'add' };
  return previewDist !== null && previewDist <= r ? { kind: 'add' } : { kind: 'preview' };
}

/** Normalise PointerEvent.pointerType (unknown or empty types count as touch: no hover to rely on). */
export const pointerKind = (t: string | undefined): PointerKind => (t === 'mouse' ? 'mouse' : t === 'pen' ? 'pen' : 'touch');
