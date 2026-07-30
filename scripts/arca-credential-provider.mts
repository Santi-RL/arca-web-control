import { describeCredentialProvider, loadCredentialProviderSelection, saveCredentialProviderSelection } from "../src/config/credentialProvider.js";
import { ensureRuntimeLayout } from "../src/config/runtimePaths.js";

const runtime = await ensureRuntimeLayout();
const [operation, provider, file] = process.argv.slice(2);

if (operation === "show" && provider === undefined) {
  console.log(JSON.stringify(describeCredentialProvider(loadCredentialProviderSelection(runtime)), null, 2));
} else if (operation === "set" && provider === "windows" && file === undefined) {
  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "windows" });
  console.log("CREDENTIAL_PROVIDER=windows");
} else if (operation === "set" && provider === "json-file" && file) {
  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file });
  console.log("CREDENTIAL_PROVIDER=json-file");
} else {
  throw new Error("Uso: arca:credentials:provider -- show | set windows | set json-file <ruta-absoluta-json>");
}
