import { Page } from "playwright";
import { FlowContext } from "./flowContext.js";
import { CaptchaRequiredError } from "./captchaErrors.js";

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

export async function pauseIfCaptcha(page: Page, _context?: Pick<FlowContext, "manualIntervention">): Promise<void> {
  if (await isCaptchaVisible(page)) {
    throw new CaptchaRequiredError();
  }
}
