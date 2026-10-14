// The handler only uses waitUntil in these tests; runtime-only properties are not exercised.
export function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}
