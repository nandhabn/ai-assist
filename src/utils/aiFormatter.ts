import { analyzeEventFlow, detectForms, extractAPIInfo, identifyTestPoints } from './flowAnalyzer';
import type { RecordedEvent, AIPromptResult } from '@/types/index';

export function prepareFlowForAI(flowData: { sessionId?: string; events?: RecordedEvent[] } ): AIPromptResult & {flowGraph?: any; forms?: any[]; apis?: any[]; testPoints?: any[]} {
  if (!flowData || !flowData.events || flowData.events.length === 0) {
    return {
      summary: 'No recorded events',
      structuredPrompt: '',
      metadata: {
        eventCount: 0,
        hasData: false,
      },
    } as any;
  }

  const events = flowData.events;
  const flowGraph = analyzeEventFlow(events);
  const forms = detectForms(events);
  const apis = extractAPIInfo(events);
  const testPoints = identifyTestPoints(events);

  const summary = generateSummary(events, flowGraph, forms, apis);

  const structuredPrompt = generateStructuredPrompt(events, flowGraph, forms, apis, testPoints);

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
    structuredPrompt,
    metadata,
    flowGraph,
    forms,
    apis,
    testPoints,
  } as any;
}

function generateSummary(events: any[], flowGraph: any, forms: any[], apis: any[]): string {
  const lines: string[] = [];

  lines.push('## User Journey Summary\n');

  if (flowGraph.stats.pageViews > 0) {
    lines.push(`- **Pages visited**: ${flowGraph.stats.pageViews}`);
  }

  if (flowGraph.stats.userActions > 0) {
    lines.push(`- **User actions**: ${flowGraph.stats.userActions} (clicks, inputs, submissions)`);
  }

  if (apis.length > 0) {
    const failedApis = apis.filter(a => a.status >= 400);
    if (failedApis.length > 0) {
      lines.push(`- **API calls**: ${apis.length} (${failedApis.length} failed with status >= 400)`);
    } else {
      lines.push(`- **API calls**: ${apis.length}`);
    }
  }

  if (forms.length > 0) {
    const totalFields = forms.reduce((sum: number, f: any) => sum + f.fields.length, 0);
    lines.push(`- **Forms**: ${forms.length} form(s) with ${totalFields} field(s)`);
  }

  const duration = calculateDuration(events);
  lines.push(`- **Duration**: ${Math.round(duration / 1000)} second(s)`);

  return lines.join('\n');
}

function generateStructuredPrompt(events: any[], flowGraph: any, forms: any[], apis: any[], testPoints: any[]): string {
  const sections: string[] = [];

  sections.push('# AI Test Generation Context\n');

  sections.push('## User Flow\n');
  sections.push('The user performed the following actions:\n');

  const actionEvents = events.filter(e => e.actionType === 'click' || e.actionType === 'input' || e.actionType === 'submit');

  actionEvents.slice(0, 20).forEach((event: any, idx: number) => {
    const meta = event.elementMetadata || {};
    const label = meta.innerText ? `"${meta.innerText.substring(0, 30)}"` : `${meta.tag}`;

    sections.push(`${idx + 1}. ${event.actionType.toUpperCase()} on ${label}`);

    if (event.selector?.css) {
      sections.push(`   - Selector: ${event.selector.css}`);
    }
  });

  if (actionEvents.length > 20) {
    sections.push(`... and ${actionEvents.length - 20} more actions`);
  }

  sections.push('');

  if (apis.length > 0) {
    sections.push('## API Endpoints Called\\n');

    const apiGroups: Record<string, {count:number; statuses:Set<number>}> = {};
    apis.forEach((api: any) => {
      const key = `${api.method} ${api.endpoint}`;
      if (!apiGroups[key]) apiGroups[key] = { count: 0, statuses: new Set() };
      apiGroups[key].count++;
      apiGroups[key].statuses.add(api.status);
    });

    Object.entries(apiGroups).forEach(([endpoint, info]) => {
      const statuses = [...info.statuses].join(', ');
      sections.push(`- ${endpoint} (${info.count}x, status: ${statuses})`);
    });

    sections.push('');
  }

  if (forms.length > 0) {
    sections.push('## Forms Detected\\n');

    forms.forEach((form: any, idx: number) => {
      sections.push(`### Form ${idx + 1}`);
      form.fields.forEach((field: any) => {
        sections.push(`- ${field.name} (${field.type || 'text'})`);
      });
      sections.push('');
    });
  }

  if (testPoints.length > 0) {
    sections.push('## Recommended Test Coverage\\n');

    testPoints.forEach((point: any) => {
      sections.push(`### ${point.type.replace(/_/g, ' ').toUpperCase()}`);
      sections.push(`Priority: ${point.priority}`);
      sections.push(`Description: ${point.description}`);
      sections.push(`Suggestion: ${point.suggestion}`);
      sections.push('');
    });
  }

  sections.push('## Code Generation Guidelines\\n');
  sections.push('Based on this user flow, generate:\n');
  sections.push('1. **Cypress Test Suite**: E2E tests that replicate this flow');
  sections.push('2. **Playwright Tests**: Cross-browser version of the flow');
  sections.push('3. **API Test Scenarios**: Tests for each API endpoint');
  sections.push('4. **Edge Cases**: Missing validation, negative cases');
  sections.push('5. **Error Scenarios**: Network failures, timeouts, error states');
  sections.push('6. **Auth Scenarios**: Session expiration, token refresh');

  return sections.join('\n');
}

function calculateDuration(events) {
  if (events.length === 0) return 0;

  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;

  return last - first;
}

export function exportFlowAsMarkdown(flowData) {
  const { summary, structuredPrompt, metadata } = flowData;

  const lines = [];

  lines.push(
    `# AI Flow Recorder Report - ${new Date().toISOString()}\n`
  );

  lines.push(`**Session ID**: ${metadata.sessionId}`);
  lines.push(`**Duration**: ${Math.round(metadata.duration / 1000)}s`);
  lines.push(
    `**Metrics**: ${metadata.pageCount} pages, ${metadata.actionCount} actions, ${metadata.apiCallCount} API calls\n`
  );

  lines.push(summary);

  lines.push('\n---\n');

  lines.push(structuredPrompt);

  return lines.join('\n');
}

export function exportFlowAsJSON(flowData) {
  return JSON.stringify(flowData, null, 2);
}
