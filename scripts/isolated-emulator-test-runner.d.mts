export function validateIsolatedEmulatorConfiguration(config: unknown, projectId: string): void;

export function runIsolatedEmulatorTests(options: Readonly<{
  backendRoot: string;
  projectId: string;
  command: string;
  environment?: Readonly<Record<string, string>>;
}>): Promise<number>;
