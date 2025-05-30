// Summary: A custom VexFlow.RenderContext implementation.
//   This is a stub for demonstration purposes. It prints method calls and arguments via console.log().
// Run:
//   node customcontext.js

const VexFlow = require('vexflow');
const { createCanvas } = require('canvas');

const { Element, RenderContext, Renderer, Stave } = VexFlow;

// In VexFlow 4, this demo worked fine without the line of code below.
// VexFlow 5 requires a hidden canvas for measuring font glyphs.
// Call VexFlow.Element.setTextMeasurementCanvas(...) with an object that conforms to the Canvas API.
// Here, we use node-canvas.
Element.setTextMeasurementCanvas(createCanvas(300, 150));

class CustomContext extends RenderContext {
  constructor() {
    super();
    this.fillStyle = '';
    this.strokeStyle = '';
  }

  log(func, ...args) {
    for (let i = 0; i < args.length; ++i) {
      if (typeof args[i] == 'string') {
        args[i] = `"${args[i]}"`;
      }
    }
    console.log(`${func}(${args.join(', ')})`);
  }

  clear() {
    this.log('clear');
  }

  setFont(f, sz, wt, st) {
    this.log('setFont', f, sz, wt, st);
    return this;
  }

  getFont() {
    this.log(`getFont() => '10pt Arial'`);
    return '10pt Arial';
  }

  setFillStyle(style) {
    this.log('setFillStyle', style);
    return this;
  }

  setBackgroundFillStyle(style) {
    this.log('setBackgroundFillStyle', style);
    return this;
  }

  setStrokeStyle(style) {
    this.log('setStrokeStyle', style);
    return this;
  }

  setShadowColor(color) {
    this.log('setShadowColor', color);
    return this;
  }

  setShadowBlur(blur) {
    this.log('setShadowBlur', blur);
    return this;
  }

  setLineWidth(width) {
    this.log('setLineWidth', width);
    return this;
  }

  setLineCap(capType) {
    this.log('setLineCap', capType);
    return this;
  }

  setLineDash(dashPattern) {
    this.log('setLineDash', `[${dashPattern.join(', ')}]`);
    return this;
  }

  scale(x, y) {
    this.log('scale', x, y);
    return this;
  }

  rect(x, y, width, height) {
    this.log('rect', x, y, width, height);
    return this;
  }

  resize(width, height) {
    this.log('resize', width, height);
    return this;
  }

  fillRect(x, y, width, height) {
    this.log('fillRect', x, y, width, height);
    return this;
  }

  clearRect(x, y, width, height) {
    this.log('clearRect', x, y, width, height);
    return this;
  }

  beginPath() {
    this.log('beginPath');
    return this;
  }

  moveTo(x, y) {
    this.log('moveTo', x, y);
    return this;
  }

  lineTo(x, y) {
    this.log('lineTo', x, y);
    return this;
  }

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    this.log('bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y);
    return this;
  }

  quadraticCurveTo(cpx, cpy, x, y) {
    this.log('quadraticCurveTo', cpx, cpy, x, y);
    return this;
  }

  arc(x, y, radius, startAngle, endAngle, antiClockwise) {
    this.log('arc', x, y, radius, startAngle, endAngle, antiClockwise);
    return this;
  }

  fill(attributes) {
    this.log('fill');
    return this;
  }

  stroke() {
    this.log('stroke');
    return this;
  }

  closePath() {
    this.log('closePath');
    return this;
  }

  fillText(text, x, y) {
    this.log('fillText', text, x, y);
    return this;
  }

  save() {
    this.log('save');
    return this;
  }

  restore() {
    this.log('restore');
    return this;
  }

  openGroup(cls, id, attrs) {
    this.log('openGroup', cls, id);
  }

  closeGroup() {
    this.log('closeGroup');
  }

  add(child) {
    this.log('add');
  }

  measureText(text) {
    this.log('measureText', text);
    return { width: 0, height: 10 };
  }
}

const renderer = new Renderer(new CustomContext());
const context = renderer.getContext();
context.setFont('Arial', 10).setBackgroundFillStyle('#eed');

const stave = new Stave(10, 40, 400);
stave.addClef('treble');
stave.addTimeSignature('4/4');
stave.setContext(context).drawWithStyle();
