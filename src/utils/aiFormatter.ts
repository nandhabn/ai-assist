import {
  analyzeEventFlow,
  detectForms,
  extractAPIInfo,
  identifyTestPoints,
} from "./flowAnalyzer";
import type { RecordedEvent } from "../types/index";

/**
 * A backend-agnostic package containing all processed data for a recorded flow.
 * This is the payload that will be sent to the secure backend proxy.
 */
export interface FlowDataPackage {
  summary: string;
  flowGraph: any;
  forms: any[];
  apis: any[];
  testPoints: any[];
  metadata: Record<string, any>;
  events: RecordedEvent[];
}

/**
 * Analyzes and packages recorded event data into a structured, backend-agnostic format.
 * It no longer calls an AI service directly.
 * @param flowData The raw recorded flow data.
 * @returns A structured package of flow data, or null if no data is present.
 */
export function prepareFlowData(flowData: {
  sessionId?: string;
  events?: RecordedEvent[];
}): FlowDataPackage | null {
  if (!flowData || !flowData.events || flowData.events.length === 0) {
    return null;
  }

  const events = flowData.events;
  const flowGraph = analyzeEventFlow(events);
  const forms = detectForms(events);
  const apis = extractAPIInfo(events);
  const testPoints = identifyTestPoints(events);

  const summary = generateSummary(events, flowGraph, forms, apis);

  const metadata = {
    sessionId: flowData.sessionId,
    eventCount: events.length,
    duration: calculateDuration(events),
    pageCount: flowGraph.stats.pageViews,
    actionCount: flowGraph.stats.userActions,
    apiCallCount: flowGraph.stats.apiCalls,
    formCount: forms.length,
    timestamp: Date.now(),
  };

  return {
    summary,
    flowGraph,
    forms,
    apis,
    testPoints,
    metadata,
    events, // Include the raw events for the backend to process
  };
}

function generateSummary(
  events: any[],
  flowGraph: any,
  forms: any[],
  apis: any[],
): string {
  const lines: string[] = [];

  lines.push("## User Journey Summary\n");

  if (flowGraph.stats.pageViews > 0) {
    lines.push(`- **Pages visited**: ${flowGraph.stats.pageViews}`);
  }

  if (flowGraph.stats.userActions > 0) {
    lines.push(
      `- **User actions**: ${flowGraph.stats.userActions} (clicks, inputs, submissions)`,
    );
  }

  if (apis.length > 0) {
    const failedApis = apis.filter((a) => a.status >= 400);
    if (failedApis.length > 0) {
      lines.push(
        `- **API calls**: ${apis.length} (${failedApis.length} failed with status >= 400)`,
      );
    } else {
      lines.push(`- **API calls**: ${apis.length}`);
    }
  }

  if (forms.length > 0) {
    const totalFields = forms.reduce(
      (sum: number, f: any) => sum + f.fields.length,
      0,
    );
    lines.push(
      `- **Forms**: ${forms.length} form(s) with ${totalFields} field(s)`,
    );
  }

  const duration = calculateDuration(events);
  lines.push(`- **Duration**: ${Math.round(duration / 1000)} second(s)`);

  return lines.join("\n");
}

function calculateDuration(events: RecordedEvent[]): number {
  if (events.length === 0) return 0;

  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;

  return last - first;
}

export function exportFlowAsMarkdown(flowData: FlowDataPackage) {
  if (!flowData) return "No data to export.";

  const { summary, metadata } = flowData;

  const lines = [];

  lines.push(
    `# AI Flow Recorder Report - ${new Date(metadata.timestamp).toISOString()}\n`,
  );

  lines.push(`**Session ID**: ${metadata.sessionId}`);
  lines.push(`**Duration**: ${Math.round(metadata.duration / 1000)}s`);
  lines.push(
    `**Metrics**: ${metadata.pageCount} pages, ${metadata.actionCount} actions, ${metadata.apiCallCount} API calls\n`,
  );

  lines.push(summary);

  lines.push("\n---\n");
  lines.push("### Raw Events Summary\n");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      flowData.events
        .slice(0, 10)
        .map((e) => ({
          action: e.actionType,
          url: e.url,
          selector: e.selector?.css,
        })),
      null,
      2,
    ),
  );
  lines.push("```");

  return lines.join("\n");
}

export function exportFlowAsJSON(flowData: FlowDataPackage) {
  return JSON.stringify(flowData, null, 2);
}
