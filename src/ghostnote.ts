// Copyright (c) 2023-present VexFlow contributors: https://github.com/vexflow/vexflow/graphs/contributors
//
// ## Description

import { ModifierContext } from './modifiercontext';
import { NoteStruct } from './note';
import { Stave } from './stave';
import { StemmableNote } from './stemmablenote';
import { Category, isAnnotation } from './typeguard';
import { RuntimeError } from './util';

const ERROR_MSG = 'Ghost note must have valid initialization data to identify duration.';

export class GhostNote extends StemmableNote {
  static override get CATEGORY(): string {
    return Category.GhostNote;
  }

  constructor(parameter: string | NoteStruct) {
    if (!parameter) {
      throw new RuntimeError('BadArguments', ERROR_MSG);
    }

    let noteStruct;
    if (typeof parameter === 'string') {
      // Preserve backwards-compatibility
      noteStruct = { duration: parameter };
    } else if (typeof parameter === 'object') {
      noteStruct = parameter;
    } else {
      throw new RuntimeError('BadArguments', ERROR_MSG);
    }

    super(noteStruct);

    // Note properties
    this.setWidth(0);
  }

  /**
   * @returns true if this note is a type of rest. Rests don't have pitches, but take up space in the score.
   */
  override isRest(): boolean {
    return true;
  }

  override setStave(stave: Stave): this {
    super.setStave(stave);
    return this;
  }

  /* Overridden to ignore */
  // eslint-disable-next-line
  override addToModifierContext(mc: ModifierContext): this {
    // DO NOTHING.
    return this;
  }

  override preFormat(): this {
    this.preFormatted = true;
    return this;
  }

  override draw(): void {
    // Draw Annotations
    this.setRendered();
    for (let i = 0; i < this.modifiers.length; ++i) {
      const modifier = this.modifiers[i];
      if (isAnnotation(modifier)) {
        modifier.setContext(this.getContext());
        modifier.drawWithStyle();
      }
    }
  }
}
