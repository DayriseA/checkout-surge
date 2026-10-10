/**
 * Fly's refusal to reserve a host's resources for a Machine. The deploy script has no dependencies,
 * so it matches only the observed phrases of the shared classifier (`packages/fly-machines`).
 */
export function isCapacityRefusal(error) {
  return (
    error.status === 409 &&
    /could not reserve resource|insufficient \w+ available/i.test(error.message)
  );
}
