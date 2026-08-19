import { test, expect } from '@playwright/test';

test.describe('Campus Chronos E2E Timetable Platform', () => {
  test('Flow: Login -> Onboarding Check -> Preflight -> Generate -> Timetable View -> Role Boundary', async ({ page }) => {
    // 1. Login Flow
    console.log('Navigating to root and logging in...');
    await page.goto('/');
    
    // Fill credentials
    await page.fill('input[type="email"]', 'admin@chronos.local');
    await page.fill('input[type="password"]', 'Chronos123!');
    
    // Click Sign In
    await page.click('button:has-text("Sign in securely")');
    
    // Verify Dashboard loading
    console.log('Verifying Dashboard has loaded...');
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('aside')).toContainText('Campus Chronos');
    await expect(page.locator('header')).toContainText('Demo Administrator');

    // 2. Onboarding check page navigation
    console.log('Navigating and verifying "Academic setup"...');
    await page.click('button:has-text("Academic setup")');
    await expect(page.locator('h1')).toHaveText('Academic setup');
    await expect(page.locator('.tree-head')).toContainText('2026–27');

    console.log('Navigating and verifying "Enrollment"...');
    await page.click('button:has-text("Enrollment")');
    await expect(page.locator('h1')).toHaveText('Enrollment');

    console.log('Navigating and verifying "Faculty"...');
    await page.click('button:has-text("Faculty")');
    await expect(page.locator('h1')).toHaveText('Faculty');

    console.log('Navigating and verifying "Infrastructure"...');
    await page.click('button:has-text("Infrastructure")');
    await expect(page.locator('h1')).toHaveText('Infrastructure');

    console.log('Navigating and verifying "Teaching requirements"...');
    await page.click('button:has-text("Teaching requirements")');
    await expect(page.locator('h1')).toHaveText('Teaching requirements');

    console.log('Navigating and verifying "Policies"...');
    await page.click('button:has-text("Policies")');
    await expect(page.locator('h1')).toHaveText('Policies');

    // 3. Timetable Generation Flow
    console.log('Navigating to "Generate" timetable page...');
    await page.click('button:has-text("Generate")');
    await expect(page.locator('h1')).toHaveText('Generate');

    // Ensure preflight summary is visible
    await expect(page.locator('.check')).toContainText(['Sessions expanded', 'Candidate combinations']);

    // Run Generator
    console.log('Triggering optimization solver run...');
    await page.click('button:has-text("Start generation")');
    
    // Wait for the solver run to finish and show the success block
    console.log('Waiting for successful timetable generation...');
    await page.waitForSelector('.result.success-box', { timeout: 30000 });
    await expect(page.locator('.result.success-box h3')).toContainText('Timetable generated');

    // 4. View Timetable and manual move interface
    console.log('Navigating to review the generated timetable...');
    await page.click('button:has-text("Review timetable")');
    await expect(page.locator('h1')).toHaveText('Timetable');

    // Ensure the calendar grid contains events
    console.log('Verifying calendar events render in the timetable grid...');
    await page.waitForSelector('.event');
    const events = await page.locator('.event');
    expect(await events.count()).toBeGreaterThan(0);

    // 5. Sign out and role boundary checks
    console.log('Signing out...');
    await page.click('.logout');
    await page.waitForSelector('form.login-card');

    // Test a student's restricted workspace
    console.log('Logging in as a student...');
    await page.fill('input[type="email"]', 'student@chronos.local');
    await page.fill('input[type="password"]', 'Chronos123!');
    await page.click('button:has-text("Sign in securely")');

    // Student should only see Dashboard or specific scopes
    await expect(page.locator('header')).toContainText('Demo Student');
    
    // Navigate to Faculty page: list should be empty or restricted for students
    await page.click('button:has-text("Faculty")');
    await expect(page.locator('table tbody')).toBeEmpty();
    console.log('✓ Confirmed student has restricted read permissions.');
  });
});
