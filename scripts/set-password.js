/*
 * Adds an admin, or resets a forgotten password:  npm run set-password -- <username>
 * Resetting signs that admin out everywhere.
 */

import readline from 'node:readline/promises';
import { passwordProblem, setAdminPassword } from '../src/auth.js';

const username = process.argv[2]?.trim();
if (!username) {
  console.error('Usage: npm run set-password -- <username>');
  process.exit(1);
}

const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
const password = await prompt.question(`New password for ${username}: `);
prompt.close();

const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}
await setAdminPassword(username, password);
console.log(`Password set for ${username}.`);
