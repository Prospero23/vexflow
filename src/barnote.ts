// Copyright (c) 2023-present VexFlow contributors: https://github.com/vexflow/vexflow/graphs/contributors
// MIT License

import { ModifierContext } from './modifiercontext';
import { Note } from './note';
import { Barline, BarlineType } from './stavebarline';
import { Category } from './typeguard';
import { log } from './util';

// eslint-disable-next-line
function L(...args: any[]) {
  if (BarNote.DEBUG) log('VexFlow.BarNote', args);
}

/**
 * A `BarNote` is used to render bar lines (from `barline.ts`). `BarNote`s can
 * be added to a voice and rendered in the middle of a stave. Since it has no
 * duration, it consumes no `tick`s, and is dealt with appropriately by the formatter.
 *
 * See `tests/barnote_tests.ts` for usage examples.
 */
export class BarNote extends Note {
  /** To enable logging for this class. Set `VexFlow.BarNote.DEBUG` to `true`. */
  static DEBUG: boolean = false;

  static override get CATEGORY(): string {
    return Category.BarNote;
  }

  protected metrics: { widths: Record<string, number> };
  // Initialized by the constructor via this.setType(type)
  protected type!: BarlineType;

  constructor(type: string | BarlineType = BarlineType.SINGLE) {
    super({ duration: 'b' });

    this.metrics = {
      widths: {},
    };

    const TYPE = BarlineType;
    this.metrics.widths = {
      [TYPE.SINGLE]: 8,
      [TYPE.DOUBLE]: 12,
      [TYPE.END]: 15,
      [TYPE.REPEAT_BEGIN]: 14,
      [TYPE.REPEAT_END]: 14,
      [TYPE.REPEAT_BOTH]: 18,
      [TYPE.NONE]: 0,
    };

    // Tell the formatter that bar notes have no duration.
    this.ignoreTicks = true;
    this.setType(type);
  }

  /** Get the type of bar note.*/
  getType(): BarlineType {
    return this.type;
  }

  /** Set the type of bar note. */
  setType(type: string | BarlineType): this {
    this.type = typeof type === 'string' ? Barline.typeString[type] : type;

    // Set width to width of relevant `Barline`.
    this.setWidth(this.metrics.widths[this.type]);
    return this;
  }

  /* Overridden to ignore */
  // eslint-disable-next-line
  override addToModifierContext(mc: ModifierContext): this {
    // DO NOTHING.
    return this;
  }

  /** Overridden to ignore. */
  override preFormat(): this {
    this.preFormatted = true;
    return this;
  }

  /** Render note to stave. */
  override draw(): void {
    const ctx = this.checkContext();
    L('Rendering bar line at: ', this.getAbsoluteX());
    const barline = new Barline(this.type);
    barline.setX(this.getAbsoluteX());
    barline.setStave(this.checkStave());
    barline.setContext(ctx);
    barline.drawWithStyle();
    this.setRendered();
  }
}
