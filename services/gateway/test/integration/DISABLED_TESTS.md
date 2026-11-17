# Disabled integration tests

One suite in this folder does not run: `test/integration/gateway-startup.test.ts`. `jest.config.json` excludes it under `testPathIgnorePatterns`.

## Why

The suite starts a real gateway and a real admin service as child processes. Each test case took 30 seconds or more, the start often timed out, and the processes left ports occupied and logged after the test had ended.

## To bring it back

- Replace the spawned processes with mocks or injected dependencies where the test is about one behaviour, not about the whole start.
- Where a real process is needed, take its port from `getAvailablePorts()` in `libs/test-utils/src/port-utils.ts` and stop the process with a bounded wait.
- Split large cases into small ones.

`test/integration/e2e-config-test.test.ts` was changed that way: it checks the configuration channel on Valkey without starting the services.

Two more suites were excluded for the same reason, `configuration-lifecycle.test.ts` and `startup-behavior.test.ts`. They have since been deleted.
