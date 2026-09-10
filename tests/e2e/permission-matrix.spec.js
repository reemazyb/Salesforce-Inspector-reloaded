import {test, expect} from "./fixtures";
import {
  TEST_CONSTANTS,
  injectSessionData
} from "./test-helpers";
import {routeMock} from "./test-mock";

test.describe("Permissions", () => {
  const {mockHost, mockToken, apiVersion} = TEST_CONSTANTS;

  test.beforeEach(async ({context}) => {
    await injectSessionData(context, {
      host: mockHost,
      token: mockToken,
      version: apiVersion
    });
    await context.route("**/*", async route => {
      if (!TEST_CONSTANTS.mockEnabled) {
        await route.continue();
        return;
      }
      if (await routeMock(route, mockHost)) {
        return;
      }
      await route.continue();
    });
  });

  async function openPage(page, extensionId, extra = "") {
    await page.goto(`chrome-extension://${extensionId}/permission-matrix.html?host=${mockHost}${extra}`);
    await page.waitForSelector("[data-testid='pm-page']", {timeout: 10000});
  }

  test("loads user lens and empty state", async ({page, extensionId}) => {
    await openPage(page, extensionId);
    await expect(page.getByTestId("pm-page")).toBeVisible();
    await expect(page.getByTestId("pm-modes")).toBeVisible();
    await expect(page.getByTestId("pm-empty")).toContainText("Select a user");
  });

  test("user summary shows OLS, View All Data, and custom permissions", async ({page, extensionId}) => {
    await openPage(page, extensionId);
    const userInput = page.getByTestId("pm-user-input");
    await userInput.fill("Integration");
    await expect(page.locator(".pm-dropdown button").first()).toBeVisible({timeout: 5000});
    await page.locator(".pm-dropdown button").first().click();
    await expect(page.getByTestId("pm-summary")).toBeVisible({timeout: 10000});
    await expect(page.getByTestId("pm-summary")).toContainText("View All Data");
    await expect(page.getByTestId("pm-summary")).toContainText("Yes");
    await expect(page.getByTestId("pm-ols-table")).toBeVisible();
    await expect(page.getByTestId("pm-ols-table")).toContainText("Account");
    await expect(page.getByTestId("pm-assignments")).toContainText("System Administrator");

    await page.getByTestId("pm-section-userPerms").click();
    await expect(page.getByTestId("pm-userperm-table")).toBeVisible();
    await expect(page.getByTestId("pm-userperm-table")).toContainText("View All Data");

    await page.getByTestId("pm-section-customPerms").click();
    await expect(page.getByTestId("pm-customperm-table")).toBeVisible();
    await expect(page.getByTestId("pm-customperm-table")).toContainText("Can Approve");
  });

  test("user field tab shows FLS after picking an object", async ({page, extensionId}) => {
    await openPage(page, extensionId);
    await page.getByTestId("pm-user-input").fill("Integration");
    await page.locator(".pm-dropdown button").first().click();
    await expect(page.getByTestId("pm-summary")).toBeVisible({timeout: 10000});
    await page.getByTestId("pm-object-input").fill("Account");
    await page.locator(".pm-dropdown button").first().click();
    await page.getByTestId("pm-section-fields").click();
    await expect(page.getByTestId("pm-fls-table")).toBeVisible({timeout: 10000});
    await expect(page.getByTestId("pm-fls-table")).toContainText("Name");
    await expect(page.getByTestId("pm-info")).toContainText("describe");
    await expect(page.getByTestId("pm-export-csv")).toBeEnabled();
  });

  test("object lens loads parent OLS matrix", async ({page, extensionId}) => {
    await openPage(page, extensionId);
    await page.locator("label[for='pm-mode-object']").click();
    await page.getByTestId("pm-object-input").fill("Account");
    await page.locator(".pm-dropdown button").first().click();
    await expect(page.getByTestId("pm-ols-table")).toBeVisible({timeout: 10000});
    await expect(page.getByTestId("pm-ols-table")).toContainText("System Administrator");
    await expect(page.getByTestId("pm-switch-user")).toBeVisible();
  });

  test("profile lens lists object permissions", async ({page, extensionId}) => {
    await openPage(page, extensionId);
    await page.locator("label[for='pm-mode-profile']").click();
    const profileSelect = page.getByTestId("pm-profile-select");
    await expect(profileSelect.locator("option").nth(1)).toHaveCount(1, {timeout: 10000});
    await profileSelect.selectOption({label: "System Administrator"});
    await expect(page.getByTestId("pm-ols-table")).toBeVisible({timeout: 10000});
    await expect(page.getByTestId("pm-summary")).toBeVisible();
  });
});
