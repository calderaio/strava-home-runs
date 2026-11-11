import { describe, expect, test } from 'bun:test';
import { HIT_PX, pickAction, pointerKind } from '../src/lib/pick.ts';

describe('picking a home: click vs tap', () => {
  const homes = [{ id: 'a', d: 40 }, { id: 'b', d: 18 }, { id: 'c', d: 9 }];

  test('a click or tap on a known home selects the nearest one within the hit radius', () => {
    expect(pickAction('mouse', homes, null)).toEqual({ kind: 'select', id: 'c' });
    expect(pickAction('touch', homes, null)).toEqual({ kind: 'select', id: 'c' });
    expect(pickAction('touch', [{ id: 'b', d: 18 }, { id: 'a', d: 40 }], null)).toEqual({ kind: 'select', id: 'b' });
  });

  test('fingers get a larger hit radius than the mouse', () => {
    const near = [{ id: 'b', d: 18 }];
    expect(pickAction('mouse', near, null)).toEqual({ kind: 'add' });
    expect(pickAction('touch', near, null)).toEqual({ kind: 'select', id: 'b' });
    expect(pickAction('pen', near, null)).toEqual({ kind: 'select', id: 'b' });
    expect(HIT_PX.touch).toBeGreaterThan(HIT_PX.mouse);
    expect(pickAction('mouse', [{ id: 'x', d: HIT_PX.mouse }], null)).toEqual({ kind: 'select', id: 'x' });
  });

  test('a mouse click away from homes picks the spot at once', () => {
    expect(pickAction('mouse', [], null)).toEqual({ kind: 'add' });
    expect(pickAction('mouse', [], 300)).toEqual({ kind: 'add' });
  });

  test('a first tap previews; a second tap on the preview picks it; a tap elsewhere moves the preview', () => {
    expect(pickAction('touch', [], null)).toEqual({ kind: 'preview' });
    expect(pickAction('touch', [], 10)).toEqual({ kind: 'add' });
    expect(pickAction('touch', [], HIT_PX.touch)).toEqual({ kind: 'add' });
    expect(pickAction('touch', [], HIT_PX.touch + 1)).toEqual({ kind: 'preview' });
  });

  test('pointer types: only "mouse" is a mouse, anything unknown counts as touch', () => {
    expect(pointerKind('mouse')).toBe('mouse');
    expect(pointerKind('pen')).toBe('pen');
    expect(pointerKind('touch')).toBe('touch');
    expect(pointerKind('')).toBe('touch');
    expect(pointerKind(undefined)).toBe('touch');
  });
});
