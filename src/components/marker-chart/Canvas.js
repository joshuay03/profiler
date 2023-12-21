/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow
import { GREY_20, GREY_30, BLUE_60, BLUE_80 } from 'photon-colors';
import * as React from 'react';
import {
  withChartViewport,
  type WithChartViewport,
  type Viewport,
} from 'firefox-profiler/components/shared/chart/Viewport';
import { ChartCanvas } from 'firefox-profiler/components/shared/chart/Canvas';
import { TooltipMarker } from 'firefox-profiler/components/tooltip/Marker';
import TextMeasurement from 'firefox-profiler/utils/text-measurement';
import { bisectionRight } from 'firefox-profiler/utils/bisect';
import memoize from 'memoize-immutable';
import {
  typeof updatePreviewSelection as UpdatePreviewSelection,
  typeof changeRightClickedMarker as ChangeRightClickedMarker,
  typeof changeMouseTimePosition as ChangeMouseTimePosition,
  typeof changeSelectedMarker as ChangeSelectedMarker,
} from 'firefox-profiler/actions/profile-view';
import { TIMELINE_MARGIN_LEFT } from 'firefox-profiler/app-logic/constants';
import type {
  Milliseconds,
  CssPixels,
  UnitIntervalOfProfileRange,
  ThreadsKey,
  Marker,
  MarkerTimingAndBuckets,
  MarkerIndex,
  TimelineTrackOrganization,
} from 'firefox-profiler/types';
import { getStartEndRangeForMarker } from 'firefox-profiler/utils';

import type {
  ChartCanvasScale,
  ChartCanvasHoverInfo,
} from '../shared/chart/Canvas';

import type { WrapFunctionInDispatch } from 'firefox-profiler/utils/connect';

type MarkerDrawingInformation = {|
  +x: CssPixels,
  +y: CssPixels,
  +w: CssPixels,
  +h: CssPixels,
  +isInstantMarker: boolean,
  +text: string,
|};

// We can hover over multiple items with Marker chart when we are in the active
// tab view. Usually on other charts, we only have one selected item at a time.
// But in here, we can hover over both markers and marker labels.
// Also, they can be hovered at the same time. That's why we keep both of their
// state in a two value tuple.
// So if we take a look at all the possible states, we can have:
//    [Hovered Marker Index, Hovered label row]
// 1. [123                 , null             ]
// 2. [null                , 12               ] (for active tab only)
// 3. [123                 , 12               ] (for active tab only)
// 4. [null                , null             ] (not used, we use primitive null
//                                              to make shared canvas happy)
// First state is the most common case, which is the only one available for the
// full view. We have second and third cases for active tab view where we can
// also see the hovered labels. 4th case is not used. We use primitive `null`
// instead when both of the states are null, because that's what our shared
// canvas component require.
type IndexIntoHoveredLabelRow = number;
type HoveredMarkerChartItems = {|
  markerIndex: MarkerIndex | null,
  rowIndexOfLabel: IndexIntoHoveredLabelRow | null,
|};

type OwnProps = {|
  +rangeStart: Milliseconds,
  +rangeEnd: Milliseconds,
  +markerTimingAndBuckets: MarkerTimingAndBuckets,
  +rowHeight: CssPixels,
  +getMarker: (MarkerIndex) => Marker,
  +threadsKey: ThreadsKey,
  +updatePreviewSelection: WrapFunctionInDispatch<UpdatePreviewSelection>,
  +changeMouseTimePosition: ChangeMouseTimePosition,
  +changeSelectedMarker: ChangeSelectedMarker,
  +changeRightClickedMarker: ChangeRightClickedMarker,
  +marginLeft: CssPixels,
  +marginRight: CssPixels,
  +selectedMarkerIndex: MarkerIndex | null,
  +rightClickedMarkerIndex: MarkerIndex | null,
  +shouldDisplayTooltips: () => boolean,
  +timelineTrackOrganization: TimelineTrackOrganization,
|};

type Props = {|
  ...OwnProps,
  // Bring in the viewport props from the higher order Viewport component.
  +viewport: Viewport,
|};

const TEXT_OFFSET_TOP = 11;
const TEXT_OFFSET_START = 3;
const MARKER_DOT_RADIUS = 0.25;
const LABEL_PADDING = 5;
const MARKER_BORDER_COLOR = '#2c77d1';

class MarkerChartCanvasImpl extends React.PureComponent<Props> {
  _textMeasurement: null | TextMeasurement;

  drawCanvas = (
    ctx: CanvasRenderingContext2D,
    scale: ChartCanvasScale,
    hoverInfo: ChartCanvasHoverInfo<HoveredMarkerChartItems>
  ) => {
    const {
      rowHeight,
      markerTimingAndBuckets,
      rightClickedMarkerIndex,
      timelineTrackOrganization,
      viewport: {
        viewportTop,
        viewportBottom,
        containerWidth,
        containerHeight,
      },
    } = this.props;
    let hoveredMarker = null;
    let hoveredLabel = null;
    let prevHoveredMarker = null;
    let prevHoveredLabel = null;

    const {
      hoveredItem: hoveredItems,
      prevHoveredItem: prevHoveredItems,
      isHoveredOnlyDifferent,
    } = hoverInfo;

    if (hoveredItems) {
      hoveredMarker = hoveredItems.markerIndex;
      hoveredLabel = hoveredItems.rowIndexOfLabel;
    }
    if (prevHoveredItems) {
      prevHoveredMarker = prevHoveredItems.markerIndex;
      prevHoveredLabel = prevHoveredItems.rowIndexOfLabel;
    }

    const { cssToUserScale } = scale;
    if (cssToUserScale !== 1) {
      throw new Error(
        'StackChartCanvasImpl sets scaleCtxToCssPixels={true}, so canvas user space units should be equal to CSS pixels.'
      );
    }

    // Convert CssPixels to Stack Depth
    const startRow = Math.floor(viewportTop / rowHeight);
    const endRow = Math.min(
      Math.ceil(viewportBottom / rowHeight),
      markerTimingAndBuckets.length
    );
    const markerIndexToTimingRow = this._getMarkerIndexToTimingRow(
      markerTimingAndBuckets
    );
    const rightClickedRow: number | void =
      rightClickedMarkerIndex === null
        ? undefined
        : markerIndexToTimingRow.get(rightClickedMarkerIndex);
    let newRow: number | void =
      hoveredMarker === null
        ? undefined
        : markerIndexToTimingRow.get(hoveredMarker);
    if (
      timelineTrackOrganization.type === 'active-tab' &&
      newRow === undefined &&
      hoveredLabel !== null
    ) {
      // If it's active tab view and we don't know the row yet, assign
      // `hoveredLabel` if it's non-null. This is needed because we can hover
      // the label and not the marker. That way we are making sure that we
      // select the correct row.
      newRow = hoveredLabel;
    }

    // Common properties that won't be changed later.
    ctx.lineWidth = 1;

    if (isHoveredOnlyDifferent) {
      // Only re-draw the rows that have been updated if only the hovering information
      // is different.
      let oldRow: number | void =
        prevHoveredMarker === null
          ? undefined
          : markerIndexToTimingRow.get(prevHoveredMarker);
      if (
        timelineTrackOrganization.type === 'active-tab' &&
        oldRow === undefined &&
        prevHoveredLabel !== null
      ) {
        // If it's active tab view and we don't know the row yet, assign
        // `prevHoveredLabel` if it's non-null. This is needed because we can
        // hover the label and not the marker. That way we are making sure that
        // previous hovered row is correct.
        oldRow = prevHoveredLabel;
      }

      if (newRow !== undefined) {
        this.clearRow(ctx, newRow);
        this.highlightRow(ctx, newRow);
        this.drawMarkers(ctx, hoveredMarker, newRow, newRow + 1);
        if (hoveredLabel === null) {
          this.drawSeparatorsAndLabels(ctx, newRow, newRow + 1);
        }
      }
      if (oldRow !== undefined && oldRow !== newRow) {
        if (oldRow !== rightClickedRow) {
          this.clearRow(ctx, oldRow);
        }
        this.drawMarkers(ctx, hoveredMarker, oldRow, oldRow + 1);
        this.drawSeparatorsAndLabels(ctx, oldRow, oldRow + 1);
      }
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, containerWidth, containerHeight);
      if (rightClickedRow !== undefined) {
        this.highlightRow(ctx, rightClickedRow);
      } else if (newRow !== undefined) {
        this.highlightRow(ctx, newRow);
      }
      this.drawMarkers(ctx, hoveredMarker, startRow, endRow);
      this.drawSeparatorsAndLabels(ctx, startRow, endRow);
    }
  };

  highlightRow = (ctx, row) => {
    const {
      rowHeight,
      viewport: { viewportTop, containerWidth },
    } = this.props;

    ctx.fillStyle = 'rgba(40, 122, 169, 0.2)';
    ctx.fillRect(
      0, // To include the labels also
      row * rowHeight - viewportTop,
      containerWidth,
      rowHeight - 1 // Subtract 1 for borders.
    );
  };

  /**
   * When re-drawing markers, it's helpful to isolate the operations to a single row
   * in order to make the drawing faster. This memoized function computes the map
   * of a marker index to its row in the marker timing.
   */
  _getMarkerIndexToTimingRow = memoize(
    (
      markerTimingAndBuckets: MarkerTimingAndBuckets
    ): Map<MarkerIndex, number> => {
      const markerIndexToTimingRow = new Map();
      for (
        let rowIndex = 0;
        rowIndex < markerTimingAndBuckets.length;
        rowIndex++
      ) {
        const markerTiming = markerTimingAndBuckets[rowIndex];
        if (typeof markerTiming === 'string') {
          continue;
        }
        for (
          let timingIndex = 0;
          timingIndex < markerTiming.length;
          timingIndex++
        ) {
          markerIndexToTimingRow.set(markerTiming.index[timingIndex], rowIndex);
        }
      }
      return markerIndexToTimingRow;
    },
    { cache: new WeakMap() }
  );

  // Note: we used a long argument list instead of an object parameter on
  // purpose, to reduce GC pressure while drawing.
  drawOneMarker(
    ctx: CanvasRenderingContext2D,
    x: CssPixels,
    y: CssPixels,
    w: CssPixels,
    h: CssPixels,
    isInstantMarker: boolean,
    text: string,
    isHighlighted: boolean = false
  ) {
    if (isInstantMarker) {
      this.drawOneInstantMarker(ctx, x, y, h, isHighlighted);
    } else {
      this.drawOneIntervalMarker(ctx, x, y, w, h, text, isHighlighted);
    }
  }

  drawOneIntervalMarker(
    ctx: CanvasRenderingContext2D,
    x: CssPixels,
    y: CssPixels,
    w: CssPixels,
    h: CssPixels,
    text: string,
    isHighlighted: boolean
  ) {
    const { marginLeft } = this.props;

    if (w <= 2) {
      // This is an interval marker small enough that if we drew it as a
      // rectangle, we wouldn't see any inside part. With a width of 2 pixels,
      // the rectangle-with-borders would only be borders. With less than 2
      // pixels, the borders would collapse.
      // So let's draw it directly as a rect.
      ctx.fillStyle = isHighlighted ? BLUE_80 : MARKER_BORDER_COLOR;

      // w is rounded in the caller, but let's make sure it's at least 1.
      w = Math.max(w, 1);
      ctx.fillRect(x, y + 1, w, h - 2);
    } else {
      // This is a bigger interval marker.
      const textMeasurement = this._getTextMeasurement(ctx);

      ctx.fillStyle = isHighlighted ? BLUE_60 : '#8ac4ff';
      ctx.strokeStyle = isHighlighted ? BLUE_80 : MARKER_BORDER_COLOR;

      ctx.beginPath();

      // We want the rectangle to have a clear margin, that's why we increment y
      // and decrement h (twice, for both margins).
      // We also add "0.5" more so that the stroke is properly on a pixel.
      // Indeed strokes are drawn on both sides equally, so half a pixel on each
      // side in this case.
      ctx.rect(
        x + 0.5, // + 0.5 for the stroke
        y + 1 + 0.5, // + 1 for the top margin, + 0.5 for the stroke
        w - 1, // - 1 to account for left and right strokes.
        h - 2 - 1 // + 2 accounts for top and bottom margins, + 1 accounts for top and bottom strokes
      );
      ctx.fill();
      ctx.stroke();

      // Draw the text label
      // TODO - L10N RTL.
      // Constrain the x coordinate to the leftmost area.
      const x2: CssPixels =
        x < marginLeft ? marginLeft + TEXT_OFFSET_START : x + TEXT_OFFSET_START;
      const visibleWidth = x < marginLeft ? w - marginLeft + x : w;
      const w2: CssPixels = visibleWidth - 2 * TEXT_OFFSET_START;

      if (w2 > textMeasurement.minWidth) {
        const fittedText = textMeasurement.getFittedText(text, w2);
        if (fittedText) {
          ctx.fillStyle = isHighlighted ? 'white' : 'black';
          ctx.fillText(fittedText, x2, y + TEXT_OFFSET_TOP);
        }
      }
    }
  }

  // x indicates the center of this marker
  // y indicates the top of the row
  // h indicates the available height in the row
  drawOneInstantMarker(
    ctx: CanvasRenderingContext2D,
    x: CssPixels,
    y: CssPixels,
    h: CssPixels,
    isHighlighted: boolean
  ) {
    ctx.fillStyle = isHighlighted ? BLUE_60 : '#8ac4ff';
    ctx.strokeStyle = isHighlighted ? BLUE_80 : MARKER_BORDER_COLOR;

    // We're drawing a diamond shape, whose height is h - 2, and width is h / 2.
    ctx.beginPath();
    ctx.moveTo(x - h / 4, y + h / 2);
    ctx.lineTo(x, y + 1.5);
    ctx.lineTo(x + h / 4, y + h / 2);
    ctx.lineTo(x, y + h - 1.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  drawMarkers(
    ctx: CanvasRenderingContext2D,
    hoveredItem: MarkerIndex | null,
    startRow: number,
    endRow: number
  ) {
    const {
      rangeStart,
      rangeEnd,
      markerTimingAndBuckets,
      rowHeight,
      marginLeft,
      marginRight,
      rightClickedMarkerIndex,
      selectedMarkerIndex,
      viewport: {
        containerWidth,
        containerHeight,
        viewportLeft,
        viewportRight,
        viewportTop,
      },
    } = this.props;

    const { devicePixelRatio } = window;
    const markerContainerWidth = containerWidth - marginLeft - marginRight;

    const rangeLength: Milliseconds = rangeEnd - rangeStart;
    const viewportLength: UnitIntervalOfProfileRange =
      viewportRight - viewportLeft;

    // Decide which samples to actually draw
    const timeAtViewportLeft: Milliseconds =
      rangeStart + rangeLength * viewportLeft;
    const timeAtViewportRightPlusMargin: Milliseconds =
      rangeStart +
      rangeLength * viewportRight +
      // This represents the amount of seconds in the right margin:
      marginRight * ((viewportLength * rangeLength) / markerContainerWidth);

    const highlightedMarkers: MarkerDrawingInformation[] = [];

    // We'll restore the context at the end, so that the clip region will be
    // removed.
    ctx.save();
    // The clip operation forbids drawing in the label zone.
    ctx.beginPath();
    ctx.rect(marginLeft, 0, markerContainerWidth, containerHeight);
    ctx.clip();

    // Only draw the stack frames that are vertically within view.
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      // Get the timing information for a row of stack frames.
      const markerTiming = markerTimingAndBuckets[rowIndex];

      if (!markerTiming || typeof markerTiming === 'string') {
        // This marker timing either didn't exist, or was a bucket.
        continue;
      }

      // Track the last drawn marker X position, so that we can avoid overdrawing.
      let previousMarkerDrawnAtX: number | null = null;

      for (let i = 0; i < markerTiming.length; i++) {
        const startTimestamp = markerTiming.start[i];
        const endTimestamp = markerTiming.end[i];
        const isInstantMarker = startTimestamp === endTimestamp;

        // Only draw samples that are in bounds.
        if (
          endTimestamp >= timeAtViewportLeft &&
          startTimestamp < timeAtViewportRightPlusMargin
        ) {
          const startTime: UnitIntervalOfProfileRange =
            (startTimestamp - rangeStart) / rangeLength;
          const endTime: UnitIntervalOfProfileRange =
            (endTimestamp - rangeStart) / rangeLength;

          let x: CssPixels =
            ((startTime - viewportLeft) * markerContainerWidth) /
              viewportLength +
            marginLeft;
          const y: CssPixels = rowIndex * rowHeight - viewportTop;
          let w: CssPixels =
            ((endTime - startTime) * markerContainerWidth) / viewportLength;
          const h: CssPixels = rowHeight - 1;

          x = Math.round(x * devicePixelRatio) / devicePixelRatio;
          w = Math.round(w * devicePixelRatio) / devicePixelRatio;

          const text = markerTiming.label[i];
          const markerIndex = markerTiming.index[i];

          const isHighlighted =
            rightClickedMarkerIndex === markerIndex ||
            hoveredItem === markerIndex ||
            selectedMarkerIndex === markerIndex;

          if (isHighlighted) {
            highlightedMarkers.push({ x, y, w, h, isInstantMarker, text });
          } else if (
            // Always render non-dot markers and markers that are larger than
            // one pixel.
            w > 1 ||
            // Do not render dot markers that occupy the same pixel, as this can take
            // a lot of time, and not change the visual display of the chart.
            x !== previousMarkerDrawnAtX
          ) {
            previousMarkerDrawnAtX = x;
            this.drawOneMarker(ctx, x, y, w, h, isInstantMarker, text);
          }
        }
      }
    }

    // We draw highlighted markers after the normal markers so that they stand
    // out more.
    highlightedMarkers.forEach((highlightedMarker) => {
      this.drawOneMarker(
        ctx,
        highlightedMarker.x,
        highlightedMarker.y,
        highlightedMarker.w,
        highlightedMarker.h,
        highlightedMarker.isInstantMarker,
        highlightedMarker.text,
        true /* isHighlighted */
      );
    });

    ctx.restore();
  }

  clearRow(ctx: CanvasRenderingContext2D, rowIndex: number) {
    const {
      rowHeight,
      viewport: { viewportTop, containerWidth },
    } = this.props;

    ctx.fillStyle = '#fff';
    ctx.fillRect(
      0,
      rowIndex * rowHeight - viewportTop,
      containerWidth,
      rowHeight - 1 // Subtract 1 for borders.
    );
  }

  /**
   * Lazily create the text measurement tool, as a valid 2d rendering context must
   * exist before it is created.
   */
  _getTextMeasurement(ctx: CanvasRenderingContext2D): TextMeasurement {
    if (!this._textMeasurement) {
      this._textMeasurement = new TextMeasurement(ctx);
    }
    return this._textMeasurement;
  }

  drawSeparatorsAndLabels(
    ctx: CanvasRenderingContext2D,
    startRow: number,
    endRow: number
  ) {
    const {
      markerTimingAndBuckets,
      rowHeight,
      marginLeft,
      marginRight,
      timelineTrackOrganization,
      viewport: { viewportTop, containerWidth, containerHeight },
    } = this.props;

    const usefulContainerWidth = containerWidth - marginRight;

    // Draw separators
    ctx.fillStyle = GREY_20;
    if (timelineTrackOrganization.type !== 'active-tab') {
      // Don't draw the separator on the right side if we are in the active tab.
      ctx.fillRect(marginLeft - 1, 0, 1, containerHeight);
    }
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      // `- 1` at the end, because the top separator is not drawn in the canvas,
      // it's drawn using CSS' border property. And canvas positioning is 0-based.
      const y = (rowIndex + 1) * rowHeight - viewportTop - 1;
      ctx.fillRect(0, y, usefulContainerWidth, 1);
    }

    const textMeasurement = this._getTextMeasurement(ctx);

    // Draw the marker names in the left margin.
    ctx.fillStyle = '#000000';
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      const markerTiming = markerTimingAndBuckets[rowIndex];
      if (typeof markerTiming === 'string') {
        continue;
      }
      // Draw the marker name.
      const { name } = markerTiming;
      if (rowIndex > 0 && name === markerTimingAndBuckets[rowIndex - 1].name) {
        continue;
      }

      const y = rowIndex * rowHeight - viewportTop;
      // Even though it's on active tab view, have a hard cap on the text length.
      const fittedText = textMeasurement.getFittedText(
        name,
        TIMELINE_MARGIN_LEFT
      );

      if (timelineTrackOrganization.type === 'active-tab') {
        // Draw the text backgound for active tab.
        ctx.fillStyle = '#ffffffbf'; // white with 75% opacity
        const textWidth = textMeasurement.getTextWidth(fittedText);
        ctx.fillRect(0, y, textWidth + LABEL_PADDING * 2, rowHeight);

        // Set the fill style back for text.
        ctx.fillStyle = '#000000';
      }

      ctx.fillText(fittedText, LABEL_PADDING, y + TEXT_OFFSET_TOP);
    }

    // Draw the bucket names.
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      // Get the timing information for a row of stack frames.
      const bucketName = markerTimingAndBuckets[rowIndex];
      if (typeof bucketName !== 'string') {
        continue;
      }
      const y = rowIndex * rowHeight - viewportTop;

      // Draw the backgound.
      ctx.fillStyle = GREY_20;
      ctx.fillRect(0, y - 1, usefulContainerWidth, rowHeight);

      // Draw the borders./*
      ctx.fillStyle = GREY_30;
      ctx.fillRect(0, y - 1, usefulContainerWidth, 1);
      ctx.fillRect(0, y + rowHeight - 1, usefulContainerWidth, 1);

      // Draw the text.
      ctx.fillStyle = '#000000';
      ctx.fillText(bucketName, LABEL_PADDING + marginLeft, y + TEXT_OFFSET_TOP);
    }
  }

  hitTest = (x: CssPixels, y: CssPixels): HoveredMarkerChartItems | null => {
    const {
      rangeStart,
      rangeEnd,
      markerTimingAndBuckets,
      rowHeight,
      marginLeft,
      marginRight,
      timelineTrackOrganization,
      viewport: { viewportLeft, viewportRight, viewportTop, containerWidth },
    } = this.props;

    // Note: we may want to increase this value to hit markers that are farther.
    const dotRadius: CssPixels = MARKER_DOT_RADIUS * rowHeight;
    if (x < marginLeft - dotRadius) {
      return null;
    }

    let markerIndex = null;
    let rowIndexOfLabel = null;
    const markerContainerWidth = containerWidth - marginLeft - marginRight;

    const rangeLength: Milliseconds = rangeEnd - rangeStart;

    // Reminder: this is a value between 0 and 1, and represents a percentage of
    // the full time range.
    const viewportLength: UnitIntervalOfProfileRange =
      viewportRight - viewportLeft;

    // This is the x position in terms of unit interval (so, between 0 and 1).
    const xInUnitInterval: UnitIntervalOfProfileRange =
      viewportLeft + viewportLength * ((x - marginLeft) / markerContainerWidth);

    const dotRadiusInTime =
      (dotRadius / markerContainerWidth) * viewportLength * rangeLength;

    const xInTime: Milliseconds = rangeStart + xInUnitInterval * rangeLength;
    const rowIndex = Math.floor((y + viewportTop) / rowHeight);

    const markerTiming = markerTimingAndBuckets[rowIndex];

    if (
      !markerTiming ||
      typeof markerTiming === 'string' ||
      !markerTiming.length
    ) {
      return null;
    }

    // This is a small utility function to define if some marker timing is in
    // our hit test range.
    const isMarkerTimingInDotRadius = (index) =>
      markerTiming.start[index] < xInTime + dotRadiusInTime &&
      markerTiming.end[index] > xInTime - dotRadiusInTime;

    // A markerTiming line is ordered.
    // 1. Let's find a marker reasonably close to our mouse cursor.
    // The result of this bisection gives the first marker that starts _after_
    // our mouse cursor. Our result will be either this marker, or the previous
    // one.
    const nextStartIndex = bisectionRight(markerTiming.start, xInTime);

    if (nextStartIndex > 0 && nextStartIndex < markerTiming.length) {
      // 2. This is the common case: 2 markers are candidates. Then we measure
      // the distance between them and the mouse cursor and chose the smallest
      // distance.
      const prevStartIndex = nextStartIndex - 1;

      // Note that these values can be negative if the cursor is _inside_ a
      // marker. There should be one at most in this case, and we'll want it. So
      // NO Math.abs here.
      const distanceToNext = markerTiming.start[nextStartIndex] - xInTime;
      const distanceToPrev = xInTime - markerTiming.end[prevStartIndex];

      const closest =
        distanceToPrev < distanceToNext ? prevStartIndex : nextStartIndex;

      // 3. When we found the closest, we still have to check if it's in close
      // enough!
      if (isMarkerTimingInDotRadius(closest)) {
        markerIndex = markerTiming.index[closest];
      }
    } else if (nextStartIndex === 0) {
      // 4. Special case 1: the mouse cursor is at the left of all markers in
      // this line. Then, we have only 1 candidate, we can check if it's inside
      // our hit test range right away.
      if (isMarkerTimingInDotRadius(nextStartIndex)) {
        markerIndex = markerTiming.index[nextStartIndex];
      }
    } else {
      // 5. Special case 2: the mouse cursor is at the right of all markers in
      // this line. Then we only have 1 candidate as well, let's check if it's
      // inside our hit test range.
      if (isMarkerTimingInDotRadius(nextStartIndex - 1)) {
        markerIndex = markerTiming.index[nextStartIndex - 1];
      }
    }

    if (timelineTrackOrganization.type === 'active-tab') {
      // We can also hover over a marker label on active tab view. That's why we
      // also need to hit test for the labels. On active tab view, markers and
      // labels can overlap with each other. Because of that, we need to hide
      // the texts if we are hovering them to make the markers more visible.
      const prevMarkerTiming = markerTimingAndBuckets[rowIndex - 1];
      if (
        // Only the first row of a marker type has label, so we are checking
        // if we changed the marker type.
        prevMarkerTiming.name !== markerTiming.name &&
        // We don't have the canvas context in this function, but if we are doing
        // the hit testing, that means we already rendered the chart and therefore
        // we initialized `this._textMeasurement`. But we are checking it just in case.
        this._textMeasurement
      ) {
        const textWidth = this._textMeasurement.getTextWidth(markerTiming.name);
        if (x < textWidth + LABEL_PADDING * 2) {
          rowIndexOfLabel = rowIndex;
        }
      }
    }

    if (markerIndex === null && rowIndexOfLabel === null) {
      // If both of them are null, return a null instead of `[null, null]`.
      // That's because shared canvas component only understands that.
      return null;
    }

    // Yes, we are returning a new object all the time when we do the hit testing.
    // I can hear you say "How does equality check work for old and new hovered
    // items then?". Well, on the shared canvas component we have a function
    // called `hoveredItemsAreEqual` that shallowly checks for equality of
    // objects and arrays. So it's safe to return a new object all the time.
    return { markerIndex, rowIndexOfLabel };
  };

  onMouseMove = (event: { nativeEvent: MouseEvent }) => {
    const {
      changeMouseTimePosition,
      rangeStart,
      rangeEnd,
      marginLeft,
      marginRight,
      viewport: { viewportLeft, viewportRight, containerWidth },
    } = this.props;
    const viewportLength: UnitIntervalOfProfileRange =
      viewportRight - viewportLeft;
    const markerContainerWidth = containerWidth - marginLeft - marginRight;
    // This is the x position in terms of unit interval (so, between 0 and 1).
    const xInUnitInterval: UnitIntervalOfProfileRange =
      viewportLeft +
      viewportLength *
        ((event.nativeEvent.offsetX - marginLeft) / markerContainerWidth);

    if (xInUnitInterval < 0 || xInUnitInterval > 1) {
      changeMouseTimePosition(null);
    } else {
      const rangeLength: Milliseconds = rangeEnd - rangeStart;
      const xInTime: Milliseconds = rangeStart + xInUnitInterval * rangeLength;
      changeMouseTimePosition(xInTime);
    }
  };

  onMouseLeave = () => {
    this.props.changeMouseTimePosition(null);
  };

  onDoubleClickMarker = (hoveredItems: HoveredMarkerChartItems | null) => {
    const markerIndex = hoveredItems === null ? null : hoveredItems.markerIndex;
    if (markerIndex === null) {
      return;
    }
    const { getMarker, updatePreviewSelection, rangeStart, rangeEnd } =
      this.props;
    const marker = getMarker(markerIndex);
    const { start, end } = getStartEndRangeForMarker(
      rangeStart,
      rangeEnd,
      marker
    );

    updatePreviewSelection({
      hasSelection: true,
      isModifying: false,
      selectionStart: start,
      selectionEnd: end,
    });
  };

  onSelectItem = (hoveredItems: HoveredMarkerChartItems | null) => {
    const markerIndex = hoveredItems === null ? null : hoveredItems.markerIndex;
    const { changeSelectedMarker, threadsKey } = this.props;
    changeSelectedMarker(threadsKey, markerIndex, { source: 'pointer' });
  };

  onRightClickMarker = (hoveredItems: HoveredMarkerChartItems | null) => {
    const markerIndex = hoveredItems === null ? null : hoveredItems.markerIndex;
    const { changeRightClickedMarker, threadsKey } = this.props;
    changeRightClickedMarker(threadsKey, markerIndex);
  };

  getHoveredMarkerInfo = ({
    markerIndex,
  }: HoveredMarkerChartItems): React.Node => {
    if (!this.props.shouldDisplayTooltips() || markerIndex === null) {
      return null;
    }

    const marker = this.props.getMarker(markerIndex);
    return (
      <TooltipMarker
        markerIndex={markerIndex}
        marker={marker}
        threadsKey={this.props.threadsKey}
        restrictHeightWidth={true}
      />
    );
  };

  render() {
    const { containerWidth, containerHeight, isDragging } = this.props.viewport;

    return (
      <ChartCanvas
        className="markerChartCanvas"
        containerWidth={containerWidth}
        containerHeight={containerHeight}
        isDragging={isDragging}
        scaleCtxToCssPixels={true}
        onSelectItem={this.onSelectItem}
        onDoubleClickItem={this.onDoubleClickMarker}
        onRightClick={this.onRightClickMarker}
        getHoveredItemInfo={this.getHoveredMarkerInfo}
        drawCanvas={this.drawCanvas}
        hitTest={this.hitTest}
        onMouseMove={this.onMouseMove}
        onMouseLeave={this.onMouseLeave}
      />
    );
  }
}

export const MarkerChartCanvas = (withChartViewport: WithChartViewport<
  OwnProps,
  Props,
>)(MarkerChartCanvasImpl);
