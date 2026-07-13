/** Incremental newline framing with a discard-until-newline overflow policy. */
export class K6JsonLineFramer {
  private readonly maxLineLength: number;
  private lineBuffer = "";
  private discardingOversizedLine = false;

  constructor(options: { maxLineLength?: number } = {}) {
    this.maxLineLength = options.maxLineLength ?? 64 * 1_024;
    if (!Number.isInteger(this.maxLineLength) || this.maxLineLength <= 0) {
      throw new Error("k6 maxLineLength must be a positive integer.");
    }
  }

  push(chunk: string): string[] {
    const lines: string[] = [];
    let offset = 0;

    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf("\n", offset);
      const hasNewline = newlineIndex >= 0;
      const segmentEnd = hasNewline ? newlineIndex : chunk.length;
      const segment = chunk.slice(offset, segmentEnd);

      if (!this.discardingOversizedLine) {
        if (this.lineBuffer.length + segment.length <= this.maxLineLength) {
          this.lineBuffer += segment;
        } else {
          this.lineBuffer = "";
          this.discardingOversizedLine = true;
        }
      }

      if (!hasNewline) break;
      if (!this.discardingOversizedLine) lines.push(stripTrailingCarriageReturn(this.lineBuffer));
      this.lineBuffer = "";
      this.discardingOversizedLine = false;
      offset = newlineIndex + 1;
    }

    return lines;
  }

  finish(): string[] {
    if (this.discardingOversizedLine || this.lineBuffer.length === 0) {
      this.lineBuffer = "";
      this.discardingOversizedLine = false;
      return [];
    }
    const line = stripTrailingCarriageReturn(this.lineBuffer);
    this.lineBuffer = "";
    return [line];
  }

  retainedCharacterCount(): number {
    return this.lineBuffer.length;
  }
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
