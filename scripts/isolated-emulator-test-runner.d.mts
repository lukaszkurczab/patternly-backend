export function resolveIsolatedEmulatorPorts(baseValue?: string): Readonly<{ auth: number; firestore: number; hub: number; logging: number }>;

export function validateIsolatedEmulatorConfiguration(
  config: unknown,
  projectId: string,
  ports?: Readonly<{ auth: number; firestore: number; hub: number; logging: number }>,
): void;

export function validateIsolatedEmulatorRuntime(
  environment: Readonly<Record<string, string | undefined>>,
  projectId: string,
  ports?: Readonly<{ auth: number; firestore: number; hub: number; logging: number }>,
): void;

export function runIsolatedEmulatorTests(options: Readonly<{
  backendRoot: string;
  projectId: string;
  command: string;
  environment?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}>): Promise<number>;
