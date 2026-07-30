import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${message}\nPresiona Enter para continuar...`);
  } finally {
    rl.close();
  }
}

export async function askText(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(`${message}: `);
  } finally {
    rl.close();
  }
}

export async function askConfirmation(message: string, expected: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message}\nEscribi ${expected} para continuar: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}
