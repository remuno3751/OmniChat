import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import type { ShapeArrow, ShapeBox, ShapeChart, ShapeLine, ShapesSpec, Shape } from '../../docModel';
import {
  DEFAULT_FILL, INK, PT, VIEWBOX, VIEW_H, VIEW_W, arrowHead, arrowLabelBox, arrowSegment, boxMap, chartPrimitives, dashArray, shapeOutline, toUnits, type Prim,
} from '../../shapeGeometry';

/*
 * The shapes of one slide, drawn over its 16:9 card (docs/design/SLIDE-SHAPES.md). Positions are percent of the
 * card. Shapes and lines go in one SVG (drawing units, see shapeGeometry); box texts are real Text views, so they
 * wrap like the body text. Font sizes are pt on the 960 pt wide slide (13.33 in, as the .pptx is written), scaled by the card width.
 * Elements without their own color take the slide's ink (spec.ink, dark text on a light slide by default).
 */

const HEAD_LEN = 9 * PT;
const HEAD_HALF = 4 * PT;
/** Arrow labels: 12 pt on the real 960 pt slide. The label box is sized for this, so the text is drawn at the same scale. */
const LABEL_PT = 12;

export default function SlideShapes({ spec, w }: { spec: ShapesSpec; w: number }) {
  const h = (w * 9) / 16;
  const boxes = boxMap(spec.elements);
  const ink = spec.ink ?? INK;
  return (
    <>
      <Svg width={w} height={h} viewBox={VIEWBOX} style={StyleSheet.absoluteFill}>
        {spec.bg ? <Rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill={spec.bg} /> : null}
        {spec.elements.map((e, i) => <ShapeSvg key={i} e={e} boxes={boxes} ink={ink} />)}
      </Svg>
      {spec.elements.map((e, i) => (e.type === 'arrow' || e.type === 'line' || e.type === 'chart' ? null : <BoxText key={i} e={e} w={w} ink={ink} />))}
      {spec.elements.map((e, i) => (e.type === 'arrow' && e.label ? <ArrowLabel key={i} e={e} boxes={boxes} w={w} ink={ink} /> : null))}
    </>
  );
}

function ShapeSvg({ e, boxes, ink }: { e: Shape; boxes: ReadonlyMap<string, ShapeBox>; ink: string }) {
  switch (e.type) {
    case 'line':
      return <LineSvg e={e} ink={ink} />;
    case 'arrow': {
      const seg = arrowSegment(e, boxes);
      if (!seg) return null;
      return <ArrowSvg e={e} ink={ink} x1={seg.x1 * 16} y1={seg.y1 * 9} x2={seg.x2 * 16} y2={seg.y2 * 9} />;
    }
    case 'chart':
      return <ChartSvg e={e} ink={ink} />;
    default:
      return <BoxSvg e={e} />;
  }
}

function BoxSvg({ e }: { e: ShapeBox }) {
  const u = toUnits(e);
  const d = shapeOutline(e.type, u);
  if (!d) return null;
  const lw = (e.lineWidth ?? 1.5) * PT;
  const fill = e.fill ?? (e.type === 'text' ? 'none' : DEFAULT_FILL);
  const stroke = e.line ?? 'none';
  return (
    <G opacity={e.opacity} rotation={e.rotate ?? 0} origin={`${u.x + u.w / 2}, ${u.y + u.h / 2}`}>
      <Path d={d} fill={fill} stroke={stroke} strokeWidth={stroke === 'none' ? 0 : lw} />
    </G>
  );
}

function LineSvg({ e, ink }: { e: ShapeLine; ink: string }) {
  const lw = (e.width ?? 1.5) * PT;
  const x1 = e.x1 * 16, y1 = e.y1 * 9, x2 = e.x2 * 16, y2 = e.y2 * 9;
  const color = e.color ?? ink;
  const heads: [number, number][][] = [];
  if (e.head === 'end' || e.head === 'both') heads.push(arrowHead(x1, y1, x2, y2, HEAD_LEN, HEAD_HALF));
  if (e.head === 'both') heads.push(arrowHead(x2, y2, x1, y1, HEAD_LEN, HEAD_HALF));
  return (
    <>
      <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={lw} strokeDasharray={dashArray(e.dash, lw)} strokeLinecap="round" />
      {heads.map((pts, i) => <Polygon key={i} points={pts.map((p) => p.join(',')).join(' ')} fill={color} />)}
    </>
  );
}

function ArrowSvg({ e, ink, x1, y1, x2, y2 }: { e: ShapeArrow; ink: string; x1: number; y1: number; x2: number; y2: number }) {
  const lw = (e.width ?? 1.5) * PT;
  const color = e.color ?? ink;
  const head = arrowHead(x1, y1, x2, y2, HEAD_LEN, HEAD_HALF);
  return (
    <>
      <Line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={lw} strokeDasharray={dashArray(e.dash, lw)} strokeLinecap="round" />
      {head.length ? <Polygon points={head.map((p) => p.join(',')).join(' ')} fill={color} /> : null}
    </>
  );
}

function ChartSvg({ e, ink }: { e: ShapeChart; ink: string }) {
  return (
    <>
      {chartPrimitives(e, ink).map((p, i) => <PrimSvg key={i} p={p} />)}
    </>
  );
}

function PrimSvg({ p }: { p: Prim }) {
  switch (p.k) {
    case 'rect':
      return <Rect x={p.x} y={p.y} width={p.w} height={p.h} fill={p.fill} opacity={p.opacity} />;
    case 'line':
      return <Line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.width} />;
    case 'path':
      return <Path d={p.d} fill={p.fill} opacity={p.opacity} stroke={p.stroke} strokeWidth={p.width} strokeLinejoin="round" />;
    case 'circle':
      return <Circle cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} />;
    case 'text':
      return (
        <SvgText x={p.x} y={p.y} fontSize={p.size} textAnchor={p.anchor} fill={p.fill} fontWeight={p.bold ? 'bold' : 'normal'}>
          {p.text}
        </SvgText>
      );
  }
}

/** The text of a box, as a view over it (the box's own position, percent). */
function BoxText({ e, w, ink }: { e: Shape; w: number; ink: string }) {
  if (e.type === 'line' || e.type === 'arrow' || e.type === 'chart' || !e.text) return null;
  const size = (e.size ?? 18) * (w / 960);
  const valign = e.valign ?? 'middle';
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', left: `${e.x}%`, top: `${e.y}%`, width: `${e.w}%`, height: `${e.h}%`,
        justifyContent: valign === 'top' ? 'flex-start' : valign === 'bottom' ? 'flex-end' : 'center',
        paddingHorizontal: w * 0.01,
        opacity: e.opacity,
        transform: e.rotate ? [{ rotate: `${e.rotate}deg` }] : undefined,
      }}
    >
      <Text
        style={{
          textAlign: e.align ?? 'center', fontSize: size, lineHeight: size * 1.25,
          color: e.color ?? ink, fontWeight: e.bold ? '700' : '400', fontStyle: e.italic ? 'italic' : 'normal',
        }}
      >
        {e.text}
      </Text>
    </View>
  );
}

/** Label of an arrow: no background, placed beside the line by arrowLabelBox (its box is the text's estimated size). */
function ArrowLabel({ e, boxes, w, ink }: { e: ShapeArrow; boxes: ReadonlyMap<string, ShapeBox>; w: number; ink: string }) {
  const seg = arrowSegment(e, boxes);
  if (!seg || !e.label) return null;
  const b = arrowLabelBox(seg, e.label, LABEL_PT);
  const size = LABEL_PT * (w / 960);
  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%`, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text style={{ fontSize: size, lineHeight: size * 1.2, color: e.color ?? ink, textAlign: 'center' }}>{e.label}</Text>
    </View>
  );
}
