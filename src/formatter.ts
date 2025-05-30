// Copyright (c) 2023-present VexFlow contributors: https://github.com/vexflow/vexflow/graphs/contributors
// MIT License

import { Beam } from './beam';
import { BoundingBox } from './boundingbox';
import { Fraction } from './fraction';
import { Metrics } from './metrics';
import { ModifierContext } from './modifiercontext';
import { RenderContext } from './rendercontext';
import { Stave } from './stave';
import { StaveConnector } from './staveconnector';
import { StemmableNote } from './stemmablenote';
import { Tables } from './tables';
import { TabNote } from './tabnote';
import { TabStave } from './tabstave';
import { Tickable } from './tickable';
import { TickContext } from './tickcontext';
import { isNote, isStaveNote } from './typeguard';
import { defined, log, midLine, RuntimeError, sumArray } from './util';
import { Voice } from './voice';

interface Distance {
  maxNegativeShiftPx: number;
  expectedDistance: number;
  fromTickable?: Tickable;
  errorPx?: number;
  fromTickablePx?: number;
}

export interface FormatterOptions {
  /** Defaults to Tables.SOFTMAX_FACTOR. */
  softmaxFactor?: number;

  /** Defaults to `false`. */
  globalSoftmax?: boolean;

  /** Defaults to 5. */
  maxIterations?: number;
}

/** An interface for passing options to various formatters **/
export interface FormatParams {
  /** Should rests align vertically with neighboring notes (default false) **/
  alignRests?: boolean;
  /** Should notes be automatically beamed **/
  autoBeam?: boolean;
  /** Stave object to render to **/
  stave?: Stave;
  /** The RenderContext **/
  context?: RenderContext;
}

export interface AlignmentTickContexts {
  list: number[];
  map: Record<number, TickContext>;
  array: TickContext[];
  resolutionMultiplier: number;
}

export interface AlignmentModifierContexts {
  map: Map<Stave | undefined, Record<number, ModifierContext>>;
  array: ModifierContext[];
  resolutionMultiplier: number;
}

// eslint-disable-next-line
function L(...args: any[]) {
  if (Formatter.DEBUG) log('VexFlow.Formatter', args);
}

/**
 * Get the rest line number of the next non-rest note(s).
 * @param notes array of Notes
 * @param currRestLine
 * @param currNoteIndex current note index
 * @param compare if true, return the midpoint between the current rest line and the next rest line
 * @returns a line number, which determines the vertical position of a rest.
 */
function getRestLineForNextNoteGroup(
  notes: Tickable[],
  currRestLine: number,
  currNoteIndex: number,
  compare: boolean
): number {
  // If no valid next note group, nextRestLine is same as current.
  let nextRestLine = currRestLine;

  // Start with the next note and keep going until we find a valid non-rest note group.
  for (let noteIndex = currNoteIndex + 1; noteIndex < notes.length; noteIndex++) {
    const note = notes[noteIndex];
    if (isNote(note) && !note.isRest() && !note.shouldIgnoreTicks()) {
      nextRestLine = note.getLineForRest();
      break;
    }
  }

  // Locate the midpoint between two lines.
  if (compare && currRestLine !== nextRestLine) {
    const top = Math.max(currRestLine, nextRestLine);
    const bot = Math.min(currRestLine, nextRestLine);
    nextRestLine = midLine(top, bot);
  }
  return nextRestLine;
}

/**
 * Format implements the formatting and layout algorithms that are used
 * to position notes in a voice. The algorithm can align multiple voices both
 * within a stave, and across multiple staves.
 *
 * To do this, the formatter breaks up voices into a grid of rational-valued
 * `ticks`, to which each note is assigned. Then, minimum widths are assigned
 * to each tick based on the widths of the notes and modifiers in that tick. This
 * establishes the smallest amount of space required for each tick.
 *
 * Finally, the formatter distributes the leftover space proportionally to
 * all the ticks, setting the `x` values of the notes in each tick.
 *
 * See `tests/formatter_tests.ts` for usage examples. The helper functions included
 * here (`FormatAndDraw`, `FormatAndDrawTab`) also serve as useful usage examples.
 */
export class Formatter {
  // To enable logging for this class. Set `VexFlow.Formatter.DEBUG` to `true`.
  static DEBUG: boolean = false;
  protected hasMinTotalWidth: boolean;
  protected minTotalWidth: number;
  protected contextGaps: {
    total: number;
    gaps: { x1: number; x2: number }[];
  };
  protected justifyWidth: number;
  protected totalCost: number;
  protected totalShift: number;
  // note: this is poorly named because there is an object type TickContext,
  // and this does not store it (similarly with modifierContexts).
  protected tickContexts: AlignmentTickContexts;
  protected formatterOptions: Required<FormatterOptions>;
  // note that this is an array of AlignmentModifierContexts, not one like tickContexts.
  protected modifierContexts: AlignmentModifierContexts[];
  protected voices: Voice[];
  protected lossHistory: number[];
  protected durationStats: Record<string, { mean: number; count: number; total: number }>;

  /**
   * Helper function to layout "notes" one after the other without
   * regard for proportions. Useful for tests and debugging.
   */
  static SimpleFormat(notes: Tickable[], x = 0, { paddingBetween = 10 } = {}): void {
    notes.reduce((accumulator, note) => {
      note.addToModifierContext(new ModifierContext());
      const tickContext = new TickContext().addTickable(note).preFormat();
      const metrics = tickContext.getMetrics();
      tickContext.setX(accumulator + metrics.totalLeftPx);

      return accumulator + tickContext.getWidth() + metrics.totalRightPx + paddingBetween;
    }, x);
  }

  /** Helper function to plot formatter debug info. */
  static plotDebugging(
    ctx: RenderContext,
    formatter: Formatter,
    xPos: number,
    y1: number,
    y2: number,
    options?: { stavePadding: number }
  ): void {
    options = {
      stavePadding: Metrics.get('Stave.padding'),
      ...options,
    };

    const x = xPos + options.stavePadding;
    const contextGaps = formatter.contextGaps;

    function stroke(x1: number, x2: number, color: string) {
      ctx.beginPath();
      ctx.setStrokeStyle(color);
      ctx.setFillStyle(color);
      ctx.setLineWidth(1);
      ctx.fillRect(x1, y1, Math.max(x2 - x1, 0), y2 - y1);
    }

    ctx.save();
    ctx.setFont(Metrics.get('fontFamily'), 8);

    contextGaps.gaps.forEach((gap) => {
      stroke(x + gap.x1, x + gap.x2, 'rgba(100,200,100,0.4)');
      ctx.setFillStyle('green');
      ctx.fillText(Math.round(gap.x2 - gap.x1).toString(), x + gap.x1, y2 + 12);
    });

    ctx.setFillStyle('red');
    ctx.fillText(
      `Loss: ${(formatter.totalCost ?? 0).toFixed(2)} Shift: ${(formatter.totalShift ?? 0).toFixed(
        2
      )} Gap: ${contextGaps.total.toFixed(2)}`,
      x - 20,
      y2 + 27
    );
    ctx.restore();
  }

  /**
   * Helper function to format and draw a single voice. Returns a bounding
   * box for the notation.
   * @param ctx  the rendering context
   * @param stave the stave to which to draw (`Stave` or `TabStave`)
   * @param notes array of `Note` instances (`Note`, `TextNote`, `TabNote`, etc.)
   * @param params one of below:
   *    * Setting `autoBeam` only `(context, stave, notes, true)` or
   *      `(ctx, stave, notes, {autoBeam: true})`
   *    * Setting `alignRests` a struct is needed `(context, stave, notes, {alignRests: true})`
   *    * Setting both a struct is needed `(context, stave, notes, {
   *      autoBeam: true, alignRests: true})`
   *    * `autoBeam` automatically generates beams for the notes.
   *    * `alignRests` aligns rests with nearby notes.
   */
  static FormatAndDraw(
    ctx: RenderContext,
    stave: Stave,
    notes: StemmableNote[],
    params?: FormatParams | boolean
  ): BoundingBox | undefined {
    let options = {
      autoBeam: false,
      alignRests: false,
    };

    if (typeof params === 'object') {
      options = { ...options, ...params };
    } else if (typeof params === 'boolean') {
      options.autoBeam = params;
    }

    // Start by creating a voice and adding all the notes to it.
    const voice = new Voice(Tables.TIME4_4).setMode(Voice.Mode.SOFT).addTickables(notes);

    // Then create beams, if requested.
    const beams = options.autoBeam ? Beam.applyAndGetBeams(voice) : [];

    // Instantiate a `Formatter` and format the notes.
    new Formatter()
      .joinVoices([voice]) // , { alignRests: options.alignRests })
      .formatToStave([voice], stave, { alignRests: options.alignRests, stave });

    // Render the voice and beams to the stave.
    voice.setContext(ctx).setStave(stave).drawWithStyle();
    beams.forEach((beam) => beam.setContext(ctx).drawWithStyle());

    // Return the bounding box of the voice.
    return voice.getBoundingBox();
  }

  /**
   * Helper function to format and draw aligned tab and stave notes in two
   * separate staves.
   * @param ctx the rendering context
   * @param tabstave a `TabStave` instance on which to render `TabNote`s.
   * @param stave a `Stave` instance on which to render `Note`s.
   * @param notes array of `Note` instances for the stave (`Note`, `BarNote`, etc.)
   * @param tabnotes array of `Note` instances for the tab stave (`TabNote`, `BarNote`, etc.)
   * @param autoBeam automatically generate beams.
   * @param params a FormatParams configuration object:
   *    * `autoBeam` automatically generates beams for the notes. (overrides autoBeam setting above)
   *    * `alignRests` aligns rests with nearby notes. (default false)
   */
  static FormatAndDrawTab(
    ctx: RenderContext,
    tabstave: TabStave,
    stave: Stave,
    tabnotes: TabNote[],
    notes: Tickable[],
    autoBeam: boolean,
    params: FormatParams
  ): void {
    let opts = {
      autoBeam,
      alignRests: false,
    };

    if (typeof params === 'object') {
      opts = { ...opts, ...params };
    } else if (typeof params === 'boolean') {
      opts.autoBeam = params;
    }

    // Create a `4/4` voice for `notes`.
    const notevoice = new Voice(Tables.TIME4_4).setMode(Voice.Mode.SOFT).addTickables(notes);

    // Create a `4/4` voice for `tabnotes`.
    const tabvoice = new Voice(Tables.TIME4_4).setMode(Voice.Mode.SOFT).addTickables(tabnotes);

    // Then create beams, if requested.
    const beams = opts.autoBeam ? Beam.applyAndGetBeams(notevoice) : [];

    // Instantiate a `Formatter` and align tab and stave notes.
    new Formatter()
      .joinVoices([notevoice]) // , { alignRests: opts.alignRests })
      .joinVoices([tabvoice])
      .formatToStave([notevoice, tabvoice], stave, { alignRests: opts.alignRests });

    // Render voices and beams to staves.
    notevoice.draw(ctx, stave);
    tabvoice.draw(ctx, tabstave);
    beams.forEach((beam) => beam.setContext(ctx).drawWithStyle());

    // Draw a connector between tab and note staves.
    new StaveConnector(stave, tabstave).setContext(ctx).drawWithStyle();
  }

  /**
   * Automatically set the vertical position of rests based on previous/next note positions.
   * Useful for multiple voices on the same staff or for rests within beam groups.
   * Ignores rests that have already been set to a line other than 3 (middle line).
   * @param tickables an array of Tickables.
   * @param alignAllNotes If `false`, only align rests that are within a group of beamed notes.
   * @param alignTuplets If `false` (default), ignores tuplets.
   */
  static AlignRestsToNotes(tickables: Tickable[], alignAllNotes: boolean, alignTuplets: boolean = false): void {
    tickables.forEach((currTickable: Tickable, index: number): void => {
      if (isStaveNote(currTickable) && currTickable.isRest()) {
        if (currTickable.getTuplet() && !alignTuplets) {
          return;
        }

        // If activated rests not on default can be rendered as specified.
        const line = currTickable.getLineForRest();
        if (line !== 3) {
          return;
        }

        if (alignAllNotes || currTickable.getBeam()) {
          // Align rests with previous/next notes.
          const props = currTickable.getKeyProps()[0];
          if (index === 0) {
            props.line = getRestLineForNextNoteGroup(tickables, props.line, index, false);
          } else if (index > 0 && index < tickables.length) {
            // If previous tickable is a rest, use its line number.
            const prevTickable = tickables[index - 1];
            if (isStaveNote(prevTickable)) {
              if (prevTickable.isRest()) {
                props.line = prevTickable.getKeyProps()[0].line;
              } else {
                const restLine = prevTickable.getLineForRest();
                // Get the rest line for next valid non-rest note group.
                props.line = getRestLineForNextNoteGroup(tickables, restLine, index, true);
              }
            }
          }
          currTickable.setKeyLine(0, props.line);
        }
      }
    });
  }

  constructor(options?: FormatterOptions) {
    this.formatterOptions = {
      globalSoftmax: false,
      softmaxFactor: Tables.SOFTMAX_FACTOR,
      maxIterations: 5,
      ...options,
    };
    this.justifyWidth = 0;
    this.totalCost = 0;
    this.totalShift = 0;
    this.durationStats = {};

    // Minimum width required to render all the notes in the voices.
    this.minTotalWidth = 0;

    // This is set to `true` after `minTotalWidth` is calculated.
    this.hasMinTotalWidth = false;

    // Arrays of tick and modifier contexts.
    this.tickContexts = {
      map: {},
      array: [],
      list: [],
      resolutionMultiplier: 0,
    };

    this.modifierContexts = [];

    // Gaps between contexts, for free movement of notes post
    // formatting.
    this.contextGaps = {
      total: 0,
      gaps: [],
    };

    this.voices = [];
    this.lossHistory = [];
  }

  /**
   * Find all the rests in each of the `voices` and align them vertically to neighboring notes.
   *
   * @param voices
   * @param alignAllNotes If `false`, only align rests within beamed groups of notes. If `true`, align all rests.
   */
  alignRests(voices: Voice[], alignAllNotes: boolean): void {
    if (!voices || !voices.length) {
      throw new RuntimeError('BadArgument', 'No voices to format rests');
    }

    voices.forEach((voice) => Formatter.AlignRestsToNotes(voice.getTickables(), alignAllNotes));
  }

  /**
   * Estimate the width required to render 'voices'.  This is done by:
   * 1. Sum the widths of all the tick contexts
   * 2. Estimate the padding.
   * The latter is done by calculating the padding 3 different ways, and taking the
   * greatest value:
   * 1. the padding required for unaligned notes in different voices
   * 2. the padding based on the stddev of the tickable widths
   * 3. the padding based on the stddev of the tickable durations.
   *
   * The last 2 quantities estimate a 'width entropy', where notes might need more
   * room than the proportional formatting gives them.  A measure of all same duration
   * and width will need no extra padding, and all these quantities will be
   * zero in that case.
   *
   * Note: joinVoices has to be called before calling preCalculateMinTotalWidth.
   *
   * @param voices the voices that contain the notes
   * @returns the estimated width in pixels
   */
  preCalculateMinTotalWidth(voices: Voice[]): number {
    const unalignedPadding = Metrics.get('Stave.unalignedNotePadding');
    // Calculate additional padding based on 3 methods:
    // 1) unaligned beats in voices, 2) variance of width, 3) variance of durations
    let unalignedCtxCount = 0;
    let wsum = 0;
    let dsum = 0;
    const widths: number[] = [];
    const durations: number[] = [];

    // Cache results.
    if (this.hasMinTotalWidth) return this.minTotalWidth;

    // Create tick contexts.
    if (!voices) {
      throw new RuntimeError('BadArgument', "'voices' required to run preCalculateMinTotalWidth");
    }

    this.createTickContexts(voices);

    const { list: contextList, map: contextMap } = this.tickContexts!;
    this.minTotalWidth = 0;

    // Go through each tick context and calculate total width,
    // and also accumulate values used in padding hints
    contextList.forEach((tick) => {
      const context = contextMap[tick];
      context.preFormat();
      // If this TC doesn't have all the voices on it, it's unaligned.
      // so increment the unaligned padding accumulator
      if (context.getTickables().length < voices.length) {
        unalignedCtxCount += 1;
      }
      // Calculate the 'width entropy' over all the Tickables.
      context.getTickables().forEach((t: Tickable) => {
        wsum += t.getMetrics().width;
        dsum += t.getTicks().value();
        widths.push(t.getMetrics().width);
        durations.push(t.getTicks().value());
      });
      const width = context.getWidth();
      this.minTotalWidth += width;
    });

    this.hasMinTotalWidth = true;
    // normalized (0-1) STDDEV of widths/durations gives us padding hints.
    const wavg = wsum > 0 ? wsum / widths.length : 1 / widths.length;
    const wvar = sumArray(widths.map((ll) => Math.pow(ll - wavg, 2)));
    const wpads = Math.pow(wvar / widths.length, 0.5) / wavg;

    const davg = dsum / durations.length;
    const dvar = sumArray(durations.map((ll) => Math.pow(ll - davg, 2)));
    const dpads = Math.pow(dvar / durations.length, 0.5) / davg;

    // Find max of 3 methods pad the width with that
    const padmax = Math.max(dpads, wpads) * contextList.length * unalignedPadding;
    const unalignedPad = unalignedPadding * unalignedCtxCount;

    return this.minTotalWidth + Math.max(unalignedPad, padmax);
  }

  /**
   * Get minimum width required to render all voices. Either `format` or
   * `preCalculateMinTotalWidth` must be called before this method.
   */
  getMinTotalWidth(): number {
    if (!this.hasMinTotalWidth) {
      throw new RuntimeError(
        'NoMinTotalWidth',
        "Call 'preCalculateMinTotalWidth' or 'preFormat' before calling 'getMinTotalWidth'"
      );
    }

    return this.minTotalWidth;
  }

  /** Calculate the resolution multiplier for `voices`, which is the
   * least common multiple of all the voices' getResolutionMultiplier() results. */
  static getResolutionMultiplier(voices: Voice[]): number {
    if (!voices || !voices.length) {
      throw new RuntimeError('BadArgument', 'No voices to format');
    }
    const totalTicks = voices[0].getTotalTicks();
    const resolutionMultiplier = voices.reduce((accumulator, voice) => {
      if (!voice.getTotalTicks().equals(totalTicks)) {
        throw new RuntimeError('TickMismatch', 'Voices should have same total note duration in ticks.');
      }

      if (voice.getMode() === Voice.Mode.STRICT && !voice.isComplete()) {
        throw new RuntimeError('IncompleteVoice', 'Voice does not have enough notes.');
      }

      return Math.max(accumulator, Fraction.LCM(accumulator, voice.getResolutionMultiplier()));
    }, 1);
    return resolutionMultiplier;
  }

  /** Create a `ModifierContext` for each tick in `voices`. */
  createModifierContexts(voices: Voice[]) {
    if (voices.length === 0) return;
    const resolutionMultiplier = Formatter.getResolutionMultiplier(voices);

    // Initialize tick maps.
    const tickToContextMap: Map<Stave | undefined, Record<number, ModifierContext>> = new Map();
    const contexts: ModifierContext[] = [];

    // For each voice, extract notes and create a context for every
    // new tick that hasn't been seen before.
    voices.forEach((voice) => {
      // Use resolution multiplier as denominator so that no additional expansion
      // of fractional tick values is needed.
      const ticksUsed = new Fraction(0, resolutionMultiplier);

      voice.getTickables().forEach((tickable) => {
        const integerTicks = ticksUsed.numerator;
        let staveTickToContextMap = tickToContextMap.get(tickable.getStave());

        // If we have no tick context for this tick, create one.
        if (!staveTickToContextMap) {
          tickToContextMap.set(tickable.getStave(), {});
          staveTickToContextMap = tickToContextMap.get(tickable.getStave());
        }
        if (!(staveTickToContextMap ? staveTickToContextMap[integerTicks] : undefined)) {
          const newContext = new ModifierContext();
          contexts.push(newContext);

          staveTickToContextMap![integerTicks] = newContext;
        }

        // Add this tickable to the TickContext.

        tickable.addToModifierContext(staveTickToContextMap![integerTicks]);
        ticksUsed.add(tickable.getTicks());
      });
    });

    this.modifierContexts.push({
      map: tickToContextMap,
      array: contexts,
      resolutionMultiplier,
    });
  }

  /**
   * Create a `TickContext` for each tick in `voices`. Also calculate the
   * total number of ticks in voices.
   */
  createTickContexts(voices: Voice[]): AlignmentTickContexts {
    if (voices.length === 0) {
      // We need to short-circuit this since at present, Formatter.getResolutionMultiplier
      // throws an error on no voices.
      return {
        map: {},
        array: [],
        list: [],
        resolutionMultiplier: 0,
      } as AlignmentTickContexts;
    }

    // Initialize tick maps.
    const tickToContextMap: Record<number, TickContext> = {};
    const tickList: number[] = [];
    const tickContexts: TickContext[] = [];
    const resolutionMultiplier = Formatter.getResolutionMultiplier(voices);
    // For each voice, extract notes and create a context for every
    // new tick that hasn't been seen before.
    voices.forEach((voice: Voice, voiceIndex: number): void => {
      // Use resolution multiplier as denominator so that no additional expansion
      // of fractional tick values is needed.
      const ticksUsed = new Fraction(0, resolutionMultiplier);

      voice.getTickables().forEach((tickable: Tickable): void => {
        const integerTicks: number = ticksUsed.numerator;

        // If we have no tick context for this tick, create one.
        if (!tickToContextMap[integerTicks]) {
          const newContext = new TickContext({ tickID: integerTicks });
          tickContexts.push(newContext);
          tickToContextMap[integerTicks] = newContext;
          // Maintain a list of unique integerTicks.
          tickList.push(integerTicks);
        }

        // Add this tickable to the TickContext.
        const tickContext: TickContext = tickToContextMap[integerTicks];
        tickContext.addTickable(tickable, voiceIndex);
        ticksUsed.add(tickable.getTicks());
      });
    });

    const contexts: AlignmentTickContexts = {
      map: tickToContextMap,
      array: tickContexts,
      list: tickList.sort((a, b) => a - b),
      resolutionMultiplier,
    };

    this.tickContexts = contexts;
    // Give each TickContext a link to the array of all TickContexts
    // for moving forward and backwards.
    const contextArray: TickContext[] = this.tickContexts.array;

    contextArray.forEach((context: TickContext): void => {
      context.tContexts = contextArray;
    });
    return contexts;
  }

  /**
   * Get the AlignmentTickContexts of TickContexts that were created by createTickContexts.
   * Returns undefined if createTickContexts has not yet been run.
   */
  getTickContexts(): AlignmentTickContexts | undefined {
    return this.tickContexts;
  }

  /**
   * This is the core formatter logic. Format voices and justify them
   * to `justifyWidth` pixels. `renderingContext` is required to justify elements
   * that can't retrieve widths without a canvas. This method sets the `x` positions
   * of all the tickables/notes in the formatter.
   */
  preFormat(justifyWidth = 0, renderingContext?: RenderContext, voicesParam?: Voice[], stave?: Stave): number {
    // Initialize context maps.
    const contexts: AlignmentTickContexts = this.tickContexts;
    if (!contexts) {
      throw new RuntimeError('NoTickContexts', 'preFormat requires TickContexts');
    }

    const { list: contextList, map: contextMap } = contexts;

    // Reset loss history for evaluator.
    this.lossHistory = [];

    // If voices and a stave were provided, set the Stave for each voice
    // and preFormat to apply Y values to the notes;
    if (voicesParam && stave) {
      voicesParam.forEach((voice: Voice): Voice => voice.setStave(stave).preFormat());
    }

    // Now distribute the ticks to each tick context, and assign them their
    // own X positions.
    let x = 0;
    let shift = 0;
    this.minTotalWidth = 0;
    let totalTicks = 0;

    // Pass 1: Give each note maximum width requested by context.
    contextList.forEach((tick) => {
      const context = contextMap[tick];

      // Make sure that all tickables in this context have calculated their
      // space requirements.
      context.preFormat();

      const width = context.getWidth();
      this.minTotalWidth += width;

      const maxTicks = context.getMaxTicks().value();
      totalTicks += maxTicks;

      const metrics = context.getMetrics();
      x = x + shift + metrics.totalLeftPx;
      context.setX(x);

      // Calculate shift for the next tick.
      shift = width - metrics.totalLeftPx;
    });

    // Use softmax based on all notes across all staves. (options.globalSoftmax)
    const { globalSoftmax, softmaxFactor, maxIterations } = this.formatterOptions;

    const exp = (tick: number) => softmaxFactor ** (contextMap[tick].getMaxTicks().value() / totalTicks);
    const expTicksUsed = sumArray(contextList.map(exp));

    this.minTotalWidth = x + shift;
    this.hasMinTotalWidth = true;

    // No justification needed. End formatting.
    if (justifyWidth <= 0) return this.evaluate();

    // Start justification. Subtract the right extra pixels of the final context because the formatter
    // justifies based on the context's X position, which is the left-most part of the note head.
    const firstContext = contextMap[contextList[0]];
    const lastContext = contextMap[contextList[contextList.length - 1]];

    // Calculate the "distance error" between the tick contexts. The expected distance is the spacing proportional to
    // the softmax of the ticks.
    function calculateIdealDistances(adjustedJustifyWidth: number): Distance[] {
      const distances: Distance[] = contextList.map((tick: number, i: number) => {
        const context: TickContext = contextMap[tick];
        const voices = context.getTickablesByVoice();
        let backTickable: Tickable | undefined;
        if (i > 0) {
          const prevContext: TickContext = contextMap[contextList[i - 1]];
          // Go through each tickable and search backwards for another tickable
          // in the same voice. If found, use that duration (ticks) to calculate
          // the expected distance.
          for (let j = i - 1; j >= 0; j--) {
            const backTick: TickContext = contextMap[contextList[j]];
            const backVoices = backTick.getTickablesByVoice();

            // Look for matching voices between tick contexts.
            const matchingVoices: string[] = [];
            Object.keys(voices).forEach((v) => {
              if (backVoices[v]) {
                matchingVoices.push(v);
              }
            });

            if (matchingVoices.length > 0) {
              // Found matching voices, get largest duration
              let maxTicks = 0;
              let maxNegativeShiftPx = Infinity;
              let expectedDistance = 0;

              matchingVoices.forEach((v) => {
                const ticks = backVoices[v].getTicks().value();
                if (ticks > maxTicks) {
                  backTickable = backVoices[v];
                  maxTicks = ticks;
                }

                // Calculate the limits of the shift based on modifiers, etc.
                const thisTickable = voices[v];
                const insideLeftEdge =
                  thisTickable.getX() -
                  (thisTickable.getMetrics().modLeftPx + thisTickable.getMetrics().leftDisplacedHeadPx);

                const backMetrics = backVoices[v].getMetrics();
                const insideRightEdge =
                  backVoices[v].getX() + backMetrics.notePx + backMetrics.modRightPx + backMetrics.rightDisplacedHeadPx;

                // Don't allow shifting if notes in the same voice can collide
                maxNegativeShiftPx = Math.min(maxNegativeShiftPx, insideLeftEdge - insideRightEdge);
              });

              // Don't shift further left than the notehead of the last context. Actually, stay at most 5% to the right
              // so that two different tick contexts don't align across staves.
              maxNegativeShiftPx = Math.min(
                maxNegativeShiftPx,
                context.getX() - (prevContext.getX() + adjustedJustifyWidth * 0.05)
              );

              // Calculate the expected distance of the current context from the last matching tickable. The
              // distance is scaled down by the softmax for the voice.
              if (globalSoftmax) {
                const t = totalTicks;
                expectedDistance = (softmaxFactor ** (maxTicks / t) / expTicksUsed) * adjustedJustifyWidth;
              } else if (typeof backTickable !== 'undefined') {
                expectedDistance = backTickable.getVoice().softmax(maxTicks) * adjustedJustifyWidth;
              }
              return {
                expectedDistance,
                maxNegativeShiftPx,
                fromTickable: backTickable,
              };
            }
          }
        }

        return { expectedDistance: 0, fromTickablePx: 0, maxNegativeShiftPx: 0 };
      });
      return distances;
    }

    function shiftToIdealDistances(idealDistances: Distance[]): number {
      // Distribute ticks to the contexts based on the calculated distance error.
      const centerX = adjustedJustifyWidth / 2;
      let spaceAccum = 0;

      contextList.forEach((tick, index) => {
        const context = contextMap[tick];
        if (index > 0) {
          const contextX = context.getX();
          const ideal = idealDistances[index];
          const errorPx = defined(ideal.fromTickable).getX() + ideal.expectedDistance - (contextX + spaceAccum);

          let negativeShiftPx = 0;
          if (errorPx > 0) {
            spaceAccum += errorPx;
          } else if (errorPx < 0) {
            negativeShiftPx = Math.min(ideal.maxNegativeShiftPx, Math.abs(errorPx));
            spaceAccum += -negativeShiftPx;
          }
          context.setX(contextX + spaceAccum);
        }
        // Move center aligned tickables to middle
        context.getCenterAlignedTickables().forEach((tickable: Tickable) => {
          tickable.setCenterXShift(centerX - context.getX());
        });
      });

      return lastContext.getX() - firstContext.getX();
    }

    const adjustedJustifyWidth =
      justifyWidth -
      lastContext.getMetrics().notePx -
      lastContext.getMetrics().totalRightPx -
      firstContext.getMetrics().totalLeftPx;
    const configMinPadding = Metrics.get('Stave.endPaddingMin');
    const configMaxPadding = Metrics.get('Stave.endPaddingMax');
    const leftPadding = Metrics.get('Stave.padding');
    let targetWidth = adjustedJustifyWidth;
    const distances = calculateIdealDistances(targetWidth);
    let actualWidth = shiftToIdealDistances(distances);

    // Just one context. Done formatting.
    if (contextList.length === 1) return 0;
    const calcMinDistance = (targetWidth: number, distances: Distance[]) => {
      let mdCalc = targetWidth / 2;
      if (distances.length > 1) {
        for (let di = 1; di < distances.length; ++di) {
          mdCalc = Math.min(distances[di].expectedDistance / 2, mdCalc);
        }
      }
      return mdCalc;
    };
    const minDistance = calcMinDistance(targetWidth, distances);

    // right justify to either the configured padding, or the min distance between notes, whichever is greatest.
    // This * 2 keeps the existing formatting unless there is 'a lot' of extra whitespace, which won't break
    // existing visual regression tests.
    const paddingMaxCalc = (curTargetWidth: number) => {
      let lastTickablePadding = 0;
      const lastTickable = lastContext && lastContext.getMaxTickable();
      if (lastTickable) {
        const voice = lastTickable.getVoice();
        // If the number of actual ticks in the measure <> configured ticks, right-justify
        // because the softmax won't yield the correct value
        if (voice.getTicksUsed().value() > voice.getTotalTicks().value()) {
          return configMaxPadding * 2 < minDistance ? minDistance : configMaxPadding;
        }
        const tickWidth = lastTickable.getWidth();
        lastTickablePadding =
          voice.softmax(lastContext.getMaxTicks().value()) * curTargetWidth - (tickWidth + leftPadding);
      }
      return configMaxPadding * 2 < lastTickablePadding ? lastTickablePadding : configMaxPadding;
    };
    let paddingMax = paddingMaxCalc(targetWidth);
    let paddingMin = paddingMax - (configMaxPadding - configMinPadding);
    const maxX = adjustedJustifyWidth - paddingMin;

    let iterations = maxIterations;
    // Adjust justification width until the right margin is as close as possible to the calculated padding,
    // without going over
    while ((actualWidth > maxX && iterations > 0) || (actualWidth + paddingMax < maxX && iterations > 1)) {
      targetWidth -= actualWidth - maxX;
      paddingMax = paddingMaxCalc(targetWidth);
      paddingMin = paddingMax - (configMaxPadding - configMinPadding);
      actualWidth = shiftToIdealDistances(calculateIdealDistances(targetWidth));
      iterations--;
    }

    this.justifyWidth = justifyWidth;
    return this.evaluate();
  }

  /** Calculate the total cost of this formatting decision. */
  evaluate(): number {
    const contexts = this.tickContexts;
    const justifyWidth = this.justifyWidth;
    // Calculate available slack per tick context. This works out how much freedom
    // to move a context has in either direction, without affecting other notes.
    this.contextGaps = { total: 0, gaps: [] };
    contexts.list.forEach((tick, index) => {
      if (index === 0) return;
      const prevTick = contexts.list[index - 1];
      const prevContext = contexts.map[prevTick];
      const context = contexts.map[tick];
      const prevMetrics = prevContext.getMetrics();
      const currMetrics = context.getMetrics();

      // Calculate X position of right edge of previous note
      const insideRightEdge = prevContext.getX() + prevMetrics.notePx + prevMetrics.totalRightPx;
      // Calculate X position of left edge of current note
      const insideLeftEdge = context.getX() - currMetrics.totalLeftPx;
      const gap = insideLeftEdge - insideRightEdge;
      this.contextGaps.total += gap;
      this.contextGaps.gaps.push({ x1: insideRightEdge, x2: insideLeftEdge });

      // Tell the tick contexts how much they can reposition themselves.
      context.getFormatterMetrics().freedom.left = gap;
      prevContext.getFormatterMetrics().freedom.right = gap;
    });

    // Calculate mean distance in each voice for each duration type, then calculate
    // how far each note is from the mean.
    this.durationStats = {};
    const durationStats = this.durationStats;

    function updateStats(duration: string, space: number) {
      const stats = durationStats[duration];
      if (stats === undefined) {
        durationStats[duration] = { mean: space, count: 1, total: space };
      } else {
        stats.count += 1;
        stats.total += space;
        stats.mean = stats.total / stats.count;
      }
    }

    this.voices.forEach((voice) => {
      voice.getTickables().forEach((note, i, notes) => {
        const duration = note.getTicks().clone().simplify().toString();
        const metrics = note.getMetrics();
        const formatterMetrics = note.getFormatterMetrics();
        const leftNoteEdge = note.getX() + metrics.notePx + metrics.modRightPx + metrics.rightDisplacedHeadPx;
        let space = 0;

        if (i < notes.length - 1) {
          const rightNote = notes[i + 1];
          const rightMetrics = rightNote.getMetrics();
          const rightNoteEdge = rightNote.getX() - rightMetrics.modLeftPx - rightMetrics.leftDisplacedHeadPx;

          space = rightNoteEdge - leftNoteEdge;
          formatterMetrics.space.used = rightNote.getX() - note.getX();
          rightNote.getFormatterMetrics().freedom.left = space;
        } else {
          space = justifyWidth - leftNoteEdge;
          formatterMetrics.space.used = justifyWidth - note.getX();
        }

        formatterMetrics.freedom.right = space;
        updateStats(duration, formatterMetrics.space.used);
      });
    });

    // Calculate how much each note deviates from the mean. Loss function is square
    // root of the sum of squared deviations.
    let totalDeviation = 0;
    this.voices.forEach((voice) => {
      voice.getTickables().forEach((note) => {
        const duration = note.getTicks().clone().simplify().toString();
        const metrics = note.getFormatterMetrics();

        metrics.space.mean = durationStats[duration].mean;
        metrics.duration = duration;
        metrics.iterations += 1;
        metrics.space.deviation = metrics.space.used - metrics.space.mean;

        totalDeviation += metrics.space.deviation ** 2;
      });
    });

    this.totalCost = Math.sqrt(totalDeviation);
    this.lossHistory.push(this.totalCost);
    return this.totalCost;
  }

  /**
   * Run a single iteration of rejustification. At a high level, this method calculates
   * the overall "loss" (or cost) of this layout, and repositions tickcontexts in an
   * attempt to reduce the cost. You can call this method multiple times until it finds
   * and oscillates around a global minimum.
   * @param options parameters for tuning, currently just "alpha".
   * @param options[alpha] the "learning rate" for the formatter. It determines how much of a shift
   * the formatter should make based on its cost function.  Defaults to 0.5.
   */
  tune(options?: { alpha?: number }): number {
    const contexts = this.tickContexts;
    if (!contexts) {
      return 0;
    }

    const alpha = options?.alpha ?? 0.5;

    // function `move` moved to tickcontext.
    let shift = 0;
    this.totalShift = 0;
    contexts.list.forEach((tick, index, list) => {
      const context = contexts.map[tick];
      const prevContext = index > 0 ? contexts.map[list[index - 1]] : undefined;
      const nextContext = index < list.length - 1 ? contexts.map[list[index + 1]] : undefined;

      context.move(shift, prevContext, nextContext);

      // Q(msac): Should the cost by normalized by the number
      // of tickables at this position?  If so, switch this to getAverageDeviationCost()
      const cost = -context.getDeviationCost();
      if (cost > 0) {
        shift = -Math.min(context.getFormatterMetrics().freedom.right, Math.abs(cost));
      } else if (cost < 0) {
        if (nextContext) {
          shift = Math.min(nextContext.getFormatterMetrics().freedom.right, Math.abs(cost));
        } else {
          shift = 0;
        }
      }

      shift *= alpha;
      this.totalShift += shift;
    });

    return this.evaluate();
  }

  /**
   * This is the top-level call for all formatting logic completed
   * after `x` *and* `y` values have been computed for the notes
   * in the voices.
   * Calls postFormat on each ModifierContext and TickContext.
   */
  postFormat(): this {
    this.modifierContexts.forEach((modifierContexts) => {
      modifierContexts.array.forEach((mc) => mc.postFormat());
    });

    this.tickContexts.list.forEach((tick: number): void => {
      this.tickContexts.map[tick].postFormat();
    });

    return this;
  }

  /**
   * Take all `voices` and create `ModifierContext`s out of them. This tells
   * the formatters that the voices belong on a single stave.
   */
  joinVoices(voices: Voice[]): this {
    this.createModifierContexts(voices);
    this.hasMinTotalWidth = false;
    return this;
  }

  /**
   * Align rests in voices, justify the contexts, and position the notes
   * so voices are aligned and ready to render onto the stave. This method
   * mutates the `x` positions of all tickables in `voices`.
   *
   * Voices are full justified to fit in `justifyWidth` pixels.
   *
   * Set `options.context` to the rendering context. Set `options.alignRests`
   * to true to enable rest vertical alignment.
   */
  format(voices: Voice[], justifyWidth?: number, options?: FormatParams): this {
    const opts = {
      alignRests: false,
      ...options,
    };

    this.voices = voices;
    const softmaxFactor = this.formatterOptions.softmaxFactor;
    if (softmaxFactor) {
      this.voices.forEach((v) => v.setSoftmaxFactor(softmaxFactor));
    }

    this.alignRests(voices, opts.alignRests);
    this.createTickContexts(voices);
    this.preFormat(justifyWidth, opts.context, voices, opts.stave);

    // Only postFormat if a stave was supplied for y value formatting
    if (opts.stave) this.postFormat();

    return this;
  }

  // This method is just like `format` except that the `justifyWidth` is inferred from the `stave`.
  formatToStave(voices: Voice[], stave: Stave, optionsParam?: FormatParams): this {
    const options: FormatParams = { context: stave.getContext(), ...optionsParam };

    const justifyWidth = stave.getNoteEndX() - stave.getNoteStartX() - Stave.defaultPadding;
    L('Formatting voices to width: ', justifyWidth);
    return this.format(voices, justifyWidth, options);
  }

  getTickContext(tick: number): TickContext | undefined {
    return this.tickContexts?.map[tick];
  }
}
