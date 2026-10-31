import { test, expect } from '@playwright/test';
test('workspace and architecture navigation work on desktop and mobile', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/infrastructure');
  await expect(page.getByRole('heading', { name: 'Your subscription workspace.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeVisible();
  await page.getByRole('link', { name: 'Architecture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'One platform. Three services.' })).toBeVisible();
  await page.goto('/infrastructure');
  await expect(page.getByRole('heading', { name: 'Service health' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Your subscription workspace.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
test('real infrastructure readiness flows through API to screen', async ({ page, request }) => {
  const response = await request.get('http://127.0.0.1:4100/api/health/ready');
  expect(response.status()).toBe(200);
  expect((await response.json()).data.checks).toEqual({
    database: true,
    redis: true,
    transactions: true,
    worker: true,
  });
  await page.goto('/infrastructure');
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(4);
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByText('Service status refreshed')).toBeVisible();
  await page.screenshot({ path: 'test-results/foundation-desktop.png', fullPage: true });
});
test('API outage shows a useful error instead of fabricated health', async ({ page }) => {
  await page.route('**/api/health/ready', (route) => route.abort());
  await page.goto('/infrastructure');
  await expect(page.getByRole('alert')).toContainText('The API is unreachable');
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
});
