import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { registerEntitySecretCiphertext } from "@circle-fin/developer-controlled-wallets";

const apiKey: string | undefined = process.env.CIRCLE_API_KEY;
if (!apiKey) {
  throw new Error("CIRCLE_API_KEY is required. Set it in .env first.");
}

// Refuse to overwrite an existing entity secret in .env. An empty
// placeholder (e.g. copied from .env.example) does not count as set.
const existingEnv: string = existsSync(".env")
  ? readFileSync(".env", "utf8")
  : "";
const existingMatch: RegExpMatchArray | null =
  existingEnv.match(/^CIRCLE_ENTITY_SECRET=(.*)$/m);
if (existingMatch?.[1]?.trim()) {
  throw new Error(
    "CIRCLE_ENTITY_SECRET already exists in .env. Refusing to overwrite it.",
  );
}

// Generate a 32-byte entity secret. The SDK's generateEntitySecret() helper
// prints to stdout but doesn't return the value, so use crypto directly.
const entitySecret: string = randomBytes(32).toString("hex");
const recoveryFilePath: string = "./recovery";

mkdirSync(recoveryFilePath, { recursive: true });

await registerEntitySecretCiphertext({
  apiKey,
  entitySecret,
  recoveryFileDownloadPath: recoveryFilePath,
});

// For production, prefer a secrets manager over .env.
if (/^CIRCLE_ENTITY_SECRET=.*$/m.test(existingEnv)) {
  writeFileSync(
    ".env",
    existingEnv.replace(
      /^CIRCLE_ENTITY_SECRET=.*$/m,
      `CIRCLE_ENTITY_SECRET=${entitySecret}`,
    ),
  );
} else {
  appendFileSync(".env", `\nCIRCLE_ENTITY_SECRET=${entitySecret}\n`);
}

console.log("Entity secret registered.");
console.log(`Recovery file saved to a new file in: ${recoveryFilePath}`);
console.log("CIRCLE_ENTITY_SECRET added to .env");