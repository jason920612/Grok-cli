#!/usr/bin/env node
import { main } from "./cli.js";

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(() => {
    // By here every CLI path — one-shot or interactive — has fully completed
    // (interactive returns only after the session/server is torn down). The xAI
    // provider talks over global fetch (undici), whose keep-alive sockets stay
    // ref'd and can hold the event loop open for minutes after the work is done
    // (the connection lingers up to the server's keep-alive hint). Exit
    // explicitly once stdout has flushed so the process ends promptly instead of
    // hanging idle.
    const code = process.exitCode ?? 0;
    if (process.stdout.writableLength === 0) process.exit(code);
    else process.stdout.once("drain", () => process.exit(code));
  });
