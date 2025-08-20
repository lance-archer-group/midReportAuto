import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://portal.elevateqs.com/login.aspx?ReturnUrl=%2f');
  await page.getByRole('textbox', { name: 'Username' }).click();
  await page.getByRole('textbox', { name: 'Username' }).fill('LanceArcher');
  await page.getByRole('textbox', { name: 'Password' }).click();
  await page.getByRole('textbox', { name: 'Password' }).fill('R9TAwJ4b!L!wCJK');
  await page.getByRole('button', { name: 'Login' }).click();
  await page.getByRole('textbox', { name: 'Passcode' }).click();
  await page.getByRole('textbox', { name: 'Passcode' }).fill('839659');
  await page.getByRole('button', { name: ' Verify code' }).click();
  await page.getByText('Query System').click();
  await page.getByRole('link', { name: ' Advanced Reporting' }).click();
  await page.getByRole('link', { name: 'Net ACH Details' }).click();
  await page.getByRole('textbox', { name: 'Search by MID/Name' }).click();
  await page.getByRole('textbox', { name: 'Search by MID/Name' }).fill('1');
  await page.getByText('840100065415 -').click();
  await page.locator('#fileDateStart').click();
  await page.locator('#fileDateStart').fill('08/12/2025');
  await page.locator('#fileDateEnd').click();
  await page.locator('#fileDateEnd').fill('08/19/2025');
  await page.getByRole('button', { name: 'Load report' }).click();
  await page.goto('https://portal.elevateqs.com/Reporting/Report.aspx?sort=1&sortDirection=2&mainIdentType=MID&mainIdentVal=840100065415&fileDateStart=08/12/2025&fileDateEnd=08/19/2025&reportID=25');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: ' Export' }).click();
  const download = await downloadPromise;
});