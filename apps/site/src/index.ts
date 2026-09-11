#!/usr/bin/env node
import { createSiteServer } from "./server.js";

function main(): void {
  const port = Number(process.env["EXEC_SITE_PORT"] ?? 4318);
  const host = process.env["EXEC_SITE_HOST"] ?? "127.0.0.1";

  const server = createSiteServer();
  server.listen(port, host, () => {
    console.log(`Praktor site: http://${host}:${port}`);
  });
}

main();
