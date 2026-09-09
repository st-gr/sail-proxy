// formatter.contextWindow delegates to this module; formatter.ts itself pulls in
// sap/ui/core/IconPool, which this app's jest setup cannot resolve (see contextWindow.ts).
import { contextWindow } from '../webapp/model/contextWindow';
// G: the library tile's deployment/retirement badges live in their own module for the same reason.
import { isDeployed, isDeployment, retires, deploymentOnly, notCallable } from '../webapp/model/deploymentBadge';

describe('contextWindow', () => {
  it('renders thousands with a k suffix', () => {
    expect(contextWindow(200000)).toBe('200k');
  });
  it('accepts the type-formatted string an OData binding hands over', () => {
    expect(contextWindow('200,000')).toBe('200k');
    expect(contextWindow('1,048,576')).toBe('1049k');
  });
  it('is empty for missing values', () => {
    expect(contextWindow(null)).toBe('');
    expect(contextWindow('')).toBe('');
  });
});

describe('deployment badges', () => {
  const deployed = { 'anthropic--claude-4-sonnet': true };
  it('marks a foundation model whose deployment sibling exists', () => {
    expect(isDeployed('anthropic--claude-4-sonnet', 'foundation', deployed)).toBe(true);
    expect(isDeployed('openai--gpt-5', 'foundation', deployed)).toBe(false);
  });
  it('never marks a deployment row as deployed, and survives a missing map', () => {
    expect(isDeployed('anthropic--claude-4-sonnet', 'deployment', deployed)).toBe(false);
    expect(isDeployed('anthropic--claude-4-sonnet', 'foundation', undefined)).toBe(false);
    expect(isDeployed(null, 'foundation', deployed)).toBe(false);
  });
  it('recognises a deployment row', () => {
    expect(isDeployment('deployment')).toBe(true);
    expect(isDeployment('foundation')).toBe(false);
    expect(isDeployment(null)).toBe(false);
  });
});

describe('retires', () => {
  it('prefixes the ISO date the binding hands over with targetType any', () => {
    expect(retires('2026-12-31')).toBe('Retires 2026-12-31');
    expect(retires('2026-12-31T00:00:00Z')).toBe('Retires 2026-12-31');
    expect(retires(new Date(Date.UTC(2026, 11, 31)))).toBe('Retires 2026-12-31');
  });
  it('passes an already type-formatted date through', () => {
    expect(retires('Dec 31, 2026')).toBe('Retires Dec 31, 2026');
  });
  it('is empty for missing values', () => {
    expect(retires(null)).toBe('');
    expect(retires('')).toBe('');
    expect(retires('   ')).toBe('');
  });
});

// M: a foundation model without the orchestration scenario is callable only through its own
// deployment ("Deployment only"); one SAP allows neither scenario for is "Not callable".
describe('deploymentOnly', () => {
  it('marks a foundation row with LLM Access but no orchestration', () => {
    expect(deploymentOnly('foundation', true, false)).toBe(true);
    expect(deploymentOnly('foundation', true, null)).toBe(true);
  });
  it('leaves an orchestration-capable or a scenario-less model alone', () => {
    expect(deploymentOnly('foundation', true, true)).toBe(false);
    expect(deploymentOnly('foundation', false, true)).toBe(false);
    expect(deploymentOnly('foundation', false, false)).toBe(false);
  });
  it('never marks a deployment row, which is callable by definition', () => {
    expect(deploymentOnly('deployment', true, false)).toBe(false);
  });
});

describe('notCallable', () => {
  it('marks a foundation row with neither scenario', () => {
    expect(notCallable('foundation', false, false)).toBe(true);
    expect(notCallable('foundation', null, null)).toBe(true);
  });
  it('leaves a model with either scenario alone', () => {
    expect(notCallable('foundation', true, false)).toBe(false);
    expect(notCallable('foundation', false, true)).toBe(false);
  });
  it('never marks a deployment row', () => {
    expect(notCallable('deployment', false, false)).toBe(false);
  });
});
