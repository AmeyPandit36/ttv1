import { test, expect } from '@playwright/test';

test.describe('Campus Chronos E2E Timetable Platform', () => {
  test('Complete System Flow: Onboarding, Fallback Policies, Workloads, Regeneration, Diffs, Exports, and AI Conversations', async ({ page }) => {
    // 1. Authenticate ADMIN User
    console.log('Logging in securely as administrator...');
    await page.goto('/');
    await page.fill('input[type="email"]', 'admin@chronos.local');
    await page.fill('input[type="password"]', 'Chronos123!');
    await page.click('button:has-text("Sign in securely")');
    await expect(page.locator('h1')).toHaveText('Dashboard');

    // 2. Onboarding Setup Pages & Readiness Verification
    console.log('Checking "Academic setup" onboarding state...');
    await page.click('button:has-text("Academic setup")');
    await expect(page.locator('h1')).toHaveText('Academic setup');

    console.log('Checking "Enrollment" onboarding state...');
    await page.click('button:has-text("Enrollment")');
    await expect(page.locator('h1')).toHaveText('Student enrollment');

    // 3. Faculty Workload Demand/Capacity Dashboard (P2-4)
    console.log('Navigating to Faculty Workload capacity dashboard...');
    await page.click('button:has-text("Faculty")');
    await expect(page.locator('h1')).toHaveText('Faculty & workloads');
    await expect(page.locator('.stat-grid')).toContainText('Total faculty members');
    await expect(page.locator('.stat-grid')).toContainText('Overloaded instructors');
    
    // 4. Combined-Class Participant Editor (P2-2)
    console.log('Navigating to Teaching Requirements...');
    await page.click('button:has-text("Teaching requirements")');
    await expect(page.locator('h1')).toHaveText('Teaching requirements');
    
    // Open modal to add a combined requirement
    console.log('Composing a combined class inside requirements editor...');
    await page.click('button:has-text("Add record")');
    await expect(page.locator('.modal-head h3')).toHaveText('Add requirements');
    
    // Check multiple division boxes for a combined class
    await page.locator('.modal input[type="checkbox"]').first().check();
    await page.locator('.modal input[type="checkbox"]').nth(1).check();
    await page.click('button:has-text("Cancel")'); // Close modal cleanly

    // 5. Ordered Fallback Policy Editor (P2-3)
    console.log('Navigating to Scheduling Policies...');
    await page.click('button:has-text("Policies")');
    await expect(page.locator('h1')).toHaveText('Scheduling policies');

    console.log('Adding an ordered fallback preference policy...');
    await page.click('button:has-text("Add record")');
    await page.fill('input[name="name"]', 'IT Lab Fallback Policy');
    await page.fill('input[name="fallbackChain"]', 'lab-it-1, lab-cse-1');
    await page.click('button:has-text("Cancel")');

    // 6. Timetable Generation & Solve Runs
    console.log('Navigating to Generator workspace...');
    await page.click('button:has-text("Generate")');
    await expect(page.locator('h1')).toHaveText('Generate');
    await page.click('button:has-text("Start generation")');
    await page.waitForSelector('.result.success-box', { timeout: 30000 });

    // 7. Dedicated Timetable Views, Excel Export, PDF Export, and Diffs (P2-1, P2-5, P2-7)
    console.log('Navigating to Calendar Timetable review workspace...');
    await page.click('button:has-text("Review timetable")');
    await expect(page.locator('h1')).toHaveText('Timetable');

    console.log('Testing Dedicated Views filtering dropdowns...');
    await page.selectOption('select:near(button:has-text("Export Excel"))', 'faculty');
    await page.selectOption('select:near(button:has-text("Export Excel"))', 'room');

    console.log('Verifying version comparison and diff logs...');
    await page.waitForSelector('select:has-text("Select version")');
    await page.selectOption('select:has-text("Select version")', { index: 1 });

    console.log('Verifying Excel and PDF Export actions...');
    await expect(page.locator('button:has-text("Export Excel")')).toBeVisible();
    await expect(page.locator('button:has-text("Print / PDF")')).toBeVisible();

    // 8. Persistent AI Conversations & Sidebar Logs (P2-persistent-chat)
    console.log('Navigating to grounding AI Assistant workspace...');
    await page.click('button:has-text("AI Assistant")');
    await expect(page.locator('h1')).toHaveText('AI Assistant');
    await expect(page.locator('.chat-history')).toContainText('Conversations');
    await expect(page.locator('.chat-history')).toContainText('New chat');

    // Type and send policy prompt
    await page.fill('textarea', 'Prefer IT Computing Lab for IT.');
    await page.click('button:has-text("Prefer IT Computing Lab for IT.")');
    await page.waitForSelector('.message.ai');

    console.log('Signing out...');
    await page.click('.logout');
  });
});
