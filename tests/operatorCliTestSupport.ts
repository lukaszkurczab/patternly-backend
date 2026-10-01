import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type OperatorCliTlsFixture = Readonly<{
  origin: string;
  caCertificatePath: string;
  caCertificate: string;
  close(): Promise<void>;
}>;

export type OperatorCliTlsHandler = (request: IncomingMessage, response: ServerResponse) => void;

export async function createTlsFixture(handler: OperatorCliTlsHandler): Promise<OperatorCliTlsFixture> {
  const directory = await mkdtemp(join(tmpdir(), "patternly-operator-cli-tls-"));
  const caKeyPath = join(directory, "ca.key");
  const caCertificatePath = join(directory, "ca.pem");
  const serverKeyPath = join(directory, "server.key");
  const csrPath = join(directory, "server.csr");
  const serverCertificatePath = join(directory, "server.pem");
  const extensionPath = join(directory, "server.ext");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKeyPath, "-out", caCertificatePath, "-days", "1", "-subj", "/CN=Patternly Operator CLI Test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", serverKeyPath, "-out", csrPath, "-subj", "/CN=localhost"], { stdio: "ignore" });
    await writeFile(extensionPath, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n");
    execFileSync("openssl", ["x509", "-req", "-in", csrPath, "-CA", caCertificatePath, "-CAkey", caKeyPath, "-CAcreateserial", "-out", serverCertificatePath, "-days", "1", "-extfile", extensionPath], { stdio: "ignore" });
    const [key, cert, caCertificate] = await Promise.all([readFile(serverKeyPath), readFile(serverCertificatePath), readFile(caCertificatePath, "utf8")]);
    const server = createServer({ key, cert }, handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("operator_cli_tls_fixture_listen_failed");
    let closed = false;
    return Object.freeze({
      origin: `https://localhost:${address.port}`,
      caCertificatePath,
      caCertificate,
      close: async () => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
        await rm(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
