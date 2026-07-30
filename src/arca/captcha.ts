import { Page } from "playwright";
import { waitForEnter } from "../io/prompt.js";
import { FlowContext } from "./flowContext.js";

export async function isCaptchaVisible(page: Page): Promise<boolean> {
  const captchaSignals = [
    page.locator("iframe[src*='captcha']"),
    page.locator("iframe[title*='captcha' i]"),
    page.locator("text=/captcha/i"),
    page.locator("input[name*='captcha' i]"),
    page.locator("[id*='captcha' i]"),
    page.locator("[class*='captcha' i]"),
  ];

  for (const signal of captchaSignals) {
    if (await signal.first().isVisible().catch(() => false)) {
      return true;
    }
  }

  return false;
}

export async function pauseIfCaptcha(page: Page, context?: Pick<FlowContext, "manualIntervention">): Promise<void> {
  if (await isCaptchaVisible(page)) {
    if (context?.manualIntervention === false) {
      throw new Error("ARCA esta solicitando captcha. Esta sesion no permite intervencion manual; reinicia en modo visible/guiado.");
    }

    await waitForEnter("ARCA esta solicitando captcha. Completalo manualmente en el navegador.");
  }
}
