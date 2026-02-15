import { ACTION_TYPES } from '@/types/index';
import type { RecordedEvent, FlowNode, FlowEdge } from '@/types/index';

export function analyzeEventFlow(events: RecordedEvent[] | any[]) {
  if (!events || events.length === 0) {
    return {
      nodes: [] as FlowNode[],
      edges: [] as FlowEdge[],
      stats: {
        totalEvents: 0,
        pageViews: 0,
        userActions: 0,
        apiCalls: 0,
      },
    };
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let nodeId = 0;

  const routeNodes = new Map<string, string>();
  const actionNodes: string[] = [];
  let lastPageNode: string | null = null;

  events.forEach((event) => {
    if (event.actionType === ACTION_TYPES.ROUTE_CHANGE) {
      const routeKey = event.route;

      if (!routeNodes.has(routeKey)) {
        const id = `page_${nodeId++}`;
        routeNodes.set(routeKey, id);

        nodes.push({
          id,
          type: 'page',
          label: event.route || '/',
          metadata: {
            url: event.url,
            timestamp: event.timestamp,
          },
        });

        if (lastPageNode) {
          edges.push({ from: lastPageNode, to: id, type: 'transition' });
        }

        lastPageNode = id;
      }
    }

    if (
      event.actionType === ACTION_TYPES.CLICK ||
      event.actionType === ACTION_TYPES.INPUT ||
      event.actionType === ACTION_TYPES.SUBMIT
    ) {
      const actionId = `action_${nodeId++}`;

      nodes.push({
        id: actionId,
        type: 'action',
        label: getActionLabel(event),
        metadata: {
          actionType: event.actionType,
          element: event.elementMetadata,
          selector: event.selector,
          timestamp: event.timestamp,
        },
      });

      actionNodes.push(actionId);

      if (lastPageNode) {
        edges.push({ from: lastPageNode, to: actionId, type: 'action' });
      }

      if (actionNodes.length > 1) {
        edges.push({ from: actionNodes[actionNodes.length - 2], to: actionId, type: 'sequence' });
      }
    }

    if (event.actionType === ACTION_TYPES.API_CALL) {
      const apiId = `api_${nodeId++}`;

      nodes.push({
        id: apiId,
        type: 'api',
        label: `${event.apiDetails.method} ${event.apiDetails.endpoint}`,
        metadata: {
          method: event.apiDetails.method,
          endpoint: event.apiDetails.endpoint,
          status: event.apiDetails.status,
          duration: event.apiDetails.duration,
          timestamp: event.timestamp,
        },
      });

      if (actionNodes.length > 0) {
        edges.push({ from: actionNodes[actionNodes.length - 1], to: apiId, type: 'triggers' });
      }
    }
  });

  return {
    nodes,
    edges,
    stats: {
      totalEvents: events.length,
      pageViews: routeNodes.size,
      userActions: actionNodes.length,
      apiCalls: nodes.filter(n => n.type === 'api').length,
    },
  };
}

function getActionLabel(event: any): string {
  const meta = event.elementMetadata || {};

  if (meta.innerText) return meta.innerText.substring(0, 40);
  if (meta.ariaLabel) return meta.ariaLabel.substring(0, 40);
  if (meta.id) return `${event.actionType} #${meta.id}`;
  if (meta.name) return `${event.actionType} [${meta.name}]`;
  return `${event.actionType} ${meta.tag}`;
}

export function detectForms(events: any[]) {
  const forms = new Map<string, any>();

  events.forEach((event) => {
    if (event.actionType === ACTION_TYPES.SUBMIT || event.actionType === ACTION_TYPES.INPUT) {
      const parentForm = event.elementMetadata?.parentForm;
      if (!parentForm) return;

      if (!forms.has(parentForm)) {
        forms.set(parentForm, {
          id: parentForm,
          fields: [],
          timestamp: event.timestamp,
        });
      }

      if (event.actionType === ACTION_TYPES.INPUT) {
        const form = forms.get(parentForm);
        form.fields.push({
          name: event.elementMetadata.name,
          type: event.elementMetadata.type,
          timestamp: event.timestamp,
        });
      }
    }
  });

  return Array.from(forms.values());
}

export function extractAPIInfo(events: any[]) {
  return events
    .filter(e => e.actionType === ACTION_TYPES.API_CALL)
    .map(e => ({
      method: e.apiDetails.method,
      endpoint: e.apiDetails.endpoint,
      status: e.apiDetails.status,
      duration: e.apiDetails.duration,
      timestamp: e.timestamp,
    }));
}

export function identifyTestPoints(events: any[]) {
  const testPoints: any[] = [];

  const apiCalls = events.filter(e => e.actionType === ACTION_TYPES.API_CALL);
  const submissions = events.filter(e => e.actionType === ACTION_TYPES.SUBMIT);
  const routes = events.filter(e => e.actionType === ACTION_TYPES.ROUTE_CHANGE);

  if (submissions.length > 0) {
    testPoints.push({
      type: 'form_validation',
      priority: 'high',
      description: `Test form validation for ${submissions.length} form(s)`,
      suggestion: 'Test with empty fields, invalid formats, and edge cases',
    });
  }

  if (apiCalls.length > 0) {
    const failedCalls = apiCalls.filter(e => e.apiDetails.status >= 400);

    testPoints.push({
      type: 'api_behavior',
      priority: 'high',
      description: `Test ${apiCalls.length} API endpoint(s)`,
      suggestion: `Test normal flow, network errors, and timeouts. ${failedCalls.length} failed calls detected.`,
    });
  }

  if (routes.length > 1) {
    testPoints.push({
      type: 'navigation_flow',
      priority: 'medium',
      description: `Test navigation across ${routes.length} page(s)`,
      suggestion: 'Verify page transitions and state persistence',
    });
  }

  const hasAuthActions = events.some(
    e =>
      e.elementMetadata?.ariaLabel?.toLowerCase().includes('login')
      || e.elementMetadata?.ariaLabel?.toLowerCase().includes('signin')
  );

  if (hasAuthActions) {
    testPoints.push({
      type: 'auth_flow',
      priority: 'high',
      description: 'Test authentication flow',
      suggestion: 'Test login, logout, session expiration, and token refresh',
    });
  }

  const inputEvents = events.filter(e => e.actionType === ACTION_TYPES.INPUT);
  if (inputEvents.length > 0) {
    testPoints.push({
      type: 'user_input',
      priority: 'medium',
      description: `Test ${inputEvents.length} user input field(s)`,
      suggestion:
        'Test with various inputs, special characters, and boundary values',
    });
  }

  return testPoints;
}
