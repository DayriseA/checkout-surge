"use client";

import { createContext, type PointerEvent, type ReactNode, useContext, useState } from "react";
import {
  axisTicks,
  type ChartPoint,
  describeSeries,
  formatNumber,
  formatSeconds,
  scale,
  valueAt,
} from "./signal-chart-math";

export type { ChartPoint };

export type ChartSeries = {
  area?: boolean;
  label: string;
  points: ChartPoint[];
  tone: "accent" | "danger" | "ok";
};

/** A numbered event line; the number matches the shared marker legend under the charts. */
export type ChartMarker = { elapsedSeconds: number; number: number };

type Cursor = { seconds: number | null; setSeconds: (seconds: number | null) => void };

const CursorContext = createContext<Cursor>({ seconds: null, setSeconds: () => {} });

/** Every chart inside shares one hover position, so values read at the same instant. */
export function SignalCursorProvider({ children }: { children: ReactNode }) {
  const [seconds, setSeconds] = useState<number | null>(null);
  return <CursorContext value={{ seconds, setSeconds }}>{children}</CursorContext>;
}

const strokeTone = { accent: "stroke-accent", danger: "stroke-danger", ok: "stroke-ok" } as const;
const fillTone = { accent: "fill-accent", danger: "fill-danger", ok: "fill-ok" } as const;
const swatchTone = { accent: "bg-accent", danger: "bg-danger", ok: "bg-ok" } as const;
const width = 640;
const height = 96;

export function SignalChart({
  ariaLabel,
  markers,
  series,
  unit,
  xMax,
}: {
  ariaLabel: string;
  markers: ChartMarker[];
  series: ChartSeries[];
  unit: string;
  xMax: number;
}) {
  const cursor = useContext(CursorContext);
  const yMax = Math.max(1, ...series.flatMap((line) => line.points.map((point) => point.value)));
  const percent = (seconds: number) => (scale(seconds, xMax, width) / width) * 100;
  const cursorPercent = cursor.seconds === null ? null : percent(cursor.seconds);
  const readings =
    cursor.seconds === null
      ? []
      : series.flatMap((line) => {
          const value = valueAt(line.points, cursor.seconds ?? 0);
          return value === null ? [] : [{ label: line.label, value }];
        });

  return (
    <div className="grid gap-1">
      {series.length > 1 ? (
        <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 pl-12 text-xs text-muted">
          {series.map((line) => (
            <li className="flex items-center gap-1.5" key={line.label}>
              <span aria-hidden="true" className={`h-0.5 w-4 ${swatchTone[line.tone]}`} />
              {line.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex">
        <div
          aria-hidden="true"
          className="relative h-24 w-12 shrink-0 pr-2 text-right text-[11px] leading-none text-muted"
        >
          <span className="absolute right-2 top-0">{formatNumber(yMax)}</span>
          <span className="absolute bottom-0 right-2">0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="relative h-24 touch-pan-y rounded bg-surface-muted"
            onPointerDown={(event) => cursor.setSeconds(secondsAt(event, xMax))}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse") cursor.setSeconds(null);
            }}
            onPointerMove={(event) => cursor.setSeconds(secondsAt(event, xMax))}
          >
            <svg
              aria-label={ariaLabel}
              className="absolute inset-0 block h-full w-full overflow-visible"
              preserveAspectRatio="none"
              role="img"
              viewBox={`0 0 ${width} ${height}`}
            >
              {markers.map((marker) => (
                <line
                  className="stroke-muted"
                  key={marker.number}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                  x1={scale(marker.elapsedSeconds, xMax, width)}
                  x2={scale(marker.elapsedSeconds, xMax, width)}
                  y1={0}
                  y2={height}
                />
              ))}
              {series.map((line) => (
                <SeriesMarks key={line.label} line={line} xMax={xMax} yMax={yMax} />
              ))}
            </svg>
            {markers.map((marker) => (
              <span
                aria-hidden="true"
                className="absolute -top-2 grid size-4 -translate-x-1/2 place-items-center rounded-full bg-muted text-[10px] font-bold leading-none text-white"
                key={marker.number}
                style={{ left: `${percent(marker.elapsedSeconds)}%` }}
              >
                {marker.number}
              </span>
            ))}
            {cursorPercent === null ? null : (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 w-px bg-ink"
                  style={{ left: `${cursorPercent}%` }}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1 z-10 whitespace-nowrap rounded border border-border bg-surface px-1.5 py-1 text-[11px] leading-4 text-ink shadow-sm"
                  style={
                    cursorPercent > 60
                      ? { right: `calc(${100 - cursorPercent}% + 6px)` }
                      : { left: `calc(${cursorPercent}% + 6px)` }
                  }
                >
                  <span className="block text-muted">{formatSeconds(cursor.seconds ?? 0)}</span>
                  {readings.length === 0 ? (
                    <span className="block">No sample</span>
                  ) : (
                    readings.map((reading) => (
                      <span className="block font-semibold" key={reading.label}>
                        {series.length > 1 ? `${reading.label} ` : ""}
                        {formatNumber(reading.value)} {unit}
                      </span>
                    ))
                  )}
                </span>
              </>
            )}
          </div>
          <div aria-hidden="true" className="relative h-4 text-[11px] leading-4 text-muted">
            {axisTicks(xMax).map((tick) => (
              <span
                className="absolute top-0.5 -translate-x-1/2"
                key={tick}
                style={{ left: `${percent(tick)}%` }}
              >
                {formatSeconds(tick)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="sr-only">{series.map((line) => describeSeries(line, unit)).join(" ")}</p>
    </div>
  );
}

function SeriesMarks({ line, xMax, yMax }: { line: ChartSeries; xMax: number; yMax: number }) {
  const coordinates = line.points.map((point) => ({
    x: scale(point.elapsedSeconds, xMax, width),
    y: height - scale(point.value, yMax, height),
  }));
  if (coordinates.length === 1) {
    const [point] = coordinates;
    return <circle className={fillTone[line.tone]} cx={point?.x} cy={point?.y} r={4} />;
  }
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <>
      {line.area && coordinates.length > 0 ? (
        <path
          className="fill-accent/20"
          d={`M 0 ${height} L ${polyline.replaceAll(" ", " L ")} L ${width} ${height} Z`}
        />
      ) : null}
      <polyline
        className={`fill-none ${strokeTone[line.tone]}`}
        points={polyline}
        strokeWidth={2.5}
        vectorEffect="non-scaling-stroke"
      />
    </>
  );
}

function secondsAt(event: PointerEvent<HTMLElement>, xMax: number): number {
  const bounds = event.currentTarget.getBoundingClientRect();
  const fraction = (event.clientX - bounds.left) / Math.max(1, bounds.width);
  return Math.max(0, Math.min(1, fraction)) * xMax;
}
