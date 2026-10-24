/* Stable CLI/API entry used by installed tasks and existing integrations. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge } from "../modules/runtime/bridge-server.mjs";
export { createBridge };
export { makeMcpServer } from "../modules/translation/mcp-server.mjs";
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory = resolve(
    process.env.OTTDECK_BRIDGE_DIR ||
      process.env.OTTSPEED_BRIDGE_DIR ||
      "private-subtitles/bridge",
  );
  const port = Number(
    process.env.OTTDECK_BRIDGE_PORT ||
      process.env.OTTSPEED_BRIDGE_PORT ||
      43127,
  );
  await createBridge({
    directory,
    port,
    extensionId:
      process.env.OTTDECK_EXTENSION_ID ||
      process.env.OTTSPEED_EXTENSION_ID ||
      "hegbpfhcjpghhhnmnjjedibpfblchefh",
  });
  console.log(
    "OTTDeck bridge listening at http://127.0.0.1:" +
      port +
      "; private storage: " +
      directory,
  );
}
