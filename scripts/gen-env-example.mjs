#!/usr/bin/env node
// Regenerates .env.example from the preferences declared in package.json,
// so the env file and the Raycast preferences UI never drift apart.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const envKey = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

let out = `# Homelab for Raycast — env file
#
# Copy to ~/.config/raycast-homelab/.env (or point the "Env File" preference elsewhere).
# Every key here has a matching field in Raycast → Extensions → Homelab; a value set
# in the Raycast UI always wins over this file. Leave a service out to hide it.
#
# Generated from package.json by: npm run gen:env
`;

for (const p of pkg.preferences) {
  if (p.name === "configFile") continue;
  const secret = p.type === "password";
  const example = p.placeholder && !secret ? `  (e.g. ${p.placeholder})` : "";
  out += `\n# ${p.title}${secret ? " (secret)" : ""}${example}\n# ${p.description}\n${envKey(p.name)}=\n`;
}
writeFileSync(new URL("../.env.example", import.meta.url), out);
console.log(`.env.example: ${pkg.preferences.length - 1} keys`);
