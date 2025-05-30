// Copyright (c) 2023-present VexFlow contributors: https://github.com/vexflow/vexflow/graphs/contributors
// MIT License
// @author Mohit Cheppudira
// @author Greg Ristow (modifications)

import { Fraction } from './fraction';
import { Metrics } from './metrics';
import { Modifier } from './modifier';
import { ModifierContextState } from './modifiercontext';
import { Music } from './music';
import { Note } from './note';
import { Tables } from './tables';
import { Tickable } from './tickable';
import { Category, isAccidental, isGraceNote, isGraceNoteGroup, isStaveNote } from './typeguard';
import { defined, log } from './util';
import { Voice } from './voice';

type StaveLineAccidentalLayoutMetrics = {
  column: number;
  line: number;
  /**
   * A flat line needs more clearance above than below. This is
   * set to true if the accidental is either a flat or double flat.
   */
  flatLine: boolean;
  /**
   * Double sharps need less clearance above and below than other
   * accidentals.
   */
  dblSharpLine: boolean;
  numAcc: number;
  width: number;
};

// eslint-disable-next-line
function L(...args: any[]) {
  if (Accidental.DEBUG) log('VexFlow.Accidental', args);
}

/**
 * An `Accidental` inherits from `Modifier`, and is formatted within a
 * `ModifierContext`. Accidentals are modifiers that can be attached to
 * notes. Support is included for both western and microtonal accidentals.
 *
 * See `tests/accidental_tests.ts` for usage examples.
 */

export class Accidental extends Modifier {
  /** Accidental code provided to the constructor. */
  readonly type: string;
  /** To enable logging for this class. Set `VexFlow.Accidental.DEBUG` to `true`. */
  static DEBUG: boolean = false;
  protected cautionary: boolean;

  /** Accidentals category string. */
  static override get CATEGORY(): string {
    return Category.Accidental;
  }

  /** Arrange accidentals inside a ModifierContext. */
  static format(accidentals: Accidental[], state: ModifierContextState): void {
    // If there are no accidentals, no need to format their positions.
    if (!accidentals || accidentals.length === 0) return;

    const noteheadAccidentalPadding = Metrics.get('Accidental.noteheadAccidentalPadding');
    const leftShift = state.leftShift + noteheadAccidentalPadding;
    const accidentalSpacing = Metrics.get('Accidental.accidentalSpacing');
    const additionalPadding = Metrics.get('Accidental.leftPadding'); // padding to the left of all accidentals

    // A type used just in this formatting function.
    type AccidentalLinePositionsAndXSpaceNeeds = {
      y?: number;
      line: number;
      /**
       * The amount by which the accidental requests that notes be shifted to the right
       * to accommodate its presence.
       */
      extraXSpaceNeeded: number;
      accidental: Accidental;
      spacingBetweenStaveLines?: number;
    };

    const accidentalLinePositionsAndSpaceNeeds: AccidentalLinePositionsAndXSpaceNeeds[] = [];
    let prevNote = undefined;
    let extraXSpaceNeededForLeftDisplacedNotehead = 0;

    // First determine the accidentals' Y positions from the note.keys
    for (let i = 0; i < accidentals.length; ++i) {
      const accidental: Accidental = accidentals[i];

      const note = accidental.getNote();
      const stave = note.getStave();
      const index = accidental.checkIndex();
      const props = note.getKeyProps()[index];

      if (note !== prevNote) {
        // Iterate through all notes to get the displaced pixels
        for (let n = 0; n < note.keys.length; ++n) {
          // If the current extra left-space needed isn't as big as this note's,
          // then we need to use this note's.
          extraXSpaceNeededForLeftDisplacedNotehead = Math.max(
            note.getLeftDisplacedHeadPx() - note.getXShift(),
            extraXSpaceNeededForLeftDisplacedNotehead
          );
        }
        prevNote = note;
      }
      if (stave) {
        const lineSpace = stave.getSpacingBetweenLines();
        const y = stave.getYForLine(props.line);
        const accLine = Math.round((y / lineSpace) * 2) / 2;
        accidentalLinePositionsAndSpaceNeeds.push({
          y,
          line: accLine,
          extraXSpaceNeeded: extraXSpaceNeededForLeftDisplacedNotehead,
          accidental: accidental,
          spacingBetweenStaveLines: lineSpace,
        });
      } else {
        accidentalLinePositionsAndSpaceNeeds.push({
          line: props.line,
          extraXSpaceNeeded: extraXSpaceNeededForLeftDisplacedNotehead,
          accidental: accidental,
        });
      }
    }

    // Sort accidentals by line number.
    accidentalLinePositionsAndSpaceNeeds.sort((a, b) => b.line - a.line);

    const staveLineAccidentalLayoutMetrics: StaveLineAccidentalLayoutMetrics[] = [];

    // amount by which all accidentals must be shifted right or left for
    // stem flipping, notehead shifting concerns.
    let maxExtraXSpaceNeeded = 0;

    // Create an array of unique line numbers (staveLineAccidentalLayoutMetrics)
    // from accidentalLinePositionsAndSpaceNeeds
    for (let i = 0; i < accidentalLinePositionsAndSpaceNeeds.length; i++) {
      const accidentalLinePositionAndSpaceNeeds = accidentalLinePositionsAndSpaceNeeds[i];
      const accidentalType = accidentalLinePositionAndSpaceNeeds.accidental.type;
      const priorLineMetric = staveLineAccidentalLayoutMetrics[staveLineAccidentalLayoutMetrics.length - 1];
      let currentLineMetric: StaveLineAccidentalLayoutMetrics;

      // if this is the first line, or a new line, add a staveLineAccidentalLayoutMetric
      if (!priorLineMetric || priorLineMetric?.line !== accidentalLinePositionAndSpaceNeeds.line) {
        currentLineMetric = {
          line: accidentalLinePositionAndSpaceNeeds.line,
          flatLine: true,
          dblSharpLine: true,
          numAcc: 0,
          width: 0,
          column: 0,
        };
        staveLineAccidentalLayoutMetrics.push(currentLineMetric);
      } else {
        currentLineMetric = priorLineMetric;
      }

      // if this accidental is not a flat, the accidental needs 3.0 lines lower
      // clearance instead of 2.5 lines for b or bb.
      if (accidentalType !== 'b' && accidentalType !== 'bb') {
        currentLineMetric.flatLine = false;
      }

      // if this accidental is not a double sharp, the accidental needs 3.0 lines above
      if (accidentalType !== '##') {
        currentLineMetric.dblSharpLine = false;
      }

      // Track how many accidentals are on this line:
      currentLineMetric.numAcc++;

      // Track the total xOffset needed for this line which will be needed
      // for formatting lines w/ multiple accidentals:

      // width = accidental width + universal spacing between accidentals
      currentLineMetric.width += accidentalLinePositionAndSpaceNeeds.accidental.getWidth() + accidentalSpacing;

      // if this extraXSpaceNeeded is the largest so far, use it as the starting point for
      // all accidental columns.
      maxExtraXSpaceNeeded = Math.max(accidentalLinePositionAndSpaceNeeds.extraXSpaceNeeded, maxExtraXSpaceNeeded);
    }

    // ### Place Accidentals in Columns
    //
    // Default to a classic triangular layout (middle accidental farthest left),
    // but follow exceptions as outlined in G. Read's _Music Notation_ and
    // Elaine Gould's _Behind Bars_.
    //
    // Additionally, this implements different vertical collision rules for
    // flats (only need 2.5 lines clearance below) and double sharps (only
    // need 2.5 lines of clearance above or below).
    //
    // Classic layouts and exception patterns are found in the 'tables.js'
    // in 'Tables.accidentalColumnsTable'
    //
    // Beyond 6 vertical accidentals, default to the parallel ascending lines approach,
    // using as few columns as possible for the vertical structure.
    //
    // TODO (?): Allow column to be specified for an accidental at run-time?

    let totalColumns = 0;

    // establish the boundaries for a group of notes with clashing accidentals:
    for (let i = 0; i < staveLineAccidentalLayoutMetrics.length; i++) {
      let noFurtherConflicts = false;
      const groupStart = i;
      let groupEnd = i;

      while (groupEnd + 1 < staveLineAccidentalLayoutMetrics.length && !noFurtherConflicts) {
        // if this note conflicts with the next:
        if (
          this.checkCollision(
            staveLineAccidentalLayoutMetrics[groupEnd],
            staveLineAccidentalLayoutMetrics[groupEnd + 1]
          )
        ) {
          // include the next note in the group:
          groupEnd++;
        } else {
          noFurtherConflicts = true;
        }
      }

      // Gets a line from the `lineList`, relative to the current group
      const getGroupLine = (index: number) => staveLineAccidentalLayoutMetrics[groupStart + index];
      const getGroupLines = (indexes: number[]) => indexes.map(getGroupLine);
      const lineDifference = (indexA: number, indexB: number) => {
        const [a, b] = getGroupLines([indexA, indexB]).map((item) => item.line);
        return a - b;
      };

      const notColliding = (...indexPairs: number[][]) =>
        indexPairs.map(getGroupLines).every(([line1, line2]) => !this.checkCollision(line1, line2));

      // Set columns for the lines in this group:
      const groupLength = groupEnd - groupStart + 1;

      // Set the accidental column for each line of the group
      let endCase = this.checkCollision(
        staveLineAccidentalLayoutMetrics[groupStart],
        staveLineAccidentalLayoutMetrics[groupEnd]
      )
        ? 'a'
        : 'b';

      switch (groupLength) {
        case 3:
          if (endCase === 'a' && lineDifference(1, 2) === 0.5 && lineDifference(0, 1) !== 0.5) {
            endCase = 'secondOnBottom';
          }
          break;
        case 4:
          if (notColliding([0, 2], [1, 3])) {
            endCase = 'spacedOutTetrachord';
          }
          break;
        case 5:
          if (endCase === 'b' && notColliding([1, 3])) {
            endCase = 'spacedOutPentachord';
            if (notColliding([0, 2], [2, 4])) {
              endCase = 'verySpacedOutPentachord';
            }
          }
          break;
        case 6:
          if (notColliding([0, 3], [1, 4], [2, 5])) {
            endCase = 'spacedOutHexachord';
          }
          if (notColliding([0, 2], [2, 4], [1, 3], [3, 5])) {
            endCase = 'verySpacedOutHexachord';
          }
          break;
        default:
          break;
      }

      let groupMember;
      let column;
      // If the group contains seven members or more, use ascending parallel lines
      // of accidentals, using as few columns as possible while avoiding collisions.
      if (groupLength >= 7) {
        // First, determine how many columns to use:
        let patternLength = 2;
        let collisionDetected = true;
        while (collisionDetected === true) {
          collisionDetected = false;
          for (let line = 0; line + patternLength < staveLineAccidentalLayoutMetrics.length; line++) {
            if (
              this.checkCollision(
                staveLineAccidentalLayoutMetrics[line],
                staveLineAccidentalLayoutMetrics[line + patternLength]
              )
            ) {
              collisionDetected = true;
              patternLength++;
              break;
            }
          }
        }
        // Then, assign a column to each line of accidentals
        for (groupMember = i; groupMember <= groupEnd; groupMember++) {
          column = ((groupMember - i) % patternLength) + 1;
          staveLineAccidentalLayoutMetrics[groupMember].column = column;
          totalColumns = totalColumns > column ? totalColumns : column;
        }
      } else {
        // If the group contains fewer than seven members, use the layouts from
        // the Tables.accidentalColumnsTable (See: tables.ts).
        for (groupMember = i; groupMember <= groupEnd; groupMember++) {
          column = Tables.accidentalColumnsTable[groupLength][endCase][groupMember - i];
          staveLineAccidentalLayoutMetrics[groupMember].column = column;
          totalColumns = totalColumns > column ? totalColumns : column;
        }
      }

      // Increment i to the last note that was set, so that if a lower set of notes
      // does not conflict at all with this group, it can have its own classic shape.
      i = groupEnd;
    }

    // ### Convert Columns to xOffsets
    //
    // This keeps columns aligned, even if they have different accidentals within them
    // which sometimes results in a larger xOffset than is an accidental might need
    // to preserve the symmetry of the accidental shape.
    //
    // Neither A.C. Vinci nor G. Read address this, and it typically only happens in
    // music with complex chord clusters.
    //
    // TODO (?): Optionally allow closer compression of accidentals, instead of forcing
    // parallel columns.

    // track each column's max width, which will be used as initial shift of later columns:
    const columnWidths: number[] = [];
    const columnXOffsets: number[] = [];
    for (let i = 0; i <= totalColumns; i++) {
      columnWidths[i] = 0;
      columnXOffsets[i] = 0;
    }

    columnWidths[0] = leftShift + maxExtraXSpaceNeeded;
    columnXOffsets[0] = leftShift;

    // Fill columnWidths with the widest needed x-space;
    // this is what keeps the columns parallel.
    staveLineAccidentalLayoutMetrics.forEach((line) => {
      if (line.width > columnWidths[line.column]) columnWidths[line.column] = line.width;
    });

    for (let i = 1; i < columnWidths.length; i++) {
      // this column's offset = this column's width + previous column's offset
      columnXOffsets[i] = columnWidths[i] + columnXOffsets[i - 1];
    }

    const totalShift = columnXOffsets[columnXOffsets.length - 1];
    // Set the xShift for each accidental according to column offsets:
    let accCount = 0;
    staveLineAccidentalLayoutMetrics.forEach((line) => {
      let lineWidth = 0;
      const lastAccOnLine = accCount + line.numAcc;
      // handle all accidentals on a given line:
      for (accCount; accCount < lastAccOnLine; accCount++) {
        const xShift = columnXOffsets[line.column - 1] + lineWidth + maxExtraXSpaceNeeded;
        accidentalLinePositionsAndSpaceNeeds[accCount].accidental.setXShift(xShift);
        // keep track of the width of accidentals we've added so far, so that when
        // we loop, we add space for them.
        lineWidth += accidentalLinePositionsAndSpaceNeeds[accCount].accidental.getWidth() + accidentalSpacing;
        L('Line, accCount, shift: ', line.line, accCount, xShift);
      }
    });
    // update the overall layout with the full width of the accidental shapes:
    state.leftShift = totalShift + additionalPadding;
  }

  /** Helper function to determine whether two lines of accidentals collide vertically */
  protected static checkCollision(
    line1: StaveLineAccidentalLayoutMetrics,
    line2: StaveLineAccidentalLayoutMetrics
  ): boolean {
    let clearance = line2.line - line1.line;
    let clearanceRequired = 3;
    // But less clearance is required for certain accidentals: b, bb and ##.
    if (clearance > 0) {
      // then line 2 is on top
      clearanceRequired = line2.flatLine || line2.dblSharpLine ? 2.5 : 3.0;
      if (line1.dblSharpLine) clearance -= 0.5;
    } else {
      // line 1 is on top
      clearanceRequired = line1.flatLine || line1.dblSharpLine ? 2.5 : 3.0;
      if (line2.dblSharpLine) clearance -= 0.5;
    }
    const collision = Math.abs(clearance) < clearanceRequired;
    L('Line1, Line2, Collision: ', line1.line, line2.line, collision);
    return collision;
  }

  /**
   * Use this method to automatically apply accidentals to a set of `voices`.
   * The accidentals will be remembered between all the voices provided.
   * Optionally, you can also provide an initial `keySignature`.
   */
  static applyAccidentals(voices: Voice[], keySignature: string): void {
    const tickPositions: number[] = [];
    const tickNoteMap: Record<number, Tickable[]> = {};

    // Sort the tickables in each voice by their tick position in the voice.
    voices.forEach((voice) => {
      const tickPosition = new Fraction(0, 1);
      const tickable = voice.getTickables();
      tickable.forEach((t) => {
        if (t.shouldIgnoreTicks()) return;

        const notesAtPosition = tickNoteMap[tickPosition.value()];

        if (!notesAtPosition) {
          tickPositions.push(tickPosition.value());
          tickNoteMap[tickPosition.value()] = [t];
        } else {
          notesAtPosition.push(t);
        }

        tickPosition.add(t.getTicks());
      });
    });

    const music = new Music();

    // Default key signature is C major.
    if (!keySignature) keySignature = 'C';

    // Get the scale map, which represents the current state of each pitch.
    const scaleMapKey = music.createScaleMap(keySignature);
    const scaleMap: Record<string, string> = {};

    tickPositions.forEach((tickPos: number) => {
      const tickables = tickNoteMap[tickPos];

      // Array to store all pitches that modified accidental states
      // at this tick position
      const modifiedPitches: string[] = [];

      const processNote = (t: Tickable) => {
        // Only StaveNote implements .addModifier(), which is used below.
        if (!isStaveNote(t) || t.isRest() || t.shouldIgnoreTicks()) {
          return;
        }

        // Go through each key and determine if an accidental should be applied.
        const staveNote = t;
        staveNote.keys.forEach((keyString: string, keyIndex: number) => {
          const key = music.getNoteParts(keyString.split('/')[0]);
          const octave = keyString.split('/')[1];

          // Force a natural for every key without an accidental
          const accidentalString = key.accidental || 'n';
          const pitch = key.root + accidentalString;

          // Determine if the current pitch has the same accidental
          // as the scale state
          if (!scaleMap[key.root + octave]) scaleMap[key.root + octave] = scaleMapKey[key.root];
          const sameAccidental = scaleMap[key.root + octave] === pitch;

          // Determine if an identical pitch in the chord already
          // modified the accidental state
          const previouslyModified = modifiedPitches.indexOf(keyString) > -1;

          // Remove accidentals
          staveNote.getModifiers().forEach((modifier, index) => {
            if (isAccidental(modifier) && modifier.type == accidentalString && modifier.getIndex() == keyIndex) {
              staveNote.getModifiers().splice(index, 1);
            }
          });

          // Add the accidental to the StaveNote
          if (!sameAccidental || (sameAccidental && previouslyModified)) {
            // Modify the scale map so that the root pitch has an
            // updated state
            scaleMap[key.root + octave] = pitch;

            // Create the accidental
            const accidental = new Accidental(accidentalString);

            // Attach the accidental to the StaveNote
            staveNote.addModifier(accidental, keyIndex);

            // Add the pitch to list of pitches that modified accidentals
            modifiedPitches.push(keyString);
          }
        });

        // process grace notes
        staveNote.getModifiers().forEach((modifier: Modifier) => {
          if (isGraceNoteGroup(modifier)) {
            modifier.getGraceNotes().forEach(processNote);
          }
        });
      };

      tickables.forEach(processNote);
    });
  }

  /**
   * Create accidental.
   * @param type value from `VexFlow.accidentalCodes.accidentals` table in `tables.ts`.
   * For example: `#`, `##`, `b`, `n`, etc.
   */
  constructor(type: string) {
    super();

    L('New accidental: ', type);

    this.type = type;
    this.position = Modifier.Position.LEFT;

    // Cautionary accidentals have parentheses around them
    this.cautionary = false;

    this.reset();
  }

  protected override reset(): void {
    this.text = '';

    if (!this.cautionary) {
      this.text += Tables.accidentalCodes(this.type);
      this.fontInfo.size = Metrics.get('Accidental.fontSize');
    } else {
      this.text += Tables.accidentalCodes('{');
      this.text += Tables.accidentalCodes(this.type);
      this.text += Tables.accidentalCodes('}');
      this.fontInfo.size = Metrics.get('Accidental.cautionary.fontSize');
    }
    // Accidentals attached to grace notes are rendered smaller.
    if (isGraceNote(this.note)) {
      this.fontInfo.size = Metrics.get('Accidental.grace.fontSize');
    }
  }

  /** Attach this accidental to `note`, which must be a `StaveNote`. */
  override setNote(note: Note): this {
    defined(note, 'ArgumentError', `Bad note value: ${note}`);

    this.note = note;
    this.reset();
    return this;
  }

  /** If called, draws parenthesis around accidental. */
  setAsCautionary(): this {
    this.cautionary = true;
    this.reset();
    return this;
  }

  /** Render accidental onto canvas. */
  override draw(): void {
    const { type, position, index } = this;

    const ctx = this.checkContext();
    const note = this.checkAttachedNote();
    this.setRendered();

    // Figure out the start `x` and `y` coordinates for note and index.
    const start = note.getModifierStartXY(position, index);
    this.x = start.x - this.width;
    this.y = start.y;
    L('Rendering: ', type, start.x, start.y);
    this.renderText(ctx, 0, 0);
  }
}
