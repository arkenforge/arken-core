export interface DecisionLine {
  ts: string;
  agent: string | null;
  tool: string;
  decision_inputs: {
    revoked: boolean;
    count: number;
    limit: number;
    window_s: number;
  };
  would_block: boolean;
  duration_ms: number;
}

export type LogSink = (line: string) => void;

/** stderr, not stdout: on stdio MCP servers stdout is the protocol channel. */
export const stderrSink: LogSink = (line) => {
  process.stderr.write(line + '\n');
};

/**
 * Serialise exactly the fields above. Built field by field so nothing else
 * (arguments, tokens, auth data) can ever reach the log.
 */
export function formatLine(line: DecisionLine): string {
  const { revoked, count, limit, window_s } = line.decision_inputs;
  return JSON.stringify({
    ts: line.ts,
    agent: line.agent,
    tool: line.tool,
    decision_inputs: { revoked, count, limit, window_s },
    would_block: line.would_block,
    duration_ms: line.duration_ms,
  });
}
