import { evaluateCondition } from './plans.js';
import { IDLE_STATE_ID, IDLE_WORKFLOW_ID } from './state.js';

/**
 * Resolve a completed goal into the next workflow/state using the workflow
 * config's declarative transitions. Pure function: no state writes.
 *
 * @param {{ state: object, stateDef: object|null, workflowDef: object|null, signal: object }} input
 * @returns {{ nextWorkflow: string, nextState: string, loopIncrement: boolean, complete: boolean, matched: boolean }}
 */
export function resolveTransition({ state, stateDef, workflowDef, signal }) {
  const context = {
    goalCompleted: Boolean(signal && signal.goalCompleted),
    ...(signal || {}),
    staticPlan: state && state.staticPlan,
    dynamicPlan: state && state.dynamicPlan,
  };
  let target = null;
  for (const tr of (stateDef && stateDef.transitions) || []) {
    if (evaluateCondition(tr.when, context)) { target = tr; break; }
  }
  let nextWorkflow = state ? state.workflowId : IDLE_WORKFLOW_ID;
  let nextState = state ? state.phase : IDLE_STATE_ID;
  let loopIncrement = false;
  let complete = false;
  let matched = false;
  if (target) {
    matched = true;
    const to = target.to;
    if (typeof to === 'string') {
      nextState = to;
    } else if (to && typeof to === 'object') {
      nextWorkflow = to.workflow === '$self' ? nextWorkflow : to.workflow;
      nextState = to.state;
    }
    loopIncrement = Boolean(target.loop && target.loop.increment === 'iteration');
    complete = Boolean(target.complete);
  } else if (workflowDef && workflowDef.onComplete) {
    matched = true;
    nextWorkflow = workflowDef.onComplete.workflow || IDLE_WORKFLOW_ID;
    nextState = workflowDef.onComplete.state || IDLE_STATE_ID;
  }
  if (complete || nextWorkflow === IDLE_WORKFLOW_ID) {
    nextWorkflow = IDLE_WORKFLOW_ID;
    nextState = IDLE_STATE_ID;
  }
  return { nextWorkflow, nextState, loopIncrement, complete, matched };
}
