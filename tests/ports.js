// Fixed test ports are 4840-4859. Set MERDIENZ_TEST_PORT_OFFSET to move every port the
// suite binds by the same amount, so several checkouts can run tests side by side.
const raw = process.env.MERDIENZ_TEST_PORT_OFFSET || '0';
const OFFSET = Number(raw);
if (!Number.isInteger(OFFSET) || OFFSET < 0 || OFFSET > 60000) {
  throw new Error('MERDIENZ_TEST_PORT_OFFSET must be a non-negative integer');
}

export function tp(port) {
  return port + OFFSET;
}
