import { expect, test, type Page } from '@playwright/test';

// The sidebar and the main content share button labels ("Tasks", "New note", "All places"),
// so every interaction is scoped to one region or the other.
const sidebar = (page: Page) => page.getByRole('complementary');
const content = (page: Page) => page.getByRole('article');

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username' }).fill(process.env.NOTES_TEST_USERNAME ?? 'admin');
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.NOTES_TEST_PASSWORD ?? 'Delivery2026!');
  await page.getByRole('button', { name: 'Sign in with password' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening),/ })).toBeVisible();
}

test('user can sign in and use the primary workspace navigation', async ({ page }) => {
  await signIn(page);

  await sidebar(page).getByRole('button', { name: 'Today' }).click();
  await expect(page.getByLabel('Today journal')).toBeVisible();

  await sidebar(page).getByRole('button', { name: 'Tasks' }).click();
  await expect(content(page).getByRole('heading', { name: 'Tasks' }).first()).toBeVisible();

  await sidebar(page).getByRole('button', { name: 'Summaries' }).click();
  await expect(page.getByRole('heading', { name: 'Period Summaries' })).toBeVisible();
});

test('user can create a place, a notebook, and file a note inside it', async ({ page }) => {
  const stamp = Date.now();
  const placeName = `Smoke place ${stamp}`;
  const notebookName = `Smoke notebook ${stamp}`;
  const title = `Smoke note ${stamp}`;

  await signIn(page);

  await sidebar(page).getByRole('button', { name: 'All places' }).click();
  await content(page).getByRole('button', { name: 'New place' }).click();
  await page.getByLabel('Place name').fill(placeName);
  await page.getByRole('button', { name: 'Create place' }).last().click();
  await expect(page.getByRole('heading', { name: placeName, exact: true })).toBeVisible();

  await content(page).getByRole('button', { name: 'New notebook' }).first().click();
  await page.getByLabel('Notebook name').fill(notebookName);
  await page.getByRole('button', { name: 'Create notebook' }).last().click();
  await expect(page.getByRole('heading', { name: notebookName, exact: true })).toBeVisible();

  await content(page).getByRole('button', { name: 'New note' }).first().click();
  await page.getByRole('textbox', { name: 'Note title' }).fill(title);
  await page.getByLabel('Note tags').fill('smoke, release');
  await page.getByLabel('Note tags').press('Tab');

  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(placeName);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(notebookName);

  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: notebookName, exact: true })).toBeVisible();
});
