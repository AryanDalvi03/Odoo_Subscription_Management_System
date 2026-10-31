import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
test('customer registration, local verification and catalog/profile portal work', async ({
  page,
}) => {
  test.setTimeout(90000);
  const email = `customer-${Date.now()}@example.test`;
  const password = 'CustomerTest!7193';
  await page.goto('/register');
  await page.getByLabel('Full name', { exact: true }).fill('Portal Customer');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  let link = '';
  await expect
    .poll(
      async () => {
        const files = await readdir('test-results/mail').catch(() => []);
        for (const file of files) {
          if (!file.endsWith('.eml')) continue;
          const mail = await readFile(`test-results/mail/${file}`, 'utf8');
          if (mail.includes(`To: ${email}`)) {
            link = mail.match(/http[^\s]+/)?.[0] ?? '';
            return Boolean(link);
          }
        }
        return false;
      },
      { timeout: 45000, intervals: [500, 1000] },
    )
    .toBe(true);
  await page.goto(link);
  await page.getByRole('button', { name: 'Verify email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Email verified');
  await page.goto('/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Good to see you, Portal.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff management', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Available plans', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find your next plan.' })).toBeVisible();
  await page.getByRole('link', { name: 'My profile', exact: true }).click();
  await page.getByLabel('Company', { exact: true }).fill('Customer Company');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Profile updated', { exact: true })).toBeVisible();
  await page.goto('/app/staff');
  await expect(page.getByRole('heading', { name: 'Access restricted' })).toBeVisible();
});
