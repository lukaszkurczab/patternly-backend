export function storedAuthorizationGeneration(user: Readonly<Record<string, unknown>>): number {
  const generation = user.authorizationGeneration === undefined ? 1 : user.authorizationGeneration;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0) throw new Error("authorization_generation_invalid");
  return generation;
}

export function activeAuthorizationGeneration(user: Readonly<Record<string, unknown>>): number {
  if (user.deletedAt !== undefined || (user.authorizationState !== undefined && user.authorizationState !== "active")) throw new Error("account_deleted");
  return storedAuthorizationGeneration(user);
}

export function assertExpectedAuthorizationGeneration(user: Readonly<Record<string, unknown>>, expectedAuthorizationGeneration: number): void {
  if (expectedAuthorizationGeneration === undefined) throw new Error("authorization_generation_required");
  if (typeof expectedAuthorizationGeneration !== "number" || !Number.isSafeInteger(expectedAuthorizationGeneration) || expectedAuthorizationGeneration <= 0) throw new Error("authorization_generation_invalid");
  const currentGeneration = storedAuthorizationGeneration(user);
  if (currentGeneration !== expectedAuthorizationGeneration) throw new Error("authorization_generation_conflict");
  if (user.deletedAt !== undefined || (user.authorizationState !== undefined && user.authorizationState !== "active")) throw new Error("account_deleted");
}
