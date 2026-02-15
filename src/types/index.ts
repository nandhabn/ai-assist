export const ACTION_TYPES = {
  CLICK: 'click',
  INPUT: 'input',
  SUBMIT: 'submit',
  API_CALL: 'api_call',
  ROUTE_CHANGE: 'route_change',
} as const;

export const ELEMENT_TYPES = {
  BUTTON: 'button',
  INPUT: 'input',
  FORM: 'form',
  LINK: 'a',
  DIV: 'div',
  SPAN: 'span',
} as const;

export const API_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH',
} as const;

export type ActionType = typeof ACTION_TYPES[keyof typeof ACTION_TYPES];

export interface ElementMetadata {
  tag: string;
  id?: string;
  className?: string;
  innerText?: string;
  name?: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  dataTestId?: string;
  parentForm?: string | null;
}

export interface Selector {
  css?: string;
  xpath?: string;
}

export interface APIDetails {
  method: string;
  endpoint: string;
  payload?: any;
  status?: number;
  duration?: number;
}

export interface RecordedEvent {
  sessionId: string;
  timestamp: number;
  url: string;
  route: string;
  actionType: ActionType | string;
  elementMetadata?: ElementMetadata;
  selector?: Selector;
  apiDetails?: APIDetails;
}

export interface FlowNode {
  id: string;
  type: string;
  label?: string;
  metadata?: Record<string, any>;
}

export interface FlowEdge {
  from: string;
  to: string;
  type?: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Flow {
  sessionId: string;
  flowGraph: FlowGraph;
  apiCalls: APIDetails[];
  formsDetected: any[];
  possibleTestPoints: any[];
}

export interface AIPromptResult {
  summary: string;
  structuredPrompt: string;
  metadata: Record<string, any>;
}
